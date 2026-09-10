// 本地文件保险箱（整合自 SafeKey-STC-B 的思路）：
// 板载 PIN 认证通过后，才允许把 .safevault 加密文件解密到临时明文目录。
// 文件格式：MAGIC(8) + salt(16) + nonce(12) + AES-256-GCM(zip 明文, AAD=MAGIC)
// 密钥由设备侧常量经 PBKDF2-HMAC-SHA256(200k 轮) 派生，PIN 只在板子上校验、不经串口传输。
use std::fs;
use std::io::{Cursor, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use aes_gcm::aead::{Aead, Payload};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use pbkdf2::pbkdf2_hmac;
use serde::Serialize;
use sha2::Sha256;

const MAGIC: &[u8; 8] = b"STCVAULT";
const HEADER_LEN: usize = 8 + 16 + 12;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 12;
const PBKDF2_ROUNDS: u32 = 200_000;
// 设备侧密钥：认证由板子完成，加密材料在此派生（换板不通用，属预期行为）
const DEVICE_SECRET: &[u8] = b"stc-b-workbench SafeKey device secret v1";

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultInfo {
    pub entries: u32,
    pub payload_size: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultState {
    pub unlocked: bool,
    pub vault_path: Option<String>,
    pub unlocked_dir: Option<String>,
    pub remaining_secs: u64,
}

#[derive(Clone, Debug, Default)]
struct VaultStateInner {
    vault_path: Option<PathBuf>,
    unlocked_dir: Option<PathBuf>,
    deadline: Option<Instant>,
}

struct VaultInner {
    state: Mutex<VaultStateInner>,
    monitor_cancel: AtomicBool,
    monitor: Mutex<Option<JoinHandle<()>>>,
}

pub struct VaultService {
    inner: Arc<VaultInner>,
}

fn derive_key(salt: &[u8]) -> [u8; 32] {
    let mut key = [0u8; 32];
    pbkdf2_hmac::<Sha256>(DEVICE_SECRET, salt, PBKDF2_ROUNDS, &mut key);
    key
}

fn zip_folder(source: &Path) -> Result<Vec<u8>, String> {
    let mut files = Vec::new();
    collect_files(source, "", &mut files)?;
    let cursor = Cursor::new(Vec::new());
    let mut writer = zip::ZipWriter::new(cursor);
    let options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for (path, name) in &files {
        writer
            .start_file(name.as_str(), options)
            .map_err(|e| format!("打包失败：{e}"))?;
        let data = fs::read(path).map_err(|e| format!("读取文件失败：{e}"))?;
        writer.write_all(&data).map_err(|e| format!("写入压缩数据失败：{e}"))?;
    }
    let cursor = writer.finish().map_err(|e| format!("打包失败：{e}"))?;
    Ok(cursor.into_inner())
}

fn collect_files(root: &Path, prefix: &str, out: &mut Vec<(PathBuf, String)>) -> Result<(), String> {
    for entry in fs::read_dir(root).map_err(|e| format!("读取目录失败：{e}"))? {
        let entry = entry.map_err(|e| format!("读取目录失败：{e}"))?;
        let path = entry.path();
        let meta = fs::symlink_metadata(&path).map_err(|e| format!("读取元数据失败：{e}"))?;
        if meta.file_type().is_symlink() {
            return Err("源文件夹包含符号链接，已拒绝".to_owned());
        }
        let name = if prefix.is_empty() {
            entry.file_name().to_string_lossy().into_owned()
        } else {
            format!("{prefix}/{}", entry.file_name().to_string_lossy())
        };
        if meta.is_dir() {
            collect_files(&path, &name, out)?;
        } else if meta.is_file() {
            out.push((path, name));
        }
    }
    Ok(())
}

fn encrypt(plaintext: &[u8]) -> Result<Vec<u8>, String> {
    let mut salt = [0u8; SALT_LEN];
    let mut nonce_bytes = [0u8; NONCE_LEN];
    getrandom::fill(&mut salt).map_err(|e| format!("随机数生成失败：{e}"))?;
    getrandom::fill(&mut nonce_bytes).map_err(|e| format!("随机数生成失败：{e}"))?;
    let cipher = Aes256Gcm::new_from_slice(&derive_key(&salt))
        .map_err(|e| format!("初始化加密失败：{e}"))?;
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload { msg: plaintext, aad: MAGIC },
        )
        .map_err(|_| "加密失败".to_owned())?;
    let mut out = Vec::with_capacity(HEADER_LEN + ciphertext.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(&salt);
    out.extend_from_slice(&nonce_bytes);
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

fn decrypt(raw: &[u8]) -> Result<Vec<u8>, String> {
    if raw.len() < HEADER_LEN || raw[..8] != *MAGIC {
        return Err("不是本应用的保险箱文件".to_owned());
    }
    let cipher = Aes256Gcm::new_from_slice(&derive_key(&raw[8..24]))
        .map_err(|e| format!("初始化解密失败：{e}"))?;
    cipher
        .decrypt(
            Nonce::from_slice(&raw[24..36]),
            Payload { msg: &raw[36..], aad: &raw[..8] },
        )
        .map_err(|_| "解密失败：认证标签无效（文件损坏，或不是本设备创建的保险箱）".to_owned())
}

fn atomic_write(dest: &Path, data: &[u8]) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
    }
    let tmp = dest.with_extension("safevault.tmp");
    fs::write(&tmp, data).map_err(|e| format!("写入临时文件失败：{e}"))?;
    // Windows 的 rename 不能覆盖已有文件，先移除旧的（此时新保险箱已完整落盘到 tmp）
    if dest.exists() {
        if let Err(error) = fs::remove_file(dest) {
            let _ = fs::remove_file(&tmp);
            return Err(format!("替换旧保险箱失败：{error}"));
        }
    }
    fs::rename(&tmp, dest).map_err(|e| format!("落盘失败：{e}"))
}

fn make_vault(source: &Path, dest: &Path) -> Result<(), String> {
    let source = source.canonicalize().map_err(|e| format!("源路径无效：{e}"))?;
    if !source.is_dir() {
        return Err("源路径必须是文件夹".to_owned());
    }
    let plaintext = zip_folder(&source)?;
    let blob = encrypt(&plaintext)?;
    atomic_write(dest, &blob)
}

fn safe_extract(archive: &[u8], dest: &Path) -> Result<u32, String> {
    let mut zf = zip::ZipArchive::new(Cursor::new(archive))
        .map_err(|e| format!("保险箱 ZIP 结构无效：{e}"))?;
    fs::create_dir_all(dest).map_err(|e| format!("创建解锁目录失败：{e}"))?;
    for index in 0..zf.len() {
        let mut entry = zf.by_index(index).map_err(|e| format!("读取条目失败：{e}"))?;
        let name = entry.name().replace('\\', "/");
        let relative = PathBuf::from(&name);
        if relative.is_absolute()
            || relative
                .components()
                .any(|c| matches!(c, Component::ParentDir))
        {
            return Err("保险箱包含非法路径".to_owned());
        }
        if let Some(mode) = entry.unix_mode() {
            if mode & 0o170000 == 0o120000 {
                return Err("保险箱不支持符号链接".to_owned());
            }
        }
        let target = dest.join(&relative);
        if entry.is_dir() {
            fs::create_dir_all(&target).map_err(|e| format!("创建目录失败：{e}"))?;
            continue;
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{e}"))?;
        }
        let mut sink = fs::File::create(&target).map_err(|e| format!("写文件失败：{e}"))?;
        std::io::copy(&mut entry, &mut sink).map_err(|e| format!("解压失败：{e}"))?;
    }
    Ok(zf.len() as u32)
}

fn read_vault(path: &Path) -> Result<Vec<u8>, String> {
    fs::read(path).map_err(|e| format!("读取保险箱失败：{e}"))
}

pub fn verify_info(path: &Path) -> Result<VaultInfo, String> {
    let plaintext = decrypt(&read_vault(path)?)?;
    let mut zf = zip::ZipArchive::new(Cursor::new(&plaintext))
        .map_err(|e| format!("保险箱 ZIP 结构无效：{e}"))?;
    Ok(VaultInfo {
        entries: zf.len() as u32,
        payload_size: plaintext.len() as u64,
    })
}

fn unlocked_dir_for(vault: &Path, output_root: &Path) -> PathBuf {
    output_root.join(format!("{}-unlocked", vault.file_stem().unwrap_or_default().to_string_lossy()))
}

// 指定盘符不存在时回退到 用户目录\Documents\SafeKey-Unlocked
fn ensure_output_root(root: &Path) -> PathBuf {
    if fs::create_dir_all(root).is_ok() {
        return root.to_path_buf();
    }
    if let Ok(profile) = std::env::var("USERPROFILE") {
        let fallback = Path::new(&profile).join("Documents").join("SafeKey-Unlocked");
        if fs::create_dir_all(&fallback).is_ok() {
            return fallback;
        }
    }
    root.to_path_buf()
}

impl VaultService {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(VaultInner {
                state: Mutex::new(VaultStateInner::default()),
                monitor_cancel: AtomicBool::new(false),
                monitor: Mutex::new(None),
            }),
        }
    }

    fn lock_state(&self) -> Result<std::sync::MutexGuard<'_, VaultStateInner>, String> {
        self.inner.state.lock().map_err(|_| "保险箱状态锁已损坏".to_owned())
    }

    fn stop_monitor(&self) {
        self.inner.monitor_cancel.store(true, Ordering::Release);
        if let Ok(mut monitor) = self.inner.monitor.lock() {
            if let Some(handle) = monitor.take() {
                let _ = handle.join();
            }
        }
        self.inner.monitor_cancel.store(false, Ordering::Release);
    }

    fn spawn_monitor(deadline: Instant, inner: Arc<VaultInner>) -> JoinHandle<()> {
        thread::spawn(move || loop {
            if inner.monitor_cancel.load(Ordering::Acquire) {
                return;
            }
            if Instant::now() >= deadline {
                let dir = inner
                    .state
                    .lock()
                    .ok()
                    .and_then(|state| state.unlocked_dir.clone());
                if let Some(dir) = dir {
                    let _ = fs::remove_dir_all(dir);
                }
                if let Ok(mut state) = inner.state.lock() {
                    *state = VaultStateInner::default();
                }
                inner.monitor_cancel.store(true, Ordering::Release);
                return;
            }
            thread::sleep(Duration::from_millis(500));
        })
    }

    pub fn create(&self, source: &Path, dest: &Path, delete_source: bool) -> Result<(), String> {
        make_vault(source, dest)?;
        if !delete_source {
            return Ok(());
        }
        let source = source.canonicalize().map_err(|e| format!("源路径无效：{e}"))?;
        let dest = dest.canonicalize().map_err(|e| format!("目标路径无效：{e}"))?;
        if dest.starts_with(&source) {
            return Err("保险箱文件位于原文件夹内部，已拒绝删除原文件夹".to_owned());
        }
        fs::remove_dir_all(&source).map_err(|e| format!("删除原文件夹失败：{e}"))
    }

    pub fn unlock(
        &self,
        vault_path: &Path,
        output_root: &Path,
        autolock_secs: u64,
    ) -> Result<String, String> {
        self.stop_monitor();
        let raw = read_vault(vault_path)?;
        let plaintext = decrypt(&raw)?;
        let mut state = self.lock_state()?;
        if state.unlocked_dir.is_some() {
            return Err("已有解锁的保险箱，请先保存或锁定".to_owned());
        }
        let dir = unlocked_dir_for(vault_path, &ensure_output_root(output_root));
        if dir.exists() {
            return Err("解锁目录已存在，请先锁定并清理上一次的目录".to_owned());
        }
        safe_extract(&plaintext, &dir)?;
        let deadline = Instant::now() + Duration::from_secs(autolock_secs.max(10));
        state.vault_path = Some(vault_path.to_path_buf());
        state.unlocked_dir = Some(dir.clone());
        state.deadline = Some(deadline);
        drop(state);
        let handle = Self::spawn_monitor(deadline, self.inner.clone());
        if let Ok(mut monitor) = self.inner.monitor.lock() {
            *monitor = Some(handle);
        }
        Ok(dir.to_string_lossy().into_owned())
    }

    /// 重新加密保存当前明文目录并锁定
    pub fn relock(&self) -> Result<(), String> {
        let (dir, vault_path) = {
            let state = self.lock_state()?;
            match (state.unlocked_dir.clone(), state.vault_path.clone()) {
                (Some(dir), Some(vault)) => (dir, vault),
                _ => return Err("尚未解锁保险箱".to_owned()),
            }
        };
        make_vault(&dir, &vault_path)?;
        self.cleanup()?;
        Ok(())
    }

    /// 放弃修改并锁定
    pub fn lock(&self) -> Result<(), String> {
        self.cleanup()
    }

    fn cleanup(&self) -> Result<(), String> {
        self.stop_monitor();
        let dir = {
            let mut state = self.lock_state()?;
            let dir = state.unlocked_dir.take();
            *state = VaultStateInner::default();
            dir
        };
        if let Some(dir) = dir {
            if dir.exists() {
                fs::remove_dir_all(&dir).map_err(|e| format!("清理临时目录失败：{e}"))?;
            }
        }
        Ok(())
    }

    pub fn state(&self) -> VaultState {
        let state = self
            .inner
            .state
            .lock()
            .map(|state| state.clone())
            .unwrap_or_default();
        let remaining_secs = state
            .deadline
            .map(|deadline| {
                deadline
                    .saturating_duration_since(Instant::now())
                    .as_secs()
            })
            .unwrap_or(0);
        VaultState {
            unlocked: state.unlocked_dir.is_some(),
            vault_path: state.vault_path.map(|path| path.to_string_lossy().into_owned()),
            unlocked_dir: state
                .unlocked_dir
                .map(|path| path.to_string_lossy().into_owned()),
            remaining_secs,
        }
    }

    pub fn open_unlocked_dir(&self) -> Result<(), String> {
        let dir = self
            .lock_state()?
            .unlocked_dir
            .clone()
            .ok_or_else(|| "尚未解锁保险箱".to_owned())?;
        std::process::Command::new("explorer")
            .arg(&dir)
            .spawn()
            .map_err(|e| format!("打开目录失败：{e}"))?;
        Ok(())
    }
}

impl Default for VaultService {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for VaultService {
    fn drop(&mut self) {
        self.stop_monitor();
        if let Ok(state) = self.inner.state.lock() {
            if let Some(dir) = &state.unlocked_dir {
                let _ = fs::remove_dir_all(dir);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn vault_roundtrip_and_tamper_rejection() {
        let tmp = std::env::temp_dir().join(format!("stcvault-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let src = tmp.join("src");
        fs::create_dir_all(src.join("sub")).unwrap();
        fs::write(src.join("a.txt"), b"hello safekey").unwrap();
        fs::write(src.join("sub/b.bin"), [1u8, 2, 3, 4]).unwrap();
        let vault = tmp.join("test.safevault");

        make_vault(&src, &vault).unwrap();
        assert!(src.join("a.txt").exists()); // 未选删除，原文件保留

        let info = verify_info(&vault).unwrap();
        assert_eq!(info.entries, 2); // a.txt、sub/b.bin（空目录不单独建档）

        let out_root = tmp.join("out");
        let dir = unlocked_dir_for(&vault, &out_root);
        let plaintext = decrypt(&fs::read(&vault).unwrap()).unwrap();
        assert_eq!(safe_extract(&plaintext, &dir).unwrap(), 2);
        assert_eq!(fs::read(dir.join("a.txt")).unwrap(), b"hello safekey");
        assert_eq!(fs::read(dir.join("sub/b.bin")).unwrap(), vec![1u8, 2, 3, 4]);

        // 篡改密文 → 认证标签校验失败
        let mut raw = fs::read(&vault).unwrap();
        raw[40] ^= 0xFF;
        assert!(decrypt(&raw).is_err());
        // 非 SafeVault 文件拒绝
        let junk = tmp.join("junk.safevault");
        fs::write(&junk, b"not a vault at all........").unwrap();
        assert!(verify_info(&junk).is_err());

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn extract_rejects_traversal_names() {
        // 手工构造带 .. 路径的 ZIP
        let tmp = std::env::temp_dir().join(format!("stcvault-zip-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let cursor = Cursor::new(Vec::new());
        let mut writer = zip::ZipWriter::new(cursor);
        let options =
            zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
        writer.start_file("../evil.txt", options).unwrap();
        writer.write_all(b"pwn").unwrap();
        let cursor = writer.finish().unwrap();
        let out = tmp.join("out");
        assert!(safe_extract(&cursor.into_inner(), &out).is_err());
        assert!(!tmp.join("evil.txt").exists());
        let _ = fs::remove_dir_all(&tmp);
    }
}

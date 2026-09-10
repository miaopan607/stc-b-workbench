use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::models::{ControllerPhase, ControllerProfile, ControllerSnapshot};
use crate::serial;

const FRAME_HEAD: [u8; 2] = [0xAA, 0x5A];
const FRAME_TYPE_KEY: u8 = 0x21;
const FRAME_LENGTH: usize = 6;
const RECONNECT_DELAY: Duration = Duration::from_millis(3000);

const ACT_PRESS: u8 = 1;
const ACT_REPEAT: u8 = 2;
const ACT_RELEASE: u8 = 3;

const KEY_UP: u8 = 1;
const KEY_DOWN: u8 = 2;
const KEY_LEFT: u8 = 3;
const KEY_RIGHT: u8 = 4;
const KEY_CENTER: u8 = 5;
const KEY_K1: u8 = 6;
const KEY_K2: u8 = 7;
const KEY_K3: u8 = 8;

// Win32 媒体键 VK 值（该 windows-sys 版本未导出这些常量）
const VK_MEDIA_PREV_TRACK: u16 = 0xB1;
const VK_MEDIA_NEXT_TRACK: u16 = 0xB2;
const VK_MEDIA_PLAY_PAUSE: u16 = 0xB3;

// ---------------------------------------------------------------------------
// 按键注入（Windows SendInput）
// ---------------------------------------------------------------------------

mod inject {
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_EXTENDEDKEY,
        KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE, KEYEVENTF_UNICODE,
    };

    // '/' 经 KEYEVENTF_UNICODE 投递，绕过中文输入法的组词拦截
    const VK_PACKET: u16 = 0xE7;

    fn key_event(wvk: u16, wscan: u16, dwflags: u32) -> INPUT {
        INPUT {
            r#type: INPUT_KEYBOARD,
            Anonymous: INPUT_0 {
                ki: KEYBDINPUT {
                    wVk: wvk,
                    wScan: wscan,
                    dwFlags: dwflags,
                    time: 0,
                    dwExtraInfo: 0,
                },
            },
        }
    }

    fn send(events: &[INPUT]) -> bool {
        let count = events.len() as u32;
        let size = std::mem::size_of::<INPUT>() as i32;
        unsafe { SendInput(count, events.as_ptr(), size) == count }
    }

    pub fn tap(scan: u16, extended: bool) -> bool {
        let mut flags = KEYEVENTF_SCANCODE;
        if extended {
            flags |= KEYEVENTF_EXTENDEDKEY;
        }
        send(&[
            key_event(0, scan, flags),
            key_event(0, scan, flags | KEYEVENTF_KEYUP),
        ])
    }

    pub fn tap_char(ch: char) -> bool {
        let scan = ch as u16;
        send(&[
            key_event(VK_PACKET, scan, KEYEVENTF_UNICODE),
            key_event(VK_PACKET, scan, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP),
        ])
    }

    // 媒体键没有 set-1 扫描码，按扩展键以 VK 投递（对应硬件 E0 前缀序列）
    pub fn tap_vk(vk: u16) -> bool {
        send(&[
            key_event(vk, 0, KEYEVENTF_EXTENDEDKEY),
            key_event(vk, 0, KEYEVENTF_EXTENDEDKEY | KEYEVENTF_KEYUP),
        ])
    }

    pub fn ctrl_c() -> bool {
        const LCTRL_SCAN: u16 = 0x1D;
        const C_SCAN: u16 = 0x2E;
        let base = KEYEVENTF_SCANCODE;
        send(&[
            key_event(0, LCTRL_SCAN, base),
            key_event(0, C_SCAN, base),
            key_event(0, C_SCAN, base | KEYEVENTF_KEYUP),
            key_event(0, LCTRL_SCAN, base | KEYEVENTF_KEYUP),
        ])
    }
}

fn key_label(key: u8) -> &'static str {
    match key {
        KEY_UP => "上",
        KEY_DOWN => "下",
        KEY_LEFT => "左",
        KEY_RIGHT => "右",
        KEY_CENTER => "中键",
        KEY_K1 => "K1",
        KEY_K2 => "K2",
        KEY_K3 => "K3",
        _ => "未知",
    }
}

fn action_label(action: u8) -> &'static str {
    match action {
        ACT_PRESS => "按下",
        ACT_REPEAT => "长按",
        _ => "抬起",
    }
}

fn inject_key(key: u8, profile: ControllerProfile) -> Option<(&'static str, fn() -> bool)> {
    match profile {
        ControllerProfile::Codex => match key {
            KEY_UP => Some(("↑", || inject::tap(0x48, true))),
            KEY_DOWN => Some(("↓", || inject::tap(0x50, true))),
            KEY_LEFT => Some(("Backspace", || inject::tap(0x0E, false))),
            KEY_RIGHT => Some(("/", || inject::tap_char('/'))),
            KEY_CENTER => Some(("Enter", || inject::tap(0x1C, false))),
            KEY_K1 => Some(("Ctrl+C", inject::ctrl_c)),
            KEY_K2 => Some(("Tab", || inject::tap(0x0F, false))),
            KEY_K3 => Some(("Esc", || inject::tap(0x01, false))),
            _ => None,
        },
        ControllerProfile::Media => match key {
            KEY_K1 => Some(("下一曲", || inject::tap_vk(VK_MEDIA_NEXT_TRACK))),
            KEY_K2 => Some(("播放/暂停", || inject::tap_vk(VK_MEDIA_PLAY_PAUSE))),
            KEY_K3 => Some(("上一曲", || inject::tap_vk(VK_MEDIA_PREV_TRACK))),
            _ => None,
        },
        // 保险箱方案：K1/K2/K3 由板子 PIN 模式自用，PC 侧不注入任何键
        ControllerProfile::Vault => None,
    }
}

// ---------------------------------------------------------------------------
// 帧解析
// ---------------------------------------------------------------------------

/// 音乐律动运行时复用：解析板子发来的按键数据，K1/K2/K3 注入系统媒体键，其余键忽略
pub fn feed_media_keys(parser: &mut KeyFrameParser, data: &[u8]) {
    for event in parser.feed(data) {
        if event.action != ACT_RELEASE {
            if let Some((_, fire)) = inject_key(event.key, ControllerProfile::Media) {
                fire();
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct KeyEvent {
    pub key: u8,
    pub action: u8,
}

pub struct KeyFrameParser {
    buf: Vec<u8>,
    bad_frames: u32,
}

impl KeyFrameParser {
    pub fn new() -> Self {
        Self {
            buf: Vec::new(),
            bad_frames: 0,
        }
    }

    pub fn bad_frames(&self) -> u32 {
        self.bad_frames
    }

    pub fn feed(&mut self, data: &[u8]) -> Vec<KeyEvent> {
        self.buf.extend_from_slice(data);
        let mut events = Vec::new();
        loop {
            match self.buf.windows(2).position(|w| w == FRAME_HEAD) {
                None => {
                    if self.buf.len() > 1 {
                        // 只保留最后 1 字节，可能是被截断的下一帧头
                        let last = self.buf[self.buf.len() - 1];
                        self.buf.clear();
                        self.buf.push(last);
                    }
                    break;
                }
                Some(0) => {
                    if self.buf.len() < FRAME_LENGTH {
                        break;
                    }
                    let frame: Vec<u8> = self.buf.drain(..FRAME_LENGTH).collect();
                    match parse_frame(&frame) {
                        Some(event) => events.push(event),
                        None => self.bad_frames += 1,
                    }
                }
                Some(position) => {
                    self.buf.drain(..position);
                }
            }
        }
        events
    }
}

impl Default for KeyFrameParser {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// SafeKey 认证帧解析（0x25：AA 5A 25 ev payload chk）
// ---------------------------------------------------------------------------

pub const FRAME_TYPE_SKAUTH: u8 = 0x25;
pub const FRAME_TYPE_SAFEKEY: u8 = 0x24;
pub const SK_EV_OK: u8 = 1;
pub const SK_EV_FAIL: u8 = 2;
pub const SK_EV_LOCK: u8 = 3;
pub const SK_EV_INPUT: u8 = 4;
pub const SK_EV_EXIT: u8 = 5;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SafeKeyEvent {
    pub event: u8,
    pub payload: u8,
}

pub struct SafeKeyScanner {
    buf: Vec<u8>,
}

impl SafeKeyScanner {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    pub fn feed(&mut self, data: &[u8]) -> Vec<SafeKeyEvent> {
        self.buf.extend_from_slice(data);
        let mut events = Vec::new();
        loop {
            match self.buf.windows(2).position(|w| w == FRAME_HEAD) {
                None => {
                    if self.buf.len() > 1 {
                        let last = self.buf[self.buf.len() - 1];
                        self.buf.clear();
                        self.buf.push(last);
                    }
                    break;
                }
                Some(0) => {
                    if self.buf.len() < FRAME_LENGTH {
                        break;
                    }
                    let frame: Vec<u8> = self.buf.drain(..FRAME_LENGTH).collect();
                    let (event, payload) = (frame[3], frame[4]);
                    if frame[2] == FRAME_TYPE_SKAUTH
                        && (SK_EV_OK..=SK_EV_EXIT).contains(&event)
                        && frame[5] == FRAME_TYPE_SKAUTH ^ event ^ payload
                    {
                        events.push(SafeKeyEvent { event, payload });
                    }
                }
                Some(position) => {
                    self.buf.drain(..position);
                }
            }
        }
        events
    }
}

impl Default for SafeKeyScanner {
    fn default() -> Self {
        Self::new()
    }
}

/// 主机→板子的 SafeKey 模式帧：AA 5A 24 0 cmd chk（cmd 1=进入 PIN 模式 0=退出）
pub fn safekey_mode_frame(enter: bool) -> Vec<u8> {
    let cmd = if enter { 1 } else { 0 };
    vec![0xAA, 0x5A, FRAME_TYPE_SAFEKEY, 0, cmd, FRAME_TYPE_SAFEKEY ^ cmd]
}

fn parse_frame(frame: &[u8]) -> Option<KeyEvent> {
    if frame.len() != FRAME_LENGTH || frame[0..2] != FRAME_HEAD {
        return None;
    }
    let (key, action) = (frame[3], frame[4]);
    if frame[2] != FRAME_TYPE_KEY
        || !(1..=KEY_K3).contains(&key)
        || !(ACT_PRESS..=ACT_RELEASE).contains(&action)
        || frame[5] != FRAME_TYPE_KEY ^ key ^ action
    {
        return None;
    }
    Some(KeyEvent { key, action })
}

// ---------------------------------------------------------------------------
// 运行时
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ControllerKeyEvent {
    pub board: &'static str,
    pub action: &'static str,
    pub injected: Option<&'static str>,
    pub ok: bool,
    pub injected_count: u32,
    pub bad_frames: u32,
}

struct ControllerShared {
    cancel: Arc<AtomicBool>,
    snapshot: Mutex<ControllerSnapshot>,
    /// 待发往板子的字节（SafeKey 模式帧等），由读取线程每轮冲刷
    tx_outbox: Mutex<Vec<u8>>,
}

impl ControllerShared {
    fn snapshot(&self) -> ControllerSnapshot {
        self.snapshot
            .lock()
            .map(|snapshot| snapshot.clone())
            .unwrap_or_else(|_| ControllerSnapshot::error("运行状态锁已损坏"))
    }

    fn update(&self, app: &AppHandle, apply: impl FnOnce(&mut ControllerSnapshot)) {
        let snapshot = self
            .snapshot
            .lock()
            .map(|mut snapshot| {
                apply(&mut snapshot);
                snapshot.clone()
            })
            .unwrap_or_else(|_| ControllerSnapshot::error("运行状态锁已损坏"));
        let _ = app.emit("controller-state", snapshot);
    }
}

struct ControllerRuntimeHandle {
    shared: Arc<ControllerShared>,
    thread: JoinHandle<()>,
}

pub struct ControllerService {
    runtime: Mutex<Option<ControllerRuntimeHandle>>,
}

impl ControllerService {
    pub fn new() -> Self {
        Self {
            runtime: Mutex::new(None),
        }
    }

    pub fn start(&self, app: &AppHandle, port_name: &str, profile: ControllerProfile) -> Result<(), String> {
        let mut runtime = self
            .runtime
            .lock()
            .map_err(|_| "运行状态锁已损坏".to_owned())?;
        if runtime.is_some() {
            return Err("控制器已经在运行".to_owned());
        }
        if port_name.trim().is_empty() {
            return Err("未选择串口".to_owned());
        }
        let shared = Arc::new(ControllerShared {
            cancel: Arc::new(AtomicBool::new(false)),
            snapshot: Mutex::new(ControllerSnapshot::starting(port_name, profile)),
            tx_outbox: Mutex::new(Vec::new()),
        });
        shared.update(app, |snapshot| {
            snapshot.phase = ControllerPhase::Starting;
            snapshot.port_name = Some(port_name.to_owned());
            snapshot.message = "正在连接设备…".to_owned();
        });
        let thread_shared = shared.clone();
        let thread_app = app.clone();
        let thread_port = port_name.to_owned();
        let thread = thread::Builder::new()
            .name("stc-controller-reader".to_owned())
            .spawn(move || reader_loop(thread_app, thread_shared, thread_port, profile))
            .map_err(|error| error.to_string())?;
        *runtime = Some(ControllerRuntimeHandle { shared, thread });
        Ok(())
    }

    pub fn stop(&self, app: Option<&AppHandle>) -> Result<(), String> {
        let handle = self
            .runtime
            .lock()
            .map_err(|_| "运行状态锁已损坏".to_owned())?
            .take();
        let Some(handle) = handle else {
            return Ok(());
        };
        handle.shared.cancel.store(true, Ordering::Release);
        if let Some(app) = app {
            handle
                .shared
                .update(app, |snapshot| *snapshot = ControllerSnapshot::idle());
        }
        if let Err(error) = handle.thread.join() {
            return Err(format!("控制器线程退出异常：{error:?}"));
        }
        Ok(())
    }

    pub fn snapshot(&self) -> ControllerSnapshot {
        self.runtime
            .lock()
            .ok()
            .and_then(|runtime| runtime.as_ref().map(|handle| handle.shared.snapshot()))
            .unwrap_or_else(ControllerSnapshot::idle)
    }

    /// 请求板子进入/退出 SafeKey PIN 模式；字节由读取线程冲刷到串口
    pub fn send_safekey(&self, enter: bool) -> Result<(), String> {
        let runtime = self
            .runtime
            .lock()
            .map_err(|_| "运行状态锁已损坏".to_owned())?;
        let Some(handle) = runtime.as_ref() else {
            return Err("控制器未运行".to_owned());
        };
        handle
            .shared
            .tx_outbox
            .lock()
            .map_err(|_| "发送队列锁已损坏".to_owned())?
            .extend_from_slice(&safekey_mode_frame(enter));
        Ok(())
    }
}

impl Default for ControllerService {
    fn default() -> Self {
        Self::new()
    }
}

fn reader_loop(app: AppHandle, shared: Arc<ControllerShared>, port_name: String, profile: ControllerProfile) {
    let mut parser;
    let mut sk_scanner = SafeKeyScanner::new();
    while !shared.cancel.load(Ordering::Acquire) {
        match serial::open_port(&port_name) {
            Ok(mut port) => {
                parser = KeyFrameParser::new();
                sk_scanner = SafeKeyScanner::new();
                shared.update(&app, |snapshot| {
                    snapshot.phase = ControllerPhase::Running;
                    snapshot.port_name = Some(port_name.to_owned());
                    snapshot.message = format!("已连接 {port_name}，等待板子按键…");
                });
                read_loop(&app, &shared, &mut port, &mut parser, &mut sk_scanner, profile);
            }
            Err(error) => {
                shared.update(&app, |snapshot| {
                    snapshot.phase = ControllerPhase::Running;
                    snapshot.message = format!("串口打开失败：{error}，3 秒后重试");
                });
            }
        }
        wait_reconnect(&shared);
    }
}

fn read_loop(
    app: &AppHandle,
    shared: &Arc<ControllerShared>,
    port: &mut Box<dyn serialport::SerialPort>,
    parser: &mut KeyFrameParser,
    sk_scanner: &mut SafeKeyScanner,
    profile: ControllerProfile,
) {
    let mut buf = [0u8; 128];
    while !shared.cancel.load(Ordering::Acquire) {
        // 冲刷待发帧（SafeKey 模式等）
        let outgoing = shared
            .tx_outbox
            .lock()
            .map(|mut outbox| std::mem::take(&mut *outbox))
            .unwrap_or_default();
        if !outgoing.is_empty() && port.write_all(&outgoing).is_err() {
            shared.update(app, |snapshot| {
                snapshot.message = "串口发送失败，3 秒后重连".to_owned();
            });
            return;
        }
        match port.read(&mut buf) {
            Ok(0) => continue,
            Ok(n) => {
                let bad_frames = parser.bad_frames();
                for event in parser.feed(&buf[..n]) {
                    dispatch_key(app, shared, event, bad_frames, profile);
                }
                for event in sk_scanner.feed(&buf[..n]) {
                    let _ = app.emit(
                        "safekey-event",
                        SafeKeyEvent {
                            event: event.event,
                            payload: event.payload,
                        },
                    );
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::TimedOut => continue,
            Err(error) => {
                shared.update(app, |snapshot| {
                    snapshot.message = format!("串口读取失败：{error}，3 秒后重连");
                });
                return;
            }
        }
    }
}

fn dispatch_key(
    app: &AppHandle,
    shared: &Arc<ControllerShared>,
    event: KeyEvent,
    bad_frames: u32,
    profile: ControllerProfile,
) {
    let board = key_label(event.key);
    let action = action_label(event.action);
    let mut injected_count = 0;
    let (injected, ok) = if event.action == ACT_RELEASE {
        (None, true)
    } else {
        match inject_key(event.key, profile) {
            Some((label, fire)) => {
                let ok = fire();
                (Some(label), ok)
            }
            None => (None, false),
        }
    };
    shared.update(app, |snapshot| {
        if ok && injected.is_some() {
            snapshot.injected_count = snapshot.injected_count.saturating_add(1);
        }
        snapshot.bad_frames = bad_frames;
        injected_count = snapshot.injected_count;
    });
    let _ = app.emit(
        "controller-key",
        ControllerKeyEvent {
            board,
            action,
            injected,
            ok,
            injected_count,
            bad_frames,
        },
    );
}

fn wait_reconnect(shared: &Arc<ControllerShared>) {
    let deadline = Instant::now() + RECONNECT_DELAY;
    while Instant::now() < deadline {
        if shared.cancel.load(Ordering::Acquire) {
            return;
        }
        thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(key: u8, action: u8) -> Vec<u8> {
        vec![
            FRAME_HEAD[0],
            FRAME_HEAD[1],
            FRAME_TYPE_KEY,
            key,
            action,
            FRAME_TYPE_KEY ^ key ^ action,
        ]
    }

    #[test]
    fn parses_valid_frames_with_noise_prefix() {
        let mut parser = KeyFrameParser::new();
        let events = parser.feed(
            &[0x00]
                .iter()
                .chain(frame(KEY_UP, ACT_PRESS).iter())
                .chain(frame(KEY_DOWN, ACT_REPEAT).iter())
                .chain(frame(KEY_CENTER, ACT_PRESS).iter())
                .chain(frame(KEY_K3, ACT_PRESS).iter())
                .chain(frame(KEY_UP, ACT_RELEASE).iter())
                .copied()
                .collect::<Vec<u8>>()
                .as_slice(),
        );
        assert_eq!(
            events,
            vec![
                KeyEvent { key: KEY_UP, action: ACT_PRESS },
                KeyEvent { key: KEY_DOWN, action: ACT_REPEAT },
                KeyEvent { key: KEY_CENTER, action: ACT_PRESS },
                KeyEvent { key: KEY_K3, action: ACT_PRESS },
                KeyEvent { key: KEY_UP, action: ACT_RELEASE },
            ]
        );
        assert_eq!(parser.bad_frames(), 0);
    }

    #[test]
    fn parses_frames_split_across_feeds() {
        let mut parser = KeyFrameParser::new();
        let stream: Vec<u8> = frame(KEY_RIGHT, ACT_PRESS)
            .iter()
            .chain(frame(KEY_LEFT, ACT_RELEASE).iter())
            .copied()
            .collect();
        let (head, tail) = stream.split_at(4);
        assert!(parser.feed(head).is_empty());
        assert_eq!(
            parser.feed(tail),
            vec![
                KeyEvent { key: KEY_RIGHT, action: ACT_PRESS },
                KeyEvent { key: KEY_LEFT, action: ACT_RELEASE },
            ]
        );
        assert_eq!(parser.bad_frames(), 0);
    }

    #[test]
    fn drops_bad_frames_and_keeps_partial_head() {
        let mut parser = KeyFrameParser::new();
        let mut bad_checksum = frame(KEY_UP, ACT_PRESS);
        bad_checksum[5] ^= 0xFF;
        let bad_type = vec![0xAA, 0x5A, 0x20, 1, 1, 0x20 ^ 1 ^ 1];
        assert!(parser
            .feed(&bad_checksum.iter().chain(bad_type.iter()).copied().collect::<Vec<u8>>())
            .is_empty());
        assert_eq!(parser.bad_frames(), 2);

        // 尾部残留半个帧头（0xAA），下次补上 0x5A 后应能继续解析
        assert!(parser.feed(&[0xAA]).is_empty());
        assert_eq!(
            parser.feed(&frame(KEY_DOWN, ACT_PRESS)),
            vec![KeyEvent { key: KEY_DOWN, action: ACT_PRESS }]
        );
        assert_eq!(parser.bad_frames(), 2);
    }

    #[test]
    fn skips_garbage_before_frame_head() {
        let mut parser = KeyFrameParser::new();
        let events = parser.feed(&[0x01, 0x02, 0xAA, 0xAA, 0xAA].iter()
            .chain(frame(KEY_K2, ACT_PRESS).iter())
            .copied()
            .collect::<Vec<u8>>());
        assert_eq!(events, vec![KeyEvent { key: KEY_K2, action: ACT_PRESS }]);
    }

    #[test]
    fn rejects_out_of_range_key_and_action() {
        assert!(parse_frame(&frame(0, ACT_PRESS)).is_none());
        assert!(parse_frame(&frame(KEY_K3 + 1, ACT_PRESS)).is_none());
        assert!(parse_frame(&frame(KEY_UP, 0)).is_none());
        assert!(parse_frame(&frame(KEY_UP, ACT_RELEASE + 1)).is_none());
        assert!(parse_frame(&[0xAA, 0x5A, 0x21, KEY_UP, ACT_PRESS]).is_none());
    }

    fn sk_frame(event: u8, payload: u8) -> Vec<u8> {
        vec![
            FRAME_HEAD[0],
            FRAME_HEAD[1],
            FRAME_TYPE_SKAUTH,
            event,
            payload,
            FRAME_TYPE_SKAUTH ^ event ^ payload,
        ]
    }

    #[test]
    fn safekey_scanner_parses_events_and_rejects_bad_frames() {
        let mut scanner = SafeKeyScanner::new();
        // 成功、失败、锁定一次到位
        let events = scanner.feed(
            &sk_frame(SK_EV_OK, 0)
                .iter()
                .chain(sk_frame(SK_EV_FAIL, 1).iter())
                .chain(sk_frame(SK_EV_LOCK, 30).iter())
                .copied()
                .collect::<Vec<u8>>(),
        );
        assert_eq!(
            events,
            vec![
                SafeKeyEvent { event: SK_EV_OK, payload: 0 },
                SafeKeyEvent { event: SK_EV_FAIL, payload: 1 },
                SafeKeyEvent { event: SK_EV_LOCK, payload: 30 },
            ]
        );
        // 坏校验和被丢弃
        let mut bad = sk_frame(SK_EV_OK, 0);
        bad[5] ^= 0xFF;
        assert!(scanner.feed(&bad).is_empty());
        // 未知事件号被丢弃
        assert!(scanner.feed(&sk_frame(9, 0)).is_empty());
        // 跨包分片
        let mut scanner2 = SafeKeyScanner::new();
        let stream = sk_frame(SK_EV_INPUT, 3);
        assert!(scanner2.feed(&stream[..4]).is_empty());
        assert_eq!(
            scanner2.feed(&stream[4..]),
            vec![SafeKeyEvent { event: SK_EV_INPUT, payload: 3 }]
        );
        // 按键帧不应被误判
        let mut scanner3 = SafeKeyScanner::new();
        assert!(scanner3
            .feed(&frame(KEY_UP, ACT_PRESS))
            .is_empty());
    }
}

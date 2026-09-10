use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter};

use crate::audio;
use crate::models::{ReactiveConfig, RuntimePhase, RuntimeSnapshot};
use crate::serial;

const SEND_INTERVAL: Duration = Duration::from_millis(50);
const STATE_INTERVAL: Duration = Duration::from_millis(100);

pub(crate) struct SharedRuntime {
    pub cancel: Arc<AtomicBool>,
    pub bars: Arc<AtomicU8>,
    pub bars_left: Arc<AtomicU8>,
    pub bars_right: Arc<AtomicU8>,
    snapshot: Mutex<RuntimeSnapshot>,
}

impl SharedRuntime {
    fn new(config: &ReactiveConfig) -> Self {
        let mut snapshot = RuntimeSnapshot::starting(config.audio_source);
        snapshot.stereo = config.stereo;
        Self {
            cancel: Arc::new(AtomicBool::new(false)),
            bars: Arc::new(AtomicU8::new(0)),
            bars_left: Arc::new(AtomicU8::new(0)),
            bars_right: Arc::new(AtomicU8::new(0)),
            snapshot: Mutex::new(snapshot),
        }
    }

    fn snapshot(&self) -> RuntimeSnapshot {
        self.snapshot
            .lock()
            .map(|snapshot| snapshot.clone())
            .unwrap_or_else(|_| RuntimeSnapshot::error(None, "运行状态锁已损坏"))
    }

    fn set_running(&self, source: crate::models::AudioSource) {
        if let Ok(mut snapshot) = self.snapshot.lock() {
            if snapshot.phase == RuntimePhase::Starting {
                let stereo = snapshot.stereo;
                *snapshot = RuntimeSnapshot::running(source);
                snapshot.stereo = stereo;
            }
        }
    }

    fn set_signal(&self, level: audio::StereoLevel, bars: u8) {
        let (left, right) = audio::level_to_bars_stereo(level);
        self.bars.store(bars.min(8), Ordering::Release);
        self.bars_left.store(left, Ordering::Release);
        self.bars_right.store(right, Ordering::Release);
        if let Ok(mut snapshot) = self.snapshot.lock() {
            snapshot.set_signal(level.left.max(level.right), bars, left, right);
        }
    }

    fn set_sent_fps(&self, sent_fps: u8) {
        if let Ok(mut snapshot) = self.snapshot.lock() {
            snapshot.sent_fps = sent_fps;
        }
    }

    fn set_error(&self, source: Option<crate::models::AudioSource>, message: String) {
        self.bars.store(0, Ordering::Release);
        if let Ok(mut snapshot) = self.snapshot.lock() {
            *snapshot = RuntimeSnapshot::error(source, message);
        }
        self.cancel.store(true, Ordering::Release);
    }
}

struct RuntimeHandle {
    app: AppHandle,
    shared: Arc<SharedRuntime>,
    threads: Vec<JoinHandle<()>>,
}

pub struct ReactiveService {
    runtime: Mutex<Option<RuntimeHandle>>,
}

impl ReactiveService {
    pub fn new() -> Self {
        Self {
            runtime: Mutex::new(None),
        }
    }

    pub fn start(&self, app: &AppHandle, config: ReactiveConfig) -> Result<(), String> {
        let mut runtime = self
            .runtime
            .lock()
            .map_err(|_| "运行状态锁已损坏".to_owned())?;
        if let Some(existing) = runtime.take() {
            if existing.shared.snapshot().phase != RuntimePhase::Error {
                *runtime = Some(existing);
                return Err("音乐律动已经在运行".to_owned());
            }
            existing.shared.cancel.store(true, Ordering::Release);
            for thread in existing.threads {
                let _ = thread.join();
            }
        }
        let config = config.clamped();
        let port = serial::open_port(&config.port_name)?;
        let shared = Arc::new(SharedRuntime::new(&config));
        let source = config.audio_source;
        let stereo = config.stereo;
        let sender_shared = shared.clone();
        let sender = thread::Builder::new()
            .name("stc-serial-sender".to_owned())
            .spawn(move || sender_loop(port, sender_shared, source, stereo))
            .map_err(|error| error.to_string())?;

        let audio_shared = shared.clone();
        let audio_config = config.clone();
        let audio = match thread::Builder::new()
            .name("stc-audio-capture".to_owned())
            .spawn(move || {
                let result = audio::run_capture(&audio_config, &audio_shared.cancel, |level, bars| {
                    audio_shared.set_signal(level, bars);
                });
                if let Err(error) = result {
                    if !audio_shared.cancel.load(Ordering::Acquire) {
                        audio_shared.set_error(Some(audio_config.audio_source), format!("音频采集失败：{error}"));
                    }
                }
            }) {
            Ok(thread) => thread,
            Err(error) => {
                shared.cancel.store(true, Ordering::Release);
                let _ = sender.join();
                return Err(error.to_string());
            }
        };

        let publisher_shared = shared.clone();
        let publisher_app = app.clone();
        let publisher = match thread::Builder::new()
            .name("stc-state-publisher".to_owned())
            .spawn(move || publish_loop(publisher_app, publisher_shared)) {
            Ok(thread) => thread,
            Err(error) => {
                shared.cancel.store(true, Ordering::Release);
                let _ = sender.join();
                let _ = audio.join();
                return Err(error.to_string());
            }
        };

        *runtime = Some(RuntimeHandle {
            app: app.clone(),
            shared,
            threads: vec![sender, audio, publisher],
        });
        Ok(())
    }

    pub fn stop(&self) -> Result<(), String> {
        let handle = self
            .runtime
            .lock()
            .map_err(|_| "运行状态锁已损坏".to_owned())?
            .take();
        let Some(handle) = handle else {
            return Ok(());
        };
        handle.shared.cancel.store(true, Ordering::Release);
        for thread in handle.threads {
            let _ = thread.join();
        }
        if let Ok(mut snapshot) = handle.shared.snapshot.lock() {
            *snapshot = RuntimeSnapshot::idle();
            let _ = handle.app.emit("reactive-state", snapshot.clone());
        }
        Ok(())
    }

    pub fn snapshot(&self) -> RuntimeSnapshot {
        self.runtime
            .lock()
            .ok()
            .and_then(|runtime| runtime.as_ref().map(|handle| handle.shared.snapshot()))
            .unwrap_or_else(RuntimeSnapshot::idle)
    }
}

impl Default for ReactiveService {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for ReactiveService {
    fn drop(&mut self) {
        let handle = self.runtime.get_mut().ok().and_then(|runtime| runtime.take());
        if let Some(handle) = handle {
            handle.shared.cancel.store(true, Ordering::Release);
            for thread in handle.threads {
                let _ = thread.join();
            }
        }
    }
}

fn sender_loop(
    mut port: Box<dyn serialport::SerialPort>,
    shared: Arc<SharedRuntime>,
    source: crate::models::AudioSource,
    stereo: bool,
) {
    shared.set_running(source);
    // 发送间隙轮询板子按键帧：K1/K2/K3 注入媒体键（读超时调短以免拖慢发送节奏）
    let _ = port.set_timeout(Duration::from_millis(2));
    let mut parser = crate::controller::KeyFrameParser::new();
    let mut sequence = 0_u8;
    let mut next_send = Instant::now();
    let mut fps_window = Instant::now();
    let mut successful_writes = 0_u16;

    while !shared.cancel.load(Ordering::Acquire) {
        let mut rx = [0u8; 64];
        loop {
            match port.read(&mut rx) {
                Ok(0) => break,
                Ok(n) => crate::controller::feed_media_keys(&mut parser, &rx[..n]),
                Err(_) => break,
            }
        }
        let write_result = if stereo {
            let left = shared.bars_left.load(Ordering::Acquire).min(8);
            let right = shared.bars_right.load(Ordering::Acquire).min(8);
            serial::write_stereo_bars(&mut *port, left, right)
        } else {
            let bars = shared.bars.load(Ordering::Acquire).min(8);
            serial::write_bars(&mut *port, sequence, bars)
        };
        if let Err(error) = write_result {
            shared.set_error(Some(source), format!("串口发送失败：{error}"));
            return;
        }
        sequence = sequence.wrapping_add(1);
        successful_writes = successful_writes.saturating_add(1);
        if fps_window.elapsed() >= Duration::from_secs(1) {
            shared.set_sent_fps(successful_writes.min(u16::from(u8::MAX)) as u8);
            successful_writes = 0;
            fps_window = Instant::now();
        }
        next_send += SEND_INTERVAL;
        let now = Instant::now();
        if next_send > now {
            thread::sleep(next_send - now);
        } else {
            next_send = now;
        }
    }

    let stop_result = if stereo {
        serial::write_stereo_bars(&mut *port, 0, 0)
    } else {
        serial::write_bars(&mut *port, sequence, 0)
    };
    let _ = stop_result;
}

fn publish_loop(app: AppHandle, shared: Arc<SharedRuntime>) {
    loop {
        let snapshot = shared.snapshot();
        if app.emit("reactive-state", snapshot).is_err() {
            shared.cancel.store(true, Ordering::Release);
            return;
        }
        if shared.cancel.load(Ordering::Acquire) {
            return;
        }
        thread::sleep(STATE_INTERVAL);
    }
}

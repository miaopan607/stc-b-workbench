use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AudioSource {
    SystemLoopback,
    Microphone,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DetectionMode {
    LowFrequency,
    BeatEnhanced,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum RuntimePhase {
    Idle,
    Starting,
    Running,
    Error,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReactiveConfig {
    pub port_name: String,
    pub audio_source: AudioSource,
    pub detection_mode: DetectionMode,
    pub sensitivity: u8,
    pub punch: u8,
    pub ambient_limit: u8,
}

impl ReactiveConfig {
    pub fn clamped(&self) -> Self {
        Self {
            port_name: self.port_name.clone(),
            audio_source: self.audio_source,
            detection_mode: self.detection_mode,
            sensitivity: self.sensitivity.clamp(50, 200),
            punch: self.punch.min(200),
            ambient_limit: self.ambient_limit.min(40),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeSnapshot {
    pub phase: RuntimePhase,
    pub source: Option<AudioSource>,
    pub level: f32,
    pub bar_count: u8,
    pub sent_fps: u8,
    pub message: String,
}

impl RuntimeSnapshot {
    pub fn idle() -> Self {
        Self {
            phase: RuntimePhase::Idle,
            source: None,
            level: 0.0,
            bar_count: 0,
            sent_fps: 0,
            message: "音乐律动未启动".to_owned(),
        }
    }

    pub fn starting(source: AudioSource) -> Self {
        Self {
            phase: RuntimePhase::Starting,
            source: Some(source),
            level: 0.0,
            bar_count: 0,
            sent_fps: 0,
            message: "正在连接设备与音频来源".to_owned(),
        }
    }

    pub fn running(source: AudioSource) -> Self {
        Self {
            phase: RuntimePhase::Running,
            source: Some(source),
            level: 0.0,
            bar_count: 0,
            sent_fps: 0,
            message: "运行中".to_owned(),
        }
    }

    pub fn error(source: Option<AudioSource>, message: impl Into<String>) -> Self {
        Self {
            phase: RuntimePhase::Error,
            source,
            level: 0.0,
            bar_count: 0,
            sent_fps: 0,
            message: message.into(),
        }
    }

    pub fn set_signal(&mut self, level: f32, bar_count: u8) {
        self.level = level.clamp(0.0, 1.0);
        self.bar_count = bar_count.min(8);
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerialPortDescriptor {
    pub name: String,
    pub friendly_name: String,
}

use std::f32::consts::PI;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use crate::models::{AudioSource, DetectionMode, ReactiveConfig};

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct StereoLevel {
    pub left: f32,
    pub right: f32,
}

pub fn level_to_bars(level: StereoLevel) -> u8 {
    let level = level.left.max(level.right).clamp(0.0, 1.0);
    if level == 0.0 {
        0
    } else {
        (level * 8.0).ceil().clamp(1.0, 8.0) as u8
    }
}

pub struct Analyzer {
    inner: AnalyzerKind,
}

enum AnalyzerKind {
    Low(LowFrequencyAnalyzer),
    Beat(BeatEnhancedAnalyzer),
}

impl Analyzer {
    pub fn new(mode: DetectionMode, sample_rate: u32) -> Self {
        let inner = match mode {
            DetectionMode::LowFrequency => {
                AnalyzerKind::Low(LowFrequencyAnalyzer::new(sample_rate))
            }
            DetectionMode::BeatEnhanced => {
                AnalyzerKind::Beat(BeatEnhancedAnalyzer::new(sample_rate))
            }
        };
        Self { inner }
    }

    pub fn update_settings(&mut self, config: &ReactiveConfig) {
        match &mut self.inner {
            AnalyzerKind::Low(analyzer) => analyzer.update_settings(config),
            AnalyzerKind::Beat(analyzer) => analyzer.update_settings(config),
        }
    }

    pub fn reset(&mut self) {
        match &mut self.inner {
            AnalyzerKind::Low(analyzer) => analyzer.reset(),
            AnalyzerKind::Beat(analyzer) => analyzer.reset(),
        }
    }

    pub fn analyze_interleaved(&mut self, samples: &[f32]) -> StereoLevel {
        match &mut self.inner {
            AnalyzerKind::Low(analyzer) => analyzer.analyze_interleaved(samples),
            AnalyzerKind::Beat(analyzer) => analyzer.analyze_interleaved(samples),
        }
    }
}

pub struct LowFrequencyAnalyzer {
    left_band: BiquadBandPass,
    right_band: BiquadBandPass,
    mono_band: BiquadBandPass,
    left_dynamics: RhythmEnvelope,
    right_dynamics: RhythmEnvelope,
    mono_dynamics: RhythmEnvelope,
    left_ambient: AmbientEnvelope,
    right_ambient: AmbientEnvelope,
    mono_ambient: AmbientEnvelope,
    sensitivity: f32,
    punch: f32,
    ambient_limit: f32,
}

impl LowFrequencyAnalyzer {
    pub fn new(sample_rate: u32) -> Self {
        Self {
            left_band: BiquadBandPass::new(sample_rate, 55.0, 260.0),
            right_band: BiquadBandPass::new(sample_rate, 55.0, 260.0),
            mono_band: BiquadBandPass::new(sample_rate, 55.0, 260.0),
            left_dynamics: RhythmEnvelope::default(),
            right_dynamics: RhythmEnvelope::default(),
            mono_dynamics: RhythmEnvelope::default(),
            left_ambient: AmbientEnvelope::default(),
            right_ambient: AmbientEnvelope::default(),
            mono_ambient: AmbientEnvelope::default(),
            sensitivity: 1.15,
            punch: 1.25,
            ambient_limit: 0.1,
        }
    }

    pub fn update_settings(&mut self, config: &ReactiveConfig) {
        let config = config.clamped();
        self.sensitivity = config.sensitivity as f32 / 100.0;
        self.punch = config.punch as f32 / 100.0;
        self.ambient_limit = config.ambient_limit as f32 / 100.0;
    }

    pub fn analyze_mono(&mut self, samples: &[f32]) -> StereoLevel {
        if samples.is_empty() {
            return StereoLevel::default();
        }
        let mut low_energy = 0.0_f64;
        let mut full_energy = 0.0_f64;
        for &sample in samples {
            let sample = clean_sample(sample);
            let filtered = self.mono_band.process(sample);
            low_energy += f64::from(filtered * filtered);
            full_energy += f64::from(sample * sample);
        }
        let count = samples.len() as f64;
        let low_rms = (low_energy / count).sqrt() as f32;
        let full_rms = (full_energy / count).sqrt() as f32;
        let rhythm = self.mono_dynamics.process(low_rms, self.sensitivity, self.punch)
            * bass_weight(low_rms, full_rms);
        let ambient = self.mono_ambient.process(full_rms, self.ambient_limit);
        let level = rhythm.max(ambient).clamp(0.0, 1.0);
        StereoLevel { left: level, right: level }
    }

    pub fn analyze_interleaved(&mut self, samples: &[f32]) -> StereoLevel {
        if samples.len() < 2 {
            return StereoLevel::default();
        }
        let frames = samples.len() / 2;
        let mut left_low_energy = 0.0_f64;
        let mut right_low_energy = 0.0_f64;
        let mut left_full_energy = 0.0_f64;
        let mut right_full_energy = 0.0_f64;
        for frame in samples[..frames * 2].chunks_exact(2) {
            let left = clean_sample(frame[0]);
            let right = clean_sample(frame[1]);
            let filtered_left = self.left_band.process(left);
            let filtered_right = self.right_band.process(right);
            left_low_energy += f64::from(filtered_left * filtered_left);
            right_low_energy += f64::from(filtered_right * filtered_right);
            left_full_energy += f64::from(left * left);
            right_full_energy += f64::from(right * right);
        }
        let frames = frames as f64;
        let left_rms = (left_low_energy / frames).sqrt() as f32;
        let right_rms = (right_low_energy / frames).sqrt() as f32;
        let left_full_rms = (left_full_energy / frames).sqrt() as f32;
        let right_full_rms = (right_full_energy / frames).sqrt() as f32;
        StereoLevel {
            left: (self.left_dynamics.process(left_rms, self.sensitivity, self.punch)
                * bass_weight(left_rms, left_full_rms))
            .max(self.left_ambient.process(left_full_rms, self.ambient_limit))
            .clamp(0.0, 1.0),
            right: (self.right_dynamics.process(right_rms, self.sensitivity, self.punch)
                * bass_weight(right_rms, right_full_rms))
            .max(self.right_ambient.process(right_full_rms, self.ambient_limit))
            .clamp(0.0, 1.0),
        }
    }

    pub fn reset(&mut self) {
        self.left_band.reset();
        self.right_band.reset();
        self.mono_band.reset();
        self.left_dynamics.reset();
        self.right_dynamics.reset();
        self.mono_dynamics.reset();
        self.left_ambient.reset();
        self.right_ambient.reset();
        self.mono_ambient.reset();
    }
}

pub struct BeatEnhancedAnalyzer {
    mono_low_band: BiquadBandPass,
    mono_mid_band: BiquadBandPass,
    mono_high_band: BiquadBandPass,
    left_low_band: BiquadBandPass,
    left_mid_band: BiquadBandPass,
    left_high_band: BiquadBandPass,
    right_low_band: BiquadBandPass,
    right_mid_band: BiquadBandPass,
    right_high_band: BiquadBandPass,
    mono_low_dynamics: RhythmEnvelope,
    mono_mid_dynamics: RhythmEnvelope,
    mono_high_dynamics: RhythmEnvelope,
    left_low_dynamics: RhythmEnvelope,
    left_mid_dynamics: RhythmEnvelope,
    left_high_dynamics: RhythmEnvelope,
    right_low_dynamics: RhythmEnvelope,
    right_mid_dynamics: RhythmEnvelope,
    right_high_dynamics: RhythmEnvelope,
    mono_ambient: AmbientEnvelope,
    left_ambient: AmbientEnvelope,
    right_ambient: AmbientEnvelope,
    sensitivity: f32,
    punch: f32,
    ambient_limit: f32,
}

impl BeatEnhancedAnalyzer {
    pub fn new(sample_rate: u32) -> Self {
        Self {
            mono_low_band: BiquadBandPass::new(sample_rate, 70.0, 180.0),
            mono_mid_band: BiquadBandPass::new(sample_rate, 180.0, 900.0),
            mono_high_band: BiquadBandPass::new(sample_rate, 900.0, 3200.0),
            left_low_band: BiquadBandPass::new(sample_rate, 70.0, 180.0),
            left_mid_band: BiquadBandPass::new(sample_rate, 180.0, 900.0),
            left_high_band: BiquadBandPass::new(sample_rate, 900.0, 3200.0),
            right_low_band: BiquadBandPass::new(sample_rate, 70.0, 180.0),
            right_mid_band: BiquadBandPass::new(sample_rate, 180.0, 900.0),
            right_high_band: BiquadBandPass::new(sample_rate, 900.0, 3200.0),
            mono_low_dynamics: RhythmEnvelope::default(),
            mono_mid_dynamics: RhythmEnvelope::default(),
            mono_high_dynamics: RhythmEnvelope::default(),
            left_low_dynamics: RhythmEnvelope::default(),
            left_mid_dynamics: RhythmEnvelope::default(),
            left_high_dynamics: RhythmEnvelope::default(),
            right_low_dynamics: RhythmEnvelope::default(),
            right_mid_dynamics: RhythmEnvelope::default(),
            right_high_dynamics: RhythmEnvelope::default(),
            mono_ambient: AmbientEnvelope::default(),
            left_ambient: AmbientEnvelope::default(),
            right_ambient: AmbientEnvelope::default(),
            sensitivity: 1.15,
            punch: 1.25,
            ambient_limit: 0.1,
        }
    }

    pub fn update_settings(&mut self, config: &ReactiveConfig) {
        let config = config.clamped();
        self.sensitivity = config.sensitivity as f32 / 100.0;
        self.punch = config.punch as f32 / 100.0;
        self.ambient_limit = config.ambient_limit as f32 / 100.0;
    }

    pub fn analyze_mono(&mut self, samples: &[f32]) -> StereoLevel {
        if samples.is_empty() {
            return StereoLevel::default();
        }
        let mut low_energy = 0.0_f64;
        let mut mid_energy = 0.0_f64;
        let mut high_energy = 0.0_f64;
        let mut full_energy = 0.0_f64;
        for &raw in samples {
            let sample = clean_sample(raw);
            let low = self.mono_low_band.process(sample);
            let mid = self.mono_mid_band.process(sample);
            let high = self.mono_high_band.process(sample);
            low_energy += f64::from(low * low);
            mid_energy += f64::from(mid * mid);
            high_energy += f64::from(high * high);
            full_energy += f64::from(sample * sample);
        }
        let count = samples.len() as f64;
        let level = self.combine(
            (low_energy / count).sqrt() as f32,
            (mid_energy / count).sqrt() as f32,
            (high_energy / count).sqrt() as f32,
            (full_energy / count).sqrt() as f32,
            Channel::Mono,
        );
        StereoLevel { left: level, right: level }
    }

    pub fn analyze_interleaved(&mut self, samples: &[f32]) -> StereoLevel {
        if samples.len() < 2 {
            return StereoLevel::default();
        }
        let frames = samples.len() / 2;
        let mut left_low = 0.0_f64;
        let mut left_mid = 0.0_f64;
        let mut left_high = 0.0_f64;
        let mut left_full = 0.0_f64;
        let mut right_low = 0.0_f64;
        let mut right_mid = 0.0_f64;
        let mut right_high = 0.0_f64;
        let mut right_full = 0.0_f64;
        for frame in samples[..frames * 2].chunks_exact(2) {
            let left = clean_sample(frame[0]);
            let right = clean_sample(frame[1]);
            let low = self.left_low_band.process(left);
            let mid = self.left_mid_band.process(left);
            let high = self.left_high_band.process(left);
            left_low += f64::from(low * low);
            left_mid += f64::from(mid * mid);
            left_high += f64::from(high * high);
            left_full += f64::from(left * left);
            let low = self.right_low_band.process(right);
            let mid = self.right_mid_band.process(right);
            let high = self.right_high_band.process(right);
            right_low += f64::from(low * low);
            right_mid += f64::from(mid * mid);
            right_high += f64::from(high * high);
            right_full += f64::from(right * right);
        }
        let frames = frames as f64;
        StereoLevel {
            left: self.combine(
                (left_low / frames).sqrt() as f32,
                (left_mid / frames).sqrt() as f32,
                (left_high / frames).sqrt() as f32,
                (left_full / frames).sqrt() as f32,
                Channel::Left,
            ),
            right: self.combine(
                (right_low / frames).sqrt() as f32,
                (right_mid / frames).sqrt() as f32,
                (right_high / frames).sqrt() as f32,
                (right_full / frames).sqrt() as f32,
                Channel::Right,
            ),
        }
    }

    pub fn reset(&mut self) {
        self.mono_low_band.reset();
        self.mono_mid_band.reset();
        self.mono_high_band.reset();
        self.left_low_band.reset();
        self.left_mid_band.reset();
        self.left_high_band.reset();
        self.right_low_band.reset();
        self.right_mid_band.reset();
        self.right_high_band.reset();
        self.mono_low_dynamics.reset();
        self.mono_mid_dynamics.reset();
        self.mono_high_dynamics.reset();
        self.left_low_dynamics.reset();
        self.left_mid_dynamics.reset();
        self.left_high_dynamics.reset();
        self.right_low_dynamics.reset();
        self.right_mid_dynamics.reset();
        self.right_high_dynamics.reset();
        self.mono_ambient.reset();
        self.left_ambient.reset();
        self.right_ambient.reset();
    }

    fn combine(&mut self, low: f32, mid: f32, high: f32, full: f32, channel: Channel) -> f32 {
        let (low_dynamics, mid_dynamics, high_dynamics, ambient) = match channel {
            Channel::Mono => (
                &mut self.mono_low_dynamics,
                &mut self.mono_mid_dynamics,
                &mut self.mono_high_dynamics,
                &mut self.mono_ambient,
            ),
            Channel::Left => (
                &mut self.left_low_dynamics,
                &mut self.left_mid_dynamics,
                &mut self.left_high_dynamics,
                &mut self.left_ambient,
            ),
            Channel::Right => (
                &mut self.right_low_dynamics,
                &mut self.right_mid_dynamics,
                &mut self.right_high_dynamics,
                &mut self.right_ambient,
            ),
        };
        let beat = (low_dynamics.process(low * 1.1, self.sensitivity, self.punch) * 0.95)
            .max(mid_dynamics.process(mid * 1.35, self.sensitivity, self.punch))
            .max(high_dynamics.process(high * 1.65, self.sensitivity, self.punch) * 1.12);
        beat.max(ambient.process(full, self.ambient_limit)).clamp(0.0, 1.0)
    }
}

enum Channel {
    Mono,
    Left,
    Right,
}

fn clean_sample(sample: f32) -> f32 {
    if sample.is_finite() { sample } else { 0.0 }
}

fn bass_weight(low_rms: f32, full_rms: f32) -> f32 {
    if full_rms <= 0.00001 {
        return 0.0;
    }
    let ratio = (low_rms / full_rms).clamp(0.0, 1.0);
    ((ratio - 0.18) / 0.22).clamp(0.0, 1.0)
}

#[derive(Clone, Copy)]
struct RhythmEnvelope {
    floor: f32,
    peak: f32,
    body: f32,
    fall: f32,
}

impl Default for RhythmEnvelope {
    fn default() -> Self {
        Self {
            floor: 0.0006,
            peak: 0.018,
            body: 0.0,
            fall: 0.0,
        }
    }
}

impl RhythmEnvelope {
    fn process(&mut self, rms: f32, sensitivity: f32, punch: f32) -> f32 {
        let rms = clean_sample(rms).max(0.0);
        self.update_range(rms);
        let range = 0.018_f32.max((self.peak - self.floor) * 2.25);
        let normalized = (((rms - self.floor) / range) * sensitivity).clamp(0.0, 1.0);
        let attack = if normalized > self.body { 0.42 } else { 0.16 };
        let previous = self.body;
        self.body += (normalized - self.body) * attack;
        let body = self.body.powf(1.35) * 0.72;
        let onset = (normalized - previous - 0.07).max(0.0);
        let pulse = (onset * 2.4 * punch).clamp(0.0, 1.0);
        let target = (body + pulse * 0.55).clamp(0.0, 1.0);
        self.fall = (self.fall * 0.82).max(target);
        if rms < 0.0009 && self.body < 0.02 {
            self.fall *= 0.35;
        }
        if self.fall < 0.035 { 0.0 } else { self.fall.clamp(0.0, 1.0) }
    }

    fn update_range(&mut self, rms: f32) {
        self.floor += (rms - self.floor) * if rms < self.floor { 0.08 } else { 0.004 };
        self.floor = self.floor.clamp(0.0001, 0.08);
        if rms > self.peak {
            self.peak += (rms - self.peak) * 0.72;
        } else {
            self.peak += (rms - self.peak) * 0.006;
        }
        self.peak = self.peak.max(self.floor + 0.018);
    }

    fn reset(&mut self) {
        *self = Self::default();
    }
}

#[derive(Clone, Copy)]
struct AmbientEnvelope {
    floor: f32,
    peak: f32,
    envelope: f32,
}

impl Default for AmbientEnvelope {
    fn default() -> Self {
        Self {
            floor: 0.0015,
            peak: 0.08,
            envelope: 0.0,
        }
    }
}

impl AmbientEnvelope {
    fn process(&mut self, rms: f32, limit: f32) -> f32 {
        if limit <= 0.0 {
            return 0.0;
        }
        let rms = clean_sample(rms).max(0.0);
        self.floor += (rms - self.floor) * if rms < self.floor { 0.06 } else { 0.002 };
        self.floor = self.floor.clamp(0.0004, 0.12);
        if rms > self.peak {
            self.peak += (rms - self.peak) * 0.35;
        } else {
            self.peak += (rms - self.peak) * 0.004;
        }
        self.peak = self.peak.max(self.floor + 0.04);
        let range = 0.04_f32.max((self.peak - self.floor) * 2.0);
        let normalized = ((rms - self.floor) / range).clamp(0.0, 1.0);
        let target = (normalized * limit).clamp(0.0, limit.min(0.4));
        let rate = if target > self.envelope { 0.28 } else { 0.08 };
        self.envelope += (target - self.envelope) * rate;
        if self.envelope < 0.006 { 0.0 } else { self.envelope }
    }

    fn reset(&mut self) {
        *self = Self::default();
    }
}

struct BiquadBandPass {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    x1: f32,
    x2: f32,
    y1: f32,
    y2: f32,
}

impl BiquadBandPass {
    fn new(sample_rate: u32, low_cut: f32, high_cut: f32) -> Self {
        let center = (low_cut * high_cut).sqrt();
        let q = center / (1.0_f32.max(high_cut - low_cut));
        let omega = 2.0 * PI * center / sample_rate as f32;
        let alpha = omega.sin() / (2.0 * q);
        let a0 = 1.0 + alpha;
        Self {
            b0: alpha / a0,
            b1: 0.0,
            b2: -alpha / a0,
            a1: -2.0 * omega.cos() / a0,
            a2: (1.0 - alpha) / a0,
            x1: 0.0,
            x2: 0.0,
            y1: 0.0,
            y2: 0.0,
        }
    }

    fn process(&mut self, input: f32) -> f32 {
        let input = clean_sample(input);
        let output = self.b0 * input + self.b1 * self.x1 + self.b2 * self.x2
            - self.a1 * self.y1
            - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = input;
        self.y2 = self.y1;
        self.y1 = clean_sample(output);
        self.y1
    }

    fn reset(&mut self) {
        self.x1 = 0.0;
        self.x2 = 0.0;
        self.y1 = 0.0;
        self.y2 = 0.0;
    }
}

struct ComGuard;

impl Drop for ComGuard {
    fn drop(&mut self) {
        wasapi::deinitialize();
    }
}

pub fn run_capture(
    config: &ReactiveConfig,
    cancel: &Arc<AtomicBool>,
    mut on_signal: impl FnMut(StereoLevel, u8),
) -> Result<(), String> {
    wasapi::initialize_mta()
        .ok()
        .map_err(|error| error.to_string())?;
    let _com_guard = ComGuard;

    let enumerator = wasapi::DeviceEnumerator::new().map_err(|error| error.to_string())?;
    let (device_direction, capture_direction) = match config.audio_source {
        AudioSource::SystemLoopback => (wasapi::Direction::Render, wasapi::Direction::Capture),
        AudioSource::Microphone => (wasapi::Direction::Capture, wasapi::Direction::Capture),
    };
    let device = enumerator
        .get_default_device(&device_direction)
        .map_err(|error| error.to_string())?;
    let mut audio_client = device
        .get_iaudioclient()
        .map_err(|error| error.to_string())?;
    let desired_format = wasapi::WaveFormat::new(
        32,
        32,
        &wasapi::SampleType::Float,
        48_000,
        2,
        None,
    );
    let (_, min_period) = audio_client
        .get_device_period()
        .map_err(|error| error.to_string())?;
    let stream_mode = wasapi::StreamMode::EventsShared {
        autoconvert: true,
        buffer_duration_hns: min_period.max(200_000),
    };
    audio_client
        .initialize_client(&desired_format, &capture_direction, &stream_mode)
        .map_err(|error| error.to_string())?;
    let event_handle = audio_client
        .set_get_eventhandle()
        .map_err(|error| error.to_string())?;
    let block_align = desired_format.get_blockalign() as usize;
    let buffer_frames = audio_client
        .get_buffer_size()
        .map_err(|error| error.to_string())?
        .max(1024) as usize;
    let capture_client = audio_client
        .get_audiocaptureclient()
        .map_err(|error| error.to_string())?;
    let mut raw_buffer = vec![0_u8; buffer_frames * block_align];
    let mut samples = vec![0.0_f32; buffer_frames * 2];
    let mut analyzer = Analyzer::new(config.detection_mode, 48_000);
    analyzer.update_settings(config);
    audio_client
        .start_stream()
        .map_err(|error| error.to_string())?;

    let result = (|| {
        while !cancel.load(Ordering::Acquire) {
            let _ = event_handle.wait_for_event(100);
            loop {
                let packet_frames = capture_client
                    .get_next_packet_size()
                    .map_err(|error| error.to_string())?
                    .unwrap_or(0);
                if packet_frames == 0 {
                    break;
                }
                let needed_bytes = packet_frames as usize * block_align;
                if needed_bytes > raw_buffer.len() {
                    return Err(format!(
                        "音频数据包过大：{} 帧，缓冲区仅支持 {} 帧",
                        packet_frames,
                        raw_buffer.len() / block_align
                    ));
                }
                let (frames, info) = capture_client
                    .read_from_device(&mut raw_buffer)
                    .map_err(|error| error.to_string())?;
                if info.flags.silent {
                    on_signal(StereoLevel::default(), 0);
                    continue;
                }
                let sample_count = frames as usize * 2;
                if sample_count > samples.len() {
                    return Err("音频采样缓冲区不足".to_owned());
                }
                for (index, chunk) in raw_buffer[..frames as usize * block_align]
                    .chunks_exact(4)
                    .take(sample_count)
                    .enumerate()
                {
                    samples[index] = f32::from_ne_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
                }
                let level = analyzer.analyze_interleaved(&samples[..sample_count]);
                on_signal(level, level_to_bars(level));
            }
        }
        Ok(())
    })();
    let stop_result = audio_client.stop_stream().map_err(|error| error.to_string());
    match (result, stop_result) {
        (Err(error), _) => Err(error),
        (Ok(()), Err(error)) if !cancel.load(Ordering::Acquire) => Err(error),
        (Ok(()), _) => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{AudioSource, DetectionMode};

    fn config(mode: DetectionMode) -> ReactiveConfig {
        ReactiveConfig {
            port_name: "COM1".to_owned(),
            audio_source: AudioSource::Microphone,
            detection_mode: mode,
            sensitivity: 115,
            punch: 125,
            ambient_limit: 10,
        }
    }

    fn tone(frequency: f32, samples: usize) -> Vec<f32> {
        (0..samples)
            .flat_map(|index| {
                let sample = (2.0 * PI * frequency * index as f32 / 48_000.0).sin() * 0.8;
                [sample, sample]
            })
            .collect()
    }

    #[test]
    fn low_frequency_prefers_120_hz_over_1200_hz() {
        let mut analyzer = LowFrequencyAnalyzer::new(48_000);
        analyzer.update_settings(&config(DetectionMode::LowFrequency));
        let low = analyzer.analyze_interleaved(&tone(120.0, 48_000));
        analyzer.reset();
        let high = analyzer.analyze_interleaved(&tone(1200.0, 48_000));
        assert!(low.left > high.left, "low={low:?}, high={high:?}");
    }

    #[test]
    fn beat_enhanced_reacts_more_to_short_high_frequency_pulse() {
        let pulse = tone(1200.0, 2_400);
        let mut low = LowFrequencyAnalyzer::new(48_000);
        low.update_settings(&config(DetectionMode::LowFrequency));
        let low_level = low.analyze_interleaved(&pulse).left;
        let mut beat = BeatEnhancedAnalyzer::new(48_000);
        beat.update_settings(&config(DetectionMode::BeatEnhanced));
        let beat_level = beat.analyze_interleaved(&pulse).left;
        assert!(beat_level > low_level, "low={low_level}, beat={beat_level}");
    }

    #[test]
    fn silence_decays_to_zero_bars() {
        let mut analyzer = Analyzer::new(DetectionMode::BeatEnhanced, 48_000);
        analyzer.update_settings(&config(DetectionMode::BeatEnhanced));
        let pulse = tone(1200.0, 2_400);
        let _ = analyzer.analyze_interleaved(&pulse);
        let silence = vec![0.0_f32; 48_000 * 2];
        let mut bars = 8;
        for chunk in silence.chunks(960 * 2) {
            bars = level_to_bars(analyzer.analyze_interleaved(chunk));
        }
        assert_eq!(bars, 0);
    }

    #[test]
    fn bars_use_louder_channel_and_exact_zero() {
        assert_eq!(level_to_bars(StereoLevel::default()), 0);
        assert_eq!(level_to_bars(StereoLevel { left: 0.01, right: 0.0 }), 1);
        assert_eq!(level_to_bars(StereoLevel { left: 0.25, right: 0.5 }), 4);
        assert_eq!(level_to_bars(StereoLevel { left: 1.0, right: 0.0 }), 8);
    }
}

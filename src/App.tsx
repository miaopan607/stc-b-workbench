import { useEffect, useState } from "react";
import "@material/web/button/filled-button.js";
import "@material/web/button/outlined-button.js";
import "@material/web/chips/filter-chip.js";
import "@material/web/progress/linear-progress.js";
import "@material/web/select/outlined-select.js";
import "@material/web/select/select-option.js";
import "@material/web/slider/slider.js";
import {
  getReactiveState,
  listSerialPorts,
  startReactive,
  stopReactive,
  subscribeReactiveState,
  type AudioSource,
  type DetectionMode,
  type ReactiveConfig,
  type RuntimePhase,
  type RuntimeSnapshot,
  type SerialPortDescriptor,
} from "./lib/tauri";
import "./styles.css";

const DEFAULT_SNAPSHOT: RuntimeSnapshot = {
  phase: "idle",
  source: null,
  level: 0,
  barCount: 0,
  sentFps: 0,
  message: "音乐律动未启动",
};

const SOURCE_LABELS: Record<AudioSource, string> = {
  systemLoopback: "系统音频",
  microphone: "麦克风",
};

function App() {
  const [snapshot, setSnapshot] = useState(DEFAULT_SNAPSHOT);
  const [ports, setPorts] = useState<SerialPortDescriptor[]>([]);
  const [portName, setPortName] = useState("");
  const [audioSource, setAudioSource] = useState<AudioSource>("systemLoopback");
  const [detectionMode, setDetectionMode] = useState<DetectionMode>("lowFrequency");
  const [sensitivity, setSensitivity] = useState(115);
  const [punch, setPunch] = useState(125);
  const [ambientLimit, setAmbientLimit] = useState(10);
  const [isDark, setIsDark] = useState(false);
  const [notice, setNotice] = useState("");

  const isRunning = snapshot.phase === "running" || snapshot.phase === "starting";
  const isBusy = snapshot.phase === "starting";
  const isError = snapshot.phase === "error";

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let active = true;

    void getReactiveState()
      .then((state) => {
        if (active) setSnapshot(state);
      })
      .catch(() => undefined)
      .finally(() => {
        void subscribeReactiveState((state) => {
          if (active) setSnapshot(state);
        }).then((cleanup) => {
          if (active) unlisten = cleanup;
          else cleanup();
        });
      });

    void refreshPorts();
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  async function refreshPorts() {
    try {
      const nextPorts = await listSerialPorts();
      setPorts(nextPorts);
      setPortName((current) =>
        nextPorts.some((port) => port.name === current) ? current : (nextPorts[0]?.name ?? ""),
      );
      setNotice(nextPorts.length ? "" : "未发现可用串口");
    } catch (error) {
      setNotice(formatError(error, "无法读取串口列表"));
    }
  }

  async function toggleReactive() {
    setNotice("");
    try {
      if (isRunning) {
        await stopReactive();
        setSnapshot(DEFAULT_SNAPSHOT);
      } else {
        const config: ReactiveConfig = {
          portName,
          audioSource,
          detectionMode,
          sensitivity,
          punch,
          ambientLimit,
        };
        await startReactive(config);
      }
    } catch (error) {
      setNotice(formatError(error, "无法启动音乐律动"));
    }
  }

  return (
    <div className={isDark ? "app dark" : "app"}>
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">STC</span>
          <div>
            <p className="eyebrow">STC-B / USB AUDIO LINK</p>
            <h1>音乐律动</h1>
          </div>
        </div>
        <div className="topbar-actions">
          <span className={`status-badge ${snapshot.phase}`} aria-live="polite">
            <span className="status-dot" aria-hidden="true" />
            {phaseLabel(snapshot.phase)}
          </span>
          <button
            className="theme-toggle"
            type="button"
            aria-label={isDark ? "切换浅色主题" : "切换深色主题"}
            onClick={() => setIsDark((value) => !value)}
          >
            {isDark ? "☼" : "◐"}
          </button>
        </div>
      </header>

      <main className="content">
        <section className="hero-grid" aria-labelledby="preview-title">
          <div className="preview-copy">
            <p className="section-kicker">LIVE SIGNAL / 8-SEGMENT DISPLAY</p>
            <h2 id="preview-title">让节拍<br /><em>看得见</em></h2>
            <p className="hero-description">实时捕捉系统声音或麦克风输入，将音量转换成板载数码管的连续律动。</p>
            <div className="signal-readout" aria-live="polite">
              <strong>{snapshot.barCount}</strong>
              <span>/ 8 格<br />实时音量</span>
            </div>
          </div>
          <div className="display-stage">
            <div className="display-glow" aria-hidden="true" />
            <div className="segment-display" role="img" aria-label={`当前点亮 ${snapshot.barCount} 格，共 8 格`}>
              {Array.from({ length: 8 }, (_, index) => (
                <SevenSegment key={index} active={index < snapshot.barCount} />
              ))}
            </div>
            <div className="stage-caption">
              <span className="live-line"><i /> {snapshot.source ? SOURCE_LABELS[snapshot.source] : "等待输入"}</span>
              <span className="fps-line">{snapshot.sentFps || "—"} FPS / USB</span>
            </div>
          </div>
        </section>

        <section className="control-shell" aria-label="音乐律动设置">
          <div className="control-section connection-section">
            <div className="section-heading">
              <span className="step-number">01</span>
              <div><p className="section-kicker">HARDWARE</p><h3>连接设备</h3></div>
            </div>
            <div className="connection-row">
              <md-outlined-select
                label="USB 虚拟串口"
                value={portName}
                disabled={isRunning}
                onChange={(event) => setPortName((event.target as HTMLSelectElement).value)}
              >
                {ports.map((port) => (
                  <md-select-option key={port.name} value={port.name}>
                    <span slot="headline">{port.name}</span>
                    <span slot="supporting-text">{port.friendlyName}</span>
                  </md-select-option>
                ))}
              </md-outlined-select>
              <md-outlined-button disabled={isRunning} onClick={() => void refreshPorts()}>
                刷新
              </md-outlined-button>
            </div>
          </div>

          <div className="control-section audio-section">
            <div className="section-heading">
              <span className="step-number">02</span>
              <div><p className="section-kicker">INPUT & DETECTION</p><h3>音频来源</h3></div>
            </div>
            <div className="chip-groups">
              <div className="chip-group" role="group" aria-label="音频来源">
                <md-filter-chip selected={audioSource === "systemLoopback"} disabled={isRunning} onClick={() => setAudioSource("systemLoopback")}>
                  系统音频
                </md-filter-chip>
                <md-filter-chip selected={audioSource === "microphone"} disabled={isRunning} onClick={() => setAudioSource("microphone")}>
                  麦克风
                </md-filter-chip>
              </div>
              <div className="chip-group" role="group" aria-label="检测模式">
                <md-filter-chip selected={detectionMode === "lowFrequency"} disabled={isRunning} onClick={() => setDetectionMode("lowFrequency")}>
                  低频律动
                </md-filter-chip>
                <md-filter-chip selected={detectionMode === "beatEnhanced"} disabled={isRunning} onClick={() => setDetectionMode("beatEnhanced")}>
                  节拍增强
                </md-filter-chip>
              </div>
            </div>
          </div>

          <div className="control-section parameters-section">
            <div className="section-heading">
              <span className="step-number">03</span>
              <div><p className="section-kicker">RESPONSE</p><h3>律动参数</h3></div>
            </div>
            <div className="sliders">
              <ParameterSlider label="灵敏度" value={sensitivity} min={50} max={200} unit="%" disabled={isRunning} onValue={setSensitivity} />
              <ParameterSlider label="鼓点冲击" value={punch} min={0} max={200} unit="%" disabled={isRunning} onValue={setPunch} />
              <ParameterSlider label="环境保留上限" value={ambientLimit} min={0} max={40} unit="%" disabled={isRunning} onValue={setAmbientLimit} />
            </div>
          </div>
        </section>

        <div className="bottom-bar">
          <div className="runtime-meta">
            <md-linear-progress value={snapshot.level} max={1} aria-label="实时音量" />
            <span>{snapshot.level > 0 ? `${Math.round(snapshot.level * 100)}% 信号强度` : "信号监测待命"}</span>
          </div>
          <div className="action-area">
            <p className={isError || notice ? "error-message" : "runtime-message"} role={isError || notice ? "alert" : undefined} aria-live="polite">
              {notice || snapshot.message}
            </p>
            <md-filled-button disabled={!portName || isBusy} onClick={() => void toggleReactive()}>
              {isRunning ? "停止律动" : "开始律动"}
            </md-filled-button>
          </div>
        </div>
      </main>
    </div>
  );
}

function SevenSegment({ active }: { active: boolean }) {
  return (
    <svg className={active ? "seven-segment active" : "seven-segment"} viewBox="0 0 52 94" aria-hidden="true">
      <path className="segment a" d="M12 4h28l5 5-5 5H12L7 9z" />
      <path className="segment b" d="M43 13l5 5v25l-5 5-5-5V18z" />
      <path className="segment c" d="M43 51l5 5v25l-5 5-5-5V56z" />
      <path className="segment d" d="M12 80h28l5 5-5 5H12l-5-5z" />
      <path className="segment e" d="M9 51l5 5v25l-5 5-5-5V56z" />
      <path className="segment f" d="M9 13l5 5v25l-5 5-5-5V18z" />
      <path className="segment g" d="M12 42h28l5 5-5 5H12l-5-5z" />
    </svg>
  );
}

function ParameterSlider({
  label,
  value,
  min,
  max,
  unit,
  disabled,
  onValue,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  unit: string;
  disabled: boolean;
  onValue: (value: number) => void;
}) {
  return (
    <label className="parameter">
      <span className="parameter-label">{label}<strong>{value}{unit}</strong></span>
      <md-slider
        min={min}
        max={max}
        value={value}
        step={1}
        disabled={disabled}
        onInput={(event) => onValue(Number((event.target as HTMLInputElement).value))}
      />
    </label>
  );
}

function phaseLabel(phase: RuntimePhase) {
  return { idle: "待命", starting: "启动中", running: "运行中", error: "连接错误" }[phase];
}

function formatError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
}

export default App;

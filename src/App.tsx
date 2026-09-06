import { useEffect, useRef, useState } from "react";
import "@material/web/button/filled-button.js";
import "@material/web/button/outlined-button.js";
import "@material/web/chips/filter-chip.js";
import "@material/web/progress/linear-progress.js";
import "@material/web/select/outlined-select.js";
import "@material/web/select/select-option.js";
import "@material/web/slider/slider.js";
import {
  getControllerState,
  getReactiveState,
  listSerialPorts,
  startController,
  startReactive,
  stopController,
  stopReactive,
  subscribeControllerKey,
  subscribeControllerState,
  subscribeReactiveState,
  type AudioSource,
  type ControllerKeyEvent,
  type ControllerPhase,
  type ControllerSnapshot,
  type DetectionMode,
  type ReactiveConfig,
  type RuntimePhase,
  type RuntimeSnapshot,
  type SerialPortDescriptor,
} from "./lib/tauri";
import "./styles.css";

type AppMode = "music" | "controller";

interface KeyLogEntry {
  id: number;
  time: string;
  text: string;
  ok: boolean;
}

const DEFAULT_SNAPSHOT: RuntimeSnapshot = {
  phase: "idle",
  source: null,
  level: 0,
  barCount: 0,
  sentFps: 0,
  message: "音乐律动未启动",
};

const DEFAULT_CONTROLLER_SNAPSHOT: ControllerSnapshot = {
  phase: "idle",
  portName: null,
  injectedCount: 0,
  badFrames: 0,
  message: "Codex 控制器未启动",
};

const SOURCE_LABELS: Record<AudioSource, string> = {
  systemLoopback: "系统音频",
  microphone: "麦克风",
};

const KEY_MAPPINGS: { board: string; inject: string; usage: string }[] = [
  { board: "摇杆上 / 下", inject: "↑ / ↓", usage: "弹窗与斜杠菜单移动选项，长按连发" },
  { board: "摇杆中键", inject: "Enter", usage: "确认执行" },
  { board: "摇杆左", inject: "Esc", usage: "关闭弹窗 / 取消" },
  { board: "摇杆右", inject: "/", usage: "打开斜杠菜单" },
  { board: "K1", inject: "Ctrl+C", usage: "中断当前回合" },
  { board: "K2", inject: "Tab", usage: "补全 / 排队提示" },
  { board: "K3", inject: "Enter", usage: "备用确认键" },
];

function App() {
  const [mode, setMode] = useState<AppMode>("music");
  const [snapshot, setSnapshot] = useState(DEFAULT_SNAPSHOT);
  const [controllerSnapshot, setControllerSnapshot] = useState(DEFAULT_CONTROLLER_SNAPSHOT);
  const [ports, setPorts] = useState<SerialPortDescriptor[]>([]);
  const [portName, setPortName] = useState("");
  const [audioSource, setAudioSource] = useState<AudioSource>("systemLoopback");
  const [detectionMode, setDetectionMode] = useState<DetectionMode>("lowFrequency");
  const [sensitivity, setSensitivity] = useState(115);
  const [punch, setPunch] = useState(125);
  const [ambientLimit, setAmbientLimit] = useState(10);
  const [isDark, setIsDark] = useState(false);
  const [notice, setNotice] = useState("");
  const [keyLog, setKeyLog] = useState<KeyLogEntry[]>([]);
  const logIdRef = useRef(0);

  const isRunning = snapshot.phase === "running" || snapshot.phase === "starting";
  const isBusy = snapshot.phase === "starting";
  const isError = snapshot.phase === "error";
  const controllerRunning = controllerSnapshot.phase !== "idle";
  const controllerBusy = controllerSnapshot.phase === "starting";

  const activeSnapshot = mode === "music" ? snapshot : controllerSnapshot;

  useEffect(() => {
    let unlistenState: (() => void) | undefined;
    let unlistenController: (() => void) | undefined;
    let unlistenKey: (() => void) | undefined;
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
          if (active) unlistenState = cleanup;
          else cleanup();
        });
      });

    void getControllerState()
      .then((state) => {
        if (active) setControllerSnapshot(state);
      })
      .catch(() => undefined)
      .finally(() => {
        void subscribeControllerState((state) => {
          if (active) setControllerSnapshot(state);
        }).then((cleanup) => {
          if (active) unlistenController = cleanup;
          else cleanup();
        });
        void subscribeControllerKey((event) => {
          if (active) appendKeyLog(event);
        }).then((cleanup) => {
          if (active) unlistenKey = cleanup;
          else cleanup();
        });
      });

    void refreshPorts();
    return () => {
      active = false;
      unlistenState?.();
      unlistenController?.();
      unlistenKey?.();
    };
  }, []);

  function appendKeyLog(event: ControllerKeyEvent) {
    const id = ++logIdRef.current;
    const time = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    const text = event.injected
      ? `${event.board} ${event.action} → 注入 ${event.injected}`
      : `${event.board} ${event.action}${event.ok ? "" : " → 无注入映射"}`;
    setKeyLog((log) => [{ id, time, text, ok: event.ok }, ...log].slice(0, 40));
  }

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

  async function toggleController() {
    setNotice("");
    try {
      if (controllerRunning) {
        await stopController();
        setControllerSnapshot(DEFAULT_CONTROLLER_SNAPSHOT);
        setKeyLog([]);
      } else {
        await startController(portName);
      }
    } catch (error) {
      setNotice(formatError(error, "无法启动 Codex 控制器"));
    }
  }

  return (
    <div className={isDark ? "app dark" : "app"}>
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">STC</span>
          <div>
            <p className="eyebrow">STC-B / USB AUDIO LINK</p>
            <h1>{mode === "music" ? "音乐律动" : "Codex 控制器"}</h1>
          </div>
        </div>
        <div className="topbar-actions">
          <nav className="mode-tabs" aria-label="功能模式">
            <button
              type="button"
              className={mode === "music" ? "mode-tab active" : "mode-tab"}
              onClick={() => setMode("music")}
            >
              音乐律动
            </button>
            <button
              type="button"
              className={mode === "controller" ? "mode-tab active" : "mode-tab"}
              onClick={() => setMode("controller")}
            >
              Codex 控制器
            </button>
          </nav>
          <span className={`status-badge ${activeSnapshot.phase}`} aria-live="polite">
            <span className="status-dot" aria-hidden="true" />
            {mode === "music" ? phaseLabel(snapshot.phase) : controllerPhaseLabel(controllerSnapshot.phase)}
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

      {mode === "music" ? (
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
      ) : (
        <main className="content">
          <section className="hero-grid" aria-labelledby="controller-title">
            <div className="preview-copy">
              <p className="section-kicker">PHYSICAL CONTROLLER / CODEX CLI</p>
              <h2 id="controller-title">让板子<br /><em>替你按键</em></h2>
              <p className="hero-description">通过 USB 串口接收板载摇杆与按键，注入真实键盘事件操控 codex 终端。</p>
              <p className="focus-warning">注入目标是当前聚焦窗口：使用时请保持 codex 终端在前台；音乐律动与控制器共用串口，二者同时只能运行一个。</p>
              <div className="signal-readout" aria-live="polite">
                <strong>{controllerSnapshot.injectedCount}</strong>
                <span>次注入<br />本次运行</span>
              </div>
            </div>
            <div className="display-stage">
              <div className="display-glow" aria-hidden="true" />
              <div className="key-log-panel" aria-live="polite" aria-label="按键注入日志">
                {keyLog.length === 0 ? (
                  <p className="key-log-empty">等待板子按键…</p>
                ) : (
                  keyLog.map((entry) => (
                    <p key={entry.id} className={entry.ok ? "key-log-line" : "key-log-line fail"}>
                      <span className="key-log-time">{entry.time}</span>
                      {entry.text}
                    </p>
                  ))
                )}
              </div>
              <div className="stage-caption">
                <span className="live-line"><i /> {controllerSnapshot.portName ?? "未连接"}</span>
                <span className="fps-line">坏帧 {controllerSnapshot.badFrames}</span>
              </div>
            </div>
          </section>

          <section className="control-shell" aria-label="Codex 控制器设置">
            <div className="control-section connection-section">
              <div className="section-heading">
                <span className="step-number">01</span>
                <div><p className="section-kicker">HARDWARE</p><h3>连接设备</h3></div>
              </div>
              <div className="connection-row">
                <md-outlined-select
                  label="USB 虚拟串口"
                  value={portName}
                  disabled={controllerRunning}
                  onChange={(event) => setPortName((event.target as HTMLSelectElement).value)}
                >
                  {ports.map((port) => (
                    <md-select-option key={port.name} value={port.name}>
                      <span slot="headline">{port.name}</span>
                      <span slot="supporting-text">{port.friendlyName}</span>
                    </md-select-option>
                  ))}
                </md-outlined-select>
                <md-outlined-button disabled={controllerRunning} onClick={() => void refreshPorts()}>
                  刷新
                </md-outlined-button>
              </div>
              <p className="section-note">断开重插 USB 后控制器会每 3 秒自动重连。</p>
            </div>

            <div className="control-section mapping-section">
              <div className="section-heading">
                <span className="step-number">02</span>
                <div><p className="section-kicker">KEY MAPPING</p><h3>按键映射</h3></div>
              </div>
              <div className="key-grid">
                {KEY_MAPPINGS.map((mapping) => (
                  <div key={mapping.board} className="key-row">
                    <span className="key-board">{mapping.board}</span>
                    <span className="key-inject">{mapping.inject}</span>
                    <span className="key-usage">{mapping.usage}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="control-section log-section">
              <div className="section-heading">
                <span className="step-number">03</span>
                <div><p className="section-kicker">SESSION</p><h3>运行状态</h3></div>
              </div>
              <div className="runtime-stats">
                <div className="stat-block">
                  <strong>{controllerSnapshot.injectedCount}</strong>
                  <span>已注入按键</span>
                </div>
                <div className="stat-block">
                  <strong>{controllerSnapshot.badFrames}</strong>
                  <span>丢弃坏帧</span>
                </div>
              </div>
              <p className="section-note">按键注入到当前聚焦窗口，若 codex 终端以管理员权限运行，本应用需以相同权限启动。</p>
            </div>
          </section>

          <div className="bottom-bar">
            <div className="runtime-meta">
              <md-linear-progress value={keyLog.length} max={40} aria-label="日志容量" />
              <span>{keyLog.length ? `最近 ${keyLog.length} 条按键记录` : "按键日志待命"}</span>
            </div>
            <div className="action-area">
              <p className={notice ? "error-message" : "runtime-message"} role={notice ? "alert" : undefined} aria-live="polite">
                {notice || controllerSnapshot.message}
              </p>
              <md-filled-button disabled={!portName || controllerBusy} onClick={() => void toggleController()}>
                {controllerRunning ? "停止控制器" : "启动控制器"}
              </md-filled-button>
            </div>
          </div>
        </main>
      )}
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

function controllerPhaseLabel(phase: ControllerPhase) {
  return { idle: "待命", starting: "启动中", running: "运行中" }[phase];
}

function formatError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
}

export default App;

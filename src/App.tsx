import { useEffect, useRef, useState } from "react";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
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
  safekeyBegin,
  safekeyEnd,
  startController,
  startReactive,
  stopController,
  stopReactive,
  subscribeControllerKey,
  subscribeControllerState,
  subscribeReactiveState,
  subscribeSafeKeyEvent,
  vaultCreate,
  vaultLock,
  vaultOpenDir,
  vaultRelock,
  vaultState,
  vaultUnlock,
  vaultVerify,
  type AudioSource,
  type ControllerKeyEvent,
  type ControllerPhase,
  type ControllerProfile,
  type ControllerSnapshot,
  type DetectionMode,
  type ReactiveConfig,
  type RuntimePhase,
  type RuntimeSnapshot,
  type SafeKeyEvent,
  type SerialPortDescriptor,
} from "./lib/tauri";
import "./styles.css";

type AppMode = "music" | "controller" | "media" | "vault";
type VaultAuthStatus = "idle" | "waiting" | "ok" | "fail" | "locked";

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
  profile: "codex",
  portName: null,
  injectedCount: 0,
  badFrames: 0,
  message: "控制器未启动",
};

const SOURCE_LABELS: Record<AudioSource, string> = {
  systemLoopback: "系统音频",
  microphone: "麦克风",
};

const KEY_MAPPINGS: { board: string; inject: string; usage: string }[] = [
  { board: "摇杆上 / 下", inject: "↑ / ↓", usage: "弹窗与斜杠菜单移动选项，长按连发" },
  { board: "摇杆中键", inject: "Enter", usage: "确认执行" },
  { board: "摇杆左", inject: "Backspace", usage: "删除字符 / 回退" },
  { board: "摇杆右", inject: "/", usage: "打开斜杠菜单" },
  { board: "K1", inject: "Ctrl+C", usage: "中断当前回合" },
  { board: "K2", inject: "Tab", usage: "补全 / 排队提示" },
  { board: "K3", inject: "Esc", usage: "关闭弹窗 / 取消" },
];

const MEDIA_KEY_MAPPINGS: { board: string; inject: string; usage: string }[] = [
  { board: "K1", inject: "下一曲", usage: "系统媒体键：切换到下一首" },
  { board: "K2", inject: "播放/暂停", usage: "系统媒体键：播放或暂停当前音乐" },
  { board: "K3", inject: "上一曲", usage: "系统媒体键：切换到上一首" },
];

const MODE_LABELS: Record<Exclude<AppMode, "music" | "vault">, { title: string; kicker: string; heading: [string, string]; description: string; warning: string }> = {
  controller: {
    title: "Codex 控制器",
    kicker: "PHYSICAL CONTROLLER / CODEX CLI",
    heading: ["让板子", "替你按键"],
    description: "通过 USB 串口接收板载摇杆与按键，注入真实键盘事件操控 codex 终端。",
    warning: "注入目标是当前聚焦窗口：使用时请保持 codex 终端在前台；音乐律动与控制器共用串口，二者同时只能运行一个。",
  },
  media: {
    title: "媒体控制",
    kicker: "PHYSICAL CONTROLLER / MEDIA KEYS",
    heading: ["让板子", "控制音乐"],
    description: "通过 USB 串口接收板载按键，注入系统媒体键控制正在播放的音乐软件。",
    warning: "媒体键为系统级按键，无需窗口聚焦即可控制音乐播放；音乐律动与控制器共用串口，二者同时只能运行一个。",
  },
};

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
  const [authStatus, setAuthStatus] = useState<VaultAuthStatus>("idle");
  const [authDetail, setAuthDetail] = useState("");
  const [vaultPath, setVaultPath] = useState("");
  const [vaultInfoText, setVaultInfoText] = useState("");
  const [outputRoot, setOutputRoot] = useState("D:\\SafeKey-Unlocked");
  const [autolockSecs, setAutolockSecs] = useState(300);
  const [vaultUnlocked, setVaultUnlocked] = useState(false);
  const [remaining, setRemaining] = useState(0);
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
    let unlistenSafeKey: (() => void) | undefined;
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
          // 板子断开/串口被音乐律动抢占：立即锁定保险箱（未解锁时为无害空操作）
          if (state.phase === "idle") {
            void vaultLock().catch(() => undefined);
          }
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
        void subscribeSafeKeyEvent((event) => {
          if (active) handleSafeKeyEvent(event);
        }).then((cleanup) => {
          if (active) unlistenSafeKey = cleanup;
          else cleanup();
        });
      });

    void refreshPorts();
    return () => {
      active = false;
      unlistenState?.();
      unlistenController?.();
      unlistenKey?.();
      unlistenSafeKey?.();
    };
  }, []);

  // 保险箱 tab 可见时轮询解锁状态与倒计时
  useEffect(() => {
    if (mode !== "vault") return;
    let active = true;
    const poll = () =>
      vaultState()
        .then((state) => {
          if (active) {
            setVaultUnlocked(state.unlocked);
            setRemaining(state.remainingSecs);
          }
        })
        .catch(() => undefined);
    poll();
    const timer = window.setInterval(poll, 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [mode]);

  function handleSafeKeyEvent(event: SafeKeyEvent) {
    if (event.event === 1) {
      setAuthStatus("ok");
      setAuthDetail("认证成功，可选择保险箱并解锁");
    } else if (event.event === 2) {
      setAuthStatus("fail");
      setAuthDetail(`认证失败（第 ${event.payload} 次），还剩 ${3 - event.payload} 次机会`);
    } else if (event.event === 3) {
      setAuthStatus("locked");
      setAuthDetail(`失败次数过多，板子锁定 ${event.payload} 秒`);
    } else if (event.event === 5) {
      setAuthStatus("idle");
      setAuthDetail("");
    } else if (event.event === 4) {
      setAuthDetail(`板上已确认 ${event.payload}/6 位，K3 可回退`);
    }
  }

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
    const profile: ControllerProfile =
      mode === "media" ? "media" : mode === "vault" ? "vault" : "codex";
    try {
      if (controllerRunning) {
        await stopController();
        setControllerSnapshot(DEFAULT_CONTROLLER_SNAPSHOT);
        setKeyLog([]);
        setAuthStatus("idle");
        setAuthDetail("");
      } else {
        await startController(portName, profile);
      }
    } catch (error) {
      setNotice(formatError(error, "无法启动控制器"));
    }
  }

  async function beginAuth() {
    setNotice("");
    try {
      await safekeyBegin();
      setAuthStatus("waiting");
      setAuthDetail("请在板上输入 6 位 PIN：K1 数字+1，K2 确认下一位，K3 回退");
    } catch (error) {
      setNotice(formatError(error, "无法开始 PIN 验证"));
    }
  }

  async function endAuth() {
    try {
      await safekeyEnd();
    } catch {
      // 忽略：板子可能已断开
    }
    setAuthStatus("idle");
    setAuthDetail("");
  }

  async function refreshVaultInfo(path: string) {
    try {
      const info = await vaultVerify(path);
      const name = path.split(/[\\/]/).pop();
      setVaultInfoText(`${name} · ${info.entries} 个文件 · 解密载荷 ${(info.payloadSize / 1024).toFixed(1)} KB`);
    } catch {
      setVaultInfoText("无法验证所选保险箱文件");
    }
  }

  async function pickVault() {
    setNotice("");
    const selected = await open({
      multiple: false,
      filters: [{ name: "保险箱文件", extensions: ["safevault"] }],
    });
    if (typeof selected === "string") {
      setVaultPath(selected);
      await refreshVaultInfo(selected);
    }
  }

  async function createVault() {
    setNotice("");
    const source = await open({ directory: true, title: "选择需要加密的文件夹" });
    if (typeof source !== "string") return;
    const dest = await save({
      title: "保存保险箱",
      defaultPath: "新建保险箱.safevault",
      filters: [{ name: "保险箱文件", extensions: ["safevault"] }],
    });
    if (typeof dest !== "string") return;
    const deleteSource = await ask(
      "创建成功后是否删除原文件夹中的明文？\n建议先解锁验证保险箱可用后再删除，此操作不可恢复。",
      { title: "删除原文件夹", kind: "warning" },
    );
    try {
      await vaultCreate(source, dest, deleteSource);
      setVaultPath(dest);
      await refreshVaultInfo(dest);
    } catch (error) {
      setNotice(formatError(error, "创建保险箱失败"));
    }
  }

  async function unlockVault() {
    setNotice("");
    if (authStatus !== "ok") {
      setNotice("请先在板上完成 PIN 认证");
      return;
    }
    if (!vaultPath) {
      setNotice("请先选择保险箱文件");
      return;
    }
    try {
      const dir = await vaultUnlock(vaultPath, outputRoot.trim(), autolockSecs);
      setVaultUnlocked(true);
      setAuthDetail(`已解锁到临时目录：${dir}`);
    } catch (error) {
      setNotice(formatError(error, "解锁失败"));
    }
  }

  async function relockVault() {
    setNotice("");
    try {
      await vaultRelock();
      setVaultUnlocked(false);
      setAuthDetail("修改已重新加密保存，临时目录已清理");
    } catch (error) {
      setNotice(formatError(error, "保存失败"));
    }
  }

  async function lockVault() {
    setNotice("");
    try {
      await vaultLock();
      setVaultUnlocked(false);
      setAuthDetail("保险箱已锁定，临时明文目录已清理");
    } catch (error) {
      setNotice(formatError(error, "锁定失败"));
    }
  }

  return (
    <div className={isDark ? "app dark" : "app"}>
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">STC</span>
          <div>
            <p className="eyebrow">STC-B / USB AUDIO LINK</p>
            <h1>
              {mode === "music"
                ? "音乐律动"
                : mode === "vault"
                  ? "文件保险箱"
                  : MODE_LABELS[mode].title}
            </h1>
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
            <button
              type="button"
              className={mode === "media" ? "mode-tab active" : "mode-tab"}
              onClick={() => setMode("media")}
            >
              媒体控制
            </button>
            <button
              type="button"
              className={mode === "vault" ? "mode-tab active" : "mode-tab"}
              onClick={() => setMode("vault")}
            >
              文件保险箱
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
              <p className="hero-description">实时捕捉系统声音或麦克风输入，将音量转换成板载数码管的连续律动。律动同时，板载 K1/K2/K3 可直接控制上一曲 / 播放暂停 / 下一曲。</p>
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
      ) : mode === "vault" ? (
        <main className="content">
          <section className="hero-grid" aria-labelledby="vault-title">
            <div className="preview-copy">
              <p className="section-kicker">HARDWARE AUTH / LOCAL VAULT</p>
              <h2 id="vault-title">板子就是<br /><em>钥匙</em></h2>
              <p className="hero-description">
                在板上输入 PIN 完成硬件认证后，才能把 AES-256-GCM 加密的保险箱解密到临时目录；
                板子断开、超时或手动锁定都会立即清理明文。
              </p>
              <p className="focus-warning">
                板上操作：K1 当前数字 +1，K2 确认进入下一位，K3 回退一位。默认 PIN 123456（修改需重新编译固件）。
              </p>
              <div className="signal-readout" aria-live="polite">
                <strong>{vaultUnlocked ? remaining : "—"}</strong>
                <span>
                  {vaultUnlocked ? "秒后自动锁定" : "自动锁定"}
                  <br />
                  {vaultUnlocked ? "保险箱已解锁" : "保险箱未解锁"}
                </span>
              </div>
            </div>
            <div className="display-stage">
              <div className="display-glow" aria-hidden="true" />
              <div className="key-log-panel" aria-live="polite" aria-label="认证状态">
                <p className={authStatus === "ok" || authStatus === "idle" ? "key-log-line" : "key-log-line fail"}>
                  {authLabel(authStatus)}
                </p>
                {authDetail && <p className="key-log-line">{authDetail}</p>}
              </div>
              <div className="stage-caption">
                <span className="live-line"><i /> {controllerSnapshot.portName ?? "未连接"}</span>
                <span className="fps-line">PIN 模式下 K1/K2/K3 由板子接管</span>
              </div>
            </div>
          </section>

          <section className="control-shell" aria-label="文件保险箱设置">
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
                {controllerRunning ? (
                  <md-filled-button onClick={() => void toggleController()}>断开连接</md-filled-button>
                ) : (
                  <md-filled-button disabled={!portName || controllerBusy} onClick={() => void toggleController()}>
                    启动连接
                  </md-filled-button>
                )}
              </div>
              <p className="section-note">认证链路与 Codex 控制器共用：此模式下板载按键不会注入键盘。</p>
            </div>

            <div className="control-section mapping-section">
              <div className="section-heading">
                <span className="step-number">02</span>
                <div><p className="section-kicker">PIN AUTH</p><h3>硬件认证</h3></div>
              </div>
              <div className="connection-row">
                <md-filled-button disabled={!controllerRunning || authStatus === "locked"} onClick={() => void beginAuth()}>
                  开始 PIN 验证
                </md-filled-button>
                <md-outlined-button disabled={!controllerRunning || authStatus === "idle"} onClick={() => void endAuth()}>
                  结束验证
                </md-outlined-button>
              </div>
              <p className="section-note">错 3 次板子锁定 30 秒；认证成功后解锁按钮才可用。</p>
            </div>

            <div className="control-section parameters-section">
              <div className="section-heading">
                <span className="step-number">03</span>
                <div><p className="section-kicker">VAULT</p><h3>保险箱文件</h3></div>
              </div>
              <div className="connection-row">
                <md-outlined-button onClick={() => void pickVault()}>选择保险箱</md-outlined-button>
                <md-outlined-button onClick={() => void createVault()}>从文件夹创建</md-outlined-button>
              </div>
              <p className="section-note">{vaultPath ? vaultPath : "尚未选择保险箱文件"}</p>
              <p className="section-note">{vaultInfoText}</p>
              <div className="sliders">
                <label className="parameter">
                  <span className="parameter-label">解锁目录<strong style={{ fontSize: "0.85em" }}>{outputRoot || "—"}</strong></span>
                  <input
                    className="vault-path-input"
                    value={outputRoot}
                    disabled={vaultUnlocked}
                    onChange={(event) => setOutputRoot(event.target.value)}
                  />
                </label>
                <ParameterSlider label="自动锁定" value={autolockSecs} min={10} max={3600} unit="秒" disabled={vaultUnlocked} onValue={setAutolockSecs} />
              </div>
            </div>
          </section>

          <div className="bottom-bar">
            <div className="runtime-meta">
              <md-linear-progress value={vaultUnlocked ? Math.min(remaining, autolockSecs) : 0} max={autolockSecs} aria-label="自动锁定倒计时" />
              <span>{vaultUnlocked ? `已解锁 · ${remaining} 秒后自动锁定` : "保险箱已锁定"}</span>
            </div>
            <div className="action-area">
              <p className={notice ? "error-message" : "runtime-message"} role={notice ? "alert" : undefined} aria-live="polite">
                {notice || controllerSnapshot.message}
              </p>
              <div className="vault-actions">
                {vaultUnlocked ? (
                  <>
                    <md-outlined-button onClick={() => void vaultOpenDir()}>打开临时目录</md-outlined-button>
                    <md-outlined-button onClick={() => void lockVault()}>放弃修改并锁定</md-outlined-button>
                    <md-filled-button onClick={() => void relockVault()}>保存修改并锁定</md-filled-button>
                  </>
                ) : (
                  <md-filled-button disabled={!controllerRunning || authStatus !== "ok" || !vaultPath} onClick={() => void unlockVault()}>
                    解锁保险箱
                  </md-filled-button>
                )}
              </div>
            </div>
          </div>
        </main>
      ) : (
        <main className="content">
          <section className="hero-grid" aria-labelledby="controller-title">
            <div className="preview-copy">
              <p className="section-kicker">{MODE_LABELS[mode].kicker}</p>
              <h2 id="controller-title">让板子<br /><em>{MODE_LABELS[mode].heading[1]}</em></h2>
              <p className="hero-description">{MODE_LABELS[mode].description}</p>
              <p className="focus-warning">{MODE_LABELS[mode].warning}</p>
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

          <section className="control-shell" aria-label={`${MODE_LABELS[mode].title}设置`}>
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
                {(mode === "media" ? MEDIA_KEY_MAPPINGS : KEY_MAPPINGS).map((mapping) => (
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

function authLabel(status: VaultAuthStatus) {
  return {
    idle: "未认证",
    waiting: "等待 PIN 输入…",
    ok: "已认证 ✓",
    fail: "认证失败",
    locked: "板子已锁定",
  }[status];
}

function formatError(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : typeof error === "string" ? error : fallback;
}

export default App;

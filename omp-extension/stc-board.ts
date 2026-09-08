// STC-B 学习板 → oh-my-pi 原生控制器扩展
//
// 板载 5 向摇杆 + K1/K2/K3 经串口(115200 8N1)发送 6 字节按键帧
// [AA 5A 21 key action chk]，本扩展在进程内读取串口并注入 omp TUI：
//   摇杆上/下 → ↑/↓        弹窗、斜杠菜单里移动（长按连发）
//   摇杆中键 → Enter       确认
//   摇杆左 → Backspace     删除字符/回退
//   摇杆右 → /             打开斜杠菜单
//   K1 → 原生中断当前回合 (ctx.abort)
//   K2 → Tab               补全/切换
//   K3 → Esc               关闭弹窗/取消
//
// 按键走 tui.injectDebugInput（与真实键盘同一管线），不依赖窗口焦点、
// 不经过系统键盘模拟，无中文输入法干扰。连接状态显示在原生状态栏
// （板:COMx / 板:未连接），不占用额外行。
//
// 工作状态回显：agent_start/agent_end 时向板子发送 6 字节状态帧
// [AA 5A 22 status 0 chk]（status 1=工作中 0=空闲），板子收到后数码管
// 显示 run+第8位转圈动画（工作中）或 Stop（空闲），8 颗 LED 上 3 颗连灯
// 常亮并连续往复扫描。动画在板上本地运行，PC 只发状态变化。
//
// 提醒音：任务完成（agent_end 非续跑且非手动中断）或需手动操作
// （tool_approval_requested 审批、ask 工具提问）时发送 [AA 5A 23 0 tune chk]，
// 板载蜂鸣器播放 C4-E4-G4-C5 上行琶音（每音 250ms）。手动中断（K1/Esc）不提醒。
//
// 命令: /board          断开/连接（多串口时弹出选择）
//       /board COM5     连接指定串口
//
// 安装: 复制本文件到 ~/.omp/agent/extensions/stc-board.ts（或项目 .omp/extensions/）
// 仅依赖 bun:ffi + node 内置模块，无需 npm install。
import { dlopen, FFIType, ptr } from "bun:ffi";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";

// ---------------------------------------------------------------------------
// 协议
// ---------------------------------------------------------------------------

const FRAME_TYPE_KEY = 0x21;
const FRAME_TYPE_STATUS = 0x22;
const FRAME_TYPE_TUNE = 0x23;
const FRAME_LEN = 6;
const ACT_PRESS = 1;
const ACT_REPEAT = 2;
const ACT_RELEASE = 3;

const KEY_UP = 1;
const KEY_DOWN = 2;
const KEY_LEFT = 3;
const KEY_RIGHT = 4;
const KEY_CENTER = 5;
const KEY_K1 = 6;
const KEY_K2 = 7;
const KEY_K3 = 8;

// 板键 → 注入的终端序列（与真实键盘同一管线）
const KEY_SEQUENCES: Record<number, string> = {
	[KEY_UP]: "\x1b[A",
	[KEY_DOWN]: "\x1b[B",
	[KEY_LEFT]: "\x7f",
	[KEY_RIGHT]: "/",
	[KEY_CENTER]: "\r",
	[KEY_K2]: "\t",
	[KEY_K3]: "\x1b",
};

// 状态帧布局与音乐帧一致：字节3为保留0，字节4为负载（固件按 [3]==0 && [4]<=1 校验）
export function statusFrame(status: number): Uint8Array {
	return Uint8Array.from([0xaa, 0x5a, FRAME_TYPE_STATUS, 0, status, FRAME_TYPE_STATUS ^ status]);
}

// 提醒音帧：字节3保留0，字节4为曲调号（固件按 [3]==0 && [4]==tune 校验）
// TUNE_REMIND = C4-E4-G4-C5 上行琶音，任务完成/需手动操作时播放
export const TUNE_REMIND = 1;
export function tuneFrame(tune: number): Uint8Array {
	return Uint8Array.from([0xaa, 0x5a, FRAME_TYPE_TUNE, 0, tune, FRAME_TYPE_TUNE ^ tune]);
}

class KeyFrameParser {
	buf = Buffer.alloc(0);
	badFrames = 0;

	feed(data: Uint8Array): Array<{ key: number; action: number }> {
		this.buf = Buffer.concat([this.buf, data]);
		const events: Array<{ key: number; action: number }> = [];
		for (;;) {
			const head = this.buf.indexOf(Buffer.from([0xaa, 0x5a]));
			if (head < 0) {
				if (this.buf.length > 1) this.buf = this.buf.subarray(this.buf.length - 1);
				break;
			}
			if (head > 0) this.buf = this.buf.subarray(head);
			if (this.buf.length < FRAME_LEN) break;
			const frame = this.buf.subarray(0, FRAME_LEN);
			this.buf = this.buf.subarray(FRAME_LEN);
			const key = frame[3];
			const action = frame[4];
			if (frame[2] === FRAME_TYPE_KEY && key >= 1 && key <= KEY_K3 && action >= ACT_PRESS && action <= ACT_RELEASE && frame[5] === (FRAME_TYPE_KEY ^ key ^ action)) {
				events.push({ key, action });
			} else {
				this.badFrames++;
			}
		}
		return events;
	}
}

// ---------------------------------------------------------------------------
// Win32 串口（bun:ffi）
// ---------------------------------------------------------------------------

const GENERIC_READ_WRITE = 0xc0000000;
const OPEN_EXISTING = 3;
const INVALID_HANDLE = 0xffffffffffffffffn;
const PURGE_TXCLEAR = 0x4;
const PURGE_RXCLEAR = 0x8;

function loadKernel32() {
	return dlopen("kernel32.dll", {
		QueryDosDeviceW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
		CreateFileW: {
			args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
			returns: FFIType.ptr,
		},
		CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
		SetCommState: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		SetCommTimeouts: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		ReadFile: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		WriteFile: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		PurgeComm: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
		GetLastError: { args: [], returns: FFIType.u32 },
	});
}

function listComPorts(): string[] {
	const k = loadKernel32();
	const buf = new Uint16Array(65536);
	const n = k.symbols.QueryDosDeviceW(null, ptr(buf), buf.length);
	if (n > 0) {
		const names = Buffer.from(buf.buffer, 0, n * 2).toString("utf16le");
		return names
			.split("\0")
			.filter((name) => /^COM\d+$/.test(name))
			.sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));
	}
	// 枚举失败时退回直接探测
	const found: string[] = [];
	for (let i = 1; i <= 32; i++) {
		const opened = tryOpen(`COM${i}`);
		if (opened) {
			found.push(`COM${i}`);
			closePort(opened);
		}
	}
	return found;
}

// DCB：115200 8N1，fBinary，DTR 不动（避免打扰 STC 自动下载电路）
function makeDCB(): Uint8Array {
	const dcb = new Uint8Array(28);
	const view = new DataView(dcb.buffer);
	view.setUint32(0, 28, true);
	view.setUint32(4, 115200, true);
	view.setUint32(8, 0x1, true);
	view.setUint8(18, 8);
	view.setUint8(19, 0);
	view.setUint8(20, 0);
	return dcb;
}

// COMMTIMEOUTS：ReadFile 立即返回（轮询模式）
function makeTimeouts(): Uint8Array {
	const timeouts = new Uint8Array(20);
	const view = new DataView(timeouts.buffer);
	view.setUint32(0, 0xffffffff, true);
	return timeouts;
}

interface OpenPort {
	name: string;
	handle: bigint;
	rx: Uint8Array;
	rxCount: Uint32Array;
	txCount: Uint32Array;
	parser: KeyFrameParser;
}

function tryOpen(name: string): OpenPort | null {
	const k = loadKernel32();
	const path = Buffer.from(`\\\\.\\${name}\0`, "utf16le");
	const handle = k.symbols.CreateFileW(ptr(path), GENERIC_READ_WRITE, 0, null, OPEN_EXISTING, 0, null);
	if (handle === INVALID_HANDLE) return null;
	const okState = k.symbols.SetCommState(handle, ptr(makeDCB()));
	const okTimeouts = k.symbols.SetCommTimeouts(handle, ptr(makeTimeouts()));
	if (!okState || !okTimeouts) {
		k.symbols.CloseHandle(handle);
		return null;
	}
	k.symbols.PurgeComm(handle, PURGE_TXCLEAR | PURGE_RXCLEAR);
	return { name, handle, rx: new Uint8Array(256), rxCount: new Uint32Array(1), txCount: new Uint32Array(1), parser: new KeyFrameParser() };
}

function closePort(port: OpenPort) {
	loadKernel32().symbols.CloseHandle(port.handle);
}

// ---------------------------------------------------------------------------
// 扩展主体
// ---------------------------------------------------------------------------

interface TuiLike {
	injectDebugInput(data: string): void;
	requestRender(force?: boolean): void;
}

export default function stcBoard(pi: ExtensionAPI) {
	pi.setLabel("STC-B Board Controller");

	let sessionCtx: ExtensionContext | null = null;
	let tui: TuiLike | null = null;
	let port: OpenPort | null = null;
	let reconnectName: string | null = null;
	let lastError = "";
	let reconnectAt = 0;
	let pollTimer: unknown = null;
	let shuttingDown = false;
	let working = false;

	// --- 状态展示（仅原生状态栏 chip，不占额外行）---

	function statusChip(): string {
		return port ? `板:${port.name}` : "板:未连接";
	}

	function setStatus(text?: string) {
		try {
			sessionCtx?.ui.setStatus("stc-board", text ?? statusChip());
		} catch {
			// 会话切换期间 ui 可能不可用
		}
	}

	// --- 连接管理 ---

	function disconnect() {
		if (port) {
			closePort(port);
			port = null;
		}
		lastError = "";
		setStatus();
	}

	function connect(name: string): boolean {
		disconnect();
		const opened = tryOpen(name);
		if (!opened) {
			lastError = `${name} 打开失败/被占用`;
			reconnectAt = Date.now() + 2000;
			setStatus();
			return false;
		}
		port = opened;
		lastError = "";
		sendStatus();
		setStatus();
		return true;
	}

	// --- 工作状态上报（[AA 5A 22 0 status chk]）---

	function sendStatus() {
		if (!port) return;
		const frame = statusFrame(working ? 1 : 0);
		try {
			loadKernel32().symbols.WriteFile(port.handle, ptr(frame), frame.length, ptr(port.txCount), null);
		} catch {
			// 写失败不致命，等下次状态变化或重连再同步
		}
	}

	// --- 提醒音（[AA 5A 23 0 tune chk]）---

	function sendTune(tune: number) {
		if (!port) return;
		const frame = tuneFrame(tune);
		try {
			loadKernel32().symbols.WriteFile(port.handle, ptr(frame), frame.length, ptr(port.txCount), null);
		} catch {
			// 写失败不致命
		}
	}

	// --- 按键处理 ---

	function handleKey(key: number, action: number) {
		if (action === ACT_RELEASE) return;
		if (key === KEY_K1) {
			// 原生中断当前回合，不走 Ctrl+C 模拟
			void sessionCtx?.abort();
			return;
		}
		const sequence = KEY_SEQUENCES[key];
		if (sequence && tui) {
			tui.injectDebugInput(sequence);
		}
	}

	// --- 串口轮询（30ms，错误被托管定时器隔离）---

	function poll() {
		if (shuttingDown) return;
		if (!port) {
			if (reconnectAt && Date.now() >= reconnectAt) {
				reconnectAt = 0;
				if (reconnectName) connect(reconnectName);
			}
			return;
		}
		const k = loadKernel32();
		port.rxCount[0] = 0;
		const ok = k.symbols.ReadFile(port.handle, ptr(port.rx), port.rx.length, ptr(port.rxCount), null);
		if (!ok) {
			lastError = "串口读取失败";
			closePort(port);
			port = null;
			reconnectAt = Date.now() + 2000;
			setStatus();
			return;
		}
		const n = port.rxCount[0];
		if (n > 0) {
			for (const { key, action } of port.parser.feed(port.rx.subarray(0, n))) {
				handleKey(key, action);
			}
		}
	}

	// --- 命令 ---

	pi.registerCommand("board", {
		description: "STC-B 板控制器：连接/断开摇杆串口（/board COM5 指定串口）",
		handler: async (args) => {
			const target = args.trim();
			if (!target) {
				if (port) {
					reconnectName = null;
					disconnect();
					sessionCtx?.ui.notify("STC-B 控制器已断开", "info");
					return;
				}
				const ports = listComPorts();
				if (ports.length === 0) {
					sessionCtx?.ui.notify("未发现串口：请确认板子已插 USB", "warning");
					return;
				}
				if (ports.length === 1) {
					reconnectName = ports[0];
					if (connect(ports[0])) {
						sessionCtx?.ui.notify(`STC-B 控制器已连接 ${ports[0]}：摇杆上/下移动 · 中键确认 · 左键 Backspace · 右键 / · K1 中断 · K2 Tab · K3 Esc`, "info");
					} else {
						sessionCtx?.ui.notify(lastError, "error");
					}
					return;
				}
				const picked = await sessionCtx?.ui.select("选择 STC-B 串口", ports.map((name) => ({ label: name })));
				if (picked) {
					reconnectName = picked;
					if (connect(picked)) {
						sessionCtx?.ui.notify(`STC-B 控制器已连接 ${picked}`, "info");
					} else {
						sessionCtx?.ui.notify(lastError, "error");
					}
				}
				return;
			}
			reconnectName = target.toUpperCase();
			if (connect(reconnectName)) {
				sessionCtx?.ui.notify(`STC-B 控制器已连接 ${reconnectName}`, "info");
			} else {
				sessionCtx?.ui.notify(lastError, "error");
			}
		},
	});

	// --- 工作状态（agent 循环启停时同步到板子）---

	pi.on("agent_start", () => {
		working = true;
		sendStatus();
	});

	pi.on("agent_end", (event) => {
		// willContinue：自动续跑（重试等）马上会再次 agent_start，保持工作中显示
		const e = event as { willContinue?: boolean; messages?: Array<{ role?: string; stopReason?: string }> };
		if (e.willContinue) return;
		// 手动中断（K1/Esc）时最后一条助手消息 stopReason=aborted：
		// 显示要切回 Stop，但不播提醒音（用户自己按的，无需提示）
		const last = e.messages?.[e.messages.length - 1];
		const aborted = last?.role === "assistant" && last.stopReason === "aborted";
		working = false;
		sendStatus();
		if (!aborted) {
			// BSP 串口为单缓冲，两个数据包之间需 ≥1ms 间隔，否则后一帧被丢弃。
			// 状态帧刚发出，提醒音帧延迟 12ms 再发，确保不撞帧。
			sessionCtx?.setTimeout(() => sendTune(TUNE_REMIND), 12);
		}
	});

	// agent 用 ask 工具向用户提问：工具执行开始后即阻塞等待回答，
	// 此时不会触发 agent_end，需单独提醒（审批弹窗由 tool_approval_requested 覆盖）
	pi.on("tool_execution_start", (event) => {
		if ((event as { toolName?: string }).toolName === "ask") {
			sendTune(TUNE_REMIND);
		}
	});

	// 工具需用户批准（手动操作）时提醒
	pi.on("tool_approval_requested", () => {
		sendTune(TUNE_REMIND);
	});

	// --- 生命周期 ---

	pi.on("session_start", async (_event, ctx) => {
		sessionCtx = ctx;
		shuttingDown = false;
		if (pollTimer) {
			ctx.clearTimer(pollTimer);
			pollTimer = null;
		}
		// 零行渲染的隐形 widget：仅用于捕获 TUI 实例（injectDebugInput 需要），
		// belowEditor 容器不会为它添加任何行
		try {
			ctx.ui.setWidget("stc-board", (boundTui: TuiLike) => {
				tui = boundTui;
				return {
					render() {
						return [];
					},
				};
			}, { placement: "belowEditor" });
		} catch {
			// 无 UI 模式（print/RPC）下忽略
		}
		setStatus();
		pollTimer = ctx.setInterval(poll, 30);
		if (!port && reconnectName) {
			connect(reconnectName);
		} else if (!port && !reconnectName) {
			// 恰好一个串口时静默自动连接
			const ports = listComPorts();
			if (ports.length === 1) {
				reconnectName = ports[0];
				connect(ports[0]);
			}
		}
	});

	pi.on("session_shutdown", () => {
		shuttingDown = true;
		if (pollTimer) {
			sessionCtx?.clearTimer(pollTimer);
			pollTimer = null;
		}
		if (port && working) {
			working = false;
			sendStatus();
		}
		if (port) {
			closePort(port);
			port = null;
		}
		sessionCtx = null;
		tui = null;
	});
}

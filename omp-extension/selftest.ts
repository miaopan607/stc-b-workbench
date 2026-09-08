// stc-board.ts 自测：mock ExtensionAPI/TUI/串口（无硬件）
// 用法: bun selftest.ts
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent";

const factory = (await import("./stc-board.ts")).default as ExtensionFactory;
const { statusFrame, tuneFrame, TUNE_REMIND } = (await import("./stc-board.ts")) as { statusFrame: (status: number) => Uint8Array; tuneFrame: (tune: number) => Uint8Array; TUNE_REMIND: number };

// 状态帧布局：字节3=保留0，字节4=状态，字节5=chk(0x22^status)
const runningFrame = statusFrame(1);
const stoppedFrame = statusFrame(0);
check("状态帧 running 布局", runningFrame[0] === 0xaa && runningFrame[1] === 0x5a && runningFrame[2] === 0x22 && runningFrame[3] === 0 && runningFrame[4] === 1 && runningFrame[5] === 0x23, Array.from(runningFrame).join(" "));
check("状态帧 stop 布局", stoppedFrame[4] === 0 && stoppedFrame[5] === 0x22, Array.from(stoppedFrame).join(" "));

// 提醒音帧布局：字节3=保留0，字节4=tune，字节5=chk(0x23^tune)
const remindFrame = tuneFrame(TUNE_REMIND);
check("提醒音帧布局", remindFrame[0] === 0xaa && remindFrame[1] === 0x5a && remindFrame[2] === 0x23 && remindFrame[3] === 0 && remindFrame[4] === TUNE_REMIND && remindFrame[5] === (0x23 ^ TUNE_REMIND), Array.from(remindFrame).join(" "));

let failures = 0;
function check(name: string, ok: boolean, detail = "") {
	console.log(`${ok ? "[通过]" : "[失败]"} ${name}${detail ? `：${detail}` : ""}`);
	if (!ok) failures++;
}

const handlers: Record<string, (event: unknown, ctx: unknown) => Promise<void>> = {};
const commands: Record<string, { description?: string; handler: (args: string) => Promise<void> | void }> = {};
let label = "";
const factoryObj = {
	setLabel(value: string) {
		label = value;
	},
	on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) {
		handlers[event] = handler;
	},
	registerCommand(name: string, options: { description?: string; handler: (args: string) => Promise<void> | void }) {
		commands[name] = options;
	},
} as never;

await factory(factoryObj);
check("扩展工厂执行", Boolean(handlers.session_start && handlers.session_shutdown && commands.board));

const notifications: string[] = [];
const statusCalls: Array<[string, string | undefined]> = [];
const injected: string[] = [];
let widgetComponent: { render(width: number): readonly string[] } | null = null;
let aborted = 0;
const timers: Array<{ fn: () => void; cleared: boolean }> = [];

const tuiMock = {
	injectDebugInput(data: string) {
		injected.push(data);
	},
	requestRender() {},
};

const ctxMock = {
	ui: {
		setStatus(key: string, text: string | undefined) {
			statusCalls.push([key, text]);
		},
		setWidget(_key: string, factory: (t: unknown) => { render(width: number): readonly string[] }) {
			widgetComponent = factory(tuiMock);
		},
		notify(message: string) {
			notifications.push(message);
		},
		select: async () => undefined,
	},
	setInterval(fn: () => void) {
		const timer = { fn, cleared: false };
		timers.push(timer);
		return timer;
	},
	setTimeout(fn: () => void) {
		// 一次性、即发即弃（真实运行时 12ms 后触发，关闭时由 ctx 自动清理）
		// 不计入 timers，避免污染轮询定时器的清理断言
		fn();
		return { fn, cleared: true };
	},
	clearTimer(timer: { cleared: boolean }) {
		timer.cleared = true;
	},
	abort() {
		aborted++;
	},
};

await handlers.session_start({}, ctxMock);
check("session_start 注册了轮询定时器", timers.length === 1);
check("widget 已注册", widgetComponent !== null);
check("agent_start/agent_end 已注册", Boolean(handlers.agent_start && handlers.agent_end));
check("tool_approval_requested / tool_execution_start 已注册", Boolean(handlers.tool_approval_requested && handlers.tool_execution_start));

// 工作状态事件（无串口时只更新内部状态，不应崩溃）
await handlers.agent_start({}, ctxMock);
await handlers.agent_end({ willContinue: true }, ctxMock);
await handlers.agent_end({}, ctxMock);
// 手动中断：最后一条助手消息 stopReason=aborted → 只发状态帧，不播提醒音
await handlers.agent_end({ messages: [{ role: "assistant", stopReason: "aborted" }] }, ctxMock);
// ask 工具提问 → 提醒音
await handlers.tool_execution_start!({ toolName: "ask" }, ctxMock);
await handlers.tool_execution_start!({ toolName: "bash" }, ctxMock);
await handlers.tool_approval_requested!({}, ctxMock);
check("agent 状态/提醒事件不崩溃（无串口）", true);
const rendered = widgetComponent!.render(120);
check("widget 零行渲染（不占额外行）", rendered.length === 0, `行数=${rendered.length}`);
const chip = statusCalls.at(-1)?.[1] ?? "";
check("状态栏显示板状态（板:COMx 或 板:未连接）", /^板:(COM\d+|未连接)$/.test(chip), chip);

// 无板子时轮询不应崩溃（port 为 null）
if (!/^板:COM\d+$/.test(chip)) {
	timers[0]!.fn();
	check("空轮询不崩溃", true);
}

// /board 无参数：已连接 → 断开；未连接 → 提示未发现串口
if (/^板:COM\d+$/.test(chip)) {
	await commands.board.handler("");
	check("/board 断开已连接的板", notifications.some((n) => n.includes("已断开")), notifications.join(" | "));
	check("断开后状态栏显示未连接", (statusCalls.at(-1)?.[1] ?? "").includes("板:未连接"), statusCalls.at(-1)?.[1] ?? "");
	// 重新连回去，模拟断开重插后的自动重连路径
	await commands.board.handler(statusCalls.findLast(([, text]) => /^板:COM\d+$/.test(text))?.[1]?.slice(2) ?? "");
} else {
	await commands.board.handler("");
	const chipAfterBoard = statusCalls.at(-1)?.[1] ?? "";
	const ok =
		notifications.some((n) => n.includes("未发现串口")) ||
		/^板:COM\d+$/.test(chipAfterBoard) ||
		notifications.some((n) => /COM\d+/.test(n));
	check("/board 无参数：连接、提示无串口或报告占用", ok, notifications.join(" | ") + " | " + chipAfterBoard);
}

// 指定不存在的串口 → 连接失败提示 + 状态栏仍未连接
await commands.board.handler("COM95");
check("/board COM95 失败提示", notifications.some((n) => n.includes("COM95")), notifications.join(" | "));
const chipAfterFail = statusCalls.at(-1)?.[1] ?? "";
check("失败后状态栏显示未连接", chipAfterFail.includes("板:未连接"), chipAfterFail);

await handlers.session_shutdown({}, ctxMock);
check("session_shutdown 清理定时器", timers.every((t) => t.cleared));

console.log(failures === 0 ? "自测全部通过" : `${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);

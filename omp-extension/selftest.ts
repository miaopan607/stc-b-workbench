// stc-board.ts 自测：mock ExtensionAPI/TUI/串口（无硬件）
// 用法: bun selftest.ts
import type { ExtensionFactory } from "@oh-my-pi/pi-coding-agent";

const factory = (await import("./stc-board.ts")).default as ExtensionFactory;

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

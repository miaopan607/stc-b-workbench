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
const line = widgetComponent!.render(120)[0];
check("widget 渲染包含状态", line.includes("STC-B") && line.includes("未连接"), line);

// 无板子时轮询不应崩溃（当前机器无串口，port 为 null）
timers[0]!.fn();
check("空轮询不崩溃", true);

// /board 无串口 → 提示未发现串口
await commands.board.handler("");
check("/board 无串口提示", notifications.some((n) => n.includes("未发现串口")), notifications.join(" | "));

// 指定不存在的串口 → 连接失败提示 + 自动重连挂起
await commands.board.handler("COM95");
check("/board COM95 失败提示", notifications.some((n) => n.includes("COM95")), notifications.join(" | "));
const chip = statusCalls.at(-1)?.[1] ?? "";
check("状态栏显示未连接", chip.includes("未连接") || chip.includes("板:"), chip);

await handlers.session_shutdown({}, ctxMock);
check("session_shutdown 清理定时器", timers.every((t) => t.cleared));

console.log(failures === 0 ? "自测全部通过" : `${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);

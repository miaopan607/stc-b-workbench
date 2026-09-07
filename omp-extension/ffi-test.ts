// bun:ffi 串口访问可行性测试（Windows）
// 用法: bun ffi-test.ts  [COMx]
import { dlopen, FFIType, ptr } from "bun:ffi";

const GENERIC_READ_WRITE = 0xc0000000;
const OPEN_EXISTING = 3;
const INVALID_HANDLE_VALUE = 0xffffffffffffffffn;
const PURGE_TXCLEAR = 0x4;
const PURGE_RXCLEAR = 0x8;

const k32 = dlopen(
	"kernel32.dll",
	{
		QueryDosDeviceW: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
		CreateFileW: {
			args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr],
			returns: FFIType.ptr,
		},
		CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
		SetCommState: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		SetCommTimeouts: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		ReadFile: { args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
		PurgeComm: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
		GetLastError: { args: [], returns: FFIType.u32 },
	},
);

function listComPorts(): string[] {
	const buf = new Uint16Array(65536);
	const n = k32.symbols.QueryDosDeviceW(null, ptr(buf), buf.length);
	if (n === 0) {
		console.log("QueryDosDeviceW 失败，GetLastError =", k32.symbols.GetLastError());
		return [];
	}
	const names = Buffer.from(buf.buffer, 0, n * 2).toString("utf16le");
	return names.split("\0").filter((name) => /^COM\d+$/.test(name));
}

function openComPort(name: string) {
	const path = Buffer.from(`\\\\.\\${name}\0`, "utf16le");
	const handle = k32.symbols.CreateFileW(ptr(path), GENERIC_READ_WRITE, 0, null, OPEN_EXISTING, 0, null);
	if (handle === INVALID_HANDLE_VALUE) {
		const err = k32.symbols.GetLastError();
		return { handle: null, error: err };
	}
	return { handle, error: 0 };
}

// DCB（28 字节，字段自然对齐无 padding）
function makeDCB(): Uint8Array {
	const dcb = new Uint8Array(28);
	const view = new DataView(dcb.buffer);
	view.setUint32(0, 28, true); // DCBlength
	view.setUint32(4, 115200, true); // BaudRate
	view.setUint32(8, 0x1, true); // fBinary
	view.setUint8(18, 8); // ByteSize
	view.setUint8(19, 0); // Parity=NOPARITY
	view.setUint8(20, 0); // StopBits=ONESTOPBIT
	return dcb;
}

// COMMTIMEOUTS：读立即返回（不阻塞）
function makeTimeouts(): Uint8Array {
	const t = new Uint8Array(20);
	const view = new DataView(t.buffer);
	view.setUint32(0, 0xffffffff, true); // ReadIntervalTimeout=MAXDWORD
	view.setUint32(4, 0, true); // ReadTotalTimeoutMultiplier
	view.setUint32(8, 0, true); // ReadTotalTimeoutConstant
	view.setUint32(12, 0, true); // WriteTotalTimeoutMultiplier
	view.setUint32(16, 0, true); // WriteTotalTimeoutConstant
	return t;
}

const explicit = process.argv[2];
let ports = explicit ? [explicit] : listComPorts();
if (!explicit && ports.length === 0) {
	// 兜底：直接探测 COM1..COM32 上可打开的口
	ports = [];
	for (let i = 1; i <= 32; i++) ports.push(`COM${i}`);
}
console.log("探测 COM 口:", ports.join(", ") || "（无）");

for (const name of ports) {
	const { handle, error } = openComPort(name);
	if (handle === null) {
		console.log(`${name}: 打开失败 Win32 错误 ${error}${error === 5 ? "（被占用）" : error === 2 ? "（不存在）" : ""}`);
		continue;
	}
	console.log(`${name}: 已打开 handle=${handle}`);
	const dcb = makeDCB();
	const okState = k32.symbols.SetCommState(handle, ptr(dcb));
	const timeouts = makeTimeouts();
	const okTimeouts = k32.symbols.SetCommTimeouts(handle, ptr(timeouts));
	console.log(`${name}: SetCommState=${okState} SetCommTimeouts=${okTimeouts}`);
	k32.symbols.PurgeComm(handle, PURGE_TXCLEAR | PURGE_RXCLEAR);

	const rx = new Uint8Array(256);
	const bytesRead = new Uint32Array(1);
	const okRead = k32.symbols.ReadFile(handle, ptr(rx), rx.length, ptr(bytesRead), null);
	console.log(`${name}: ReadFile=${okRead} 读到 ${bytesRead[0]} 字节${bytesRead[0] ? " " + Buffer.from(rx.buffer, 0, bytesRead[0]).toString("hex") : ""}`);
	k32.symbols.CloseHandle(handle);
}

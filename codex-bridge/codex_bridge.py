#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""STC-B 学习板 → codex 控制器桥接。

板载 5 向摇杆与 K1/K2 按键经串口(115200, 8N1)发送 6 字节帧
[AA 5A 21 key action chk]，本脚本将其翻译成真实键盘输入
(SendInput)，注入到“当前聚焦窗口”——使用时请保持 codex
终端在前台。

按键映射:
  摇杆上/下  → ↑ / ↓     弹窗、斜杠菜单里移动选项（长按连发）
  摇杆中键   → Enter     确认
  摇杆左     → Esc       关闭弹窗/取消
  摇杆右     → /         打开斜杠菜单
  K1         → Ctrl+C    中断当前回合
  K2         → Tab       补全/排队
  K3         → Enter     备用确认键

依赖: pip install pyserial

用法:
  python codex_bridge.py                 自动选串口并监听
  python codex_bridge.py --port COM5     指定串口
  python codex_bridge.py --list-ports    列出串口
  python codex_bridge.py --launch        先开新终端运行 codex 再监听
  python codex_bridge.py --dry-run       只打印注入动作，不真正发送
  python codex_bridge.py --selftest      合成帧自测（无需硬件）
  python codex_bridge.py --probe         新开控制台实测按键注入（无需串口）
"""

from __future__ import annotations

import argparse
import ctypes
import subprocess
import sys
import time
from ctypes import wintypes

FRAME_HEAD = b"\xaa\x5a"
FRAME_TYPE_KEY = 0x21
FRAME_LEN = 6

ACT_PRESS = 1
ACT_REPEAT = 2
ACT_RELEASE = 3

CREATE_NEW_CONSOLE = 0x00000010

KEY_UP, KEY_DOWN, KEY_LEFT, KEY_RIGHT, KEY_CENTER, KEY_K1, KEY_K2 = range(1, 8)
KEY_K3 = 8
KEY_NAMES = {
    KEY_UP: "上", KEY_DOWN: "下", KEY_LEFT: "左", KEY_RIGHT: "右",
    KEY_CENTER: "中键", KEY_K1: "K1", KEY_K2: "K2", KEY_K3: "K3",
}
ACTION_NAMES = {ACT_PRESS: "按下", ACT_REPEAT: "长按", ACT_RELEASE: "抬起"}

# ---------------------------------------------------------------------------
# Windows SendInput
# ---------------------------------------------------------------------------

INPUT_KEYBOARD = 1
KEYEVENTF_EXTENDEDKEY = 0x0001
KEYEVENTF_KEYUP = 0x0002
KEYEVENTF_SCANCODE = 0x0008
KEYEVENTF_UNICODE = 0x0004
VK_PACKET = 0xE7

# (scancode, extended)
_SCANCODE = {
    "up": (0x48, True),
    "down": (0x50, True),
    "esc": (0x01, False),
    "enter": (0x1C, False),
    "tab": (0x0F, False),
    "c": (0x2E, False),
    "lctrl": (0x1D, False),
}


class _KEYBDINPUT(ctypes.Structure):
    _fields_ = [
        ("wVk", wintypes.WORD),
        ("wScan", wintypes.WORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.c_size_t),
    ]


class _MOUSEINPUT(ctypes.Structure):
    _fields_ = [
        ("dx", wintypes.LONG),
        ("dy", wintypes.LONG),
        ("mouseData", wintypes.DWORD),
        ("dwFlags", wintypes.DWORD),
        ("time", wintypes.DWORD),
        ("dwExtraInfo", ctypes.c_size_t),
    ]


class _HARDWAREINPUT(ctypes.Structure):
    _fields_ = [("uMsg", wintypes.DWORD), ("wParamL", wintypes.WORD), ("wParamH", wintypes.WORD)]


class _INPUTUNION(ctypes.Union):
    _fields_ = [("ki", _KEYBDINPUT), ("mi", _MOUSEINPUT), ("hi", _HARDWAREINPUT)]


class INPUT(ctypes.Structure):
    _anonymous_ = ("u",)
    _fields_ = [("type", wintypes.DWORD), ("u", _INPUTUNION)]


_user32 = ctypes.WinDLL("user32", use_last_error=True)
_user32.SendInput.argtypes = [ctypes.c_uint, ctypes.POINTER(INPUT), ctypes.c_int]
_user32.SendInput.restype = ctypes.c_uint


def _key_event(scan: int, extended: bool, up: bool) -> INPUT:
    flags = KEYEVENTF_SCANCODE
    if extended:
        flags |= KEYEVENTF_EXTENDEDKEY
    if up:
        flags |= KEYEVENTF_KEYUP
    item = INPUT()
    item.type = INPUT_KEYBOARD
    item.ki = _KEYBDINPUT(0, scan, flags, 0, 0)
    return item


def _send(events: list[INPUT]) -> bool:
    array = (INPUT * len(events))(*events)
    return _user32.SendInput(len(array), array, ctypes.sizeof(INPUT)) == len(array)


def _tap(name: str) -> bool:
    scan, extended = _SCANCODE[name]
    return _send([_key_event(scan, extended, False), _key_event(scan, extended, True)])


def _tap_char(ch: str) -> bool:
    # KEYEVENTF_UNICODE 直接投递字符，绕过键盘布局与输入法（中文 IME 会把 scancode 的 '/' 截成组词键）
    down = INPUT()
    down.type = INPUT_KEYBOARD
    down.ki = _KEYBDINPUT(VK_PACKET, ord(ch), KEYEVENTF_UNICODE, 0, 0)
    up = INPUT()
    up.type = INPUT_KEYBOARD
    up.ki = _KEYBDINPUT(VK_PACKET, ord(ch), KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, 0, 0)
    return _send([down, up])


def _ctrl_c() -> bool:
    ctrl, _ = _SCANCODE["lctrl"]
    c, _ = _SCANCODE["c"]
    return _send([
        _key_event(ctrl, False, False),
        _key_event(c, False, False),
        _key_event(c, False, True),
        _key_event(ctrl, False, True),
    ])


# 板子按键 → (注入标签, 注入函数)
INJECTORS = {
    KEY_UP: ("↑", lambda: _tap("up")),
    KEY_DOWN: ("↓", lambda: _tap("down")),
    KEY_LEFT: ("Esc", lambda: _tap("esc")),
    KEY_RIGHT: ("/", lambda: _tap_char("/")),
    KEY_CENTER: ("Enter", lambda: _tap("enter")),
    KEY_K1: ("Ctrl+C", _ctrl_c),
    KEY_K2: ("Tab", lambda: _tap("tab")),
    KEY_K3: ("Enter", lambda: _tap("enter")),
}

# ---------------------------------------------------------------------------
# 协议
# ---------------------------------------------------------------------------


def build_key_frame(key: int, action: int) -> bytes:
    checksum = FRAME_TYPE_KEY ^ key ^ action
    return FRAME_HEAD + bytes([FRAME_TYPE_KEY, key, action, checksum])


class KeyFrameParser:
    """字节流 → 合法按键帧 (key, action)；坏帧丢弃并计数。"""

    def __init__(self) -> None:
        self.buf = bytearray()
        self.bad_frames = 0

    def feed(self, data: bytes) -> list[tuple[int, int]]:
        self.buf.extend(data)
        results: list[tuple[int, int]] = []
        while True:
            head = self.buf.find(FRAME_HEAD)
            if head < 0:
                if len(self.buf) > 1:
                    del self.buf[:-1]
                break
            if head > 0:
                del self.buf[:head]
            if len(self.buf) < FRAME_LEN:
                break
            frame = bytes(self.buf[:FRAME_LEN])
            del self.buf[:FRAME_LEN]
            key, action = frame[3], frame[4]
            checksum = FRAME_TYPE_KEY ^ key ^ action
            if (
                frame[2] == FRAME_TYPE_KEY
                and 1 <= key <= KEY_K3
                and ACT_PRESS <= action <= ACT_RELEASE
                and frame[5] == checksum
            ):
                results.append((key, action))
            else:
                self.bad_frames += 1
        return results


# ---------------------------------------------------------------------------
# 行为
# ---------------------------------------------------------------------------


def log(message: str) -> None:
    print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)


def dispatch(frames: list[tuple[int, int]], dry_run: bool) -> None:
    for key, action in frames:
        name = KEY_NAMES.get(key, f"key{key}")
        if action == ACT_RELEASE:
            log(f"{name} 抬起")
            continue
        label, inject = INJECTORS.get(key, (None, None))
        if inject is None:
            log(f"{name} 未知按键码，忽略")
            continue
        if dry_run:
            log(f"{name} {ACTION_NAMES[action]} → [dry-run] {label}")
            continue
        if inject():
            log(f"{name} {ACTION_NAMES[action]} → 注入 {label}")
        else:
            log(f"{name} {ACTION_NAMES[action]} → 注入失败 (Win32 错误 {ctypes.get_last_error()})")


def list_ports() -> list[tuple[str, str]]:
    import serial.tools.list_ports

    return sorted((p.device, p.description) for p in serial.tools.list_ports.comports())


def pick_port(explicit: str | None) -> str:
    if explicit:
        return explicit
    ports = list_ports()
    if not ports:
        raise SystemExit("未发现串口：请确认板子已插 USB，或用 --port COMx 指定。")
    if len(ports) == 1:
        return ports[0][0]
    print("发现多个串口：")
    for index, (device, desc) in enumerate(ports):
        print(f"  {index + 1}. {device}  {desc}")
    choice = input(f"选择串口 [1-{len(ports)}，回车默认 1]: ").strip()
    try:
        return ports[int(choice) - 1 if choice else 0][0]
    except (ValueError, IndexError):
        raise SystemExit("无效选择。")


def listen(port_name: str, dry_run: bool) -> None:
    import serial

    parser = KeyFrameParser()
    while True:
        try:
            with serial.Serial(port_name, 115200, timeout=0.05) as port:
                parser.buf.clear()
                log(f"已连接 {port_name} @115200，等待板子按键…")
                while True:
                    data = port.read(128)
                    if data:
                        dispatch(parser.feed(data), dry_run)
        except serial.SerialException as error:
            log(f"串口异常：{error}，3 秒后重试（Ctrl+C 退出）")
            time.sleep(3)


def launch_codex() -> None:
    try:
        subprocess.Popen(["cmd", "/k", "codex"], creationflags=CREATE_NEW_CONSOLE)
        log("已在新终端窗口启动 codex")
        time.sleep(3)
    except OSError as error:
        log(f"启动 codex 终端失败（可手动打开）：{error}")


# ---------------------------------------------------------------------------
# 自测 / 探针
# ---------------------------------------------------------------------------


def selftest() -> int:
    parser = KeyFrameParser()
    expected = [
        (KEY_UP, ACT_PRESS),
        (KEY_DOWN, ACT_REPEAT),
        (KEY_CENTER, ACT_PRESS),
        (KEY_LEFT, ACT_PRESS),
        (KEY_RIGHT, ACT_PRESS),
        (KEY_K1, ACT_PRESS),
        (KEY_K2, ACT_PRESS),
        (KEY_K3, ACT_PRESS),
        (KEY_UP, ACT_RELEASE),
    ]
    bad_type = FRAME_HEAD + bytes([0x99, 0, 0, 0])
    bad_checksum = build_key_frame(KEY_UP, ACT_PRESS)
    bad_checksum = bad_checksum[:5] + bytes([bad_checksum[5] ^ 0xFF])
    stream = b"\x00" + bad_type + bad_checksum + b"".join(build_key_frame(k, a) for k, a in expected) + b"\xaa\x5a"

    got = parser.feed(stream)
    failures = 0
    if got != expected:
        print(f"[失败] 解析结果不符: {got}")
        failures += 1
    else:
        print(f"[通过] {len(got)} 帧按序解析: {[KEY_NAMES[k] + '/' + ACTION_NAMES[a] for k, a in got]}")
    if parser.bad_frames != 2:
        print(f"[失败] 坏帧计数应为 2，实际 {parser.bad_frames}")
        failures += 1
    else:
        print("[通过] 坏帧(类型错/校验错)被丢弃")

    missing = [KEY_NAMES[k] for k in range(KEY_UP, KEY_K3 + 1) if k not in INJECTORS]
    if missing:
        print(f"[失败] 缺少注入映射: {missing}")
        failures += 1
    else:
        print("[通过] 8 个按键全部有注入映射")

    print("== 注入映射演练（dry-run）==")
    dispatch([(k, ACT_PRESS) for k in range(KEY_UP, KEY_K3 + 1)], dry_run=True)

    print("自测结果：" + ("通过" if failures == 0 else f"{failures} 项失败"))
    return 0 if failures == 0 else 1


def probe() -> int:
    """新开控制台窗口捕获注入按键，验证 SendInput 全链路（与 codex 终端同一通路）。"""
    import ast
    import os
    import tempfile

    workdir = tempfile.mkdtemp(prefix="stcbridge_probe_")
    target = os.path.join(workdir, "keycap_target.py")
    logfile = os.path.join(workdir, "keys.txt")
    with open(target, "w", encoding="utf-8") as f:
        f.write(
            "import msvcrt\n"
            f"log = open(r'{logfile}', 'w', encoding='utf-8')\n"
            "try:\n"
            "    while True:\n"
            "        ch = msvcrt.getwch()\n"
            "        log.write(repr(ch) + chr(10)); log.flush()\n"
            "        if ch == 'q':\n"
            "            break\n"
            "except KeyboardInterrupt:\n"
            "    log.write('CTRLC' + chr(10))\n"
            "finally:\n"
            "    log.write('END' + chr(10)); log.close()\n"
        )
    open(logfile, "w").close()
    print("将弹出一个控制台窗口并依次注入 8 个按键（约 5 秒）…", flush=True)
    subprocess.Popen([sys.executable, "-u", target], creationflags=CREATE_NEW_CONSOLE)
    time.sleep(3)
    steps = [
        ("↑", lambda: _tap("up")),
        ("↓", lambda: _tap("down")),
        ("Enter", lambda: _tap("enter")),
        ("Esc", lambda: _tap("esc")),
        ("/", lambda: _tap_char("/")),
        ("Tab", lambda: _tap("tab")),
        ("Ctrl+C", _ctrl_c),
        ("q(收尾)", lambda: _tap_char("q")),
    ]
    for index, (label, fn) in enumerate(steps):
        ok = fn()
        print(f"probe 注入 {label}: {'OK' if ok else 'SendInput 失败'}", flush=True)
        time.sleep(0.3)

    chars = []
    for _ in range(50):
        try:
            data = open(logfile, encoding="utf-8").read()
        except FileNotFoundError:
            data = ""
        if "END" in data:
            for line in data.splitlines():
                try:
                    chars.append(ast.literal_eval(line))
                except (ValueError, SyntaxError):
                    chars.append(line)
            break
        time.sleep(0.3)
    else:
        print("probe 失败：控制台窗口未回传按键（窗口可能未获得焦点）")
        return 1

    prefix = ("\xe0", "\x00")
    expected: list[object] = [prefix, "H", prefix, "P", "\r", "\x1b", "/", "\t", ("\x03", "CTRLC"), "q"]
    got = [c for c in chars if c != "END"]
    failures = 0
    if len(got) != len(expected):
        print(f"[失败] 收到 {len(got)} 个事件，期望 {len(expected)}: {[repr(c) for c in got]}")
        failures += 1
    else:
        for index, (g, e) in enumerate(zip(got, expected)):
            ok = g in e if isinstance(e, tuple) else g == e
            if not ok:
                print(f"[失败] 第 {index + 1} 个事件不符: {g!r}，期望 {e!r}")
                failures += 1
    if failures == 0:
        print("probe 通过：8 个注入按键全部到达控制台（含经 Unicode 通道的 '/'，与 codex 终端同一通路）")
    try:
        import shutil

        shutil.rmtree(workdir, ignore_errors=True)
    except OSError:
        pass
    return 0 if failures == 0 else 1


# ---------------------------------------------------------------------------


BANNER = """\
--------------------------------------------------------------
 STC-B → codex 控制器
 摇杆上/下=↑↓  中键=Enter  左=Esc  右=/  K1=Ctrl+C  K2=Tab  K3=Enter
 注意：按键注入到“当前聚焦窗口”，请保持 codex 终端在前台。
 若 codex 终端以管理员权限运行，本脚本需以相同权限启动。
--------------------------------------------------------------"""


def main() -> int:
    if sys.platform != "win32":
        print("仅支持 Windows。")
        return 1
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except AttributeError:
        pass

    ap = argparse.ArgumentParser(description="STC-B 板 → codex 控制器桥接", formatter_class=argparse.RawDescriptionHelpFormatter, epilog=BANNER)
    ap.add_argument("--port", help="串口名，如 COM5；缺省自动选择")
    ap.add_argument("--list-ports", action="store_true", help="列出可用串口后退出")
    ap.add_argument("--launch", action="store_true", help="先在新终端窗口启动 codex 再监听")
    ap.add_argument("--dry-run", action="store_true", help="只打印注入动作，不真正发送")
    ap.add_argument("--selftest", action="store_true", help="合成帧自测协议解析与映射（无需硬件）")
    ap.add_argument("--probe", action="store_true", help="弹窗实测 SendInput 注入（无需串口）")
    args = ap.parse_args()

    if args.list_ports:
        try:
            ports = list_ports()
        except ImportError:
            print("缺少 pyserial：pip install pyserial")
            return 1
        if not ports:
            print("未发现串口。")
        for device, desc in ports:
            print(f"{device}  {desc}")
        return 0
    if args.selftest:
        return selftest()
    if args.probe:
        return probe()

    try:
        import serial  # noqa: F401
    except ImportError:
        print("缺少 pyserial：pip install pyserial")
        return 1

    print(BANNER)
    if args.launch:
        launch_codex()
    try:
        port_name = pick_port(args.port)
        listen(port_name, args.dry_run)
    except KeyboardInterrupt:
        print("\n已退出。")
    return 0


if __name__ == "__main__":
    sys.exit(main())

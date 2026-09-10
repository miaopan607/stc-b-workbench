import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type AudioSource = "systemLoopback" | "microphone";
export type DetectionMode = "lowFrequency" | "beatEnhanced";
export type RuntimePhase = "idle" | "starting" | "running" | "error";

export interface SerialPortDescriptor {
  name: string;
  friendlyName: string;
}

export interface ReactiveConfig {
  portName: string;
  audioSource: AudioSource;
  detectionMode: DetectionMode;
  sensitivity: number;
  punch: number;
  ambientLimit: number;
  stereo: boolean;
}

export interface RuntimeSnapshot {
  phase: RuntimePhase;
  source: AudioSource | null;
  stereo: boolean;
  level: number;
  barCount: number;
  barCountLeft: number;
  barCountRight: number;
  sentFps: number;
  message: string;
}

export const listSerialPorts = () => invoke<SerialPortDescriptor[]>("list_serial_ports");
export const startReactive = (config: ReactiveConfig) => invoke<void>("start_reactive", { config });
export const stopReactive = () => invoke<void>("stop_reactive");
export const getReactiveState = () => invoke<RuntimeSnapshot>("get_reactive_state");

export const subscribeReactiveState = (onState: (state: RuntimeSnapshot) => void): Promise<UnlistenFn> =>
  listen<RuntimeSnapshot>("reactive-state", (event) => onState(event.payload));

export interface ControllerSnapshot {
  phase: ControllerPhase;
  profile: ControllerProfile;
  portName: string | null;
  injectedCount: number;
  badFrames: number;
  message: string;
}

export interface ControllerKeyEvent {
  board: string;
  action: string;
  injected: string | null;
  ok: boolean;
  injectedCount: number;
  badFrames: number;
}

export type ControllerPhase = "idle" | "starting" | "running";
export type ControllerProfile = "codex" | "media" | "vault";

export const startController = (portName: string, profile: ControllerProfile) =>
  invoke<void>("start_controller", { portName, profile });
export const stopController = () => invoke<void>("stop_controller");
export const getControllerState = () => invoke<ControllerSnapshot>("get_controller_state");

export const subscribeControllerState = (onState: (state: ControllerSnapshot) => void): Promise<UnlistenFn> =>
  listen<ControllerSnapshot>("controller-state", (event) => onState(event.payload));

export const subscribeControllerKey = (onKey: (event: ControllerKeyEvent) => void): Promise<UnlistenFn> =>
  listen<ControllerKeyEvent>("controller-key", (event) => onKey(event.payload));

// ---------------------------------------------------------------------------
// SafeKey 硬件认证 + 本地文件保险箱
// ---------------------------------------------------------------------------

export interface SafeKeyEvent {
  event: number;
  payload: number;
}

export interface VaultInfo {
  entries: number;
  payloadSize: number;
}

export interface VaultState {
  unlocked: boolean;
  vaultPath: string | null;
  unlockedDir: string | null;
  remainingSecs: number;
}

export const safekeyBegin = () => invoke<void>("safekey_begin");
export const safekeyEnd = () => invoke<void>("safekey_end");
export const vaultCreate = (source: string, dest: string, deleteSource: boolean) =>
  invoke<void>("vault_create", { source, dest, deleteSource });
export const vaultVerify = (path: string) => invoke<VaultInfo>("vault_verify", { path });
export const vaultUnlock = (path: string, outputRoot: string, autolockSecs: number) =>
  invoke<string>("vault_unlock", { path, outputRoot, autolockSecs });
export const vaultRelock = () => invoke<void>("vault_relock");
export const vaultLock = () => invoke<void>("vault_lock");
export const vaultState = () => invoke<VaultState>("vault_state");
export const vaultOpenDir = () => invoke<void>("vault_open_dir");

export const subscribeSafeKeyEvent = (onEvent: (event: SafeKeyEvent) => void): Promise<UnlistenFn> =>
  listen<SafeKeyEvent>("safekey-event", (event) => onEvent(event.payload));

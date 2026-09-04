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
}

export interface RuntimeSnapshot {
  phase: RuntimePhase;
  source: AudioSource | null;
  level: number;
  barCount: number;
  sentFps: number;
  message: string;
}

export const listSerialPorts = () => invoke<SerialPortDescriptor[]>("list_serial_ports");
export const startReactive = (config: ReactiveConfig) => invoke<void>("start_reactive", { config });
export const stopReactive = () => invoke<void>("stop_reactive");
export const getReactiveState = () => invoke<RuntimeSnapshot>("get_reactive_state");

export const subscribeReactiveState = (onState: (state: RuntimeSnapshot) => void): Promise<UnlistenFn> =>
  listen<RuntimeSnapshot>("reactive-state", (event) => onState(event.payload));

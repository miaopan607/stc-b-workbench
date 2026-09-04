mod audio;
mod models;
mod protocol;
mod serial;
mod service;

use models::{ReactiveConfig, RuntimeSnapshot, SerialPortDescriptor};
use service::ReactiveService;

use tauri::{AppHandle, Manager, State};

#[tauri::command]
fn list_serial_ports() -> Result<Vec<SerialPortDescriptor>, String> {
    serial::list_ports()
}

#[tauri::command]
fn start_reactive(
    app: AppHandle,
    state: State<'_, ReactiveService>,
    config: ReactiveConfig,
) -> Result<(), String> {
    state.start(&app, config)
}

#[tauri::command]
fn stop_reactive(state: State<'_, ReactiveService>) -> Result<(), String> {
    state.stop()
}

#[tauri::command]
fn get_reactive_state(state: State<'_, ReactiveService>) -> RuntimeSnapshot {
    state.snapshot()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ReactiveService::new())
        .invoke_handler(tauri::generate_handler![
            list_serial_ports,
            start_reactive,
            stop_reactive,
            get_reactive_state
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                let _ = window.app_handle().state::<ReactiveService>().stop();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

mod audio;
mod controller;
mod models;
mod protocol;
mod serial;
mod service;

use controller::ControllerService;
use models::{ControllerSnapshot, ReactiveConfig, RuntimeSnapshot, SerialPortDescriptor};
use service::ReactiveService;

use tauri::{AppHandle, Manager, State};

#[tauri::command]
fn list_serial_ports() -> Result<Vec<SerialPortDescriptor>, String> {
    serial::list_ports()
}

#[tauri::command]
fn start_reactive(
    app: AppHandle,
    reactive: State<'_, ReactiveService>,
    controller: State<'_, ControllerService>,
    config: ReactiveConfig,
) -> Result<(), String> {
    // 串口独占：启动音乐律动前先停掉控制器
    controller.stop(Some(&app))?;
    reactive.start(&app, config)
}

#[tauri::command]
fn stop_reactive(state: State<'_, ReactiveService>) -> Result<(), String> {
    state.stop()
}

#[tauri::command]
fn get_reactive_state(state: State<'_, ReactiveService>) -> RuntimeSnapshot {
    state.snapshot()
}

#[tauri::command]
fn start_controller(
    app: AppHandle,
    reactive: State<'_, ReactiveService>,
    controller: State<'_, ControllerService>,
    port_name: String,
) -> Result<(), String> {
    // 串口独占：启动控制器前先停掉音乐律动
    reactive.stop()?;
    controller.start(&app, &port_name)
}

#[tauri::command]
fn stop_controller(controller: State<'_, ControllerService>) -> Result<(), String> {
    controller.stop(None)
}

#[tauri::command]
fn get_controller_state(state: State<'_, ControllerService>) -> ControllerSnapshot {
    state.snapshot()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(ReactiveService::new())
        .manage(ControllerService::new())
        .invoke_handler(tauri::generate_handler![
            list_serial_ports,
            start_reactive,
            stop_reactive,
            get_reactive_state,
            start_controller,
            stop_controller,
            get_controller_state
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                let app = window.app_handle();
                let _ = app.state::<ReactiveService>().stop();
                let _ = app.state::<ControllerService>().stop(None);
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

mod audio;
mod controller;
mod models;
mod protocol;
mod serial;
mod service;
mod vault;

use controller::ControllerService;
use models::{
    ControllerProfile, ControllerSnapshot, ReactiveConfig, RuntimeSnapshot, SerialPortDescriptor,
};
use service::ReactiveService;
use vault::{VaultInfo, VaultService, VaultState};

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
    profile: ControllerProfile,
) -> Result<(), String> {
    // 串口独占：启动控制器前先停掉音乐律动
    reactive.stop()?;
    controller.start(&app, &port_name, profile)
}

#[tauri::command]
fn stop_controller(app: AppHandle, controller: State<'_, ControllerService>) -> Result<(), String> {
    // 断开板子前通知其退出 PIN 模式（板子可能不在，忽略失败）
    let _ = controller.send_safekey(false);
    controller.stop(Some(&app))
}

#[tauri::command]
fn get_controller_state(state: State<'_, ControllerService>) -> ControllerSnapshot {
    state.snapshot()
}

#[tauri::command]
fn safekey_begin(controller: State<'_, ControllerService>) -> Result<(), String> {
    controller.send_safekey(true)
}

#[tauri::command]
fn safekey_end(controller: State<'_, ControllerService>) -> Result<(), String> {
    // 控制器未运行时静默成功（板上 PIN 显示保留到重连/复位）
    controller.send_safekey(false).or(Ok(()))
}

#[tauri::command]
fn vault_create(
    vault: State<'_, VaultService>,
    source: String,
    dest: String,
    delete_source: bool,
) -> Result<(), String> {
    vault.create(
        std::path::Path::new(&source),
        std::path::Path::new(&dest),
        delete_source,
    )
}

#[tauri::command]
fn vault_verify(path: String) -> Result<VaultInfo, String> {
    vault::verify_info(std::path::Path::new(&path))
}

#[tauri::command]
fn vault_unlock(
    vault: State<'_, VaultService>,
    path: String,
    output_root: String,
    autolock_secs: u64,
) -> Result<String, String> {
    vault.unlock(
        std::path::Path::new(&path),
        std::path::Path::new(&output_root),
        autolock_secs,
    )
}

#[tauri::command]
fn vault_relock(vault: State<'_, VaultService>) -> Result<(), String> {
    vault.relock()
}

#[tauri::command]
fn vault_lock(vault: State<'_, VaultService>) -> Result<(), String> {
    vault.lock()
}

#[tauri::command]
fn vault_state(vault: State<'_, VaultService>) -> VaultState {
    vault.state()
}

#[tauri::command]
fn vault_open_dir(vault: State<'_, VaultService>) -> Result<(), String> {
    vault.open_unlocked_dir()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ReactiveService::new())
        .manage(ControllerService::new())
        .manage(VaultService::new())
        .invoke_handler(tauri::generate_handler![
            list_serial_ports,
            start_reactive,
            stop_reactive,
            get_reactive_state,
            start_controller,
            stop_controller,
            get_controller_state,
            safekey_begin,
            safekey_end,
            vault_create,
            vault_verify,
            vault_unlock,
            vault_relock,
            vault_lock,
            vault_state,
            vault_open_dir
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                let app = window.app_handle();
                let _ = app.state::<ReactiveService>().stop();
                let _ = app.state::<ControllerService>().stop(None);
                let _ = app.state::<VaultService>().lock();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

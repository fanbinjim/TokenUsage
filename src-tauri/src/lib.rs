use std::sync::Mutex;

use tauri::{Emitter, Manager, State};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tokenusage_core::{AppSettings, DataPaths, MultiRuntimeUsageSnapshot, SettingsPatch, SettingsStore, load_multi_runtime};

struct AppState {
    settings: Mutex<AppSettings>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BootstrapPayload {
    settings: AppSettings,
    snapshot: MultiRuntimeUsageSnapshot,
}

fn config_store(settings: &AppSettings) -> SettingsStore {
    SettingsStore::new(DataPaths::live(settings).app_config_directory)
}

fn load_usage(settings: &AppSettings) -> MultiRuntimeUsageSnapshot {
    let paths = DataPaths::live(settings);
    load_multi_runtime(&paths, settings)
}

#[tauri::command]
async fn bootstrap(state: State<'_, AppState>) -> Result<BootstrapPayload, String> {
    let settings = state.settings.lock().map_err(|_| "Application settings are unavailable.")?.clone();
    let snapshot = tauri::async_runtime::spawn_blocking({
        let settings = settings.clone();
        move || load_usage(&settings)
    }).await.map_err(|_| "Usage refresh task failed.")?;
    Ok(BootstrapPayload { settings, snapshot })
}

#[tauri::command]
async fn refresh_usage(state: State<'_, AppState>, _force: bool) -> Result<MultiRuntimeUsageSnapshot, String> {
    let settings = state.settings.lock().map_err(|_| "Application settings are unavailable.")?.clone();
    let snapshot = tauri::async_runtime::spawn_blocking(move || load_usage(&settings))
        .await.map_err(|_| "Usage refresh task failed.")?;
    Ok(snapshot)
}

#[tauri::command]
fn save_settings(state: State<'_, AppState>, patch: SettingsPatch) -> Result<AppSettings, String> {
    let mut settings = state.settings.lock().map_err(|_| "Application settings are unavailable.")?;
    settings.apply_patch(patch);
    config_store(&settings).save(&settings).map_err(|_| "Settings could not be saved.")?;
    Ok(settings.clone())
}

pub fn run() {
    let initial_settings = {
        let defaults = AppSettings::default();
        config_store(&defaults).load()
    };
    tauri::Builder::default()
        .manage(AppState { settings: Mutex::new(initial_settings) })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_single_instance::init(|app, _, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let keep_running = window.state::<AppState>()
                    .settings.lock().map(|settings| settings.keep_running_when_main_window_closed).unwrap_or(true);
                if keep_running {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_decorations(false);
                let _ = window.set_background_color(None);
            }
            let open = MenuItem::with_id(app, "open", "Open TokenUsage", true, None::<&str>)?;
            let refresh = MenuItem::with_id(app, "refresh", "Refresh", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &refresh, &settings, &separator, &quit])?;
            let icon = app.default_window_icon().cloned().ok_or("application icon is unavailable")?;
            TrayIconBuilder::with_id("tokenusage-tray")
                .icon(icon)
                .tooltip("TokenUsage")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main_window(app),
                    "settings" => {
                        show_main_window(app);
                        let _ = app.emit("tokenusage://open-settings", ());
                    }
                    "refresh" => {
                        show_main_window(app);
                        let _ = app.emit("tokenusage://refresh-requested", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![bootstrap, refresh_usage, save_settings])
        .run(tauri::generate_context!())
        .expect("error while running TokenUsage");
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

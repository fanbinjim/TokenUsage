use std::{sync::Mutex, time::Duration};

#[cfg(target_os = "windows")]
use std::{
    fs::OpenOptions,
    io::Write,
    sync::{
        OnceLock,
        atomic::{AtomicIsize, Ordering},
    },
    time::{Instant, SystemTime, UNIX_EPOCH},
};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::window::Color;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, Theme, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};
use tauri_plugin_autostart::ManagerExt;
use tokenusage_core::{
    APP_SETTINGS_SCHEMA_VERSION, AppSettings, DataPaths, MultiRuntimeUsageSnapshot, SettingsPatch,
    SettingsStore, load_multi_runtime,
};

#[cfg(target_os = "windows")]
use windows::{
    Win32::{
        Foundation::{LPARAM, LRESULT, POINT, RECT, WPARAM},
        Graphics::Dwm::{
            DWMWA_BORDER_COLOR, DWMWA_COLOR_NONE, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND,
            DwmSetWindowAttribute,
        },
        UI::{
            WindowsAndMessaging::{
                AppendMenuW, CallNextHookEx, CreatePopupMenu, DestroyMenu, FindWindowExW,
                FindWindowW, GW_OWNER, GWLP_HWNDPARENT, GetCursorPos, GetWindow, GetWindowRect,
                HWND_TOPMOST, MF_SEPARATOR, MF_STRING, MSLLHOOKSTRUCT, SWP_NOACTIVATE,
                SWP_NOMOVE, SWP_NOSIZE, SWP_SHOWWINDOW, SetForegroundWindow, SetWindowLongPtrW,
                SetWindowPos, SetWindowsHookExW, TPM_LEFTALIGN, TPM_RETURNCMD, TPM_RIGHTBUTTON,
                TrackPopupMenu, WH_MOUSE_LL, WM_RBUTTONUP,
            },
        },
    },
    core::{PCWSTR, w},
};

struct AppState {
    settings: Mutex<AppSettings>,
    snapshot: Mutex<Option<MultiRuntimeUsageSnapshot>>,
    #[cfg(target_os = "windows")]
    taskbar_widget_next_recreate_at: Mutex<Option<Instant>>,
}

const TASKBAR_WIDGET_LABEL: &str = "taskbar-widget";
const TASKBAR_WIDGET_WIDTH: f64 = 184.0;
const TASKBAR_WIDGET_VERTICAL_MARGIN: f64 = 3.0;
const TASKBAR_NOTIFICATION_FALLBACK_WIDTH: f64 = 320.0;
const USAGE_REFRESH_INTERVAL: Duration = Duration::from_secs(10);
#[cfg(target_os = "windows")]
const TASKBAR_WIDGET_RECREATE_DELAY: Duration = Duration::from_secs(5);
const TRANSIENT_REMOTE_FAILURE_CODES: &[&str] = &[
    "app_server_request_failed",
    "app_server_initialize_timeout",
    "app_server_partial_timeout",
    "app_server_unavailable",
];
// The taskbar widget is a single transparent WebView window. Explorer can rebuild
// Shell_TrayWnd, so its lifecycle is recovered independently from the main UI.

#[cfg(target_os = "windows")]
const TASKBAR_MENU_OPEN: usize = 1;
#[cfg(target_os = "windows")]
const TASKBAR_MENU_REFRESH: usize = 2;
#[cfg(target_os = "windows")]
const TASKBAR_MENU_SETTINGS: usize = 3;
#[cfg(target_os = "windows")]
const TASKBAR_MENU_QUIT: usize = 4;

#[cfg(target_os = "windows")]
static TASKBAR_WIDGET_APP: OnceLock<AppHandle> = OnceLock::new();
#[cfg(target_os = "windows")]
static TASKBAR_WIDGET_MOUSE_HOOK: AtomicIsize = AtomicIsize::new(0);

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
async fn bootstrap(app: AppHandle, state: State<'_, AppState>) -> Result<BootstrapPayload, String> {
    let settings = state
        .settings
        .lock()
        .map_err(|_| "Application settings are unavailable.")?
        .clone();
    if let Some(snapshot) = state
        .snapshot
        .lock()
        .map_err(|_| "Usage snapshot is unavailable.")?
        .clone()
    {
        return Ok(BootstrapPayload { settings, snapshot });
    }
    let snapshot = tauri::async_runtime::spawn_blocking({
        let settings = settings.clone();
        move || load_usage(&settings)
    })
    .await
    .map_err(|_| "Usage refresh task failed.")?;
    let snapshot = store_and_publish_snapshot(&app, &state, snapshot)?;
    Ok(BootstrapPayload { settings, snapshot })
}

#[tauri::command]
async fn refresh_usage(
    app: AppHandle,
    state: State<'_, AppState>,
    _force: bool,
) -> Result<MultiRuntimeUsageSnapshot, String> {
    let settings = state
        .settings
        .lock()
        .map_err(|_| "Application settings are unavailable.")?
        .clone();
    let snapshot = tauri::async_runtime::spawn_blocking(move || load_usage(&settings))
        .await
        .map_err(|_| "Usage refresh task failed.")?;
    store_and_publish_snapshot(&app, &state, snapshot)
}

#[tauri::command]
fn save_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    patch: SettingsPatch,
) -> Result<AppSettings, String> {
    if let Some(enabled) = patch.autostart_enabled {
        let autostart = app.autolaunch();
        if enabled {
            autostart
                .enable()
                .map_err(|error| format!("无法启用开机自启动：{error}"))?;
        } else {
            autostart
                .disable()
                .map_err(|error| format!("无法关闭开机自启动：{error}"))?;
        }
    }
    let mut settings = state
        .settings
        .lock()
        .map_err(|_| "Application settings are unavailable.")?;
    settings.apply_patch(patch);
    config_store(&settings)
        .save(&settings)
        .map_err(|_| "Settings could not be saved.")?;
    let updated = settings.clone();
    drop(settings);

    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_always_on_top(updated.keep_main_window_on_top);
        sync_main_window_appearance(&window, &updated.theme);
    }
    sync_taskbar_widget(&app, &updated);
    let _ = app.emit("tokenusage://settings-updated", &updated);
    Ok(updated)
}

fn reconcile_autostart_setting(app: &tauri::App) {
    let Ok(enabled) = app.autolaunch().is_enabled() else {
        return;
    };
    let state = app.state::<AppState>();
    let Ok(mut settings) = state.settings.lock() else {
        return;
    };
    if settings.autostart_enabled == enabled {
        return;
    }
    settings.autostart_enabled = enabled;
    let updated = settings.clone();
    drop(settings);
    let _ = config_store(&updated).save(&updated);
}

fn store_and_publish_snapshot(
    app: &AppHandle,
    state: &AppState,
    snapshot: MultiRuntimeUsageSnapshot,
) -> Result<MultiRuntimeUsageSnapshot, String> {
    let mut cached_snapshot = state
        .snapshot
        .lock()
        .map_err(|_| "Usage snapshot is unavailable.")?;

    if should_keep_cached_snapshot(cached_snapshot.as_ref(), &snapshot) {
        return cached_snapshot
            .clone()
            .ok_or_else(|| "Usage snapshot is unavailable.".to_owned());
    }

    *cached_snapshot = Some(snapshot.clone());
    drop(cached_snapshot);
    let _ = app.emit("tokenusage://snapshot", snapshot.clone());
    Ok(snapshot)
}

fn should_keep_cached_snapshot(
    cached: Option<&MultiRuntimeUsageSnapshot>,
    candidate: &MultiRuntimeUsageSnapshot,
) -> bool {
    cached.is_some_and(has_quota_data)
        && !has_quota_data(candidate)
        && candidate.runtimes.iter().any(|runtime| {
            runtime.snapshot.diagnostics.iter().any(|diagnostic| {
                TRANSIENT_REMOTE_FAILURE_CODES.contains(&diagnostic.code.as_str())
            })
        })
}

fn has_quota_data(snapshot: &MultiRuntimeUsageSnapshot) -> bool {
    snapshot.runtimes.iter().any(|runtime| {
        runtime.snapshot.primary.is_some() || runtime.snapshot.secondary.is_some()
    })
}

#[cfg(test)]
mod refresh_snapshot_tests {
    use super::*;
    use tokenusage_core::{
        DiagnosticItem, RateWindow, RuntimeScope, RuntimeStatus, RuntimeUsageSnapshot,
        SNAPSHOT_SCHEMA_VERSION, UsageSnapshot,
    };

    fn snapshot(has_quota_data: bool, diagnostic_codes: &[&str]) -> MultiRuntimeUsageSnapshot {
        let mut usage = UsageSnapshot::empty();
        if has_quota_data {
            usage.primary = Some(RateWindow::new(20.0, Some(10_080), None));
        }
        usage.diagnostics = diagnostic_codes
            .iter()
            .map(|code| DiagnosticItem::warning(*code, "test diagnostic"))
            .collect();
        let refreshed_at = usage.refreshed_at;
        MultiRuntimeUsageSnapshot {
            schema_version: SNAPSHOT_SCHEMA_VERSION,
            refreshed_at,
            runtimes: vec![RuntimeUsageSnapshot {
                scope: RuntimeScope::Codex,
                display_name: "Codex".to_owned(),
                status: if has_quota_data {
                    RuntimeStatus::Available
                } else {
                    RuntimeStatus::LocalOnly
                },
                snapshot: usage,
            }],
        }
    }

    #[test]
    fn failed_remote_refresh_keeps_the_last_valid_quota_snapshot() {
        let cached = snapshot(true, &[]);
        let failed = snapshot(false, &["app_server_partial_timeout"]);

        assert!(should_keep_cached_snapshot(Some(&cached), &failed));
    }

    #[test]
    fn refresh_with_quota_data_replaces_the_cached_snapshot() {
        let cached = snapshot(true, &[]);
        let refreshed = snapshot(true, &["app_server_request_failed"]);

        assert!(!should_keep_cached_snapshot(Some(&cached), &refreshed));
    }
}

fn sync_main_window_appearance(window: &WebviewWindow, theme: &str) {
    let _ = window.set_background_color(Some(Color(0, 0, 0, 0)));
    let native_theme = match theme {
        "light" => Some(Theme::Light),
        "dark" => Some(Theme::Dark),
        _ => None,
    };
    let _ = window.set_theme(native_theme);

    #[cfg(target_os = "windows")]
    {
        // Acrylic supplies the desktop blur; React provides the readable tint.
        let _ = window_vibrancy::apply_acrylic(window, None);
        if let Ok(hwnd) = window.hwnd() {
            let border_color = DWMWA_COLOR_NONE;
            let _ = unsafe {
                DwmSetWindowAttribute(
                    hwnd,
                    DWMWA_BORDER_COLOR,
                    &border_color as *const _ as _,
                    std::mem::size_of_val(&border_color) as u32,
                )
            };
            let corner_preference = DWMWCP_ROUND;
            let _ = unsafe {
                DwmSetWindowAttribute(
                    hwnd,
                    DWMWA_WINDOW_CORNER_PREFERENCE,
                    &corner_preference as *const _ as _,
                    std::mem::size_of_val(&corner_preference) as u32,
                )
            };
        }
    }
}

pub fn run() {
    let initial_settings = {
        let defaults = AppSettings::default();
        config_store(&defaults).load()
    };
    tauri::Builder::default()
        .manage(AppState {
            settings: Mutex::new(initial_settings),
            snapshot: Mutex::new(None),
            #[cfg(target_os = "windows")]
            taskbar_widget_next_recreate_at: Mutex::new(None),
        })
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
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
                if window.label() != "main" {
                    return;
                }
                let keep_running = window
                    .state::<AppState>()
                    .settings
                    .lock()
                    .map(|settings| settings.keep_running_when_main_window_closed)
                    .unwrap_or(true);
                if keep_running {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .setup(|app| {
            reconcile_autostart_setting(app);
            migrate_taskbar_anchor_settings(app);
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_decorations(false);
                let theme = app
                    .state::<AppState>()
                    .settings
                    .lock()
                    .map(|settings| settings.theme.clone())
                    .unwrap_or_else(|_| "system".into());
                sync_main_window_appearance(&window, &theme);
                let _ = window.show();
                let _ = window.set_focus();
            }
            create_taskbar_widget(&app.handle())?;
            install_taskbar_widget_mouse_hook(&app.handle());
            start_usage_refresh_loop(app.handle().clone());
            start_taskbar_position_loop(app.handle().clone());
            let open = MenuItem::with_id(app, "open", "Open TokenUsage", true, None::<&str>)?;
            let refresh = MenuItem::with_id(app, "refresh", "Refresh", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
            let separator = PredefinedMenuItem::separator(app)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &refresh, &settings, &separator, &quit])?;
            let icon = app
                .default_window_icon()
                .cloned()
                .ok_or("application icon is unavailable")?;
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
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                })
                .build(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            bootstrap,
            refresh_usage,
            save_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running TokenUsage");
}

fn start_usage_refresh_loop(app: AppHandle) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(USAGE_REFRESH_INTERVAL);
            let Some(state) = app.try_state::<AppState>() else {
                return;
            };
            let Ok(settings) = state.settings.lock().map(|settings| settings.clone()) else {
                continue;
            };
            let snapshot = load_usage(&settings);
            let _ = store_and_publish_snapshot(&app, &state, snapshot);
            sync_taskbar_widget(&app, &settings);
        }
    });
}

#[cfg(target_os = "windows")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct TaskbarLayoutSignature {
    taskbar_rect: [i32; 4],
    notification_rect: Option<[i32; 4]>,
    manual_offset: u32,
    enabled: bool,
}

#[cfg(target_os = "windows")]
fn window_rect(hwnd: windows::Win32::Foundation::HWND) -> Option<RECT> {
    let mut rect = RECT::default();
    unsafe { GetWindowRect(hwnd, &mut rect) }.ok()?;
    Some(rect)
}

#[cfg(target_os = "windows")]
fn rect_signature(rect: RECT) -> [i32; 4] {
    [rect.left, rect.top, rect.right, rect.bottom]
}

#[cfg(target_os = "windows")]
fn current_taskbar_layout_signature(settings: &AppSettings) -> Option<TaskbarLayoutSignature> {
    let taskbar = taskbar_handle()?;
    let taskbar_rect = window_rect(taskbar)?;
    let notification_rect = taskbar_notification_rect(taskbar).map(rect_signature);
    Some(TaskbarLayoutSignature {
        taskbar_rect: rect_signature(taskbar_rect),
        notification_rect,
        manual_offset: settings.taskbar_widget_right_offset,
        enabled: settings.taskbar_widget_enabled,
    })
}

#[cfg(target_os = "windows")]
fn start_taskbar_position_loop(app: AppHandle) {
    std::thread::spawn(move || {
        let mut previous = None;
        loop {
            std::thread::sleep(Duration::from_millis(500));
            let Some(state) = app.try_state::<AppState>() else {
                return;
            };
            let Ok(settings) = state.settings.lock().map(|settings| settings.clone()) else {
                continue;
            };
            let current = current_taskbar_layout_signature(&settings);
            let needs_widget_recovery = taskbar_widget_needs_recovery(
                settings.taskbar_widget_enabled,
                app.get_webview_window(TASKBAR_WIDGET_LABEL)
                    .and_then(|widget| widget.is_visible().ok()),
            );
            if current != previous || needs_widget_recovery {
                sync_taskbar_widget(&app, &settings);
            }
            previous = current;
        }
    });
}

#[cfg(target_os = "windows")]
fn taskbar_widget_needs_recovery(
    enabled: bool,
    widget_visible: Option<bool>,
) -> bool {
    enabled && widget_visible != Some(true)
}

#[cfg(not(target_os = "windows"))]
fn start_taskbar_position_loop(_app: AppHandle) {}

#[cfg(target_os = "windows")]
fn anchored_offset_from_legacy(legacy_offset: u32, notification_width: i32, scale: f64) -> u32 {
    if !scale.is_finite() || scale <= 0.0 {
        return 0;
    }
    let legacy_physical = (legacy_offset as f64 * scale).round() as i32;
    let anchored_physical = legacy_physical.saturating_sub(notification_width).max(0);
    ((anchored_physical as f64 / scale).round() as u32).min(3000)
}

#[cfg(target_os = "windows")]
fn migrate_taskbar_anchor_settings(app: &tauri::App) {
    let state = app.state::<AppState>();
    let Ok(mut settings) = state.settings.lock() else {
        return;
    };
    if settings.schema_version >= APP_SETTINGS_SCHEMA_VERSION {
        return;
    }

    let scale = app
        .primary_monitor()
        .ok()
        .flatten()
        .map(|monitor| monitor.scale_factor())
        .unwrap_or(1.0);
    let notification_width = taskbar_handle()
        .and_then(taskbar_notification_rect)
        .map(|rect| rect.right.saturating_sub(rect.left))
        .unwrap_or(0);
    settings.taskbar_widget_right_offset = anchored_offset_from_legacy(
        settings.taskbar_widget_right_offset,
        notification_width,
        scale,
    );
    settings.schema_version = APP_SETTINGS_SCHEMA_VERSION;
    let updated = settings.clone();
    drop(settings);
    let _ = config_store(&updated).save(&updated);
}

#[cfg(not(target_os = "windows"))]
fn migrate_taskbar_anchor_settings(app: &tauri::App) {
    let state = app.state::<AppState>();
    let Ok(mut settings) = state.settings.lock() else {
        return;
    };
    if settings.schema_version >= APP_SETTINGS_SCHEMA_VERSION {
        return;
    }
    settings.schema_version = APP_SETTINGS_SCHEMA_VERSION;
    settings.taskbar_widget_right_offset = 0;
    let updated = settings.clone();
    drop(settings);
    let _ = config_store(&updated).save(&updated);
}

#[cfg(target_os = "windows")]
fn create_taskbar_widget(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    if let Some(widget) = app.get_webview_window(TASKBAR_WIDGET_LABEL) {
        return Ok(widget);
    }

    let widget = WebviewWindowBuilder::new(
        app,
        TASKBAR_WIDGET_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title("TokenUsage Taskbar Widget")
    .inner_size(TASKBAR_WIDGET_WIDTH, 34.0)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .background_color(Color(0, 0, 0, 0))
    .always_on_top(true)
    .skip_taskbar(true)
    .focusable(true)
    .shadow(false)
    .visible(false)
    .on_page_load(|widget, payload| {
        if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
            let app = widget.app_handle();
            let settings = app
                .state::<AppState>()
                .settings
                .lock()
                .map(|settings| settings.clone())
                .unwrap_or_default();
            sync_taskbar_widget(app, &settings);
        }
    })
    .build()?;
    let _ = widget.set_background_color(Some(Color(0, 0, 0, 0)));
    Ok(widget)
}

#[cfg(target_os = "windows")]
fn ensure_taskbar_widget(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(widget) = app.get_webview_window(TASKBAR_WIDGET_LABEL) {
        return Some(widget);
    }

    let state = app.state::<AppState>();
    let Ok(mut next_recreate_at) = state.taskbar_widget_next_recreate_at.lock() else {
        record_taskbar_widget_event(app, "任务栏窗口重建状态不可用。");
        return None;
    };
    let now = Instant::now();
    if next_recreate_at.is_some_and(|retry_at| retry_at > now) {
        return None;
    }
    *next_recreate_at = Some(now + TASKBAR_WIDGET_RECREATE_DELAY);
    drop(next_recreate_at);

    match create_taskbar_widget(app) {
        Ok(widget) => {
            if let Ok(mut next_recreate_at) = state.taskbar_widget_next_recreate_at.lock() {
                *next_recreate_at = None;
            }
            record_taskbar_widget_event(app, "任务栏窗口已创建或已恢复。");
            Some(widget)
        }
        Err(error) => {
            record_taskbar_widget_event(app, &format!("任务栏窗口创建失败：{error}"));
            None
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn ensure_taskbar_widget(_app: &AppHandle) -> Option<WebviewWindow> { None }

#[cfg(target_os = "windows")]
fn sync_taskbar_widget(app: &AppHandle, settings: &AppSettings) {
    if !settings.taskbar_widget_enabled {
        if let Some(widget) = app.get_webview_window(TASKBAR_WIDGET_LABEL) {
            let _ = widget.hide();
        }
        return;
    }

    let Some(widget) = ensure_taskbar_widget(app) else {
        return;
    };
    if let Err(error) = position_top_level_taskbar_window(
        app,
        &widget,
        settings.taskbar_widget_right_offset,
    ) {
        record_taskbar_widget_event(app, &format!("任务栏窗口定位失败：{error}"));
        let _ = widget.hide();
    }
}

#[cfg(not(target_os = "windows"))]
fn sync_taskbar_widget(_app: &AppHandle, _settings: &AppSettings) {}

#[cfg(target_os = "windows")]
fn taskbar_handle() -> Option<windows::Win32::Foundation::HWND> {
    unsafe { FindWindowW(w!("Shell_TrayWnd"), PCWSTR::null()).ok() }
}

#[cfg(target_os = "windows")]
fn taskbar_notification_rect(taskbar: windows::Win32::Foundation::HWND) -> Option<RECT> {
    let notification =
        unsafe { FindWindowExW(Some(taskbar), None, w!("TrayNotifyWnd"), PCWSTR::null()).ok()? };
    let rect = window_rect(notification)?;
    (rect.right > rect.left && rect.bottom > rect.top).then_some(rect)
}

#[cfg(target_os = "windows")]
fn taskbar_anchor_screen_left(
    taskbar: windows::Win32::Foundation::HWND,
    taskbar_rect: RECT,
    scale_factor: f64,
) -> i32 {
    taskbar_notification_rect(taskbar)
        .map(|rect| rect.left)
        .filter(|left| *left >= taskbar_rect.left && *left <= taskbar_rect.right)
        .unwrap_or_else(|| {
            let fallback_width =
                (TASKBAR_NOTIFICATION_FALLBACK_WIDTH * scale_factor).round() as i32;
            taskbar_rect.right.saturating_sub(fallback_width)
        })
}

#[cfg(target_os = "windows")]
fn taskbar_widget_left(anchor_left: i32, width: i32, manual_offset: i32, minimum: i32) -> i32 {
    anchor_left
        .saturating_sub(manual_offset)
        .saturating_sub(width)
        .max(minimum)
}

#[cfg(target_os = "windows")]
fn keep_taskbar_widget_above_taskbar(widget: &WebviewWindow) -> Result<(), String> {
    let hwnd = widget
        .hwnd()
        .map_err(|error| format!("无法获取任务栏窗口句柄：{error}"))?;
    let taskbar = taskbar_handle().ok_or("未找到 Shell_TrayWnd。")?;

    // Explorer does not reliably accept a foreign WebView as a child window.
    // Keep the widget as an owned, top-level overlay instead: it stays above
    // the taskbar while preserving normal WebView painting and hit testing.
    let owner = unsafe { GetWindow(hwnd, GW_OWNER) }.ok();
    if owner != Some(taskbar) {
        unsafe { SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, taskbar.0 as isize) };
    }
    if unsafe { GetWindow(hwnd, GW_OWNER) }.ok() != Some(taskbar) {
        return Err("无法将任务栏窗口绑定到当前 Shell_TrayWnd。".into());
    }

    unsafe {
        SetWindowPos(
            hwnd,
            Some(HWND_TOPMOST),
            0,
            0,
            0,
            0,
            SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW,
        )
    }
    .map_err(|error| format!("无法将任务栏窗口置于任务栏上方：{error}"))?;
    Ok(())
}

#[cfg(target_os = "windows")]
fn install_taskbar_widget_mouse_hook(app: &AppHandle) {
    let _ = TASKBAR_WIDGET_APP.set(app.clone());
    if TASKBAR_WIDGET_MOUSE_HOOK.load(Ordering::Acquire) != 0 {
        return;
    }

    match unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(taskbar_widget_mouse_hook_proc), None, 0) } {
        Ok(hook) => {
            TASKBAR_WIDGET_MOUSE_HOOK.store(hook.0 as isize, Ordering::Release);
            record_taskbar_widget_event(app, "任务栏右键监听已启用。");
        }
        Err(error) => record_taskbar_widget_event(app, &format!("任务栏右键监听启动失败：{error}")),
    }
}

#[cfg(target_os = "windows")]
fn taskbar_widget_at_point(app: &AppHandle, point: POINT) -> Option<windows::Win32::Foundation::HWND> {
    let widget = app.get_webview_window(TASKBAR_WIDGET_LABEL)?;
    let hwnd = widget.hwnd().ok()?;
    let rect = window_rect(hwnd)?;
    (point.x >= rect.left && point.x < rect.right && point.y >= rect.top && point.y < rect.bottom)
        .then_some(hwnd)
}

#[cfg(target_os = "windows")]
unsafe extern "system" fn taskbar_widget_mouse_hook_proc(
    code: i32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    if code >= 0 && wparam.0 as u32 == WM_RBUTTONUP {
        let info = unsafe { (lparam.0 as *const MSLLHOOKSTRUCT).as_ref() };
        if let (Some(info), Some(app)) = (info, TASKBAR_WIDGET_APP.get()) {
            if taskbar_widget_at_point(app, info.pt).is_some() {
                let app_for_menu = app.clone();
                let point = info.pt;
                let _ = app.run_on_main_thread(move || {
                    if let Some(hwnd) = taskbar_widget_at_point(&app_for_menu, point) {
                        show_native_taskbar_widget_menu(&app_for_menu, hwnd);
                    }
                });
                return LRESULT(1);
            }
        }
    }

    unsafe { CallNextHookEx(None, code, wparam, lparam) }
}

#[cfg(target_os = "windows")]
fn record_taskbar_widget_event(app: &AppHandle, message: &str) {
    eprintln!("[taskbar-widget] {message}");
    let settings = app
        .state::<AppState>()
        .settings
        .lock()
        .map(|settings| settings.clone())
        .unwrap_or_default();
    let path = DataPaths::live(&settings)
        .app_config_directory
        .join("taskbar-widget.log");
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if !path.exists() {
        let _ = std::fs::write(&path, [0xEF, 0xBB, 0xBF]);
    }
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or_default();
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "[{timestamp}] {message}");
    }
}

#[cfg(target_os = "windows")]
fn show_native_taskbar_widget_menu(app: &AppHandle, hwnd: windows::Win32::Foundation::HWND) {
    let Ok(menu) = (unsafe { CreatePopupMenu() }) else {
        return;
    };
    let append_result = unsafe {
        AppendMenuW(menu, MF_STRING, TASKBAR_MENU_OPEN, w!("Open TokenUsage"))
            .and_then(|_| AppendMenuW(menu, MF_STRING, TASKBAR_MENU_REFRESH, w!("Refresh")))
            .and_then(|_| AppendMenuW(menu, MF_STRING, TASKBAR_MENU_SETTINGS, w!("Settings")))
            .and_then(|_| AppendMenuW(menu, MF_SEPARATOR, 0, PCWSTR::null()))
            .and_then(|_| AppendMenuW(menu, MF_STRING, TASKBAR_MENU_QUIT, w!("Quit")))
    };
    if append_result.is_err() {
        let _ = unsafe { DestroyMenu(menu) };
        return;
    }

    let mut cursor = POINT::default();
    if unsafe { GetCursorPos(&mut cursor) }.is_err() {
        let _ = unsafe { DestroyMenu(menu) };
        return;
    }
    let _ = unsafe { SetForegroundWindow(hwnd) };
    let command = unsafe {
        TrackPopupMenu(
            menu,
            TPM_LEFTALIGN | TPM_RETURNCMD | TPM_RIGHTBUTTON,
            cursor.x,
            cursor.y,
            None,
            hwnd,
            None,
        )
        .0 as usize
    };
    let _ = unsafe { DestroyMenu(menu) };

    match command {
        TASKBAR_MENU_OPEN => show_main_window(app),
        TASKBAR_MENU_SETTINGS => {
            show_main_window(app);
            let _ = app.emit("tokenusage://open-settings", ());
        }
        TASKBAR_MENU_REFRESH => {
            show_main_window(app);
            let _ = app.emit("tokenusage://refresh-requested", ());
        }
        TASKBAR_MENU_QUIT => app.exit(0),
        _ => {}
    }
}

#[cfg(target_os = "windows")]
fn position_top_level_taskbar_window(
    app: &AppHandle,
    window: &WebviewWindow,
    right_offset: u32,
) -> Result<(), String> {
    window
        .show()
        .map_err(|error| format!("无法显示任务栏窗口：{error}"))?;
    let monitor = app
        .primary_monitor()
        .map_err(|error| format!("无法读取主显示器：{error}"))?
        .ok_or("未找到主显示器。")?;
    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    let work_area = monitor.work_area();
    let screen_left = monitor_position.x;
    let screen_top = monitor_position.y;
    let screen_bottom = screen_top.saturating_add(monitor_size.height as i32);
    let work_top = work_area.position.y;
    let work_bottom = work_top.saturating_add(work_area.size.height as i32);

    let taskbar_top = if work_top > screen_top {
        Some(screen_top)
    } else if work_bottom < screen_bottom {
        Some(work_bottom)
    } else {
        None
    };
    let Some(taskbar_top) = taskbar_top else {
        return Err("当前仅支持位于屏幕顶部或底部的任务栏。".into());
    };
    let taskbar_bottom = if taskbar_top == screen_top {
        work_top
    } else {
        screen_bottom
    };
    let taskbar_height = taskbar_bottom.saturating_sub(taskbar_top);
    if taskbar_height <= 0 {
        return Err("任务栏高度无效。".into());
    }

    let scale_factor = monitor.scale_factor();
    let margin = (TASKBAR_WIDGET_VERTICAL_MARGIN * scale_factor).round() as i32;
    let width = (TASKBAR_WIDGET_WIDTH * scale_factor).round() as u32;
    let height = taskbar_height.saturating_sub(margin.saturating_mul(2)) as u32;
    if height == 0 {
        return Err("任务栏可用高度无效。".into());
    }
    let offset = (right_offset as f64 * scale_factor).round() as i32;
    let (taskbar, taskbar_rect) = taskbar_handle()
        .and_then(|taskbar| window_rect(taskbar).map(|rect| (taskbar, rect)))
        .ok_or("未找到可用的 Shell_TrayWnd。")?;
    let anchor_left = taskbar_anchor_screen_left(taskbar, taskbar_rect, scale_factor);
    let x = taskbar_widget_left(anchor_left, width as i32, offset, screen_left);
    let y = taskbar_top.saturating_add(margin);

    window
        .set_size(PhysicalSize::new(width, height))
        .map_err(|error| format!("无法设置任务栏窗口尺寸：{error}"))?;
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|error| format!("无法设置任务栏窗口位置：{error}"))?;
    keep_taskbar_widget_above_taskbar(window)
}

#[cfg(all(test, target_os = "windows"))]
mod taskbar_widget_tests {
    use super::*;

    #[test]
    fn taskbar_widget_position_tracks_the_notification_anchor() {
        let first = taskbar_widget_left(1_994, 184, 282, 0);
        let after_icon_change = taskbar_widget_left(1_946, 184, 282, 0);

        assert_eq!(first, 1_528);
        assert_eq!(after_icon_change, 1_480);
        assert_eq!(after_icon_change - first, -48);
    }

    #[test]
    fn legacy_right_edge_offset_is_migrated_without_moving_the_widget() {
        assert_eq!(anchored_offset_from_legacy(848, 566, 1.0), 282);
        assert_eq!(anchored_offset_from_legacy(848, 849, 1.5), 282);
        assert_eq!(anchored_offset_from_legacy(200, 566, 1.0), 0);
    }

    #[test]
    fn taskbar_widget_recovery_requires_an_enabled_missing_or_hidden_window() {
        assert!(taskbar_widget_needs_recovery(true, None));
        assert!(taskbar_widget_needs_recovery(true, Some(false)));
        assert!(!taskbar_widget_needs_recovery(true, Some(true)));
        assert!(!taskbar_widget_needs_recovery(false, None));
    }
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

use std::{sync::Mutex, time::Duration};

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::window::Color;
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, Theme, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};
use tokenusage_core::{
    AppSettings, DataPaths, MultiRuntimeUsageSnapshot, SettingsPatch, SettingsStore,
    load_multi_runtime,
};

#[cfg(target_os = "windows")]
use windows::{
    Win32::{
        Foundation::RECT,
        Graphics::Dwm::{DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_ROUND, DwmSetWindowAttribute},
        UI::WindowsAndMessaging::{
            FindWindowW, GA_PARENT, GW_OWNER, GWL_EXSTYLE, GWL_STYLE, GWLP_HWNDPARENT,
            GetAncestor, GetWindow, GetWindowLongPtrW, GetWindowRect, HWND_TOPMOST,
            SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER,
            SWP_SHOWWINDOW, SetParent, SetWindowLongPtrW, SetWindowPos, WS_CAPTION, WS_CHILD,
            WS_EX_TRANSPARENT, WS_MAXIMIZEBOX, WS_MINIMIZEBOX, WS_POPUP, WS_SYSMENU,
            WS_THICKFRAME,
        },
    },
    core::{PCWSTR, w},
};

struct AppState {
    settings: Mutex<AppSettings>,
    snapshot: Mutex<Option<MultiRuntimeUsageSnapshot>>,
}

const TASKBAR_WIDGET_LABEL: &str = "taskbar-widget";
const TASKBAR_INPUT_PROXY_LABEL: &str = "taskbar-input-proxy";
const TASKBAR_WIDGET_WIDTH: f64 = 184.0;
const TASKBAR_WIDGET_VERTICAL_MARGIN: f64 = 3.0;

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
    store_and_publish_snapshot(&app, &state, snapshot.clone())?;
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
    store_and_publish_snapshot(&app, &state, snapshot.clone())?;
    Ok(snapshot)
}

#[tauri::command]
fn save_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    patch: SettingsPatch,
) -> Result<AppSettings, String> {
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

#[tauri::command]
fn show_taskbar_widget_menu(window: WebviewWindow) -> Result<(), String> {
    if !matches!(
        window.label(),
        TASKBAR_WIDGET_LABEL | TASKBAR_INPUT_PROXY_LABEL
    ) {
        return Err("The taskbar widget menu is only available from the taskbar widget.".into());
    }

    let open = MenuItem::with_id(&window, "open", "Open TokenUsage", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let refresh = MenuItem::with_id(&window, "refresh", "Refresh", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let settings = MenuItem::with_id(&window, "settings", "Settings", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let separator = PredefinedMenuItem::separator(&window).map_err(|error| error.to_string())?;
    let quit = MenuItem::with_id(&window, "quit", "Quit", true, None::<&str>)
        .map_err(|error| error.to_string())?;
    let menu = Menu::with_items(&window, &[&open, &refresh, &settings, &separator, &quit])
        .map_err(|error| error.to_string())?;

    window.popup_menu(&menu).map_err(|error| error.to_string())
}

fn store_and_publish_snapshot(
    app: &AppHandle,
    state: &AppState,
    snapshot: MultiRuntimeUsageSnapshot,
) -> Result<(), String> {
    *state
        .snapshot
        .lock()
        .map_err(|_| "Usage snapshot is unavailable.")? = Some(snapshot.clone());
    let _ = app.emit("tokenusage://snapshot", snapshot);
    Ok(())
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
        })
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
            create_taskbar_widget(app)?;
            create_taskbar_input_proxy(app)?;
            start_usage_refresh_loop(app.handle().clone());
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
            save_settings,
            show_taskbar_widget_menu
        ])
        .run(tauri::generate_context!())
        .expect("error while running TokenUsage");
}

fn start_usage_refresh_loop(app: AppHandle) {
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(Duration::from_secs(120));
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
fn create_taskbar_widget(app: &tauri::App) -> tauri::Result<()> {
    if app.get_webview_window(TASKBAR_WIDGET_LABEL).is_some() {
        return Ok(());
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
    .always_on_top(false)
    .skip_taskbar(true)
    .focusable(false)
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
    Ok(())
}

#[cfg(target_os = "windows")]
fn create_taskbar_input_proxy(app: &tauri::App) -> tauri::Result<()> {
    if app
        .get_webview_window(TASKBAR_INPUT_PROXY_LABEL)
        .is_some()
    {
        return Ok(());
    }

    let proxy = WebviewWindowBuilder::new(
        app,
        TASKBAR_INPUT_PROXY_LABEL,
        WebviewUrl::App("index.html".into()),
    )
    .title("TokenUsage Taskbar Input Proxy")
    .inner_size(TASKBAR_WIDGET_WIDTH, 34.0)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .background_color(Color(0, 0, 0, 0))
    .always_on_top(true)
    .skip_taskbar(true)
    .focusable(false)
    .shadow(false)
    .visible(false)
    .on_page_load(|proxy, payload| {
        if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
            let app = proxy.app_handle();
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
    let _ = proxy.set_background_color(Some(Color(0, 0, 0, 0)));
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn create_taskbar_widget(_app: &tauri::App) -> tauri::Result<()> {
    Ok(())
}

#[cfg(not(target_os = "windows"))]
fn create_taskbar_input_proxy(_app: &tauri::App) -> tauri::Result<()> {
    Ok(())
}

#[cfg(target_os = "windows")]
fn sync_taskbar_widget(app: &AppHandle, settings: &AppSettings) {
    if let Some(widget) = app.get_webview_window(TASKBAR_WIDGET_LABEL) {
        if !settings.taskbar_widget_enabled {
            let _ = widget.hide();
        } else if !position_taskbar_widget(app, &widget, settings.taskbar_widget_right_offset) {
            let _ = widget.hide();
        }
    }

    sync_taskbar_input_proxy(app, settings);
}

#[cfg(target_os = "windows")]
fn sync_taskbar_input_proxy(app: &AppHandle, settings: &AppSettings) {
    let Some(proxy) = app.get_webview_window(TASKBAR_INPUT_PROXY_LABEL) else {
        return;
    };
    if !settings.taskbar_widget_enabled {
        let _ = proxy.hide();
    } else if position_top_level_taskbar_window(app, &proxy, settings.taskbar_widget_right_offset) {
        let _ = keep_taskbar_input_proxy_above_taskbar(&proxy);
    } else {
        let _ = proxy.hide();
    }
}

#[cfg(not(target_os = "windows"))]
fn sync_taskbar_widget(_app: &AppHandle, _settings: &AppSettings) {}

#[cfg(target_os = "windows")]
fn taskbar_handle() -> Option<windows::Win32::Foundation::HWND> {
    unsafe { FindWindowW(w!("Shell_TrayWnd"), PCWSTR::null()).ok() }
}

#[cfg(target_os = "windows")]
fn keep_taskbar_input_proxy_above_taskbar(proxy: &WebviewWindow) -> bool {
    let (Ok(hwnd), Some(taskbar)) = (proxy.hwnd(), taskbar_handle()) else {
        return false;
    };

    // Keep this as a top-level window: using SetParent would put it back into
    // Explorer's unreliable child hit-test path. An owned top-level window is
    // always above its owner, so taskbar activation cannot bury the proxy.
    let owner = unsafe { GetWindow(hwnd, GW_OWNER) }.ok();
    if owner != Some(taskbar) {
        unsafe { SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, taskbar.0 as isize) };
    }
    if unsafe { GetWindow(hwnd, GW_OWNER) }.ok() != Some(taskbar) {
        return false;
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
    .is_ok()
}

#[cfg(target_os = "windows")]
fn taskbar_child_window_style(style: isize) -> isize {
    // SetParent does not convert a top-level window into a true child window.
    // Clear every style that can produce a native non-client frame as a guard
    // against the WebView host restoring those styles during initialization.
    let non_client_style = (WS_POPUP.0
        | WS_CAPTION.0
        | WS_THICKFRAME.0
        | WS_SYSMENU.0
        | WS_MINIMIZEBOX.0
        | WS_MAXIMIZEBOX.0) as isize;
    (style & !non_client_style) | WS_CHILD.0 as isize
}

#[cfg(target_os = "windows")]
fn taskbar_widget_interactive_ex_style(style: isize) -> isize {
    style & !(WS_EX_TRANSPARENT.0 as isize)
}

#[cfg(target_os = "windows")]
fn restore_taskbar_widget_hit_testing(hwnd: windows::Win32::Foundation::HWND) {
    let ex_style = unsafe { GetWindowLongPtrW(hwnd, GWL_EXSTYLE) };
    let interactive_ex_style = taskbar_widget_interactive_ex_style(ex_style);
    if ex_style != interactive_ex_style {
        unsafe { SetWindowLongPtrW(hwnd, GWL_EXSTYLE, interactive_ex_style) };
    }
}

#[cfg(target_os = "windows")]
fn apply_taskbar_child_window_style(hwnd: windows::Win32::Foundation::HWND) -> isize {
    let style = unsafe { GetWindowLongPtrW(hwnd, GWL_STYLE) };
    let child_style = taskbar_child_window_style(style);
    if style != child_style {
        unsafe { SetWindowLongPtrW(hwnd, GWL_STYLE, child_style) };
    }
    style
}

#[cfg(target_os = "windows")]
fn restore_top_level_window_style(hwnd: windows::Win32::Foundation::HWND, style: isize) {
    unsafe { SetWindowLongPtrW(hwnd, GWL_STYLE, style) };
    let _ = unsafe {
        SetWindowPos(
            hwnd,
            None,
            0,
            0,
            0,
            0,
            SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER,
        )
    };
}

#[cfg(target_os = "windows")]
fn attach_taskbar_widget(widget: &WebviewWindow) -> bool {
    let (Ok(hwnd), Some(taskbar)) = (widget.hwnd(), taskbar_handle()) else {
        return false;
    };

    // Tauri implements cursor pass-through with WS_EX_TRANSPARENT. Clear a
    // stale flag left by older widget versions before the shell hit-tests it.
    restore_taskbar_widget_hit_testing(hwnd);

    // SetParent intentionally leaves WS_POPUP/WS_CHILD unchanged. A top-level
    // WebView hosted beneath Shell_TrayWnd can therefore occasionally expose a
    // caption and shrink its client area into the taskbar. Convert the style
    // first, then attach it as a real child window.
    let original_style = apply_taskbar_child_window_style(hwnd);
    if unsafe { GetAncestor(hwnd, GA_PARENT) } == taskbar {
        return true;
    }

    // SetParent may return a null previous parent even when the operation succeeds.
    let _ = unsafe { SetParent(hwnd, Some(taskbar)) };
    if (unsafe { GetAncestor(hwnd, GA_PARENT) }) == taskbar {
        true
    } else {
        // A style conversion is only valid for a child window.  Restore the
        // original top-level style so the independent-window fallback still works.
        restore_top_level_window_style(hwnd, original_style);
        false
    }
}

#[cfg(target_os = "windows")]
fn position_taskbar_widget(app: &AppHandle, widget: &WebviewWindow, right_offset: u32) -> bool {
    if attach_taskbar_widget(widget) {
        return position_embedded_taskbar_widget(app, widget, right_offset);
    }

    position_top_level_taskbar_window(app, widget, right_offset)
}

#[cfg(target_os = "windows")]
fn position_top_level_taskbar_window(
    app: &AppHandle,
    window: &WebviewWindow,
    right_offset: u32,
) -> bool {
    let _ = window.show();
    let Ok(Some(monitor)) = app.primary_monitor() else {
        return false;
    };
    let monitor_position = monitor.position();
    let monitor_size = monitor.size();
    let work_area = monitor.work_area();
    let screen_left = monitor_position.x;
    let screen_top = monitor_position.y;
    let screen_right = screen_left.saturating_add(monitor_size.width as i32);
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
        return false;
    };
    let taskbar_bottom = if taskbar_top == screen_top {
        work_top
    } else {
        screen_bottom
    };
    let taskbar_height = taskbar_bottom.saturating_sub(taskbar_top);
    if taskbar_height <= 0 {
        return false;
    }

    let scale_factor = monitor.scale_factor();
    let margin = (TASKBAR_WIDGET_VERTICAL_MARGIN * scale_factor).round() as i32;
    let width = (TASKBAR_WIDGET_WIDTH * scale_factor).round() as u32;
    let height = taskbar_height.saturating_sub(margin.saturating_mul(2)) as u32;
    if height == 0 {
        return false;
    }
    let offset = (right_offset as f64 * scale_factor).round() as i32;
    let x = screen_right
        .saturating_sub(offset)
        .saturating_sub(width as i32)
        .max(screen_left);
    let y = taskbar_top.saturating_add(margin);

    window.set_size(PhysicalSize::new(width, height)).is_ok()
        && window.set_position(PhysicalPosition::new(x, y)).is_ok()
}

#[cfg(target_os = "windows")]
fn position_embedded_taskbar_widget(
    app: &AppHandle,
    widget: &WebviewWindow,
    right_offset: u32,
) -> bool {
    let (Ok(hwnd), Some(taskbar), Ok(Some(monitor))) =
        (widget.hwnd(), taskbar_handle(), app.primary_monitor())
    else {
        return false;
    };
    let mut taskbar_rect = RECT::default();
    if unsafe { GetWindowRect(taskbar, &mut taskbar_rect) }.is_err() {
        return false;
    }

    let taskbar_width = taskbar_rect.right.saturating_sub(taskbar_rect.left);
    let taskbar_height = taskbar_rect.bottom.saturating_sub(taskbar_rect.top);
    if taskbar_width <= taskbar_height || taskbar_height <= 0 {
        return false;
    }

    let scale_factor = monitor.scale_factor();
    let margin = (TASKBAR_WIDGET_VERTICAL_MARGIN * scale_factor).round() as i32;
    let width = (TASKBAR_WIDGET_WIDTH * scale_factor).round() as i32;
    let height = taskbar_height.saturating_sub(margin.saturating_mul(2));
    let offset = (right_offset as f64 * scale_factor).round() as i32;
    let x = taskbar_width
        .saturating_sub(offset)
        .saturating_sub(width)
        .max(0);
    if width <= 0 || height <= 0 {
        return false;
    }

    unsafe {
        SetWindowPos(
            hwnd,
            None,
            x,
            margin,
            width,
            height,
            SWP_FRAMECHANGED | SWP_NOACTIVATE | SWP_NOZORDER | SWP_SHOWWINDOW,
        )
    }
    .is_ok()
}

#[cfg(all(test, target_os = "windows"))]
mod taskbar_widget_tests {
    use super::*;

    #[test]
    fn embedded_widget_style_is_a_frameless_child_window() {
        let top_level_style = (WS_POPUP.0
            | WS_CAPTION.0
            | WS_THICKFRAME.0
            | WS_SYSMENU.0
            | WS_MINIMIZEBOX.0
            | WS_MAXIMIZEBOX.0) as isize;
        let style = taskbar_child_window_style(top_level_style);

        assert_ne!(style & WS_CHILD.0 as isize, 0);
        assert_eq!(style & WS_POPUP.0 as isize, 0);
        assert_eq!(style & WS_CAPTION.0 as isize, 0);
        assert_eq!(style & WS_THICKFRAME.0 as isize, 0);
        assert_eq!(style & WS_SYSMENU.0 as isize, 0);
        assert_eq!(style & WS_MINIMIZEBOX.0 as isize, 0);
        assert_eq!(style & WS_MAXIMIZEBOX.0 as isize, 0);
    }

    #[test]
    fn embedded_widget_style_does_not_pass_pointer_events_through() {
        let style = taskbar_widget_interactive_ex_style(WS_EX_TRANSPARENT.0 as isize);

        assert_eq!(style & WS_EX_TRANSPARENT.0 as isize, 0);
    }
}

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

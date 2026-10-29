mod agent_runtime;
mod commands;
mod error;
mod launchctl;
mod plist_util;
mod service_overlays;
mod types;

use tauri::image::Image;
use tauri::menu::{MenuBuilder, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};

const TRAY_COMMAND_EVENT: &str = "daemonic:command";

fn show_main_window(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    let _ = app.show();
}

fn tray_icon_image(app: &tauri::App) -> Image<'static> {
    app.default_window_icon()
        .map(|icon| Image::new_owned(icon.rgba().to_vec(), icon.width(), icon.height()))
        .unwrap_or_else(|| Image::new_owned(vec![0, 0, 0, 0], 1, 1))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(target_os = "macos")]
            {
                app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                app.set_dock_visibility(false);
            }

            let open_item = MenuItem::with_id(app, "open", "Open Daemonic", true, None::<&str>)?;
            let refresh_item =
                MenuItem::with_id(app, "refresh", "Refresh Jobs", true, None::<&str>)?;
            let new_agent_item =
                MenuItem::with_id(app, "new_agent", "New Agent", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;

            let menu = MenuBuilder::new(app)
                .items(&[&open_item, &refresh_item, &new_agent_item, &quit_item])
                .build()?;

            let _tray = TrayIconBuilder::new()
                .icon(tray_icon_image(app))
                .tooltip("Daemonic")
                .menu(&menu)
                .show_menu_on_left_click(true)
                .on_tray_icon_event(|tray, event| match event {
                    TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    }
                    | TrayIconEvent::DoubleClick {
                        button: MouseButton::Left,
                        ..
                    } => {
                        show_main_window(tray.app_handle());
                    }
                    _ => {}
                })
                .build(app)?;

            show_main_window(app.handle());

            app.on_menu_event(|app_handle, event| match event.id().0.as_str() {
                "open" => {
                    show_main_window(app_handle);
                    let _ = app_handle.emit(TRAY_COMMAND_EVENT, "open");
                }
                "refresh" => {
                    show_main_window(app_handle);
                    let _ = app_handle.emit(TRAY_COMMAND_EVENT, "refresh");
                }
                "new_agent" => {
                    show_main_window(app_handle);
                    let _ = app_handle.emit(TRAY_COMMAND_EVENT, "new-agent");
                }
                "quit" => {
                    std::process::exit(0);
                }
                _ => {}
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_jobs,
            commands::get_job_detail,
            commands::start_job,
            commands::stop_job,
            commands::restart_job,
            commands::kickstart_job,
            commands::enable_job,
            commands::disable_job,
            commands::save_job,
            commands::save_raw_plist,
            commands::create_job,
            commands::delete_job,
            commands::check_service_health,
            commands::diagnose_service,
            commands::read_log_file,
            commands::clear_log_file,
            commands::open_log_in_editor,
            commands::get_home_dir,
            commands::reveal_in_finder,
            commands::get_agent_runtime_settings,
            commands::save_agent_runtime_settings,
            commands::get_app_preferences,
            commands::save_app_preferences,
            commands::get_agent_runtime_summary,
            commands::run_agent_prompt,
            commands::apply_approved_agent_action,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

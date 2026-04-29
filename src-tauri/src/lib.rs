mod commands;
mod config;
mod server;

use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            let store = config::ConfigStore::load(app.handle())?;
            let scope = app.asset_protocol_scope();
            for root in &store.snapshot().roots {
                let _ = scope.allow_directory(&root.path, true);
            }
            let http_state = server::HttpState::new();
            server::spawn(store.snapshot(), http_state.status.clone());
            app.manage(http_state);
            app.manage(store);

            // 系统托盘(macOS 菜单栏图标)
            let show_item = MenuItem::with_id(app, "tray_show", "显示窗口", true, None::<&str>)?;
            let reload_item = MenuItem::with_id(app, "tray_reload", "刷新", true, None::<&str>)?;
            let settings_item = MenuItem::with_id(app, "tray_settings", "设置", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "tray_quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(
                app,
                &[&show_item, &reload_item, &settings_item, &quit_item],
            )?;

            let tray_png = image::load_from_memory(include_bytes!("../icons/tray.png"))?
                .to_rgba8();
            let (tw, th) = (tray_png.width(), tray_png.height());
            let tray_icon = tauri::image::Image::new_owned(tray_png.into_raw(), tw, th);

            TrayIconBuilder::with_id("main-tray")
                .icon(tray_icon)
                .icon_as_template(true)
                .tooltip("Haystack")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        let app = tray.app_handle();
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.unminimize();
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                })
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "tray_show" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.unminimize();
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "tray_reload" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.unminimize();
                            let _ = w.show();
                            let _ = w.set_focus();
                            let _ = w.eval("location.reload()");
                        }
                    }
                    "tray_settings" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.unminimize();
                            let _ = w.show();
                            let _ = w.set_focus();
                            let _ = w.eval("document.getElementById('btnSettings')?.click()");
                        }
                    }
                    "tray_quit" => {
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            // 关闭按钮 → 隐藏窗口(应用驻留在菜单栏);只有托盘菜单"退出"才真正退出
            if let Some(window) = app.get_webview_window("main") {
                let w = window.clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                        api.prevent_close();
                        let _ = w.hide();
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_dir,
            commands::search,
            commands::create_file,
            commands::move_path,
            commands::copy_path,
            commands::reveal_in_file_manager,
            commands::open_terminal,
            commands::pick_folder,
            config::get_config,
            config::set_config,
            server::get_http_status,
            server::get_local_ip,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

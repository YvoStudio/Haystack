use tauri::{
    menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu},
    AppHandle, Manager,
};

// The default macOS menu owns Cmd+W and closes the window before the webview
// sees it. Route tab commands explicitly, while retaining native edit shortcuts.
pub fn install(app: &AppHandle) -> tauri::Result<()> {
    let app_menu = Submenu::with_items(
        app,
        "Haystack",
        true,
        &[
            &PredefinedMenuItem::about(
                app,
                None,
                Some(AboutMetadata {
                    name: Some("Haystack".into()),
                    version: Some(app.package_info().version.to_string()),
                    ..Default::default()
                }),
            )?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    let file_menu = Submenu::with_items(
        app,
        "文件",
        true,
        &[
            &MenuItem::with_id(app, "tab_new", "新建标签页", true, Some("CmdOrCtrl+T"))?,
            &MenuItem::with_id(app, "tab_close", "关闭标签页", true, Some("CmdOrCtrl+W"))?,
            &MenuItem::with_id(
                app,
                "tab_reopen",
                "重新打开关闭的标签页",
                true,
                Some("CmdOrCtrl+Shift+T"),
            )?,
        ],
    )?;
    let edit_menu = Submenu::with_items(
        app,
        "编辑",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let window_menu = Submenu::with_items(
        app,
        "窗口",
        true,
        &[
            &PredefinedMenuItem::minimize(app, None)?,
            &PredefinedMenuItem::maximize(app, None)?,
            &PredefinedMenuItem::fullscreen(app, None)?,
        ],
    )?;
    app.set_menu(Menu::with_items(
        app,
        &[&app_menu, &file_menu, &edit_menu, &window_menu],
    )?)?;
    app.on_menu_event(|app, event| {
        let action = match event.id().as_ref() {
            "tab_new" => "new",
            "tab_close" => "close",
            "tab_reopen" => "reopen",
            _ => return,
        };
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.eval(format!(
                "window.dispatchEvent(new CustomEvent('haystack:tab-action', {{ detail: '{action}' }}))"
            ));
        }
    });
    Ok(())
}

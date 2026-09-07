English | [中文](./README.md)

# Haystack

Cross-platform desktop file manager — turn any directory into a searchable, previewable, LAN-shareable file library. Built with Tauri 2 + Rust + a single-page HTML/JS frontend.

<p align="center"><img src="src/favicon.svg" width="128" alt="Haystack icon"/></p>

## Features

### Browsing
- **Multiple roots** — mount any number of root directories on one machine (works on macOS / Windows / Linux), with sidebar tree navigation
- **Folder tabs** — browse several folders at once, each with independent navigation history, view, sort, search query, selection and scroll position; sessions restore after reload or restart
- **Three views** — list / small thumbnails / large thumbnails, sortable by name / size / date
- **Live directory updates** — external file creation, deletion, renaming and edits automatically update lists, thumbnails and sidebar without reloading; tab state, selection, scroll and expanded branches are preserved, with focus refresh and periodic checks as fallbacks
- **Rich preview**
  - Images (gallery navigation + zoom: Ctrl+wheel / double-click / `+ −` buttons / `Cmd+0` to reset)
  - Video / audio (native webview playback)
  - Code / text (syntax highlighting via highlight.js)
  - Markdown (rendered with marked.js)
  - HTML (iframe preview + one-click view source)
  - PDF (rendered inline via WebKit)
  - Office / archives and other binaries (info card with metadata)
- **Search** — recursive filename search within a root, supports extension search like `.png`
- **Keyboard** — arrow keys, Enter, Backspace, Esc

### Using tabs
- Click `+` to open the current folder in a new tab; click a tab to switch, or its `×` / middle-click to close (one tab always remains)
- Right-click a folder or use its “···” menu to **open in a new tab**; supported in lists, thumbnails, sidebar, breadcrumbs, folder bookmarks and folder search results
- `Cmd/Ctrl+click` or middle-click a folder to open in the background; add `Shift` to activate the new tab
- `Cmd/Ctrl+T`: new tab; `Cmd/Ctrl+W`: close; `Cmd/Ctrl+Shift+T`: reopen the last closed tab
- `Ctrl+Tab` / `Ctrl+Shift+Tab`: next / previous; `Cmd/Ctrl+1…8`: select a tab; `Cmd/Ctrl+9`: last tab
- `Alt+Left/Right` or the toolbar arrows: back / forward in the current tab
- File previews and system-default Open remain unchanged; the window close button still hides the window
- Sessions use local WebView storage (`haystack_tabs_v1`); roots are matched by their actual paths when reordered, and tabs belonging to removed roots are skipped

### Operations
- **Open** — open any file with the system default app (Excel, Preview, Photoshop, ...)
- **New** — templates for text / Markdown / JSON / HTML / JS / Python / xlsx / docx and more
- **Move / Copy** — uses the native folder picker
- **Reveal in Finder / Explorer** — locate the item in the OS file manager
- **Open Terminal** — open a terminal at the file's directory (macOS Terminal / Windows Terminal / gnome-terminal etc.)
- **Bookmarks** — pin folders or files, persisted
- **Color tags** — red / orange / yellow / green / blue / purple / gray, filterable

### LAN sharing (built-in HTTP server)
- An HTTP server starts with the app, listening on port 8765 by default (incrementing to the next free port if busy)
- Each root can have its own URL prefix (e.g. `http://192.168.1.10:8765/projects`)
- Routes map URL prefixes to local directories, automatically exposing them to other machines on the network
- No nginx or other external HTTP server required
- Safety: only roots with an explicit `urlBase` are exposed; others are local-only

### Settings panel (gear button)
- Add / remove roots, configure URL prefixes
- **Check for updates** — shows the current version and checks the latest online release; after confirmation, downloads, verifies the signature, installs and restarts, with failure/retry feedback. Debug builds and unpackaged macOS binaries can check but cannot overwrite development directories
- New roots get the local LAN IP + current server port pre-filled as the URL base
- "Copy URL" button builds links using the URL prefix of the file's owning root, with proper handling of Chinese and special characters
- Save settings before installing an update; checking alone does not save or discard draft settings

### Desktop niceties
- **Menu-bar tray icon** (macOS) — left-click to show window, right-click for the menu (Show / Reload / Settings / Quit)
- **Close button** → hides the window; the app stays in the menu bar. Real quit is via the tray menu
- **Cmd+R / Ctrl+R** reloads the window content

## Requirements

- macOS 11+ (Apple Silicon / Intel)
- Windows 10+ (WebView2 — bundled with Win11; Win10 requires installation)
- Linux (WebKit2GTK)

## Install

Download the package for your platform from [Releases](https://github.com/YvoStudio/Haystack/releases).

### macOS

Download the `.dmg` (`aarch64` for Apple Silicon, `x64` for Intel) and drag it to your Applications folder. The app is Apple-signed and notarized.

### Windows

Download `.msi` or `.exe` and run it. Windows 11 ships with WebView2; on Windows 10 the installer will prompt to install it on first launch.

### Linux

- **Debian / Ubuntu**: download `.deb` and run `sudo dpkg -i Haystack_*.deb`
- **Other distros**: download `.AppImage`, `chmod +x` and run

Runtime deps: `webkit2gtk-4.1`, `libayatana-appindicator3` (for the tray icon). Ubuntu 22.04+ / Debian 12+ usually have these available out of the box.

### Build from source

Requires [Rust](https://rustup.rs/) 1.77+ and Node.js 18+:

```bash
git clone git@github.com:YvoStudio/Haystack.git
cd Haystack
npm install
npx tauri icon src/favicon.svg       # generate icons (first time only)
npm run dev                          # development
npm run build                        # produces a package for the current platform
```

**Extra dependencies on Linux** (Ubuntu/Debian):
```bash
sudo apt install -y libwebkit2gtk-4.1-dev libappindicator3-dev \
    librsvg2-dev patchelf libssl-dev libgtk-3-dev
```

**Windows requirements**: Visual Studio 2022 with the "Desktop development with C++" workload. WebView2 SDK is fetched automatically by Tauri.

### Tests

```bash
npm test                             # tab state / session unit tests
npx playwright install chromium      # first-time browser installation
npm run test:browser                  # browser regression tests (mock Tauri invoke)
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml directory_watch  # scope and real filesystem event tests
```

Browser tests do not replace native macOS/Windows/Linux verification of menus, shortcuts and window behavior.

## Architecture

- **Frontend** — `src/index.html`, no bundling step, plain ES6 + DOM
  - `tabs.js` — independent tab state, history and session restoration
  - `tab-ui.js` / `tabs.css` — tab bar, navigation, shortcuts and state switching
  - `live-updates.js` — debounced events, silent diff refresh, focus refresh and polling fallback
- **Backend** — Rust (`src-tauri/src/`):
  - `app_menu.rs` — macOS tab menu and native shortcut bridge
  - `directory_watch.rs` — non-recursive native watches for browsed folders and their ancestors, without scanning entire root trees
  - `commands.rs` — directory listing, search, file ops, terminal integration
  - `config.rs` — multi-root configuration persistence (`app_config_dir/config.json`)
  - `server.rs` — built-in `tiny_http` static file server, mounts routes per `urlBase`
- **IPC** — Tauri `invoke`; the compatibility shim `src/api.js` rewrites legacy `fetch('/www/_*')` calls to invoke, so the existing frontend code works unchanged

## Config file

```
~/Library/Application Support/io.github.yvo-zym.haystack/config.json    # macOS
%APPDATA%\io.github.yvo-zym.haystack\config.json                         # Windows
~/.config/io.github.yvo-zym.haystack/config.json                         # Linux
```

Format:

```json
{
  "roots": [
    { "name": "Home", "path": "/Users/me", "urlBase": null },
    { "name": "Projects", "path": "/Users/me/projects", "urlBase": "http://192.168.1.10/projects" }
  ]
}
```

You can edit it via the settings panel; the window reloads on save. HTTP routes do not hot-reload yet, so restart the app after changing `urlBase`.

## Contributing

Issues and pull requests are welcome. **By submitting a pull request you agree to assign the copyright and re-licensing rights (including the right to relicense under non-GPL terms) of your contribution to the project author, free of charge.** This keeps the project under a single copyright holder so the author can relicense the code if needed (e.g. for App Store distribution).

If you do not agree to this clause, please do not open a pull request; open an issue for discussion instead.

## License

GPL-3.0-or-later. See [LICENSE](./LICENSE) for the full text.

In short: you may use, modify, and redistribute this code freely, but **derivative works must also be released under a GPL-compatible license**. For closed-source / commercial use, contact the author about a commercial license.

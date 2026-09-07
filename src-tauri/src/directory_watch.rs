use std::{
    collections::HashSet,
    path::{Component, Path, PathBuf},
    sync::{Arc, Mutex},
};

use notify::{event::ModifyKind, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter, State};

use crate::config::{AppConfig, ConfigStore};

fn affects_directory(kind: EventKind) -> bool {
    // Reading the directory/preview must not itself trigger a refresh loop.
    !matches!(kind, EventKind::Access(_) | EventKind::Other)
        && !matches!(
            kind,
            EventKind::Modify(ModifyKind::Metadata(
                notify::event::MetadataKind::AccessTime
            ))
        )
}

struct WatchSet {
    watcher: Option<RecommendedWatcher>,
    paths: HashSet<PathBuf>,
}

pub struct DirectoryWatch(Arc<Mutex<WatchSet>>);

impl DirectoryWatch {
    pub fn new(app: AppHandle) -> Self {
        let watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
            if event
                .map(|event| affects_directory(event.kind))
                .unwrap_or(true)
            {
                // No filesystem paths are broadcast. The webview re-reads only
                // the currently browsed directories, with debounce and diffing.
                let _ = app.emit("haystack:directory-changed", ());
            }
        })
        .map_err(|error| eprintln!("[directory-watch] {error}; using refresh fallback"))
        .ok();
        Self(Arc::new(Mutex::new(WatchSet {
            watcher,
            paths: HashSet::new(),
        })))
    }
}

fn watch_paths(config: &AppConfig, requested: Vec<String>) -> Result<HashSet<PathBuf>, String> {
    if requested.len() > 512 {
        return Err("too many watched directories".into());
    }
    let roots: Vec<_> = config
        .roots
        .iter()
        .filter_map(|root| root.path.canonicalize().ok())
        .collect();
    let mut paths = HashSet::new();
    for raw in requested {
        let path = Path::new(&raw);
        if !path.is_absolute() || path.components().any(|part| part == Component::ParentDir) {
            return Err("watched directory must be an absolute path without '..'".into());
        }
        if !config.roots.iter().any(|root| path.starts_with(&root.path)) {
            return Err("watched directory is outside configured roots".into());
        }
        // A deleted folder cannot be watched. Its nearest existing ancestor
        // (within the configured scope) lets us detect recreation instead.
        if let Some(existing) = path.ancestors().find(|parent| parent.is_dir()) {
            let canonical = existing.canonicalize().map_err(|error| error.to_string())?;
            if roots.iter().any(|root| canonical.starts_with(root)) {
                paths.insert(canonical);
            }
        }
    }
    Ok(paths)
}

#[tauri::command]
pub async fn watch_directories(
    store: State<'_, ConfigStore>,
    watch: State<'_, DirectoryWatch>,
    paths: Vec<String>,
) -> Result<bool, String> {
    let config = store.snapshot();
    let inner = watch.0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let desired = watch_paths(&config, paths)?;
        let mut state = inner.lock().map_err(|error| error.to_string())?;
        let WatchSet { watcher, paths } = &mut *state;
        let Some(watcher) = watcher else {
            return Ok(false);
        };
        // Re-arm subscriptions: some OS backends drop a watch after a directory
        // is deleted/recreated. This also retries previously unsupported paths.
        for old in paths.drain() {
            let _ = watcher.unwatch(&old);
        }
        let mut complete = true;
        for path in desired {
            match watcher.watch(&path, RecursiveMode::NonRecursive) {
                Ok(()) => {
                    paths.insert(path);
                }
                Err(error) => {
                    eprintln!("[directory-watch] {}: {error}", path.display());
                    complete = false;
                }
            }
        }
        Ok(complete)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::RootConfig;
    use std::{
        fs,
        sync::mpsc,
        time::{Duration, Instant},
    };

    fn config(path: &Path) -> AppConfig {
        AppConfig {
            roots: vec![RootConfig {
                name: "Test".into(),
                path: path.into(),
                url_base: None,
            }],
        }
    }

    #[test]
    fn scopes_watches_and_falls_back_for_missing_directories() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        fs::create_dir(&root).unwrap();
        let cfg = config(&root);
        let paths = watch_paths(
            &cfg,
            vec![root.join("missing/child").to_string_lossy().into()],
        )
        .unwrap();
        assert_eq!(paths, HashSet::from([root.canonicalize().unwrap()]));
        assert!(watch_paths(&cfg, vec!["relative".into()]).is_err());
        assert!(watch_paths(&cfg, vec![root.join("../outside").to_string_lossy().into()]).is_err());
        assert!(watch_paths(&cfg, vec![temp.path().to_string_lossy().into()]).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn does_not_watch_a_symlink_target_outside_the_roots() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("root");
        let outside = temp.path().join("outside");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&outside).unwrap();
        let link = root.join("link");
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        assert!(
            watch_paths(&config(&root), vec![link.to_string_lossy().into()])
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn ignores_read_events_but_handles_writes_renames_and_deletions() {
        use notify::event::{AccessKind, CreateKind, ModifyKind, RemoveKind, RenameMode};
        assert!(!affects_directory(EventKind::Access(AccessKind::Any)));
        assert!(affects_directory(EventKind::Create(CreateKind::File)));
        assert!(affects_directory(EventKind::Modify(ModifyKind::Name(
            RenameMode::Both
        ))));
        assert!(affects_directory(EventKind::Remove(RemoveKind::File)));
    }

    #[test]
    fn native_watcher_reports_external_file_changes() {
        let temp = tempfile::tempdir().unwrap();
        let (tx, rx) = mpsc::channel();
        let mut watcher =
            notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                if let Ok(event) = event {
                    if affects_directory(event.kind) {
                        let _ = tx.send(event);
                    }
                }
            })
            .unwrap();
        let root = temp.path().canonicalize().unwrap();
        watcher.watch(&root, RecursiveMode::NonRecursive).unwrap();
        let file = root.join("new.txt");
        fs::write(&file, "new").unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let event = rx
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .expect("native filesystem event for the created file");
            if event.paths.contains(&file) {
                break;
            }
        }
    }
}

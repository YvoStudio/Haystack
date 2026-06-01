use std::fs;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use base64::{engine::general_purpose::STANDARD as B64, Engine};
use serde::Serialize;
use tauri::State;
use walkdir::WalkDir;

use crate::config::ConfigStore;

#[derive(Debug, Serialize)]
pub struct DirEntry {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub size: u64,
    pub mtime: String,
}

#[derive(Debug, Serialize)]
pub struct SearchHit {
    pub name: String,
    /// 绝对路径
    pub path: String,
    #[serde(rename = "type")]
    pub kind: &'static str,
    pub size: u64,
    pub mtime: String,
}

fn fmt_mtime(t: std::time::SystemTime) -> String {
    let secs = t.duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
    secs.to_string()
}

fn ensure_within_roots(store: &ConfigStore, p: &Path) -> Result<(), String> {
    if store.resolve_within_roots(p).is_none() {
        return Err(format!("path not within any configured root: {}", p.display()));
    }
    Ok(())
}

#[tauri::command]
pub fn list_dir(store: State<'_, ConfigStore>, path: String) -> Result<Vec<DirEntry>, String> {
    let target = PathBuf::from(&path);
    if !target.is_absolute() {
        return Err("path must be absolute".into());
    }
    ensure_within_roots(&store, &target)?;
    let read = fs::read_dir(&target).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for entry in read.flatten() {
        let Ok(meta) = entry.metadata() else { continue };
        let kind = if meta.is_dir() { "directory" } else { "file" };
        let mtime = meta.modified().map(fmt_mtime).unwrap_or_default();
        out.push(DirEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            kind,
            size: meta.len(),
            mtime,
        });
    }
    Ok(out)
}

/// 文件名搜索。`q` 以 `.` 开头视作扩展名搜索。
#[tauri::command]
pub fn search(
    store: State<'_, ConfigStore>,
    path: String,
    q: String,
) -> Result<Vec<SearchHit>, String> {
    let q = q.trim().to_lowercase();
    if q.is_empty() {
        return Err("missing q".into());
    }
    let root = PathBuf::from(&path);
    if !root.is_absolute() {
        return Err("path must be absolute".into());
    }
    ensure_within_roots(&store, &root)?;

    let is_ext = q.starts_with('.');
    let mut hits = Vec::new();
    let walker = WalkDir::new(&root)
        .max_depth(10)
        .into_iter()
        .filter_entry(|e| {
            // 跳过隐藏目录(.开头),根目录本身放行
            if e.depth() == 0 {
                return true;
            }
            !e.file_name().to_string_lossy().starts_with('.')
        });

    for entry in walker.flatten() {
        if hits.len() >= 200 {
            break;
        }
        let name = entry.file_name().to_string_lossy().to_lowercase();
        let matched = if is_ext {
            name.ends_with(&q)
        } else {
            name.contains(&q)
        };
        if !matched {
            continue;
        }
        let Ok(meta) = entry.metadata() else { continue };
        let kind = if meta.is_dir() { "directory" } else { "file" };
        hits.push(SearchHit {
            name: entry.file_name().to_string_lossy().into_owned(),
            path: entry.path().to_string_lossy().into_owned(),
            kind,
            size: meta.len(),
            mtime: meta.modified().map(fmt_mtime).unwrap_or_default(),
        });
    }
    hits.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(hits)
}

#[derive(serde::Deserialize)]
pub struct CreateArgs {
    /// 目标目录绝对路径
    pub dir: String,
    pub name: String,
    pub content: String,
    #[serde(default)]
    pub base64: bool,
}

#[tauri::command]
pub fn create_file(store: State<'_, ConfigStore>, args: CreateArgs) -> Result<String, String> {
    if args.name.is_empty() {
        return Err("missing name".into());
    }
    let dir = PathBuf::from(&args.dir);
    if !dir.is_absolute() {
        return Err("dir must be absolute".into());
    }
    let target = dir.join(&args.name);
    ensure_within_roots(&store, &target)?;
    if target.exists() {
        return Err("file already exists".into());
    }
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let bytes = if args.base64 {
        B64.decode(args.content.as_bytes()).map_err(|e| e.to_string())?
    } else {
        args.content.into_bytes()
    };
    fs::write(&target, bytes).map_err(|e| e.to_string())?;
    Ok(target.to_string_lossy().into_owned())
}

fn copy_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    if src.is_dir() {
        fs::create_dir_all(dst)?;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            let from = entry.path();
            let to = dst.join(entry.file_name());
            if entry.file_type()?.is_dir() {
                copy_recursive(&from, &to)?;
            } else {
                fs::copy(&from, &to)?;
            }
        }
        Ok(())
    } else {
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)?;
        }
        fs::copy(src, dst).map(|_| ())
    }
}

#[tauri::command]
pub fn move_path(
    store: State<'_, ConfigStore>,
    src: String,
    dest_dir: String,
) -> Result<(), String> {
    let src = PathBuf::from(&src);
    let dest_dir = PathBuf::from(&dest_dir);
    let name = src
        .file_name()
        .ok_or_else(|| "invalid src".to_string())?
        .to_owned();
    let dest = dest_dir.join(&name);
    ensure_within_roots(&store, &src)?;
    ensure_within_roots(&store, &dest)?;
    if dest.exists() {
        return Err("目标位置已存在同名文件".into());
    }
    if let Err(_) = fs::rename(&src, &dest) {
        // 跨分区:递归 copy + 删除
        copy_recursive(&src, &dest).map_err(|e| e.to_string())?;
        if src.is_dir() {
            fs::remove_dir_all(&src).map_err(|e| e.to_string())?;
        } else {
            fs::remove_file(&src).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn copy_path(
    store: State<'_, ConfigStore>,
    src: String,
    dest_dir: String,
) -> Result<(), String> {
    let src = PathBuf::from(&src);
    let dest_dir = PathBuf::from(&dest_dir);
    let name = src
        .file_name()
        .ok_or_else(|| "invalid src".to_string())?
        .to_owned();
    let dest = dest_dir.join(&name);
    ensure_within_roots(&store, &src)?;
    ensure_within_roots(&store, &dest)?;
    if dest.exists() {
        return Err("目标位置已存在同名文件".into());
    }
    copy_recursive(&src, &dest).map_err(|e| e.to_string())?;
    Ok(())
}

/// 在系统文件管理器中显示该路径(macOS Finder / Windows Explorer / Linux file manager)
#[tauri::command]
pub fn reveal_in_file_manager(
    store: State<'_, ConfigStore>,
    path: String,
) -> Result<(), String> {
    let p = PathBuf::from(&path);
    ensure_within_roots(&store, &p)?;

    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .args(["-R", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", path))
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        // 多数 Linux 发行版用 xdg-open 打开父目录(无原生 reveal)
        let parent = p.parent().unwrap_or(&p).to_string_lossy().into_owned();
        std::process::Command::new("xdg-open")
            .arg(parent)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn pick_folder(app: tauri::AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog().file().pick_folder(move |p| {
        let _ = tx.send(p);
    });
    let res = tauri::async_runtime::spawn_blocking(move || rx.recv().ok().flatten())
        .await
        .map_err(|e| e.to_string())?;
    Ok(res.map(|fp| fp.to_string()))
}

/// 检测目录受哪种版本控制管理:返回 "git" / "svn" / ""(无)。
/// 只看目录本身是否含 .git / .svn,符合"当前目录是否是 git/svn 目录"的语义。
#[tauri::command]
pub fn detect_vcs(store: State<'_, ConfigStore>, path: String) -> Result<&'static str, String> {
    let p = PathBuf::from(&path);
    ensure_within_roots(&store, &p)?;
    // .git 可能是目录(普通仓库)或文件(submodule / worktree),exists() 都能命中
    if p.join(".git").exists() {
        return Ok("git");
    }
    if p.join(".svn").exists() {
        return Ok("svn");
    }
    Ok("")
}

/// 在 `dir` 下跑一条命令,成功返回合并后的输出,失败返回错误输出。
fn run_in(dir: &Path, program: &str, args: &[&str]) -> Result<String, String> {
    let out = std::process::Command::new(program)
        .args(args)
        .current_dir(dir)
        .output()
        .map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout);
    let stderr = String::from_utf8_lossy(&out.stderr);
    let combined = format!("{stdout}{stderr}").trim().to_string();
    if out.status.success() {
        Ok(combined)
    } else {
        Err(if combined.is_empty() {
            format!("{program} 退出码非 0")
        } else {
            combined
        })
    }
}

/// 版本控制的"更新"。`mode`:
///   - "normal"  普通更新:git → `git pull --ff-only`;svn → `svn update`
///   - "discard" 丢弃本地修改再更新:
///       git → `git fetch --all` + `git reset --hard @{u}`(对齐上游,丢弃已跟踪文件的本地改动)
///       svn → `svn revert -R .` + `svn update`
/// 按顺序执行多条命令,任一失败即中止;返回各步非空输出拼接。
#[tauri::command]
pub fn vcs_update(
    store: State<'_, ConfigStore>,
    path: String,
    kind: String,
    mode: String,
) -> Result<String, String> {
    let p = PathBuf::from(&path);
    ensure_within_roots(&store, &p)?;
    let steps: Vec<Vec<&str>> = match (kind.as_str(), mode.as_str()) {
        ("git", "normal") => vec![vec!["pull", "--ff-only"]],
        ("git", "discard") => vec![vec!["fetch", "--all"], vec!["reset", "--hard", "@{u}"]],
        ("svn", "normal") => vec![vec!["update"]],
        ("svn", "discard") => vec![vec!["revert", "-R", "."], vec!["update"]],
        _ => return Err(format!("unknown vcs kind/mode: {kind}/{mode}")),
    };
    let program = if kind == "git" { "git" } else { "svn" };
    let mut outputs = Vec::new();
    for args in &steps {
        outputs.push(run_in(&p, program, args)?);
    }
    Ok(outputs
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(" | "))
}

/// 在指定目录下打开终端
#[tauri::command]
pub fn open_terminal(store: State<'_, ConfigStore>, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    ensure_within_roots(&store, &p)?;

    #[cfg(target_os = "macos")]
    {
        let escaped = path.replace('\'', "'\\''");
        let script = format!(
            "tell application \"Terminal\"\n  if not (exists window 1) then\n    reopen\n    delay 0.5\n    do script \"cd '{p}' && clear\" in window 1\n  else\n    do script \"cd '{p}' && clear\"\n  end if\n  activate\nend tell",
            p = escaped
        );
        std::process::Command::new("osascript")
            .args(["-e", &script])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        // 优先 Windows Terminal,失败回退 cmd
        let wt = std::process::Command::new("wt")
            .args(["-d", &path])
            .spawn();
        if wt.is_err() {
            std::process::Command::new("cmd")
                .args(["/C", "start", "cmd", "/K", &format!("cd /d {}", path)])
                .spawn()
                .map_err(|e| e.to_string())?;
        }
    }
    #[cfg(target_os = "linux")]
    {
        // 尝试常见终端
        let candidates = ["x-terminal-emulator", "gnome-terminal", "konsole", "xterm"];
        let mut last_err = None;
        for term in candidates {
            match std::process::Command::new(term)
                .args(["--working-directory", &path])
                .spawn()
            {
                Ok(_) => return Ok(()),
                Err(e) => last_err = Some(e),
            }
        }
        return Err(last_err.map(|e| e.to_string()).unwrap_or_else(|| "no terminal found".into()));
    }
    Ok(())
}

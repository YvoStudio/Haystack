use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RootConfig {
    /// 显示名(侧栏分组用)
    pub name: String,
    /// 绝对路径
    pub path: PathBuf,
    /// 可选 URL 前缀,用于"复制网络地址"。例:http://192.168.1.10/projects
    #[serde(default, rename = "urlBase")]
    pub url_base: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    #[serde(default)]
    pub roots: Vec<RootConfig>,
}

impl Default for AppConfig {
    fn default() -> Self {
        let home = dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"));
        let name = if cfg!(windows) {
            "User".to_string()
        } else {
            home.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("home")
                .to_string()
        };
        Self {
            roots: vec![RootConfig {
                name,
                path: home,
                url_base: None,
            }],
        }
    }
}

pub struct ConfigStore {
    inner: Mutex<AppConfig>,
    file: PathBuf,
}

impl ConfigStore {
    pub fn load(app: &AppHandle) -> anyhow::Result<Self> {
        let dir = app
            .path()
            .app_config_dir()
            .map_err(|e| anyhow::anyhow!("app_config_dir: {e}"))?;
        fs::create_dir_all(&dir)?;
        let file = dir.join("config.json");
        let cfg = if file.exists() {
            let txt = fs::read_to_string(&file)?;
            serde_json::from_str(&txt).unwrap_or_default()
        } else {
            let cfg = AppConfig::default();
            fs::write(&file, serde_json::to_string_pretty(&cfg)?)?;
            cfg
        };
        Ok(Self {
            inner: Mutex::new(cfg),
            file,
        })
    }

    pub fn snapshot(&self) -> AppConfig {
        self.inner.lock().unwrap().clone()
    }

    pub fn replace(&self, new_cfg: AppConfig) -> anyhow::Result<()> {
        fs::write(&self.file, serde_json::to_string_pretty(&new_cfg)?)?;
        *self.inner.lock().unwrap() = new_cfg;
        Ok(())
    }

    /// 校验绝对路径是否落在任一根目录下;返回命中的根。
    pub fn resolve_within_roots(&self, target: &Path) -> Option<RootConfig> {
        let cfg = self.inner.lock().unwrap();
        cfg.roots
            .iter()
            .find(|r| target.starts_with(&r.path))
            .cloned()
    }
}

#[tauri::command]
pub fn get_config(store: State<'_, ConfigStore>) -> AppConfig {
    store.snapshot()
}

#[tauri::command]
pub fn set_config(store: State<'_, ConfigStore>, config: AppConfig) -> Result<(), String> {
    store.replace(config).map_err(|e| e.to_string())
}

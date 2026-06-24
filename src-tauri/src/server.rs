use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;

use percent_encoding::percent_decode_str;
use serde::Serialize;
use tauri::State;
use tiny_http::{Header, Response, Server, StatusCode};

use crate::config::{AppConfig, RootConfig};

#[derive(Debug, Clone, Serialize, Default)]
pub struct HttpStatus {
    pub running: bool,
    pub port: Option<u16>,
    pub error: Option<String>,
}

pub struct HttpState {
    pub status: Arc<Mutex<HttpStatus>>,
}

impl HttpState {
    pub fn new() -> Self {
        Self {
            status: Arc::new(Mutex::new(HttpStatus::default())),
        }
    }
}

#[tauri::command]
pub fn get_http_status(state: State<'_, HttpState>) -> HttpStatus {
    state.status.lock().unwrap().clone()
}

/// 取本机在局域网中可路由的 IPv4 地址(连一个公网 UDP 不发包,读 local_addr)。
/// 失败时返回 "127.0.0.1"。
#[tauri::command]
pub fn get_local_ip() -> String {
    use std::net::UdpSocket;
    if let Ok(s) = UdpSocket::bind("0.0.0.0:0") {
        if s.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = s.local_addr() {
                return addr.ip().to_string();
            }
        }
    }
    "127.0.0.1".to_string()
}

/// Try ports in order, take the first that binds. Runs forever in a background thread.
pub fn spawn(cfg: AppConfig, status: Arc<Mutex<HttpStatus>>) {
    thread::spawn(move || {
        // 默认从高位端口起,避开 80/8080 等常用端口;被占用则自增到下一个空闲端口。
        const PORT_START: u16 = 8765;
        const PORT_END: u16 = 8784;
        let mut server: Option<Server> = None;
        let mut bound: Option<u16> = None;
        let mut last_err: Option<String> = None;
        for port in PORT_START..=PORT_END {
            let addr = format!("0.0.0.0:{port}");
            match Server::http(&addr) {
                Ok(s) => {
                    server = Some(s);
                    bound = Some(port);
                    break;
                }
                Err(e) => last_err = Some(format!("bind {port}: {e}")),
            }
        }
        let server = match server {
            Some(s) => s,
            None => {
                let mut g = status.lock().unwrap();
                g.running = false;
                g.error = last_err;
                return;
            }
        };
        {
            let mut g = status.lock().unwrap();
            g.running = true;
            g.port = bound;
            g.error = None;
        }
        let routes = build_routes(&cfg.roots);
        for req in server.incoming_requests() {
            let routes = routes.clone();
            thread::spawn(move || handle(req, routes));
        }
    });
}

#[derive(Clone)]
struct Route {
    /// 已规范化的 URL 路径前缀,前导 `/`,无尾 `/`(根则为空串)
    prefix: String,
    fs_root: PathBuf,
}

fn build_routes(roots: &[RootConfig]) -> Vec<Route> {
    let mut out: Vec<Route> = roots
        .iter()
        .map(|r| {
            // 显式 urlBase → 取其 path 段;否则用根目录的 basename
            // 兼容老配置:urlBase 缺协议头时,补 http:// 再解析
            let parsed_url = r.url_base.as_deref().and_then(|b| {
                let normalized = if b.starts_with("http://") || b.starts_with("https://") {
                    b.to_string()
                } else {
                    format!("http://{}", b)
                };
                url::Url::parse(&normalized).ok()
            });
            let prefix = match parsed_url {
                Some(u) => u.path().trim_end_matches('/').to_string(),
                None => default_prefix_for(&r.path),
            };
            Route {
                prefix,
                fs_root: r.path.clone(),
            }
        })
        .collect();
    out.sort_by_key(|r| std::cmp::Reverse(r.prefix.len()));
    out
}

fn default_prefix_for(path: &Path) -> String {
    let basename = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .trim();
    if basename.is_empty() {
        String::new()
    } else {
        format!("/{}", basename)
    }
}

fn handle(req: tiny_http::Request, routes: Vec<Route>) {
    let url_path = req.url().split('?').next().unwrap_or("/").to_string();
    let decoded = percent_decode_str(&url_path).decode_utf8_lossy().into_owned();

    let route = routes.iter().find(|r| {
        if r.prefix.is_empty() {
            true
        } else {
            decoded == r.prefix || decoded.starts_with(&format!("{}/", r.prefix))
        }
    });
    let Some(route) = route else {
        let _ = req.respond(text(404, "not found"));
        return;
    };

    let rel = decoded
        .strip_prefix(&route.prefix)
        .unwrap_or(&decoded)
        .trim_start_matches('/');
    let target = if rel.is_empty() {
        route.fs_root.clone()
    } else {
        route.fs_root.join(rel)
    };

    let canonical = match target.canonicalize() {
        Ok(p) => p,
        Err(_) => {
            let _ = req.respond(text(404, "not found"));
            return;
        }
    };
    let root_canonical = route.fs_root.canonicalize().unwrap_or(route.fs_root.clone());
    if !canonical.starts_with(&root_canonical) {
        let _ = req.respond(text(403, "forbidden"));
        return;
    }
    if canonical.is_dir() {
        let _ = req.respond(text(403, "directory listing disabled"));
        return;
    }

    let mime = mime_guess::from_path(&canonical).first_or_octet_stream();
    let essence = mime.essence_str();
    // 文本类型补 utf-8,避免中文乱码
    let content_type: String = if essence.starts_with("text/")
        || essence == "application/json"
        || essence == "application/javascript"
        || essence == "application/xml"
    {
        format!("{}; charset=utf-8", essence)
    } else {
        essence.to_string()
    };
    serve_file(req, &canonical, &content_type);
}

fn serve_file(req: tiny_http::Request, path: &Path, mime: &str) {
    let file = match File::open(path) {
        Ok(f) => f,
        Err(e) => {
            let _ = req.respond(text(404, &format!("{e}")));
            return;
        }
    };
    let len = file.metadata().ok().map(|m| m.len());
    let mut resp = Response::from_file(file);
    if let Ok(h) = Header::from_bytes(&b"Content-Type"[..], mime.as_bytes()) {
        resp.add_header(h);
    }
    if let Some(n) = len {
        if let Ok(h) = Header::from_bytes(&b"Content-Length"[..], n.to_string().as_bytes()) {
            resp.add_header(h);
        }
    }
    let _ = req.respond(resp);
}

fn text(code: u16, body: &str) -> Response<io::Cursor<Vec<u8>>> {
    Response::from_string(body.to_string())
        .with_status_code(StatusCode(code))
        .with_header(Header::from_bytes(&b"Content-Type"[..], &b"text/plain; charset=utf-8"[..]).unwrap())
}

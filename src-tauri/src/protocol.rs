// 自定义 URI 协议 `haystack-asset://localhost/<percent-encoded-abs-path>`
// 让 webview 不靠 HTTP 端口就能渲染本机文件(缩略图/预览),scope 由 ConfigStore 校验。
// 前端通过 Tauri JS API 的 convertFileSrc(absPath, "haystack-asset") 生成 URL。
use std::borrow::Cow;
use std::path::PathBuf;

use percent_encoding::percent_decode_str;
use tauri::http::{Request, Response, StatusCode};
use tauri::{Manager, UriSchemeContext, Wry};

use crate::config::ConfigStore;

pub const SCHEME: &str = "haystack-asset";

pub fn handle(
    ctx: UriSchemeContext<Wry>,
    request: Request<Vec<u8>>,
) -> Response<Cow<'static, [u8]>> {
    let app = ctx.app_handle();

    // URL 形如:
    //   macOS/Linux: haystack-asset://localhost/<encodeURIComponent(abs)>
    //   Windows    : http://haystack-asset.localhost/<encodeURIComponent(abs)>
    // path() 留着 percent encoding,先剥前导 / 再解码,自动恢复原始绝对路径。
    let raw = request.uri().path();
    let decoded = percent_decode_str(raw.trim_start_matches('/'))
        .decode_utf8_lossy()
        .into_owned();
    let target = PathBuf::from(&decoded);
    if !target.is_absolute() {
        return reply(StatusCode::BAD_REQUEST, "absolute path required");
    }

    let store = match app.try_state::<ConfigStore>() {
        Some(s) => s,
        None => return reply(StatusCode::INTERNAL_SERVER_ERROR, "config store missing"),
    };
    let cfg = store.snapshot();

    let in_root = cfg.roots.iter().any(|r| target.starts_with(&r.path));
    if !in_root {
        return reply(StatusCode::FORBIDDEN, "outside configured roots");
    }

    let canonical = match target.canonicalize() {
        Ok(p) => p,
        Err(_) => return reply(StatusCode::NOT_FOUND, "not found"),
    };
    let safe = cfg.roots.iter().any(|r| {
        let rc = r.path.canonicalize().unwrap_or_else(|_| r.path.clone());
        canonical.starts_with(&rc)
    });
    if !safe {
        return reply(StatusCode::FORBIDDEN, "symlink escape blocked");
    }
    if canonical.is_dir() {
        return reply(StatusCode::FORBIDDEN, "directory listing disabled");
    }

    let data = match std::fs::read(&canonical) {
        Ok(d) => d,
        Err(e) => return reply(StatusCode::NOT_FOUND, &e.to_string()),
    };

    let mime = mime_guess::from_path(&canonical).first_or_octet_stream();
    let essence = mime.essence_str();
    let content_type = if essence.starts_with("text/")
        || essence == "application/json"
        || essence == "application/javascript"
        || essence == "application/xml"
    {
        format!("{}; charset=utf-8", essence)
    } else {
        essence.to_string()
    };

    Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", content_type)
        .header("Access-Control-Allow-Origin", "*")
        .body(Cow::Owned(data))
        .unwrap_or_else(|_| reply(StatusCode::INTERNAL_SERVER_ERROR, "response build failed"))
}

fn reply(code: StatusCode, msg: &str) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(code)
        .header("Content-Type", "text/plain; charset=utf-8")
        .body(Cow::Owned(msg.as_bytes().to_vec()))
        .unwrap()
}

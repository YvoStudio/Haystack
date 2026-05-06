[English](./README.en.md) | 中文

# Haystack

跨平台桌面文件管理器 — 把任意目录变成可搜索、可预览、可通过局域网共享的文件库。基于 Tauri 2 + Rust + 单页 HTML/JS 实现。

<p align="center"><img src="src/favicon.svg" width="128" alt="Haystack icon"/></p>

## 主要特性

### 文件浏览
- **多根目录** — 一台机器可挂载任意数量的根(macOS/Windows/Linux 通用),侧栏树导航
- **三种视图** — 列表 / 小缩略图 / 大缩略图,可按名称/大小/日期排序
- **强大的预览**
  - 图片(画廊式翻页 + 缩放,Ctrl+滚轮 / 双击 / `+ −` 按钮 / `Cmd+0` 复位)
  - 视频 / 音频(原生 webview 播放)
  - 代码 / 文本(highlight.js 语法高亮)
  - Markdown(marked.js 渲染)
  - HTML(iframe 预览 + 一键查看源码)
  - PDF(WebKit 内嵌渲染)
  - Office / 压缩包等二进制(显示元信息卡)
- **搜索** — 单根内递归搜索,支持 `.png` 这种按后缀搜
- **键盘** — 方向键、Enter、Backspace、Esc

### 文件操作
- **打开** — 任意文件类型一键调系统默认应用(Excel、Preview、Photoshop...)
- **新建** — 文本 / Markdown / JSON / HTML / JS / Python / xlsx / docx 等模板
- **移动 / 复制** — 调原生目录选择器
- **在 Finder/Explorer 中显示** — 一键定位到原生文件管理器
- **打开终端** — 一键在文件所在目录开终端(macOS Terminal / Windows Terminal / Linux gnome-terminal 等)
- **书签收藏** — 文件夹/文件均可收藏,持久化
- **颜色标签** — 红/橙/黄/绿/蓝/紫/灰,可按色筛选

### 局域网共享(内置 HTTP 静态服务)
- 应用启动时自动开 HTTP 服务,优先绑 80,失败回退 8080
- 每个根目录可单独配 URL 前缀(如 `http://192.168.1.10/projects`)
- 服务路由按 URL 前缀映射到本地目录,自动暴露给同网段的其他机器
- 不依赖 nginx 等外部 HTTP 服务,装完即用
- 安全:只暴露你显式配过 urlBase 的根目录,其他根仅本地可见

### 设置面板(齿轮按钮)
- 增删根目录、配 URL 前缀
- 新建根目录时 URL 自动用本机局域网 IP + 当前服务端口预填
- "复制地址"按钮按文件所属根的 URL 前缀拼链接,支持中文/特殊字符

### 桌面体验
- **菜单栏托盘图标**(macOS) — 左键单击显示窗口、右键显示菜单(显示 / 设置 / 退出)
- **关闭按钮** → 隐藏到菜单栏,应用驻留后台,真正退出走托盘 → 退出
- **复制网络地址** — 点击文件的"复制地址"自动按所属根的 urlBase 生成 LAN URL

## 系统要求

- macOS 11+(Apple Silicon / Intel)
- Windows 10+(WebView2 — Win11 内置;Win10 需补装)
- Linux(WebKit2GTK)

## 安装

到 [Releases](https://github.com/YvoStudio/Haystack/releases) 下载对应平台的安装包。

### macOS

下载 `.dmg`(Apple Silicon 选 `aarch64`,Intel 选 `x64`),拖入"应用程序"文件夹。

由于 App 暂未做 Apple 签名 / 公证,首次打开时 macOS 可能提示 **"Haystack" 已损坏,无法打开**。这不是真的损坏,是浏览器下载时打了隔离标记,执行下面命令去掉即可:

```bash
xattr -dr com.apple.quarantine /Applications/Haystack.app
```

之后双击就能正常启动。如果只是提示"无法验证开发者",到「系统设置 → 隐私与安全性」滑到底点 **仍要打开** 也可以。

### Windows

下载 `.msi` 或 `.exe` 直接双击安装。Windows 11 自带 WebView2 运行时;Windows 10 首次启动如提示需要 WebView2,系统会自动引导安装。

### Linux

- **Debian / Ubuntu**:下载 `.deb`,`sudo dpkg -i Haystack_*.deb`
- **其他发行版**:下载 `.AppImage`,`chmod +x` 后直接运行

依赖:`webkit2gtk-4.1`、`libayatana-appindicator3`(系统托盘图标用)。Ubuntu 22.04+ / Debian 12+ 通常已自带或可一键安装。

### 自行编译

需要 [Rust](https://rustup.rs/) 1.77+ 和 Node.js 18+:

```bash
git clone git@github.com:YvoStudio/Haystack.git
cd Haystack
npm install
npx tauri icon src/favicon.svg       # 生成图标(首次)
npm run dev                          # 开发模式
npm run build                        # 出当前平台的安装包
```

**Linux 额外依赖**(Ubuntu/Debian):
```bash
sudo apt install -y libwebkit2gtk-4.1-dev libappindicator3-dev \
    librsvg2-dev patchelf libssl-dev libgtk-3-dev
```

**Windows 额外要求**:Visual Studio 2022 + "Desktop development with C++" 工作负载、WebView2 SDK(随 Tauri 自动拉取)。

## 技术栈

- **前端** — 单文件 `src/index.html`,无打包步骤,原生 ES6 + DOM API
- **后端** — Rust(`src-tauri/src/`):
  - `commands.rs` — 列目录、搜索、文件操作、终端集成
  - `config.rs` — 多根目录配置持久化(`app_config_dir/config.json`)
  - `server.rs` — 内置 `tiny_http` 静态文件服务,按 urlBase 自动挂载路由
- **前后通信** — Tauri `invoke`;前端兼容层 `src/api.js` 拦截旧 `fetch('/www/_*')` 路由到 invoke,旧前端代码免改

## 配置文件

```
~/Library/Application Support/io.github.yvo-zym.haystack/config.json    # macOS
%APPDATA%\io.github.yvo-zym.haystack\config.json                          # Windows
~/.config/io.github.yvo-zym.haystack/config.json                          # Linux
```

格式:

```json
{
  "roots": [
    { "name": "Home", "path": "/Users/me", "urlBase": null },
    { "name": "Projects", "path": "/Users/me/projects", "urlBase": "http://192.168.1.10/projects" }
  ]
}
```

可在设置面板修改,保存后窗口自动刷新。HTTP 路由热加载暂未实现,改动 urlBase 后建议重启应用。

## 贡献

欢迎提 Issue 和 PR。**提交 Pull Request 即视为你同意:将所贡献代码的版权及再许可权(包括以非 GPL 协议再发布的权利)无偿授予项目作者**。这样作者可以保持单一版权人身份,在未来需要时(如 App Store 上架等场景)对代码进行重新授权。

如不接受此条款,请不要提交 PR;可改为开 Issue 讨论。

## License

GPL-3.0-or-later。完整条款见 [LICENSE](./LICENSE)。

简单来说:你可以自由使用、修改、分发本项目的代码,但**衍生作品也必须以 GPL 兼容许可开源**。
如需用于闭源/商业产品,请联系作者讨论商业授权。

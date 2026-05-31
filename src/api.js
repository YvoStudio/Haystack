// Haystack Tauri 适配层
// 将旧 nginx 路径 /www/_xxx 翻译到 Tauri invoke 调用。
// 兼容策略:
//   - 旧前端的相对路径(rel)→ 拼接到"配置中第一个根目录"为绝对路径
//   - 旧前端期望返回 rel → 把后端返回的 abs 再剥成 rel
// 待多根 UI 上线后,此层可逐步退场。

(function () {
  const tauri = window.__TAURI__;
  if (!tauri) {
    console.warn('[haystack] Tauri global not available, running outside desktop shell');
    return;
  }
  const { invoke, convertFileSrc } = tauri.core;

  let cachedCfg = null;
  async function getCfg() {
    if (!cachedCfg) cachedCfg = await invoke('get_config');
    return cachedCfg;
  }
  async function getRoot(idx) {
    const cfg = await getCfg();
    const r = cfg.roots[idx] || cfg.roots[0];
    if (!r) throw new Error('no root configured');
    return r.path;
  }
  function rootIdxFromUrl(u) {
    const p = u.searchParams.get('root');
    return p != null ? parseInt(p) : 0;
  }
  function isAbs(p) {
    return p.startsWith('/') || /^[A-Za-z]:[\\/]/.test(p);
  }
  function joinAbs(root, rel) {
    if (!rel) return root;
    if (isAbs(rel)) return rel;
    const sep = root.endsWith('/') || root.endsWith('\\') ? '' : '/';
    return root + sep + rel;
  }
  function toRel(root, abs) {
    if (abs.startsWith(root)) {
      let r = abs.slice(root.length);
      if (r.startsWith('/') || r.startsWith('\\')) r = r.slice(1);
      return r;
    }
    return abs;
  }

  // Cmd+R / Ctrl+R 刷新页面(Tauri 默认不绑此键)
  window.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'r' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      location.reload();
    }
  });

  window.__haystackInvalidateCfg = () => { cachedCfg = null; };

  // ============================================================
  // 资源协议:走自定义 URI scheme `haystack-asset://`,scope 在 Rust 端校验。
  // 不再依赖 HTTP 端口、不再有 startup 竞态;
  // server.rs 上的 HTTP 仍保留给"复制网络地址"(LAN/外部分享场景)。
  // ============================================================
  let cfgSync = null;
  let firstRootSync = null;
  let rootsSync = [];
  let localIpSync = null;
  let httpPortSync = null;

  window.__haystack = { invoke, getCfg, _rootsSync: rootsSync, _cfgSyncRef: () => cfgSync };

  // 把"navPath (rootIdx/rel) 或 rel"解析成绝对路径
  window.__haystackAbs = async function (navPath) {
    if (!navPath) return await getRoot(0);
    if (isAbs(navPath)) return navPath;
    const m = navPath.match(/^(\d+)\/(.*)$/);
    if (m) return joinAbs(await getRoot(parseInt(m[1])), m[2] || '');
    return joinAbs(await getRoot(0), navPath);
  };

  getCfg().then(cfg => {
    cfgSync = cfg;
    firstRootSync = cfg.roots[0]?.path || null;
    rootsSync = cfg.roots.map(r => r.path);
    if (document.body) scan(document.body);
  });
  invoke('get_local_ip').then(ip => { localIpSync = ip; }).catch(() => {});
  // 仍然轮询一次拿到端口,只给 __haystackBuildUrl(复制网络地址)用,不再阻塞 asset
  (function pollHttp(tries) {
    invoke('get_http_status').then(s => {
      if (s && s.port) httpPortSync = s.port;
      else if (tries > 0) setTimeout(() => pollHttp(tries - 1), 200);
    }).catch(() => {
      if (tries > 0) setTimeout(() => pollHttp(tries - 1), 200);
    });
  })(50);

  // 把"navPath (rootIdx/rel) 或 rel"生成 webview 能 fetch 的 asset URL
  function relToAssetUrl(rel) {
    if (!firstRootSync) return null;
    // 解析 root 前缀
    const m = rel.match(/^(\d+)\/(.*)$/);
    let rootPath, actualRel;
    if (m && rootsSync[m[1]]) {
      rootPath = rootsSync[parseInt(m[1])];
      actualRel = m[2];
    } else {
      rootPath = firstRootSync;
      actualRel = rel;
    }
    const abs = isAbs(actualRel) ? actualRel : joinAbs(rootPath, actualRel);
    return convertFileSrc(abs, 'haystack-asset');
  }
  function rewriteSrcAttr(el) {
    if (!el || !el.getAttribute) return;
    const s = el.getAttribute('src');
    if (!s) return;
    // 跳过已重写、外链、data URL
    if (s.startsWith('haystack-asset:') || s.startsWith('asset:') || s.startsWith('http') || s.startsWith('data:') || s.startsWith('blob:')) return;
    if (!s.startsWith('/www/') && !s.startsWith('www/')) return;
    if (s.startsWith('/www/_')) return; // 接口路径,不是文件
    let rel = s.replace(/^\/?www\//, '');
    try { rel = decodeURIComponent(rel); } catch {}
    const url = relToAssetUrl(rel);
    if (url) el.setAttribute('src', url);
  }
  function scan(node) {
    if (node.nodeType !== 1) return;
    if (node.matches && node.matches('img,video,audio,source,iframe')) rewriteSrcAttr(node);
    if (node.querySelectorAll) node.querySelectorAll('img,video,audio,source,iframe').forEach(rewriteSrcAttr);
  }
  // 监听新增节点 + src 属性变更(图片预览换张需要)
  // 重写函数对已是 asset:// 的 src 直接 return,不会无限递归
  const mo = new MutationObserver(muts => {
    for (const m of muts) {
      if (m.type === 'childList') m.addedNodes.forEach(scan);
      else if (m.type === 'attributes') rewriteSrcAttr(m.target);
    }
  });
  document.addEventListener('DOMContentLoaded', () => {
    scan(document.body);
    mo.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src'],
    });
  });

  // ============================================================
  // 统一"打开"行为:
  //   - 可在 webview 内渲染的类型 → 新建 Tauri 子窗口(等效新标签)
  //   - 其他类型 → 调系统默认程序(opener.openPath)
  //   - 外链 http(s) → 系统默认浏览器(opener.openUrl)
  // 通过劫持 window.open 实现,index.html 现有 window.open(...) 调用零修改
  // ============================================================
  async function openLocal(rel) {
    let cleaned = rel.replace(/^\/?www\//, '');
    try { cleaned = decodeURIComponent(cleaned); } catch {}
    const m = cleaned.match(/^(\d+)\/(.*)$/);
    let rootIdx = 0, actualRel = cleaned;
    if (m) { rootIdx = parseInt(m[1]); actualRel = m[2]; }
    const root = await getRoot(rootIdx);
    const abs = isAbs(actualRel) ? actualRel : joinAbs(root, actualRel);
    await invoke('plugin:opener|open_path', { path: abs, with: null });
  }
  const origOpen = window.open.bind(window);
  window.open = function (url, target, features) {
    if (typeof url === 'string') {
      if (/^https?:/i.test(url)) {
        invoke('plugin:opener|open_url', { url, with: null }).catch(console.error);
        return null;
      }
      if (url.startsWith('/www/') && !url.startsWith('/www/_')) {
        openLocal(url).catch(console.error);
        return null;
      }
    }
    return origOpen(url, target, features);
  };

  document.addEventListener('click', async (ev) => {
    // 快速排除非链接点击,避免 closest 全树遍历开销
    const t = ev.target;
    if (!t || t.nodeType !== 1) return;
    const a = t.tagName === 'A' ? t : (t.closest && t.closest('a[href]'));
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href) return;
    // 处理本地资源链接 + target=_blank 链接
    const isWwwLink = href.startsWith('/www/') && !href.startsWith('/www/_');
    const isExternal = /^https?:/i.test(href);
    if (!isWwwLink && !(isExternal && a.target === '_blank')) return;
    ev.preventDefault();
    try {
      if (isExternal) {
        await invoke('plugin:opener|open_url', { url: href, with: null });
      } else {
        await openLocal(href);
      }
    } catch (e) {
      console.error('[haystack] open failed', e);
    }
  }, true);

  function epochToIso(s) {
    if (!s) return '';
    const n = Number(s);
    if (!Number.isFinite(n)) return s;
    return new Date(n * 1000).toUTCString();
  }
  function jsonResp(obj, status = 200) {
    return new Response(JSON.stringify(obj), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  async function readBody(init) {
    if (!init || !init.body) return {};
    try { return JSON.parse(init.body); } catch { return {}; }
  }
  async function tryInvoke(fn) {
    try { return jsonResp(await fn()); }
    catch (e) { return jsonResp({ error: String(e && e.message || e) }, 500); }
  }

  const orig = window.fetch.bind(window);
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input.url;
    let u;
    try { u = new URL(url, 'http://_'); } catch { return orig(input, init); }
    const p = u.pathname;

    if (p === '/www/_list_all') {
      const rel = u.searchParams.get('dir') || '';
      const rootIdx = rootIdxFromUrl(u);
      const root = await getRoot(rootIdx);
      return tryInvoke(async () => {
        const items = await invoke('list_dir', { path: joinAbs(root, rel) });
        return items.map(it => ({ ...it, mtime: epochToIso(it.mtime) }));
      });
    }

    if (p === '/www/_search') {
      const rel = u.searchParams.get('dir') || '';
      const q = u.searchParams.get('q') || '';
      const rootIdx = rootIdxFromUrl(u);
      const root = await getRoot(rootIdx);
      return tryInvoke(async () => {
        const hits = await invoke('search', { path: joinAbs(root, rel), q });
        return hits.map(h => ({ ...h, path: toRel(root, h.path), mtime: epochToIso(h.mtime) }));
      });
    }

    if (p === '/www/_create') {
      const body = await readBody(init);
      const rootIdx = rootIdxFromUrl(u);
      const root = await getRoot(rootIdx);
      return tryInvoke(async () => {
        await invoke('create_file', {
          args: {
            dir: joinAbs(root, body.dir || ''),
            name: body.name || '',
            content: body.content || '',
            base64: !!body.base64,
          },
        });
        return { ok: true };
      });
    }

    if (p === '/www/_terminal') {
      const body = await readBody(init);
      return tryInvoke(async () => {
        await invoke('open_terminal', { path: body.path });
        return { ok: true };
      });
    }

    if (p === '/www/_finder') {
      const body = await readBody(init);
      return tryInvoke(async () => {
        await invoke('reveal_in_file_manager', { path: body.path });
        return { ok: true };
      });
    }

    if (p === '/www/_move') {
      const body = await readBody(init);
      return tryInvoke(async () => {
        await invoke('move_path', { src: body.src, destDir: body.destDir });
        return { ok: true };
      });
    }

    if (p === '/www/_copy') {
      const body = await readBody(init);
      return tryInvoke(async () => {
        await invoke('copy_path', { src: body.src, destDir: body.destDir });
        return { ok: true };
      });
    }

    // 静态文件读取(md/text/code/html 预览等):/www/<rel> → 走内置 HTTP
    if (p.startsWith('/www/') && !p.startsWith('/www/_')) {
      let rel = p.slice('/www/'.length);
      try { rel = decodeURIComponent(rel); } catch {}
      const url = relToAssetUrl(rel);
      if (url) return orig(url, init);
      // 兜底:回到 asset:// (基本走不到这一步)
      const root = await getRoot(0);
      const abs = isAbs(rel) ? rel : joinAbs(root, rel);
      return orig(convertFileSrc(abs), init);
    }

    if (p === '/www/_pick_folder') {
      return tryInvoke(async () => {
        const picked = await invoke('pick_folder');
        if (!picked) return { cancelled: true };
        return { ok: true, path: picked };
      });
    }

    return orig(input, init);
  };
})();

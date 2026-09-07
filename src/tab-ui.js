// Bridge the existing single file pane to independent folder-tab sessions.
const TAB_SESSION_KEY = 'haystack_tabs_v1';
let tabSession = null;
let tabNavigationVersion = 0;
let displayedTabId = null;
let displayedTabPath = null;
let sessionSaveTimer = null;
const mainPane = document.querySelector('.main');
const tabList = document.getElementById('tabList');

function readHashPath() {
  const raw = location.hash.replace(/^#\/?/, '');
  try { return decodeURIComponent(raw); } catch { return raw; }
}

// Retain the helper name for existing preview/file-operation callers. The active
// tab, not browser-wide history, is now the source of truth.
function pathFromHash() { return tabSession?.active.path || readHashPath(); }

function captureActiveTab() {
  if (!tabSession) return;
  const tab = tabSession.active;
  tab.viewMode = currentViewMode;
  tab.sort = currentSort;
  tab.searchQuery = searchInput.value;
  if (displayedTabId === tab.id && displayedTabPath === tab.path) {
    tab.scrollTop = mainPane.scrollTop;
    tab.selectedName = getFileItems()[fileSelectedIdx]?.dataset.name || null;
  }
}

function persistTabs() {
  if (!tabSession) return;
  try { localStorage.setItem(TAB_SESSION_KEY, JSON.stringify(tabSession.snapshot())); }
  catch (e) { console.warn('[tabs] Cannot save session', e); }
}

function saveTabs() {
  captureActiveTab();
  persistTabs();
}

function restoreActiveTabView() {
  if (!tabSession) return;
  const tab = tabSession.active;
  const items = getFileItems();
  fileSelectedIdx = Array.from(items).findIndex(item => item.dataset.name === tab.selectedName);
  updateFileSelection(items, fileSelectedIdx, false);
  mainPane.scrollTop = tab.scrollTop;
  displayedTabId = tab.id;
  displayedTabPath = tab.path;
}

function renderTabBar() {
  const focused = document.activeElement?.closest('[data-tab-id]')?.dataset.tabId;
  tabList.replaceChildren();
  for (const tab of tabSession.tabs) {
    const { rootIdx, rel } = parseNavPath(tab.path);
    const root = tabSession.rootConfig[rootIdx];
    const name = rel.split('/').filter(Boolean).pop() || root?.name || root?.path || '根目录';
    const wrapper = document.createElement('div');
    wrapper.className = 'folder-tab' + (tab.id === tabSession.activeId ? ' active' : '');
    wrapper.dataset.tabId = tab.id;
    const button = document.createElement('button');
    button.className = 'tab-select';
    button.id = tab.id;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(tab.id === tabSession.activeId));
    button.setAttribute('aria-controls', 'content');
    button.tabIndex = tab.id === tabSession.activeId ? 0 : -1;
    button.title = (root?.path || '') + '/' + rel;
    button.innerHTML = SVG.folder;
    const label = document.createElement('span');
    label.className = 'tab-label';
    label.textContent = name;
    button.appendChild(label);
    button.addEventListener('click', () => switchTab(tab.id));
    const close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '×';
    close.title = tabSession.tabs.length === 1 ? '至少保留一个标签页' : '关闭标签页';
    close.setAttribute('aria-label', '关闭标签页：' + name);
    close.disabled = tabSession.tabs.length === 1;
    close.addEventListener('click', () => closeTab(tab.id));
    wrapper.addEventListener('mousedown', e => { if (e.button === 1) e.preventDefault(); });
    wrapper.addEventListener('auxclick', e => {
      if (e.button === 1) { e.preventDefault(); closeTab(tab.id); }
    });
    wrapper.append(button, close);
    tabList.appendChild(wrapper);
  }
  document.getElementById('btnBack').disabled = !tabSession.canBack;
  document.getElementById('btnForward').disabled = !tabSession.canForward;
  document.getElementById('btnNewTab').disabled = false;
  document.getElementById('content').setAttribute('aria-labelledby', tabSession.activeId);
  if (focused) document.getElementById(focused)?.focus({ preventScroll: true });
  const active = document.getElementById(tabSession.activeId)?.parentElement;
  if (active) {
    const bounds = active.getBoundingClientRect();
    const viewport = tabList.getBoundingClientRect();
    if (bounds.left < viewport.left) tabList.scrollLeft -= viewport.left - bounds.left;
    else if (bounds.right > viewport.right) tabList.scrollLeft += bounds.right - viewport.right;
  }
  window.HaystackLiveUpdates.sync();
}

async function showActiveTab({ highlight = null, suppressTree = false } = {}) {
  const tab = tabSession.active;
  const version = ++tabNavigationVersion;
  invalidateDirCache(); // Re-entered/background folders must never reuse an old disk snapshot.
  ++treeExpansionVersion; // Cancel an old tab's pending tree expansion immediately.
  displayedTabId = null;
  displayedTabPath = null;
  fileSelectedIdx = -1;
  cancelSearch();
  closeMoreMenu();
  closeDrawer();
  document.querySelectorAll('.create-menu.open').forEach(menu => menu.classList.remove('open'));
  currentViewMode = tab.viewMode;
  currentSort = tab.sort;
  currentRootIdx = parseNavPath(tab.path).rootIdx;
  searchInput.value = tab.searchQuery;
  searchClear.style.display = tab.searchQuery ? 'block' : 'none';
  // No hashchange for tab switches: browser-wide history must not leak between tabs.
  history.replaceState(null, '', '#/' + tab.path.split('/').map(encodeURIComponent).join('/'));
  renderTabBar();
  mainPane.scrollTop = 0;
  persistTabs();
  const rendered = await renderFiles(tab.path);
  if (version !== tabNavigationVersion || !rendered) return false;
  if (highlight) highlightFileItem(highlight);
  if (!suppressTree) await expandTreeTo(tab.path);
  if (version !== tabNavigationVersion) return false;
  highlightTree(tab.path);
  return true;
}

async function navigate(path, options = {}) {
  if (!tabSession) return false;
  captureActiveTab();
  const suppressTree = _suppressExpandTree;
  _suppressExpandTree = false;
  if (!tabSession.navigate(path)) {
    if (options.highlight) highlightFileItem(options.highlight);
    return false;
  }
  return showActiveTab({ ...options, suppressTree });
}

function openTab(path = pathFromHash(), options = {}) {
  if (!tabSession) return;
  captureActiveTab();
  const tab = tabSession.open(path, options);
  if (!tab) return;
  if (options.background) { renderTabBar(); persistTabs(); }
  else showActiveTab();
}

function switchTab(id) {
  captureActiveTab();
  if (tabSession.activate(id)) showActiveTab();
}

function closeTab(id) {
  captureActiveTab();
  const activeId = tabSession.activeId;
  if (!tabSession.close(id)) return;
  if (activeId !== tabSession.activeId) showActiveTab();
  else { renderTabBar(); persistTabs(); }
}

function travelTab(delta) {
  if (!tabSession) return;
  captureActiveTab();
  if (tabSession.travel(delta)) showActiveTab();
}

function reopenTab() {
  captureActiveTab();
  if (tabSession.reopen()) showActiveTab();
}

// Hash links (breadcrumbs/parent directory) and directory rows share the same
// modifier/middle-click behavior, without intercepting file-action buttons.
function directoryTarget(event) {
  if (event.target.closest('button, .file-actions, .thumb-actions-popup')) return null;
  const row = event.target.closest('[data-nav-path], a[href^="#/"]');
  if (!row) return null;
  let path = row.dataset.navPath;
  if (!path) {
    try { path = decodeURIComponent(row.getAttribute('href').slice(2)); } catch { return null; }
  }
  return { row, path };
}

document.addEventListener('click', e => {
  const target = directoryTarget(e);
  if (!target || !tabSession) return;
  if (e.metaKey || e.ctrlKey) {
    e.preventDefault();
    e.stopImmediatePropagation();
    openTab(target.path, { background: !e.shiftKey });
  } else if (target.row.matches('a')) {
    e.preventDefault();
    e.stopImmediatePropagation();
    navigate(target.path);
  }
}, true);

document.addEventListener('mousedown', e => {
  if (e.button === 1 && directoryTarget(e)) e.preventDefault();
});
document.addEventListener('auxclick', e => {
  const target = directoryTarget(e);
  if (e.button !== 1 || !target || !tabSession) return;
  e.preventDefault();
  openTab(target.path, { background: !e.shiftKey });
});
document.addEventListener('contextmenu', e => {
  const target = directoryTarget(e);
  if (!target || !tabSession) return;
  e.preventDefault();
  closeMoreMenu();
  const menu = document.createElement('div');
  menu.className = 'more-menu open';
  menu.style.left = Math.max(0, Math.min(e.clientX, innerWidth - 200)) + 'px';
  menu.style.top = Math.max(0, Math.min(e.clientY, innerHeight - 50)) + 'px';
  const item = document.createElement('div');
  item.className = 'more-menu-item';
  item.textContent = '在新标签页中打开';
  item.addEventListener('click', () => { closeMoreMenu(); openTab(target.path); });
  menu.appendChild(item);
  activeMoreMenu = menu;
  document.body.appendChild(menu);
});

document.getElementById('btnNewTab').addEventListener('click', () => openTab());
document.getElementById('btnBack').addEventListener('click', () => travelTab(-1));
document.getElementById('btnForward').addEventListener('click', () => travelTab(1));

tabList.addEventListener('keydown', e => {
  if (!e.target.matches('.tab-select') || e.altKey || e.metaKey || e.ctrlKey) return;
  let index = tabSession.tabs.findIndex(tab => tab.id === tabSession.activeId);
  if (e.key === 'ArrowLeft') index = (index - 1 + tabSession.tabs.length) % tabSession.tabs.length;
  else if (e.key === 'ArrowRight') index = (index + 1) % tabSession.tabs.length;
  else if (e.key === 'Home') index = 0;
  else if (e.key === 'End') index = tabSession.tabs.length - 1;
  else if (e.key === 'Delete') { e.preventDefault(); closeTab(tabSession.activeId); return; }
  else return;
  e.preventDefault();
  switchTab(tabSession.tabs[index].id);
  document.getElementById(tabSession.activeId)?.focus({ preventScroll: true });
});

function tabCommandsBlocked() {
  return !tabSession || document.getElementById('preview-modal') ||
    document.getElementById('settings-modal') || document.querySelector('.hsu-overlay') ||
    document.getElementById('gotoPathOverlay').style.display !== 'none';
}

// macOS menu accelerators are consumed natively, before webview keydown.
window.addEventListener('haystack:tab-action', e => {
  if (tabCommandsBlocked()) return;
  if (e.detail === 'new') openTab();
  else if (e.detail === 'close') closeTab(tabSession.activeId);
  else if (e.detail === 'reopen') reopenTab();
});

// Capture before file-list shortcuts. Never discard a modal editor.
window.addEventListener('keydown', e => {
  if (!tabSession || e.defaultPrevented) return;
  const mod = e.metaKey || e.ctrlKey;
  const key = e.key.toLowerCase();
  let action;
  if (mod && !e.altKey && key === 't') action = e.shiftKey ? reopenTab : () => openTab();
  else if (mod && !e.altKey && !e.shiftKey && key === 'w') action = () => closeTab(tabSession.activeId);
  else if (e.ctrlKey && !e.altKey && key === 'tab') action = () => {
    const index = tabSession.tabs.findIndex(tab => tab.id === tabSession.activeId);
    const next = (index + (e.shiftKey ? -1 : 1) + tabSession.tabs.length) % tabSession.tabs.length;
    switchTab(tabSession.tabs[next].id);
  };
  else if (mod && !e.altKey && !e.shiftKey && /^[1-9]$/.test(key)) action = () => {
    const index = key === '9' ? tabSession.tabs.length - 1 : Number(key) - 1;
    if (tabSession.tabs[index]) switchTab(tabSession.tabs[index].id);
  };
  else if (!mod && e.altKey && !e.shiftKey && key === 'arrowleft') action = () => travelTab(-1);
  else if (!mod && e.altKey && !e.shiftKey && key === 'arrowright') action = () => travelTab(1);
  if (!action) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (tabCommandsBlocked()) return;
  action();
}, true);

window.addEventListener('hashchange', () => navigate(readHashPath()));
mainPane.addEventListener('scroll', () => {
  clearTimeout(sessionSaveTimer);
  sessionSaveTimer = setTimeout(saveTabs, 150);
}, { passive: true });
window.addEventListener('pagehide', saveTabs);
window.addEventListener('beforeunload', saveTabs);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveTabs(); });

(async function initTabs() {
  try {
    const cfg = await window.__haystack.getCfg();
    let saved;
    try { saved = JSON.parse(localStorage.getItem(TAB_SESSION_KEY)); } catch { /* Fresh session. */ }
    tabSession = new HaystackTabs.TabSession(cfg.roots, saved, {
      path: readHashPath(), viewMode: currentViewMode, sort: currentSort,
    });
    tabSession.rootConfig = cfg.roots;
    window.HaystackLiveUpdates.start();
    await rebuildTree();
    await showActiveTab();
  } catch (e) {
    console.error('[tabs:init]', e);
    const message = document.createElement('div');
    message.className = 'empty-msg';
    message.textContent = '初始化失败: ' + e.message;
    document.getElementById('content').replaceChildren(message);
  }
})();

// Native, non-recursive watches for browsed directories. Polling/focus refresh
// covers unsupported/network filesystems and events missed while hidden.
window.HaystackLiveUpdates = (() => {
  let started = false;
  let dirty = false;
  let running = false;
  let refreshTimer, pollTimer, watchTimer;
  let observer;
  let nativeEvents = false;
  let nativeHealthy = false;
  let watchSignature = '';
  let watchVersion = 0;
  let watchQueue = Promise.resolve();
  const unlisteners = [];

  function isPaused() {
    return document.hidden || tabCommandsBlocked() || activeMoreMenu || isResizing ||
      document.querySelector('.create-menu.open');
  }

  function visibleTreeLevels() {
    return Array.from(document.querySelectorAll('.tree-children.open[data-nav-path]'))
      .filter(level => !level.parentElement.closest('.tree-children:not(.open)'));
  }

  function watchedNavPaths() {
    const paths = new Set();
    // Watching ancestors catches renaming/deleting/recreating the open folder.
    for (const tab of [tabSession.active, ...tabSession.tabs]) {
      const { rootIdx, rel } = parseNavPath(tab.path);
      paths.add(makeNavPath(rootIdx, rel));
      let parent = '';
      paths.add(makeNavPath(rootIdx, parent));
      for (const part of rel.split('/').filter(Boolean)) {
        parent += part + '/';
        paths.add(makeNavPath(rootIdx, parent));
      }
    }
    tabSession.rootConfig.forEach((_, index) => paths.add(makeNavPath(index, '')));
    visibleTreeLevels().forEach(level => paths.add(level.dataset.navPath));
    return [...paths].slice(0, 512).sort();
  }

  function sync(force = false) {
    if (!started || !tabSession || !nativeEvents) return;
    clearTimeout(watchTimer);
    watchTimer = setTimeout(() => {
      const navPaths = watchedNavPaths();
      const signature = JSON.stringify(navPaths);
      if (!force && signature === watchSignature) return;
      const version = ++watchVersion;
      // Serializing invoke prevents a slow old subscription from replacing the
      // newest tab's watch set (invoke itself has no cancellation support).
      watchQueue = watchQueue.catch(() => {}).then(async () => {
        if (!started || version !== watchVersion) return;
        const paths = await Promise.all(navPaths.map(path => window.__haystackAbs(path)));
        if (!started || version !== watchVersion) return;
        try {
          nativeHealthy = await window.__haystack.invoke('watch_directories', { paths }) === true;
          const changed = signature !== watchSignature;
          watchSignature = signature;
          // Cover the read-to-subscription gap without looping on re-arm.
          if (changed) request();
        } catch (error) {
          nativeHealthy = false;
          console.warn('[live-updates] Native watch unavailable; using polling', error);
        }
        schedulePoll();
      }).catch(error => {
        nativeHealthy = false;
        console.warn('[live-updates] Cannot update directory watches', error);
        schedulePoll();
      });
    }, 50);
  }

  function request() {
    if (!started || !tabSession) return;
    invalidateDirCache();
    dirty = true;
    // Fixed debounce window: continuous writes cannot postpone refresh forever.
    if (!refreshTimer) refreshTimer = setTimeout(flush, 300);
  }

  async function flush() {
    refreshTimer = null;
    if (!started || !dirty || running || document.hidden) return;
    if (isPaused() || displayedTabId !== tabSession.activeId) {
      refreshTimer = setTimeout(flush, 500);
      return;
    }
    dirty = false;
    running = true;
    const version = tabNavigationVersion;
    const path = pathFromHash();
    const current = () => started && version === tabNavigationVersion;
    try {
      let changed = false;
      try {
        const items = await fetchDir(path);
        if (!current()) return;
        changed = JSON.stringify(items) !== document.getElementById('content')._directorySignature;
      } catch {
        if (!current()) return;
        // Show a removed/inaccessible folder rather than keeping stale entries.
        changed = document.getElementById('content')._directorySignature !== null;
      }
      if (isPaused()) { dirty = true; return; }
      if (changed && !await renderFiles(path, { silent: true })) { dirty = true; return; }
      if (!current()) return;
      for (const level of visibleTreeLevels()) {
        if (!current()) return;
        if (level.isConnected) await buildTreeLevel(level, level.dataset.navPath, Number(level.dataset.depth));
      }
      if (!current()) return;
      highlightTree(path, false);
      // Re-run only an already-open search, never pop it open while browsing.
      if (searchInput.value.trim() && searchResults.hasChildNodes()) doSearch(searchInput.value.trim());
    } catch (error) {
      console.warn('[live-updates] Refresh failed', error);
    } finally {
      running = false;
      sync(true);
      if (dirty && started && !document.hidden && !refreshTimer) refreshTimer = setTimeout(flush, 300);
    }
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    if (!started) return;
    pollTimer = setTimeout(() => {
      if (!document.hidden) request();
      schedulePoll();
    }, nativeHealthy ? 10000 : 2000);
  }

  function resume() {
    if (!document.hidden) { request(); sync(true); }
  }

  async function start() {
    if (started) return;
    started = true;
    observer = new MutationObserver(() => sync());
    observer.observe(document.getElementById('tree'), { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    window.addEventListener('focus', resume);
    document.addEventListener('visibilitychange', resume);
    window.addEventListener('pagehide', stop, { once: true });
    schedulePoll();
    const listen = window.__TAURI__?.event?.listen;
    if (listen) {
      try {
        for (const [name, handler] of [['haystack:directory-changed', request], ['tauri://focus', resume]]) {
          const unlisten = await listen(name, handler);
          if (!started) { unlisten(); return; }
          unlisteners.push(unlisten);
        }
        nativeEvents = true;
      } catch (error) {
        console.warn('[live-updates] Event listener unavailable; using polling', error);
      }
    }
    sync(true);
    request();
  }

  function stop() {
    started = false;
    ++watchVersion;
    clearTimeout(refreshTimer);
    clearTimeout(pollTimer);
    clearTimeout(watchTimer);
    observer?.disconnect();
    window.removeEventListener('focus', resume);
    document.removeEventListener('visibilitychange', resume);
    unlisteners.splice(0).forEach(unlisten => unlisten());
  }

  return { start, sync, request, isPaused };
})();

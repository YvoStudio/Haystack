// Pure tab/session state. No DOM or Tauri dependency; also usable by Node tests.
(function (global) {
  const VIEWS = ['list', 'thumb-sm', 'thumb-lg'];
  const SORTS = ['name', 'size', 'date'];
  const MAX_HISTORY = 100;

  class TabSession {
    constructor(roots, saved, defaults = {}) {
      this.roots = roots.map(root => root.path);
      this.tabs = [];
      this.closed = [];
      this.nextId = 1;
      this.defaults = {
        viewMode: VIEWS.includes(defaults.viewMode) ? defaults.viewMode : 'list',
        sort: SORTS.includes(defaults.sort) ? defaults.sort : 'name',
      };
      if (saved?.version === 1 && Array.isArray(saved.tabs) && Array.isArray(saved.roots)) {
        saved.tabs.forEach((raw, index) => {
          const remap = path => {
            const match = typeof path === 'string' && path.match(/^(\d+)\/(.*)$/s);
            if (!match) return null;
            const rootIdx = this.roots.indexOf(saved.roots[Number(match[1])]);
            return rootIdx < 0 ? null : this.normalize(rootIdx + '/' + match[2]);
          };
          const path = remap(raw?.path);
          if (!path) return; // Never silently point a removed root at a different folder.
          const tab = this.create(path, raw);
          if (Array.isArray(raw.history) && Number.isInteger(raw.historyIndex) &&
              raw.historyIndex >= 0 && raw.historyIndex < raw.history.length &&
              remap(raw.history[raw.historyIndex]) === path) {
            const before = raw.history.slice(0, raw.historyIndex).map(remap).filter(Boolean);
            const after = raw.history.slice(raw.historyIndex + 1).map(remap).filter(Boolean);
            tab.history = [...before.slice(-(MAX_HISTORY - 1)), path, ...after].slice(0, MAX_HISTORY);
            tab.historyIndex = Math.min(before.length, MAX_HISTORY - 1);
          }
          this.tabs.push(tab);
          if (index === saved.activeIndex) this.activeId = tab.id;
        });
      }
      if (!this.tabs.length) this.tabs.push(this.create(this.normalize(defaults.path) || '0/'));
      if (!this.activeId) this.activeId = this.tabs[0].id;
    }

    normalize(path) {
      if (typeof path !== 'string') return null;
      const match = path.match(/^(\d+)\/(.*)$/s);
      const rootIdx = match ? Number(match[1]) : 0;
      if (rootIdx >= this.roots.length && this.roots.length) return null;
      const parts = (match ? match[2] : path).split('/').filter(Boolean);
      if (parts.some(part => part === '..' || part === '.' || part.includes('\0'))) return null;
      return rootIdx + '/' + (parts.length ? parts.join('/') + '/' : '');
    }

    create(path, state = this.defaults) {
      return {
        id: 'tab-' + this.nextId++, path, history: [path], historyIndex: 0,
        viewMode: VIEWS.includes(state.viewMode) ? state.viewMode : this.defaults.viewMode,
        sort: SORTS.includes(state.sort) ? state.sort : this.defaults.sort,
        scrollTop: Number.isFinite(state.scrollTop) ? Math.max(0, state.scrollTop) : 0,
        selectedName: typeof state.selectedName === 'string' ? state.selectedName : null,
        searchQuery: typeof state.searchQuery === 'string' ? state.searchQuery : '',
      };
    }

    get active() { return this.tabs.find(tab => tab.id === this.activeId); }
    get canBack() { return this.active.historyIndex > 0; }
    get canForward() { return this.active.historyIndex < this.active.history.length - 1; }

    open(path = this.active.path, { background = false } = {}) {
      path = this.normalize(path);
      if (!path) return null;
      const tab = this.create(path, { viewMode: this.active.viewMode, sort: this.active.sort });
      this.tabs.push(tab);
      if (!background) this.activeId = tab.id;
      return tab;
    }

    activate(id) {
      if (!this.tabs.some(tab => tab.id === id) || this.activeId === id) return false;
      this.activeId = id;
      return true;
    }

    resetLocationState() {
      Object.assign(this.active, { scrollTop: 0, selectedName: null, searchQuery: '' });
    }

    navigate(path) {
      path = this.normalize(path);
      if (!path || path === this.active.path) return false;
      const tab = this.active;
      tab.history = [...tab.history.slice(0, tab.historyIndex + 1), path].slice(-MAX_HISTORY);
      tab.historyIndex = tab.history.length - 1;
      tab.path = path;
      this.resetLocationState();
      return true;
    }

    travel(delta) {
      const tab = this.active;
      const index = tab.historyIndex + delta;
      if (!Number.isInteger(index) || index < 0 || index >= tab.history.length) return false;
      tab.historyIndex = index;
      tab.path = tab.history[index];
      this.resetLocationState();
      return true;
    }

    close(id) {
      const index = this.tabs.findIndex(tab => tab.id === id);
      if (index < 0 || this.tabs.length === 1) return false;
      this.closed.push({ tab: this.tabs[index], index });
      if (this.closed.length > 10) this.closed.shift();
      this.tabs.splice(index, 1);
      if (this.activeId === id) this.activeId = this.tabs[Math.min(index, this.tabs.length - 1)].id;
      return true;
    }

    reopen() {
      const entry = this.closed.pop();
      if (!entry) return false;
      this.tabs.splice(Math.min(entry.index, this.tabs.length), 0, entry.tab);
      this.activeId = entry.tab.id;
      return true;
    }

    snapshot() {
      return {
        version: 1, roots: [...this.roots],
        activeIndex: this.tabs.findIndex(tab => tab.id === this.activeId),
        tabs: this.tabs.map(({ id, ...tab }) => ({ ...tab, history: [...tab.history] })),
      };
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { TabSession };
  else global.HaystackTabs = { TabSession };
})(globalThis);

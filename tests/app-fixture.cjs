const { test: base, expect } = require('@playwright/test');
const row = (page, name) => page.locator('#content .file-item').filter({
  has: page.locator('.file-name', { hasText: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$') }),
});
const activeTab = page => page.getByRole('tab', { selected: true });
// Exercise the real api.js adapter, including invoke's non-cancellable promises.
// An auto fixture (rather than module-level hooks) also works when one worker
// loads several spec files through Node's shared require cache.
const test = base.extend({ app: [async ({ page }, use) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://cdnjs.cloudflare.com/**', route => route.fulfill({ body: '' }));
  await page.addInitScript(() => {
    const directory = name => ({ name, type: 'directory', size: 0, mtime: '100' });
    const file = (name, size = 10) => ({ name, type: 'file', size, mtime: String(size) });
    const listeners = new Map();
    window.fixture = {
      cfg: { roots: [{ name: 'Home', path: '/home' }, { name: 'Work', path: '/work' }] },
      calls: [], delays: {}, searchDelay: 0, watched: [], watchSupported: true, listResolvers: [],
      updater: { result: null, canInstall: true, checkResolvers: [], downloadResolvers: [] },
      emit: (name = 'haystack:directory-changed') => { for (const handler of listeners.get(name) || []) handler({ payload: null }); },
      dirs: {
        '/home': [directory('Alpha'), directory('Beta'), directory('Slow'), directory('Empty'), directory('100% #中文 <x>')],
        '/home/Alpha': [directory('Child'), ...Array.from({ length: 50 }, (_, i) => file('a' + String(i).padStart(2, '0') + '.txt', i + 1))],
        '/home/Alpha/Child': [file('child.txt')],
        '/home/Beta': [file('beta.txt')],
        '/home/Slow': [file('slow.txt')],
        '/home/Empty': [],
        '/home/100% #中文 <x>': [file('special.txt')],
        '/work': [file('work.txt')],
      },
    };
    window.__TAURI__ = {
      event: { listen: async (name, handler) => {
        if (!listeners.has(name)) listeners.set(name, new Set());
        listeners.get(name).add(handler);
        return () => listeners.get(name).delete(handler);
      } },
      core: {
        Channel: class { onmessage = () => {}; },
        convertFileSrc: path => '/asset/' + encodeURIComponent(path),
        invoke: async (command, args = {}) => {
          const f = window.fixture;
          f.calls.push({ command, args });
          if (command === 'get_config') return f.cfg;
          if (command === 'plugin:app|version') return '0.1.11';
          if (command === 'can_install_updates') return f.updater.canInstall;
          if (command === 'get_local_ip') return '127.0.0.1';
          if (command === 'get_http_status') return { running: true, port: 8765 };
          if (command === 'watch_directories') {
            f.watched = args.paths;
            return f.watchSupported;
          }
          if (command === 'list_dir') {
            const path = args.path.replace(/\/+$/, '');
            const snapshot = f.dirs[path] && structuredClone(f.dirs[path]);
            if (f.holdPath === path) await new Promise(resolve => f.listResolvers.push(resolve));
            else await new Promise(resolve => setTimeout(resolve, f.delays[path] || 0));
            if (!snapshot) throw new Error('Not a directory');
            return snapshot;
          }
          if (command === 'search') {
            if (f.holdSearch) await new Promise(resolve => f.searchResolvers.push(resolve));
            else await new Promise(resolve => setTimeout(resolve, f.searchDelay));
            return [{ ...file(args.q + '.txt'), path: args.path.replace(/\/+$/, '') + '/' + args.q + '.txt' }];
          }
          if (command === 'plugin:updater|check') {
            if (f.updater.holdCheck) await new Promise(resolve => f.updater.checkResolvers.push(resolve));
            if (f.updater.checkError) throw new Error(f.updater.checkError);
            return f.updater.result && structuredClone(f.updater.result);
          }
          if (command === 'plugin:updater|download_and_install') {
            f.updater.channel = args.onEvent;
            args.onEvent.onmessage({ event: 'Started', data: { contentLength: 100 } });
            if (f.updater.holdDownload) await new Promise(resolve => f.updater.downloadResolvers.push(resolve));
            if (f.updater.downloadError) throw new Error(f.updater.downloadError);
            args.onEvent.onmessage({ event: 'Progress', data: { chunkLength: 100 } });
            args.onEvent.onmessage({ event: 'Finished' });
            return null;
          }
          if (command === 'plugin:process|restart' && f.updater.restartError) throw new Error(f.updater.restartError);
          return null;
        },
      },
    };
  });
  await page.goto('/');
  await expect(row(page, 'Alpha')).toBeVisible();
  await expect.poll(() => page.evaluate(() => fixture.watched.length)).toBeGreaterThan(0);
  await use();
  expect(errors).toEqual([]);
}, { auto: true }] });

module.exports = { test, expect, row, activeTab };

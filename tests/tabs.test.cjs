const { test } = require('node:test');
const assert = require('node:assert/strict');
const { TabSession } = require('../src/tabs.js');
const roots = [{ path: '/home' }, { path: '/projects' }];
const create = (saved, defaults) => new TabSession(roots, saved, defaults);

test('new tabs inherit display preferences but have independent location state', () => {
  const session = create();
  const first = session.active;
  Object.assign(first, { viewMode: 'thumb-lg', sort: 'date', scrollTop: 400, searchQuery: 'png' });
  session.navigate('0/Downloads');
  first.scrollTop = 400;
  const second = session.open('1/工作 #100%/');
  assert.equal(second.path, '1/工作 #100%/');
  assert.equal(second.viewMode, 'thumb-lg');
  assert.equal(second.sort, 'date');
  assert.equal(second.scrollTop, 0);
  assert.equal(second.searchQuery, '');
  session.activate(first.id);
  assert.equal(session.active.path, '0/Downloads/');
  assert.equal(session.active.scrollTop, 400);
  assert.equal(first.history.length, 2);
  assert.equal(second.history.length, 1);
});

test('background open and close do not change the active tab', () => {
  const session = create();
  const first = session.active;
  const background = session.open('1/', { background: true });
  assert.equal(session.active, first);
  session.close(background.id);
  assert.equal(session.active, first);
  assert.equal(session.close(first.id), false);
  assert.equal(session.tabs.length, 1);
});

test('each tab has its own back/forward history and navigation truncates forward entries', () => {
  const session = create();
  const first = session.active;
  session.navigate('0/a/');
  session.navigate('0/b/');
  assert.equal(session.travel(-1), true);
  assert.equal(first.path, '0/a/');
  assert.equal(session.canForward, true);
  session.open('1/');
  assert.equal(session.canBack, false);
  assert.equal(session.travel(-1), false);
  session.activate(first.id);
  session.navigate('0/c/');
  assert.deepEqual(first.history, ['0/', '0/a/', '0/c/']);
  assert.equal(session.canForward, false);
  assert.equal(session.navigate('0/c'), false);
  assert.equal(first.history.length, 3);
});

test('closing active tabs selects a neighbor and reopening restores state and position', () => {
  const session = create();
  const first = session.active;
  const middle = session.open('0/a/');
  session.navigate('1/b/');
  middle.scrollTop = 90;
  const last = session.open('1/');
  session.close(last.id);
  assert.equal(session.active, middle);
  session.close(middle.id);
  assert.equal(session.active, first);
  session.reopen();
  assert.equal(session.active, middle);
  assert.equal(session.tabs[1], middle);
  assert.equal(middle.scrollTop, 90);
  assert.deepEqual(middle.history, ['0/a/', '1/b/']);
  session.reopen();
  assert.equal(session.active, last);
  assert.equal(session.reopen(), false);
});

test('snapshot round trips active tab, history, selection, scroll, search and display settings', () => {
  const session = create();
  session.open('1/a/');
  session.navigate('1/b/');
  session.travel(-1);
  Object.assign(session.active, { viewMode: 'thumb-sm', sort: 'size', scrollTop: 999, selectedName: 'file.txt', searchQuery: 'test' });
  const snapshot = session.snapshot();
  assert.deepEqual(create(JSON.parse(JSON.stringify(snapshot))).snapshot(), snapshot);
  snapshot.tabs[0].history.push('0/mutated/');
  assert.deepEqual(session.tabs[0].history, ['0/']);
});

test('restoration follows root paths when roots are reordered', () => {
  const session = create();
  session.navigate('1/src/');
  session.open('0/Downloads/');
  const restored = new TabSession([...roots].reverse(), session.snapshot());
  assert.equal(restored.active.path, '1/Downloads/');
  assert.deepEqual(restored.tabs[0].history, ['1/', '0/src/']);
});

test('removed roots and their history entries are discarded, never reassigned', () => {
  const session = create();
  session.navigate('1/src/');
  session.navigate('0/Downloads/');
  session.open('1/');
  const restored = new TabSession([roots[0]], session.snapshot());
  assert.equal(restored.tabs.length, 1);
  assert.equal(restored.active.path, '0/Downloads/');
  assert.deepEqual(restored.active.history, ['0/', '0/Downloads/']);
  assert.equal(restored.active.historyIndex, 1);
});

test('invalid saved sessions, preferences and paths safely fall back', () => {
  for (const saved of [null, {}, { version: 2 }, { version: 1, tabs: [null, {}], roots: ['/home'] }]) {
    const session = create(saved, { viewMode: 'invalid', sort: 'invalid', path: '9/' });
    assert.equal(session.tabs.length, 1);
    assert.equal(session.active.path, '0/');
    assert.equal(session.active.viewMode, 'list');
    assert.equal(session.active.sort, 'name');
    assert.equal(session.open('0/../private'), null);
  }
});

test('corrupt history cursors fall back to the current folder', () => {
  for (const historyIndex of [-1, 5, 0.5, '0']) {
    const session = create({ version: 1, roots: ['/home'], activeIndex: 0,
      tabs: [{ path: '0/a/', history: ['0/a/'], historyIndex }] });
    assert.deepEqual(session.active.history, ['0/a/']);
    assert.equal(session.active.historyIndex, 0);
    assert.equal(session.canBack, false);
    assert.equal(session.canForward, false);
  }
});

test('location changes clear transient state without resetting view preferences', () => {
  const session = create();
  Object.assign(session.active, { viewMode: 'thumb-lg', scrollTop: 50, selectedName: 'a', searchQuery: 'a' });
  session.navigate('0/a/');
  assert.equal(session.active.scrollTop, 0);
  assert.equal(session.active.selectedName, null);
  assert.equal(session.active.searchQuery, '');
  assert.equal(session.active.viewMode, 'thumb-lg');
});

test('history is bounded and remains navigable after restore', () => {
  const session = create();
  for (let i = 0; i < 150; i++) session.navigate('0/' + i);
  assert.equal(session.active.history.length, 100);
  const restored = create(session.snapshot());
  assert.equal(restored.active.historyIndex, 99);
  restored.travel(-99);
  assert.equal(restored.active.path, '0/50/');
});

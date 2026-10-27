const { test, expect, row, activeTab } = require('./app-fixture.cjs');
const treeRow = (page, path) => page.locator(`.tree-item[data-path="${path}"]`);

test('external create, rename, write and delete update files and sidebar without reload', async ({ page }) => {
  await page.evaluate(() => {
    fixture.dirs['/home'].push({ name: 'NewFolder', type: 'directory', size: 0, mtime: '100' });
    fixture.dirs['/home/NewFolder'] = [{ name: 'new.txt', type: 'file', size: 10, mtime: '100' }];
    fixture.emit();
  });
  await expect(row(page, 'NewFolder')).toBeVisible();
  await expect(treeRow(page, '0/NewFolder/')).toBeVisible();
  await row(page, 'NewFolder').locator('.file-name').click();
  await expect(row(page, 'new.txt')).toBeVisible();
  await page.evaluate(() => {
    Object.assign(fixture.dirs['/home/NewFolder'][0], { name: 'renamed.txt', size: 2048, mtime: '200' });
    fixture.emit();
  });
  await expect(row(page, 'new.txt')).toHaveCount(0);
  await expect(row(page, 'renamed.txt').locator('.file-size')).toHaveText('2.0 K');
  await page.evaluate(() => { fixture.dirs['/home/NewFolder'] = []; fixture.emit(); });
  await expect(page.getByText('空目录', { exact: true })).toBeVisible();
  await expect(activeTab(page)).toHaveText('NewFolder');
});

test('same-size image edits within one second invalidate thumbnail URLs', async ({ page }) => {
  await page.evaluate(() => {
    fixture.dirs['/home'].push({ name: 'photo.png', type: 'file', size: 10, mtime: '100', revision: '100000000001' });
    fixture.emit();
  });
  await expect(row(page, 'photo.png')).toBeVisible();
  await page.locator('#btnViewSort').click();
  await page.locator('#viewSortMenu').getByText('小缩略图', { exact: true }).click();
  await expect(row(page, 'photo.png').locator('img')).toHaveAttribute('src', /\?v=100000000001$/);
  await page.evaluate(() => {
    fixture.dirs['/home'].find(item => item.name === 'photo.png').revision = '100000000002';
    fixture.emit();
  });
  await expect(row(page, 'photo.png').locator('img')).toHaveAttribute('src', /\?v=100000000002$/);
});

test('silent refresh preserves tab, history, search, selection and scroll', async ({ page }) => {
  await row(page, 'Alpha').locator('.file-name').click();
  await expect(row(page, 'a49.txt')).toBeAttached();
  await page.evaluate(() => {
    fileSelectedIdx = 20;
    updateFileSelection(getFileItems(), fileSelectedIdx, false);
    document.querySelector('.main').scrollTop = 650;
    searchInput.value = 'keep my query';
    fixture.savedHistory = [...tabSession.active.history];
    fixture.dirs['/home/Alpha'].push({ name: 'z-added.txt', type: 'file', size: 1, mtime: '100' });
    fixture.emit();
  });
  await expect(row(page, 'z-added.txt')).toBeAttached();
  await expect(activeTab(page)).toHaveText('Alpha');
  await expect(page.locator('#searchInput')).toHaveValue('keep my query');
  await expect.poll(() => page.evaluate(() => document.querySelector('.main').scrollTop)).toBeCloseTo(650, -1);
  expect(await page.evaluate(() => fileSelectedIdx)).toBe(20);
  expect(await page.evaluate(() => JSON.stringify(tabSession.active.history) === JSON.stringify(fixture.savedHistory))).toBe(true);
});

test('sidebar reconciliation keeps manually expanded branches and unchanged list DOM', async ({ page }) => {
  await row(page, 'Alpha').locator('.file-name').click();
  await expect(row(page, 'Child')).toBeVisible();
  await page.evaluate(async () => {
    await expandOneLevel('0/Beta/', 2, () => true);
    fixture.oldRow = document.querySelector('#content .file-item');
    fixture.dirs['/home'].push({ name: 'NewSibling', type: 'directory', size: 0, mtime: '100' });
    fixture.dirs['/home/NewSibling'] = [];
    fixture.emit();
  });
  await expect(treeRow(page, '0/NewSibling/')).toBeVisible();
  await expect(treeRow(page, '0/Alpha/').locator('..').locator(':scope > .tree-children')).toHaveClass(/open/);
  await expect(treeRow(page, '0/Beta/').locator('..').locator(':scope > .tree-children')).toHaveClass(/open/);
  expect(await page.evaluate(() => fixture.oldRow === document.querySelector('#content .file-item'))).toBe(true);
});

test('background tabs update on return and closing them releases their watches', async ({ page }) => {
  await row(page, 'Beta').locator('.file-name').click({ modifiers: ['ControlOrMeta'] });
  await row(page, 'Alpha').locator('.file-name').click();
  await expect.poll(() => page.evaluate(() => fixture.watched.some(path => path.replace(/\/+$/, '') === '/home/Beta'))).toBe(true);
  await page.evaluate(() => {
    fixture.dirs['/home/Beta'].push({ name: 'external.txt', type: 'file', size: 1, mtime: '100' });
    fixture.emit();
  });
  await page.getByRole('tab', { name: 'Beta', exact: true }).click();
  await expect(row(page, 'external.txt')).toBeVisible();
  await page.keyboard.press('Control+w');
  await expect(activeTab(page)).toHaveText('Alpha');
  await expect.poll(() => page.evaluate(() => fixture.watched.some(path => path.replace(/\/+$/, '') === '/home/Beta'))).toBe(false);
});

test('invalidated in-flight invoke responses cannot refill stale directory cache', async ({ page }) => {
  await row(page, 'Beta').locator('.file-name').click();
  await expect(row(page, 'beta.txt')).toBeVisible();
  await page.waitForTimeout(700); // Initial subscription/debounce settled.
  await page.evaluate(() => {
    fixture.holdPath = '/home/Beta';
    invalidateDirCache();
    fixture.pendingRead = fetchDir('0/Beta/');
  });
  await expect.poll(() => page.evaluate(() => fixture.listResolvers.length)).toBe(1);
  await page.evaluate(() => {
    fixture.dirs['/home/Beta'] = [{ name: 'latest.txt', type: 'file', size: 1, mtime: '100' }];
    fixture.emit();
    fixture.holdPath = null;
    fixture.listResolvers.splice(0).forEach(resolve => resolve());
  });
  expect(await page.evaluate(async () => (await fixture.pendingRead).map(item => item.name))).toEqual(['latest.txt']);
  await expect(row(page, 'latest.txt')).toBeVisible();
  await expect(row(page, 'beta.txt')).toHaveCount(0);
});

test('a slow automatic refresh cannot overwrite a newly selected tab', async ({ page }) => {
  await row(page, 'Beta').locator('.file-name').click({ modifiers: ['ControlOrMeta'] });
  await row(page, 'Alpha').locator('.file-name').click();
  await expect(row(page, 'a49.txt')).toBeAttached();
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    fixture.holdPath = '/home/Alpha';
    fixture.dirs['/home/Alpha'].push({ name: 'added.txt', type: 'file', size: 1, mtime: '100' });
    fixture.emit();
  });
  await expect.poll(() => page.evaluate(() => fixture.listResolvers.length)).toBeGreaterThan(0);
  await page.getByRole('tab', { name: 'Beta', exact: true }).click();
  await expect(row(page, 'beta.txt')).toBeVisible();
  await page.evaluate(() => { fixture.holdPath = null; fixture.listResolvers.splice(0).forEach(resolve => resolve()); });
  await page.waitForTimeout(600);
  await expect(row(page, 'beta.txt')).toBeVisible();
  await expect(row(page, 'added.txt')).toHaveCount(0);
});

test('updates wait for an open editor and do not discard unsaved content', async ({ page }) => {
  await page.locator('#btnCreate').click();
  await page.locator('#createMenu').getByText('文本文件', { exact: true }).click();
  await page.locator('#preview-modal textarea').fill('unsaved');
  await page.evaluate(() => {
    fixture.dirs['/home'].push({ name: 'external.txt', type: 'file', size: 1, mtime: '100' });
    fixture.emit();
  });
  await page.waitForTimeout(700);
  await expect(page.locator('#preview-modal textarea')).toHaveValue('unsaved');
  await expect(row(page, 'external.txt')).toHaveCount(0);
  await page.locator('#preview-modal').getByRole('button', { name: '取消', exact: true }).click();
  await expect(row(page, 'external.txt')).toBeVisible();
});

test('focus catches missed events and polling works when native watching is unsupported', async ({ page }) => {
  await row(page, 'Beta').locator('.file-name').click();
  await expect(row(page, 'beta.txt')).toBeVisible();
  await page.evaluate(() => {
    fixture.dirs['/home/Beta'].push({ name: 'focus.txt', type: 'file', size: 1, mtime: '100' });
    fixture.emit('tauri://focus');
  });
  await expect(row(page, 'focus.txt')).toBeVisible();
  await page.evaluate(() => {
    fixture.watchSupported = false;
    HaystackLiveUpdates.sync(true);
  });
  await page.waitForTimeout(600);
  await page.evaluate(() => {
    fixture.dirs['/home/Beta'].push({ name: 'polled.txt', type: 'file', size: 1, mtime: '100' });
  });
  await expect(row(page, 'polled.txt')).toBeVisible({ timeout: 5000 });
});

test('bursts are debounced and unchanged directory contents are not re-rendered', async ({ page }) => {
  await page.waitForTimeout(700);
  const baseline = await page.evaluate(() => {
    fixture.oldRow = document.querySelector('#content .file-item');
    const count = fixture.calls.filter(call => call.command === 'list_dir').length;
    for (let i = 0; i < 40; i++) fixture.emit();
    return count;
  });
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => fixture.oldRow === document.querySelector('#content .file-item'))).toBe(true);
  const count = await page.evaluate(() => fixture.calls.filter(call => call.command === 'list_dir').length);
  expect(count - baseline).toBeLessThan(5);
});

test('hidden windows defer reads and catch up when shown again', async ({ page }) => {
  await page.waitForTimeout(700);
  const baseline = await page.evaluate(() => {
    fixture.hidden = true;
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => fixture.hidden });
    document.dispatchEvent(new Event('visibilitychange'));
    fixture.dirs['/home'].push({ name: 'while-hidden.txt', type: 'file', size: 1, mtime: '100' });
    fixture.emit();
    return fixture.calls.filter(call => call.command === 'list_dir').length;
  });
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => fixture.calls.filter(call => call.command === 'list_dir').length)).toBe(baseline);
  await page.evaluate(() => { fixture.hidden = false; document.dispatchEvent(new Event('visibilitychange')); });
  await expect(row(page, 'while-hidden.txt')).toBeVisible();
});

test('deleted open folders show an error and recover automatically when recreated', async ({ page }) => {
  await row(page, 'Beta').locator('.file-name').click();
  await expect(row(page, 'beta.txt')).toBeVisible();
  await page.evaluate(() => {
    delete fixture.dirs['/home/Beta'];
    fixture.dirs['/home'] = fixture.dirs['/home'].filter(item => item.name !== 'Beta');
    fixture.emit();
  });
  await expect(page.locator('#content')).toContainText('加载失败');
  await expect(treeRow(page, '0/Beta/')).toHaveCount(0);
  await page.evaluate(() => {
    fixture.dirs['/home/Beta'] = [{ name: 'recreated.txt', type: 'file', size: 1, mtime: '100' }];
    fixture.dirs['/home'].push({ name: 'Beta', type: 'directory', size: 0, mtime: '100' });
    fixture.emit();
  });
  await expect(row(page, 'recreated.txt')).toBeVisible();
  await expect(treeRow(page, '0/Beta/')).toBeVisible();
});

const { test, expect, row, activeTab } = require('./app-fixture.cjs');

test('new, switch, independent history, close, reopen and last-tab protection', async ({ page }) => {
  await row(page, 'Alpha').click();
  await expect(activeTab(page)).toHaveText('Alpha');
  await expect(row(page, 'Child')).toBeVisible();
  await page.getByRole('button', { name: '新建标签页', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.getByRole('button', { name: '后退', exact: true })).toBeDisabled();
  await row(page, 'Child').click();
  await expect(row(page, 'child.txt')).toBeVisible();
  await page.getByRole('tab', { name: 'Alpha', exact: true }).click();
  await expect(row(page, 'Child')).toBeVisible();
  await page.getByRole('button', { name: '后退', exact: true }).click();
  await expect(activeTab(page)).toHaveText('Home');
  await page.getByRole('button', { name: '前进', exact: true }).click();
  await expect(activeTab(page)).toHaveText('Alpha');
  await page.getByRole('tab', { name: 'Child', exact: true }).click();
  await page.keyboard.press('Control+w');
  await expect(page.getByRole('tab')).toHaveCount(1);
  await page.keyboard.press('Control+Shift+t');
  await expect(activeTab(page)).toHaveText('Child');
  await expect(row(page, 'child.txt')).toBeVisible();
  await page.getByRole('tab', { name: 'Alpha', exact: true }).click({ button: 'middle' });
  await expect(page.getByRole('tab')).toHaveCount(1);
  await page.keyboard.press('Control+w');
  await expect(page.getByRole('tab')).toHaveCount(1);
  await expect(page.locator('.tab-close')).toBeDisabled();
});

test('folders open via modifier click, middle click, context menu, more menu and sidebar', async ({ page }) => {
  await row(page, 'Alpha').click({ modifiers: ['Meta'] });
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(activeTab(page)).toHaveText('Home');
  await row(page, 'Beta').click({ button: 'middle' });
  await expect(page.getByRole('tab')).toHaveCount(3);
  await expect(activeTab(page)).toHaveText('Home');
  await row(page, 'Empty').click({ button: 'right' });
  await page.getByText('在新标签页中打开', { exact: true }).click();
  await expect(activeTab(page)).toHaveText('Empty');
  await expect(page.getByText('空目录', { exact: true })).toBeVisible();
  await page.locator('.tree-root-item').filter({ hasText: 'Work' }).click({ modifiers: ['ControlOrMeta', 'Shift'] });
  await expect(activeTab(page)).toHaveText('Work');
  await expect(row(page, 'work.txt')).toBeVisible();
  await page.locator('#btnBcMore').click();
  await page.getByText('在新标签页中打开', { exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(6);
});

test('view, sort, selection, scroll and search are isolated and restored on reload', async ({ page }) => {
  await row(page, 'Alpha').click();
  await expect(row(page, 'a49.txt')).toBeAttached();
  await page.evaluate(() => {
    fileSelectedIdx = 20;
    updateFileSelection(getFileItems(), fileSelectedIdx, false);
    document.querySelector('.main').scrollTop = 650;
  });
  await page.locator('#searchInput').fill('needle');
  await page.locator('#btnNewTab').click();
  await page.locator('#btnViewSort').click();
  await page.locator('#viewSortMenu').getByText('大缩略图', { exact: true }).click();
  await page.locator('#btnViewSort').click();
  await page.locator('#viewSortMenu').getByText('按大小', { exact: true }).click();
  await expect(page.locator('.thumb-card')).toHaveCount(51);
  await page.getByRole('tab').first().click();
  await expect(page.locator('#content .file-list')).toBeVisible();
  await expect(page.locator('#searchInput')).toHaveValue('needle');
  await expect.poll(() => page.evaluate(() => document.querySelector('.main').scrollTop)).toBeCloseTo(650, -1);
  await expect.poll(() => page.evaluate(() => fileSelectedIdx)).toBe(20);
  await page.reload();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.locator('#content .file-list')).toBeVisible();
  await expect(page.locator('#searchInput')).toHaveValue('needle');
  await expect.poll(() => page.evaluate(() => document.querySelector('.main').scrollTop)).toBeCloseTo(650, -1);
  await page.getByRole('tab').nth(1).click();
  await expect(page.locator('.thumb-card')).toHaveCount(51);
  await expect(page.locator('.thumb-card').nth(1)).toHaveAttribute('data-name', 'a49.txt');
  await expect(page.locator('#searchInput')).toHaveValue('');
});

test('slow directory and per-file path results cannot overwrite another tab', async ({ page }) => {
  await row(page, 'Beta').click({ modifiers: ['ControlOrMeta'] });
  await page.evaluate(() => { fixture.delays['/home/Slow'] = 400; });
  await row(page, 'Slow').click();
  await page.getByRole('tab', { name: 'Beta', exact: true }).click();
  await expect(row(page, 'beta.txt')).toBeVisible();
  await page.waitForTimeout(600);
  await expect(row(page, 'slow.txt')).toHaveCount(0);
  await expect(page.locator('#breadcrumb')).toContainText('Beta');
  await page.evaluate(() => {
    const original = window.__haystackAbs;
    window.__haystackAbs = async path => {
      if (path.includes('Slow')) await new Promise(resolve => setTimeout(resolve, 400));
      return original(path);
    };
  });
  await page.getByRole('tab', { name: 'Slow', exact: true }).click();
  await page.getByRole('tab', { name: 'Beta', exact: true }).click();
  await page.waitForTimeout(600);
  await expect(row(page, 'beta.txt')).toBeVisible();
  await expect(row(page, 'slow.txt')).toHaveCount(0);
});

test('non-cancellable search results do not leak across tabs or reappear after clearing', async ({ page }) => {
  await row(page, 'Beta').click({ modifiers: ['ControlOrMeta'] });
  await page.evaluate(() => { fixture.holdSearch = true; fixture.searchResolvers = []; });
  await page.locator('#searchInput').fill('old');
  await expect.poll(() => page.evaluate(() => fixture.searchResolvers.length)).toBe(1);
  await page.getByRole('tab', { name: 'Beta', exact: true }).click();
  await page.evaluate(() => fixture.searchResolvers.splice(0).forEach(resolve => resolve()));
  await page.waitForTimeout(50);
  await expect(page.locator('#searchResults')).toBeEmpty();
  await page.locator('#searchInput').fill('cleared');
  await expect.poll(() => page.evaluate(() => fixture.searchResolvers.length)).toBe(1);
  await page.locator('#searchClear').click();
  await page.evaluate(() => fixture.searchResolvers.splice(0).forEach(resolve => resolve()));
  await page.waitForTimeout(50);
  await expect(page.locator('#searchResults')).toBeEmpty();
  await expect(page.locator('#searchInput')).toHaveValue('');
});

test('special folder names are safe in tabs, breadcrumbs, hash and restored sessions', async ({ page }) => {
  await page.locator('#content [data-nav-path="0/100% #中文 <x>/"]').click();
  await expect(activeTab(page)).toHaveText('100% #中文 <x>');
  await expect(row(page, 'special.txt')).toBeVisible();
  await expect(page.locator('#breadcrumb x')).toHaveCount(0);
  await page.locator('#breadcrumb a').last().click({ modifiers: ['ControlOrMeta', 'Shift'] });
  await expect(page.getByRole('tab')).toHaveCount(2);
  await page.reload();
  await expect(activeTab(page)).toHaveText('100% #中文 <x>');
  await expect(row(page, 'special.txt')).toBeVisible();
});

test('tab shortcuts work from search but never discard a modal editor', async ({ page }) => {
  await page.locator('#searchInput').focus();
  await page.keyboard.press('Meta+t');
  await expect(page.getByRole('tab')).toHaveCount(2);
  await page.keyboard.press('Control+Shift+Tab');
  await expect(page.getByRole('tab').first()).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Meta+9');
  await expect(page.getByRole('tab').last()).toHaveAttribute('aria-selected', 'true');
  await page.locator('#btnCreate').click();
  await page.locator('#createMenu').getByText('文本文件', { exact: true }).click();
  await page.locator('#preview-modal textarea').fill('unsaved');
  await page.keyboard.press('Meta+w');
  await page.keyboard.press('Meta+t');
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.locator('#preview-modal textarea')).toHaveValue('unsaved');
});

test('folder bookmarks support new tabs; file Open still uses the system opener', async ({ page }) => {
  await row(page, 'Beta').click();
  await expect(row(page, 'beta.txt')).toBeVisible();
  await page.locator('#btnStar').click();
  await row(page, 'beta.txt').hover();
  await row(page, 'beta.txt').locator('.btn-more').click();
  await page.locator('.more-menu').getByText('打开', { exact: true }).click();
  await expect.poll(() => page.evaluate(() => fixture.calls.filter(c => c.command === 'plugin:opener|open_path').length)).toBe(1);
  await page.locator('#btnBookmarks').click();
  await page.locator('.bm-item').click({ modifiers: ['ControlOrMeta', 'Shift'] });
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(activeTab(page)).toHaveText('Beta');
});

test('native macOS menu events use the same tab actions and modal protection', async ({ page }) => {
  const action = detail => page.evaluate(detail => window.dispatchEvent(new CustomEvent('haystack:tab-action', { detail })), detail);
  await action('new');
  await expect(page.getByRole('tab')).toHaveCount(2);
  await action('close');
  await expect(page.getByRole('tab')).toHaveCount(1);
  await action('reopen');
  await expect(page.getByRole('tab')).toHaveCount(2);
  await page.locator('#btnSettings').click();
  await expect(page.locator('#settings-modal')).toBeVisible();
  await action('close');
  await action('new');
  await expect(page.getByRole('tab')).toHaveCount(2);
});

test('many tabs remain horizontally scrollable at the minimum window size', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 600 });
  await page.evaluate(() => { for (let i = 0; i < 16; i++) openTab('0/Alpha/', { background: true }); });
  await page.keyboard.press('Control+9');
  await expect(page.getByRole('tab').last()).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#btnNewTab')).toBeInViewport();
  await expect(activeTab(page)).toBeInViewport();
  expect(await page.evaluate(() => document.body.scrollWidth)).toBe(900);
  await page.keyboard.press('Control+1');
  await expect(page.getByRole('tab').first()).toHaveAttribute('aria-selected', 'true');
  await expect(activeTab(page)).toBeInViewport();
});

test('inaccessible restored folders show an error without blocking other tabs', async ({ page }) => {
  await page.evaluate(() => {
    openTab('0/Removed/');
    saveTabs();
  });
  await expect(page.locator('#content')).toContainText('加载失败');
  await page.reload();
  await expect(activeTab(page)).toHaveText('Removed');
  await expect(page.locator('#content')).toContainText('加载失败');
  await page.getByRole('tab', { name: 'Home', exact: true }).click();
  await expect(row(page, 'Alpha')).toBeVisible();
});

const { test, expect } = require('./app-fixture.cjs');
const checkButton = page => page.getByRole('button', { name: '检查更新', exact: true });
const status = page => page.locator('#settingsUpdateStatus');
const callCount = (page, command) => page.evaluate(command => fixture.calls.filter(call => call.command === command).length, command);

async function available(page, extra = {}) {
  await page.evaluate(extra => {
    fixture.updater.result = { rid: 42, currentVersion: '0.1.11', version: '0.2.0', body: '更新说明\n<em>原样显示</em>' };
    Object.assign(fixture.updater, extra);
  }, extra);
}

async function settings(page) {
  await page.locator('#btnSettings').click();
  await expect(checkButton(page)).toBeVisible();
}

test('settings shows current version and explicit up-to-date feedback without saving draft settings', async ({ page }) => {
  await settings(page);
  await expect(page.locator('#settings-modal')).toContainText('当前版本 v0.1.11');
  const draft = page.locator('#settings-modal input[placeholder="名称"]').first();
  await draft.fill('尚未保存');
  await checkButton(page).click();
  await expect(status(page)).toHaveText('当前已是最新版本');
  await expect(checkButton(page)).toBeEnabled();
  await expect(draft).toHaveValue('尚未保存');
  await expect(page.locator('.hsu-overlay')).toHaveCount(0);
  expect(await callCount(page, 'set_config')).toBe(0);
  expect(await page.evaluate(() => fixture.calls.find(call => call.command === 'plugin:updater|check').args.timeout)).toBe(15000);
});

test('failed checks show an error and can be retried', async ({ page }) => {
  await page.evaluate(() => { fixture.updater.checkError = '网络连接失败'; });
  await settings(page);
  await checkButton(page).click();
  await expect(status(page)).toContainText('检查更新失败：网络连接失败');
  await expect(status(page)).toHaveClass(/error/);
  await expect(checkButton(page)).toBeEnabled();
  await page.evaluate(() => { fixture.updater.checkError = null; });
  await checkButton(page).click();
  await expect(status(page)).toHaveText('当前已是最新版本');
  await expect(status(page)).not.toHaveClass(/error/);
});

test('manual checks join pending startup checks, ignore skipped versions and show only one dialog', async ({ page }) => {
  await available(page, { holdCheck: true });
  await page.evaluate(() => {
    localStorage.setItem('haystack-updater:dismissed-version', '0.2.0');
    fixture.backgroundCheck = HaystackUpdater.check();
  });
  await expect.poll(() => page.evaluate(() => fixture.updater.checkResolvers.length)).toBe(1);
  await settings(page);
  await checkButton(page).click();
  await expect(page.locator('#btnCheckUpdate')).toBeDisabled();
  await expect(page.locator('#btnCheckUpdate')).toHaveText('检查中…');
  await page.evaluate(() => { fixture.updater.checkResolvers.splice(0).forEach(resolve => resolve()); });
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('.hsu-overlay')).toHaveCount(1);
  await page.evaluate(() => HaystackUpdater.check({ silent: false }));
  expect(await callCount(page, 'plugin:updater|check')).toBe(1);
  expect(await callCount(page, 'plugin:resources|close')).toBe(0);
  await expect(page.locator('.hsu-notes')).toContainText('<em>原样显示</em>');
  await expect(page.locator('.hsu-notes em')).toHaveCount(0);
  await expect(status(page)).toContainText('发现新版本 v0.2.0');
  await page.getByRole('button', { name: '稍后提醒', exact: true }).click();
  await expect(page.locator('#settings-modal')).toBeVisible();
  expect(await callCount(page, 'plugin:resources|close')).toBe(1);
});

test('silent skipped updates release resources, but settings can check the same version again', async ({ page }) => {
  await available(page);
  const result = await page.evaluate(async () => {
    localStorage.setItem('haystack-updater:dismissed-version', '0.2.0');
    return HaystackUpdater.check();
  });
  expect(result.status).toBe('skipped');
  await expect(page.locator('.hsu-overlay')).toHaveCount(0);
  expect(await callCount(page, 'plugin:resources|close')).toBe(1);
  await page.evaluate(() => { fixture.updater.result.rid = 43; });
  await settings(page);
  await checkButton(page).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('update requires confirmation, reports download progress and restarts only after installation', async ({ page }) => {
  await available(page, { holdDownload: true });
  await settings(page);
  await checkButton(page).click();
  const install = page.getByRole('button', { name: '立即更新并重启', exact: true });
  await expect(install).toBeVisible();
  expect(await callCount(page, 'plugin:updater|download_and_install')).toBe(0);
  await install.click();
  await expect(install).toBeDisabled();
  await expect(page.getByRole('button', { name: '稍后提醒', exact: true })).toBeDisabled();
  await page.evaluate(() => fixture.updater.channel.onmessage({ event: 'Progress', data: { chunkLength: 40 } }));
  await expect(page.locator('.hsu-progress-text')).toContainText('40%');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await callCount(page, 'plugin:process|restart')).toBe(0);
  await page.evaluate(() => fixture.updater.downloadResolvers.splice(0).forEach(resolve => resolve()));
  await expect(page.locator('.hsu-overlay')).toHaveCount(0);
  expect(await callCount(page, 'plugin:process|restart')).toBe(1);
  expect(await page.evaluate(() => fixture.calls.find(call => call.command === 'plugin:updater|download_and_install').args.rid)).toBe(42);
});

test('signature/download failures do not restart and allow retrying the update', async ({ page }) => {
  await available(page, { downloadError: '签名校验失败' });
  await settings(page);
  await checkButton(page).click();
  await page.getByRole('button', { name: '立即更新并重启', exact: true }).click();
  await expect(page.locator('.hsu-progress-text')).toContainText('更新失败: 签名校验失败');
  expect(await callCount(page, 'plugin:process|restart')).toBe(0);
  expect(await callCount(page, 'plugin:resources|close')).toBe(0);
  await page.evaluate(() => { fixture.updater.downloadError = null; });
  await page.getByRole('button', { name: '重试更新', exact: true }).click();
  await expect(page.locator('.hsu-overlay')).toHaveCount(0);
  expect(await callCount(page, 'plugin:updater|download_and_install')).toBe(2);
  expect(await callCount(page, 'plugin:process|restart')).toBe(1);
});

test('restart failure retries only the restart, not the completed installation', async ({ page }) => {
  await available(page, { restartError: '重启失败' });
  await settings(page);
  await checkButton(page).click();
  await page.getByRole('button', { name: '立即更新并重启', exact: true }).click();
  await expect(page.getByRole('button', { name: '重试重启', exact: true })).toBeVisible();
  await page.evaluate(() => { fixture.updater.restartError = null; });
  await page.getByRole('button', { name: '重试重启', exact: true }).click();
  await expect(page.locator('.hsu-overlay')).toHaveCount(0);
  expect(await callCount(page, 'plugin:updater|download_and_install')).toBe(1);
  expect(await callCount(page, 'plugin:process|restart')).toBe(2);
});

test('development and unpackaged builds can check but cannot overwrite their build directory', async ({ page }) => {
  await available(page, { canInstall: false });
  await settings(page);
  await checkButton(page).click();
  await expect(status(page)).toContainText('发现新版本 v0.2.0');
  await expect(page.getByRole('button', { name: '当前环境不可安装', exact: true })).toBeDisabled();
  await expect(page.locator('.hsu-progress-text')).toContainText('仅支持检查更新');
  expect(await callCount(page, 'plugin:updater|download_and_install')).toBe(0);
  await page.getByRole('button', { name: '稍后提醒', exact: true }).click();
  await expect(checkButton(page)).toBeEnabled();
});

test('missing updater support is reported instead of leaving the button stuck', async ({ page }) => {
  await page.evaluate(() => { delete window.HaystackUpdater; });
  await settings(page);
  await checkButton(page).click();
  await expect(status(page)).toContainText('当前环境不支持在线更新');
  await expect(checkButton(page)).toBeEnabled();
});

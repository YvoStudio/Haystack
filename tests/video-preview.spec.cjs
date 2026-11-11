const fs = require('node:fs');
const path = require('node:path');
const { test, expect, row } = require('./app-fixture.cjs');

const first = '01-blue.mp4';
const second = '02-中文 #50%.MP4';
const third = '03-orange.mov';
const landscape = fs.readFileSync(path.join(__dirname, 'fixtures/video-landscape.mp4'));
const portrait = fs.readFileSync(path.join(__dirname, 'fixtures/video-portrait.mp4'));

async function setupVideos(page) {
  await page.route('**/asset/**', route => {
    const file = decodeURIComponent(new URL(route.request().url()).pathname.slice('/asset/'.length));
    return route.fulfill({
      contentType: 'video/mp4',
      body: file.includes('broken') ? Buffer.from('invalid video') : file.includes('02-') ? portrait : landscape,
    });
  });
  await page.evaluate(({ first, second, third }) => {
    const file = (name, size, mtime) => ({ name, type: 'file', size, mtime });
    fixture.dirs['/work'] = [
      file(first, 1024, '2026-11-01T00:00:00Z'),
      file(second, 2048, '2026-11-03T00:00:00Z'),
      file(third, 3072, '2026-11-02T00:00:00Z'),
      file('notes.txt', 10, '2026-11-04T00:00:00Z'),
      file('audio.mp3', 10, '2026-11-04T00:00:00Z'),
      { name: 'folder.mp4', type: 'directory', size: 0, mtime: '2026-11-04T00:00:00Z' },
    ];
    fixture.dirs['/work/folder.mp4'] = [];
  }, { first, second, third });
  await page.locator('.tree-root-item').filter({ hasText: 'Work' }).click();
  await expect(row(page, first)).toBeVisible();
}

const modal = page => page.locator('#preview-modal');
const title = page => modal(page).locator(':scope > div > div:first-child > span').first();
const prev = page => page.getByRole('button', { name: '上一个视频', exact: true });
const next = page => page.getByRole('button', { name: '下一个视频', exact: true });
const count = page => page.locator('.video-preview-counter');
const info = page => page.locator('.video-preview-info');
const playing = page => expect.poll(() => page.locator('#preview-modal video').evaluate(v => v.readyState >= 2 && !v.paused && v.currentTime > 0)).toBe(true);

test('video navigation follows display order, skips other entries and opens the current file', async ({ page }, testInfo) => {
  await setupVideos(page);
  await page.locator('#btnViewSort').click();
  await page.locator('#viewSortMenu').getByText('按日期', { exact: true }).click();
  await row(page, third).locator('.file-name').click();
  await expect(count(page)).toHaveText('2 / 3');
  await playing(page);
  await next(page).click();
  await expect(title(page)).toHaveText(first);
  await expect(count(page)).toHaveText('3 / 3');
  await expect(next(page)).toBeDisabled();
  await modal(page).getByRole('button', { name: '打开', exact: true }).click();
  await expect.poll(() => page.evaluate(() => fixture.calls.filter(c => c.command === 'plugin:opener|open_path').at(-1)?.args.path)).toBe('/work/' + first);
  await prev(page).click();
  await prev(page).click();
  await expect(title(page)).toHaveText(second);
  await expect(count(page)).toHaveText('1 / 3');
  await expect(prev(page)).toBeDisabled();
  await expect(next(page)).toBeEnabled();
  await playing(page);
  await expect(info(page)).toHaveText('90 × 160  ·  0:07  ·  2.0 K');
  await modal(page).locator('video').evaluate(v => new Promise(resolve => v.requestVideoFrameCallback(() => { v.pause(); resolve(); })));
  await page.screenshot({ path: testInfo.outputPath('video-preview-portrait.png') });
  await modal(page).getByRole('button', { name: '打开', exact: true }).click();
  await expect.poll(() => page.evaluate(() => fixture.calls.filter(c => c.command === 'plugin:opener|open_path').at(-1)?.args.path)).toBe('/work/' + second);
  await page.keyboard.press('Escape');
});

test('switching reuses the player and closing or replacing the preview releases playback', async ({ page }) => {
  await setupVideos(page);
  await row(page, first).locator('.file-name').click();
  await playing(page);
  await page.evaluate(() => {
    window.previousVideo = document.querySelector('#preview-modal video');
    previousVideo.muted = true;
    previousVideo.volume = 0.25;
    previousVideo.playbackRate = 1.5;
    previousVideo.currentTime = 3;
  });
  await next(page).click();
  await expect(title(page)).toHaveText(second);
  await playing(page);
  expect(await page.evaluate(() => {
    const v = document.querySelector('#preview-modal video');
    return { samePlayer: v === previousVideo, muted: v.muted, volume: v.volume, rate: v.playbackRate, startedFromBeginning: v.currentTime < 3 };
  })).toEqual({ samePlayer: true, muted: true, volume: 0.25, rate: 1.5, startedFromBeginning: true });
  await page.keyboard.press('Escape');
  await expect(modal(page)).toHaveCount(0);
  expect(await page.evaluate(() => previousVideo.paused && !previousVideo.getAttribute('src'))).toBe(true);
  await row(page, first).locator('.file-name').click();
  await playing(page);
  await page.evaluate(({ second }) => {
    window.replacedVideo = document.querySelector('#preview-modal video');
    showVideoPreview('/www/1/' + second, second);
  }, { second });
  await expect(title(page)).toHaveText(second);
  expect(await page.evaluate(() => replacedVideo.paused && !replacedVideo.getAttribute('src'))).toBe(true);
  await page.keyboard.press('Escape');
});

test('a video outside the cached folder stays isolated and a single video disables navigation', async ({ page }) => {
  await setupVideos(page);
  await page.evaluate(({ first }) => showVideoPreview('/www/0/Alpha/' + first, first), { first });
  await expect(count(page)).toHaveText('1 / 1');
  await expect(prev(page)).toBeDisabled();
  await expect(next(page)).toBeDisabled();
  await expect(modal(page).locator('video')).toHaveAttribute('src', '/asset/' + encodeURIComponent('/home/Alpha/' + first));
  await modal(page).getByRole('button', { name: '打开', exact: true }).click();
  await expect.poll(() => page.evaluate(() => fixture.calls.filter(c => c.command === 'plugin:opener|open_path').at(-1)?.args.path)).toBe('/home/Alpha/' + first);
  await page.keyboard.press('Escape');
  await page.evaluate(async ({ first }) => {
    fixture.dirs['/work'] = fixture.dirs['/work'].filter(item => item.name === first);
    invalidateDirCache();
    await renderFiles(pathFromHash());
  }, { first });
  await row(page, first).locator('.file-name').click();
  await expect(count(page)).toHaveText('1 / 1');
  await expect(prev(page)).toBeDisabled();
  await expect(next(page)).toBeDisabled();
  await playing(page);
  await page.keyboard.press('Escape');
});

test('an unplayable video can be skipped and navigation fits a small thumbnail preview', async ({ page }, testInfo) => {
  await setupVideos(page);
  await page.evaluate(async () => {
    fixture.dirs['/work'].push({ name: '00-broken.mp4', type: 'file', size: 10, mtime: '2026-11-04T00:00:00Z' });
    invalidateDirCache();
    await renderFiles(pathFromHash());
  });
  await page.setViewportSize({ width: 900, height: 600 });
  await page.locator('#btnViewSort').click();
  await page.locator('#viewSortMenu').getByText('大缩略图', { exact: true }).click();
  await page.locator('.thumb-card[data-name="00-broken.mp4"]').click();
  await expect(info(page)).toContainText('视频加载失败');
  await expect(next(page)).toBeEnabled();
  await next(page).click();
  await expect(title(page)).toHaveText(first);
  await expect(count(page)).toHaveText('2 / 4');
  await playing(page);
  await expect(info(page)).toHaveText('160 × 90  ·  0:05  ·  1.0 K');
  await expect(prev(page)).toBeInViewport();
  await expect(next(page)).toBeInViewport();
  await modal(page).locator('video').evaluate(v => new Promise(resolve => v.requestVideoFrameCallback(() => { v.pause(); resolve(); })));
  await page.screenshot({ path: testInfo.outputPath('video-preview-small.png') });
  await page.keyboard.press('Escape');
});

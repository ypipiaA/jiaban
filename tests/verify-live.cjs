/* 手动执行的线上验收：新建独立临时同步空间，不接触用户已有浏览器或记录。 */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const URL = 'https://jiaban-x2m.pages.dev';
const marker = 'jiaban-live-check-' + randomUUID();
const metadata = path.join(ROOT, '.local', 'live-verification.json');

async function record(page, date, hours, note) {
  await page.locator('nav [data-view="cal"]').click();
  await page.locator('#calMonth').fill(date.slice(0, 7));
  await page.locator(`[data-ds="${date}"]`).click();
  await page.locator('#dHours').fill(String(hours - 2));
  await page.locator('#dOT').fill('2');
  assert.equal(await page.locator('#dayCard .tag').textContent(), '待保存');
  await page.locator('#btnDaySave').click();
  assert.equal(await page.locator('#dayCard .tag').textContent(), '已保存');
  await page.locator('[data-action="edit"]').click();
  assert.equal(await page.locator('#fHours').inputValue(), String(hours - 2));
  assert.equal(await page.locator('#fOT').inputValue(), '2');
  if (!await page.locator('#fMore').evaluate(el => el.open)) await page.locator('#fMore > summary').click();
  await page.locator('#fNote').fill(marker + ' ' + note);
  await page.locator('#btnSave').click();
  await page.locator('nav [data-view="set"]').click();
}
async function synced(page) {
  if (!await page.locator('#syncCard').evaluate(el => el.open)) await page.locator('#syncCard > summary').click();
  await page.locator('#syncNow').click();
  await page.waitForFunction(() => document.getElementById('syncStatus').textContent.startsWith('已同步'), null, { timeout: 45000 });
}
const data = page => page.evaluate(() => JSON.parse(localStorage.getItem('jiaban.v1')));

(async () => {
  await fs.mkdir(path.join(ROOT, '.local'), { recursive: true });
  await fs.mkdir(path.join(ROOT, 'test-results'), { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  let a, b;
  try {
    const ca = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    const cb = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', isMobile: true, hasTouch: true });
    a = await ca.newPage(); b = await cb.newPage();
    for (const p of [a, b]) { p.setDefaultTimeout(45000); p.on('pageerror', error => errors.push(error.message)); }
    await Promise.all([a.goto(URL), b.goto(URL)]);
    assert.equal(await a.evaluate(() => typeof settingsDirty), 'function', '正式站已更新设置草稿保护');
    assert.deepEqual(await a.locator('.sum .metric').evaluateAll(nodes => nodes.map(el => getComputedStyle(el).backgroundColor)), Array(3).fill('rgb(255, 255, 255)'));
    assert.match(await b.locator('meta[name="viewport"]').getAttribute('content'), /maximum-scale=1, user-scalable=no/);
    assert.equal(await a.locator('.daily-table thead th').count(), 9);
    assert.equal(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await record(a, '2026-09-07', 10, 'device-a initial');
    await a.locator('#syncCard > summary').click();
    await a.locator('#syncCreate').click();
    await a.waitForFunction(() => !!localStorage.getItem('jiaban.sync.v1'));
    const code = await a.evaluate(() => JSON.parse(localStorage.getItem('jiaban.sync.v1')).code);
    await fs.writeFile(metadata, JSON.stringify({ url: URL, code, marker, startedAt: new Date().toISOString() }), 'utf8');
    await a.waitForFunction(() => document.getElementById('syncStatus').textContent.startsWith('已同步'));
    await b.locator('nav [data-view="set"]').click();
    await b.locator('#syncCard > summary').click();
    await b.locator('#syncJoinDetails > summary').click();
    await b.locator('#syncJoinCode').fill(code); await b.locator('#syncJoin').click();
    await b.waitForFunction(() => document.getElementById('syncStatus').textContent.startsWith('已同步'));
    assert.equal((await data(b)).records['2026-09-07'].hours, 10);
    assert.equal((await data(b)).records['2026-09-07'].ot, 2);
    console.log('PASS: Production pairing and device A -> device B transfer');

    await ca.setOffline(true); await cb.setOffline(true);
    await record(a, '2026-09-08', 11, 'device-a offline');
    await record(b, '2026-09-09', 12, 'device-b offline');
    await ca.setOffline(false); await synced(a);
    await cb.setOffline(false); await synced(b); await synced(a);
    assert.deepEqual(await data(a), await data(b));
    assert.equal(Object.keys((await data(a)).records).length, 3);
    console.log('PASS: Bidirectional offline changes merge through real D1');

    await ca.setOffline(true); await cb.setOffline(true);
    await record(a, '2026-09-07', 11, 'device-a conflict');
    await record(b, '2026-09-07', 12, 'device-b conflict');
    await ca.setOffline(false); await synced(a);
    await cb.setOffline(false); await b.locator('#syncNow').click();
    await b.waitForFunction(() => !document.getElementById('syncConflicts').classList.contains('hide'));
    assert.equal((await data(b)).records['2026-09-07'].hours, 12);
    await b.locator('input[name="sync-conflict-0"][value="remote"]').check();
    await b.locator('#syncResolve').click();
    await b.waitForFunction(() => document.getElementById('syncStatus').textContent.startsWith('已同步'));
    assert.equal((await data(b)).records['2026-09-07'].hours, 11);
    assert.equal(await b.evaluate(() => JSON.parse(localStorage.getItem('jiaban.recovery.v1'))[0].data.records['2026-09-07'].hours), 12);
    console.log('PASS: Conflicting edits require a choice and retain local recovery');

    await a.locator('#syncAdvanced > summary').click();
    await a.locator('#syncHistory').click();
    await a.locator('#syncHistoryList [data-version]').first().waitFor();
    assert.ok(await a.locator('#syncHistoryList [data-version]').count() >= 3);
    const downloadPromise = a.waitForEvent('download');
    await a.locator('#syncHistoryList [data-version]').first().click();
    const download = await downloadPromise;
    const historical = JSON.parse(await fs.readFile(await download.path(), 'utf8'));
    assert.ok(Object.keys(historical.records).length > 0);
    await a.locator('#syncHistory').click();
    assert.equal(await a.locator('#syncHistoryList').isVisible(), false, '云端历史再次点击收起');
    await a.locator('#syncHistory').click();
    await a.locator('#syncHistoryList [data-version]').first().waitFor();
    assert.equal(await a.locator('#syncHistory').getAttribute('aria-expanded'), 'true');
    console.log('PASS: Cloud history downloads, collapses and reopens correctly');

    await b.evaluate(() => navigator.serviceWorker.ready);
    await b.reload(); await b.waitForFunction(() => !!navigator.serviceWorker.controller);
    await cb.setOffline(true); await b.reload();
    assert.equal((await data(b)).records['2026-09-09'].hours, 12);
    assert.ok(await b.locator('#calGrid .day').count() > 0);
    await cb.setOffline(false);
    await b.locator('nav [data-view="set"]').click(); await synced(b);
    await b.screenshot({ path: path.join(ROOT, 'test-results/live-sync-mobile.png'), fullPage: true });
    assert.deepEqual(errors, []);
    console.log('PASS: Production PWA restarts offline with saved records');
    await fs.writeFile(path.join(ROOT, 'test-results/live-verification-result.json'), JSON.stringify({ url: URL, checkedAt: new Date().toISOString(), passed: 5, result: 'passed', devices: 'two isolated Chromium contexts (desktop and mobile)', pageErrors: errors }, null, 2));
    console.log('LIVE VERIFICATION PASSED');
  } catch (error) {
    for (const [name, p] of [['a', a], ['b', b]]) if (p) console.error('Device', name, 'status:', await p.locator('#syncStatus').textContent().catch(() => 'unavailable'));
    console.error(error.message); process.exitCode = 1;
  } finally { await browser.close(); }
})();

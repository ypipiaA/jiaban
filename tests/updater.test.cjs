const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { createServer } = require('../dev-server.cjs');
const path = require('node:path');
let server, browser, base;
before(async () => { server = await createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`; browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); await new Promise(r => server.close(r)); });

async function device(t, options = {}) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  t.after(() => context.close());
  await context.addInitScript(options => {
    window.updateTest = { checks: 0, installs: 0, downloads: 0, permission: true, offline: false, progress: null, ...options };
    const state = window.updateTest;
    window.JiabanNative = { appInfo: async () => ({ version: '1.3.0' }), updater: {
      check: async () => {
        state.checks++;
        if (state.offline) throw new Error('offline');
        return { currentVersion: '1.3.0', available: state.available !== false, compatible: state.compatible !== false,
          release: { version: '1.4.0', versionCode: 140, size: 4200000, notes: '操作体验优化\n保留已有工时记录' } };
      },
      addListener: async (name, handler) => { state.progress = handler; return { remove: async () => {} }; },
      download: async () => { state.downloads++; if (state.failDownload) throw new Error('下载中断，请联网后重试'); if (state.delayDownload) await new Promise(resolve => { state.finish = resolve; }); },
      install: async () => { state.installs++; return { permissionRequired: !state.permission }; },
      openInstallSettings: async () => { state.settingsOpened = true; }
    } };
  }, options);
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.goto(base);
  return page;
}

test('打开提示新版，稍后不重复打扰，手动检查可重新打开', async t => {
  const page = await device(t);
  await page.locator('#appUpdate').waitFor({ state: 'visible' });
  assert.match(await page.locator('#updateVersion').textContent(), /1.4.0/);
  assert.equal(await page.locator('#appVersionLabel').textContent(), 'v1.3.0', '显示实际已安装版本，不把可下载新版当作当前版本');
  assert.equal(await page.locator('#v-set > :last-child').getAttribute('id'), 'appVersion');
  await page.screenshot({ path: path.join(__dirname, '../.local/update-prompt-390.png') });
  await page.setViewportSize({ width: 320, height: 568 });
  const fit = await page.locator('.update-panel').boundingBox();
  assert.ok(fit.x >= 0 && fit.x + fit.width <= 320 && fit.y + fit.height <= 568);
  await page.screenshot({ path: path.join(__dirname, '../.local/update-prompt-320.png') });
  await page.locator('#updateLater').click();
  assert.equal(await page.evaluate(() => document.querySelector('main').inert), false);
  await page.reload(); await page.waitForFunction(() => updateTest.checks === 1);
  assert.equal(await page.locator('#appUpdate').isVisible(), false);
  await page.locator('nav [data-view="set"]').click(); await page.locator('#checkAppUpdate').click();
  await page.locator('#appUpdate').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => JiabanUpdate.back()), true);
  assert.equal(await page.evaluate(() => JiabanUpdate.back()), false);
});

test('断网自动检查安静失败，手动可重试，最新版本不弹窗', async t => {
  const page = await device(t, { offline: true, available: false });
  await page.waitForFunction(() => updateTest.checks === 1);
  assert.equal(await page.locator('#appUpdate').isVisible(), false);
  assert.equal(await page.locator('#appUpdateStatus').textContent(), '');
  await page.locator('nav [data-view="set"]').click(); await page.locator('#checkAppUpdate').click();
  assert.match(await page.locator('#appUpdateStatus').textContent(), /联网后重试/);
  await page.evaluate(() => { updateTest.offline = false; });
  await page.locator('#checkAppUpdate').click();
  assert.equal(await page.locator('#appUpdateStatus').textContent(), '已是最新版本');
  assert.equal(await page.locator('#appUpdate').isVisible(), false);
});

test('下载完成后引导安装权限，返回继续安装，保留已保存记录', async t => {
  const page = await device(t, { permission: false });
  await page.locator('#dHours').fill('7'); await page.locator('#dOT').fill('2'); await page.locator('#btnDaySave').click();
  const saved = await page.evaluate(() => JSON.stringify(S.records));
  await page.locator('#appUpdate').waitFor({ state: 'visible' }); await page.locator('#updateNow').click();
  await page.waitForFunction(() => document.getElementById('updateNow').textContent === '去允许安装');
  await page.locator('#updateNow').click();
  assert.equal(await page.evaluate(() => updateTest.settingsOpened), true);
  assert.equal(await page.locator('#updateNow').textContent(), '继续安装');
  await page.evaluate(() => { updateTest.permission = true; JiabanUpdate.resume(); });
  await page.locator('#updateNow').click();
  assert.equal(await page.evaluate(() => updateTest.installs), 2);
  assert.equal(await page.evaluate(() => JSON.stringify(S.records)), saved);
});

test('后台下载完成不弹系统安装，未保存的草稿可拒绝更新', async t => {
  const page = await device(t, { delayDownload: true });
  await page.locator('#dHours').fill('6.5');
  await page.locator('#appUpdate').waitFor({ state: 'visible' }); await page.locator('#updateNow').click();
  await page.evaluate(() => updateTest.progress({ percent: 43 }));
  assert.equal(await page.locator('#updateProgress').getAttribute('value'), '43');
  await page.locator('#updateLater').click(); await page.evaluate(() => updateTest.finish());
  await page.waitForFunction(() => document.getElementById('appUpdateStatus').textContent.includes('已下载'));
  assert.equal(await page.evaluate(() => updateTest.installs), 0);
  // Open without navigating away from the unsaved day.
  await page.evaluate(() => document.getElementById('checkAppUpdate').click());
  page.once('dialog', dialog => dialog.dismiss()); await page.locator('#updateNow').click();
  assert.equal(await page.evaluate(() => updateTest.installs), 0);
  await page.locator('#updateLater').click(); assert.equal(await page.locator('#dHours').inputValue(), '6.5');
});

test('下载失败可在原面板重试，系统不兼容时禁止更新', async t => {
  const page = await device(t, { failDownload: true });
  await page.locator('#appUpdate').waitFor({ state: 'visible' }); await page.locator('#updateNow').click();
  assert.equal(await page.locator('#updateNow').textContent(), '重新下载');
  assert.match(await page.locator('#updateMessage').textContent(), /下载中断/);
  await page.evaluate(() => { updateTest.failDownload = false; }); await page.locator('#updateNow').click();
  assert.equal(await page.evaluate(() => updateTest.downloads), 2);
  assert.equal(await page.evaluate(() => updateTest.installs), 1);
  const other = await device(t, { compatible: false });
  await other.waitForFunction(() => updateTest.checks === 1);
  assert.equal(await other.locator('#appUpdate').isVisible(), false);
  await other.locator('nav [data-view="set"]').click(); await other.locator('#checkAppUpdate').click();
  assert.equal(await other.locator('#updateNow').isDisabled(), true);
  assert.match(await other.locator('#updateMessage').textContent(), /更高的安卓系统/);
});

test('苹果桌面版首次缓存不提示更新，新版就绪提示且拒绝丢弃草稿', async t => {
  const context = await browser.newContext(); t.after(() => context.close());
  await context.addInitScript(() => {
    window.swTest = { controller: null, register: async () => ({}), getRegistration: async () => ({}),
      addEventListener: (name, callback) => { window.swChange = callback; } };
    Object.defineProperty(navigator, 'serviceWorker', { value: window.swTest });
  });
  const page = await context.newPage(); await page.goto(base);
  await page.evaluate(() => swChange()); assert.equal(await page.locator('#webUpdate').isVisible(), false);
  await page.evaluate(() => swChange()); assert.equal(await page.locator('#webUpdate').isVisible(), true);
  await page.locator('#dHours').fill('7.5');
  page.once('dialog', dialog => dialog.dismiss()); await page.locator('#webUpdateNow').click();
  assert.equal(await page.locator('#dHours').inputValue(), '7.5');
  await page.locator('#webUpdateDismiss').click(); assert.equal(await page.locator('#webUpdate').isVisible(), false);
  await page.evaluate(() => swChange());
  let confirmations = 0;
  page.on('dialog', async dialog => { confirmations++; await dialog.accept(); });
  await Promise.all([page.waitForEvent('load'), page.locator('#webUpdateNow').click()]);
  assert.equal(confirmations, 1, '确认后直接更新，不重复确认放弃同一草稿');
});

test('重新打开或安装更新前，工时设置和详细记录草稿都受保护', async t => {
  const page = await device(t, { available: false });
  await page.locator('nav [data-view="set"]').click(); await page.locator('#rulesSettings > summary').click();
  await page.locator('#sDaily').fill('9'); page.once('dialog', d => d.dismiss());
  assert.equal(await page.evaluate(() => JiabanApp.canRestart()), false);
  assert.equal(await page.locator('#sDaily').inputValue(), '9');
  page.once('dialog', d => d.accept()); await page.locator('nav [data-view="cal"]').click();
  await page.locator('[data-action="edit"]').click();
  await page.locator('#fHours').fill('7'); page.once('dialog', d => d.dismiss());
  assert.equal(await page.evaluate(() => JiabanApp.canRestart()), false);
  assert.equal(await page.locator('#fHours').inputValue(), '7');
});

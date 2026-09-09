const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { build } = require('esbuild');
const { chromium } = require('playwright');
const { createServer } = require('../dev-server.cjs');
let browser, server, base;
before(async () => { server = await createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`; browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); await new Promise(r => server.close(r)); });

test('内置资源不包含凭据或服务端代码，使用原生桥接而非远程网页外壳', async () => {
  const config = JSON.parse(await fs.readFile(path.join(__dirname, 'capacitor.config.json'), 'utf8'));
  assert.equal(config.server, undefined);
  assert.equal(config.android.webContentsDebuggingEnabled, false);
  assert.deepEqual((await fs.readdir(path.join(__dirname, 'www'))).sort(), ['index.html', 'sync-core.js', 'sync-client.js', 'app-update.js', 'native-runtime.js', 'manifest.json', 'icon.svg', 'icon-192.png', 'icon-512.png'].sort());
  const html = await fs.readFile(path.join(__dirname, 'www/index.html'), 'utf8');
  assert.ok(html.includes('<script src="native-runtime.js"></script>'));
  assert.ok(!html.includes('id="installLink"'));
});

test('原生桥固定 HTTPS 同步地址，备份调用私有缓存和系统分享', async () => {
  const calls = [], listeners = {}, window = {};
  const plugins = {
    Capacitor: { isNativePlatform: () => true },
    registerPlugin: name => ({ name }),
    CapacitorHttp: { request: async args => { calls.push(['http', args]); return { status: 409, data: { error: 'conflict' } }; } },
    Filesystem: { writeFile: async args => { calls.push(['file', args]); return { uri: 'file:///private/cache/exports/backup.json' }; } },
    Directory: { Cache: 'CACHE' }, Encoding: { UTF8: 'UTF8' },
    Share: { share: async args => calls.push(['share', args]) },
    Clipboard: { write: async args => calls.push(['copy', args]) },
    App: { addListener: (event, handler) => { listeners[event] = handler; }, exitApp: () => calls.push(['exit']) },
    SystemBars: { setStyle: async () => {} }, SystemBarsStyle: { Light: 'LIGHT' }
  };
  const result = await build({ entryPoints: [path.join(__dirname, 'runtime.js')], bundle: true, write: false, format: 'iife', plugins: [{ name: 'device-plugins', setup(build) {
    build.onResolve({ filter: /^@capacitor\// }, args => ({ path: args.path, namespace: 'mock' }));
    build.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: Object.keys(plugins).map(key => `export const ${key} = globalThis.plugins.${key};`).join('\n') }));
  }}] });
  vm.runInNewContext(result.outputFiles[0].text, { window, plugins, DOMException });
  assert.equal(window.JiabanNative.updater.name, 'AppUpdater');
  const response = await window.JiabanNative.request('/api/sync', 'PUT', { revision: 2 }, { Authorization: 'Bearer isolated-test' });
  assert.equal(response.status, 409); assert.equal(response.ok, false);
  assert.equal((await response.json()).error, 'conflict');
  assert.equal(calls[0][1].url, 'https://jiaban-x2m.pages.dev/api/sync');
  assert.equal(calls[0][1].disableRedirects, true);
  await assert.rejects(() => window.JiabanNative.request('https://untrusted.invalid', 'GET'), /同步地址/);
  await window.JiabanNative.download('{"记录":1}', '加班备份.json');
  assert.equal(calls[1][1].directory, 'CACHE'); assert.equal(calls[1][1].path, 'exports/加班备份.json');
  assert.equal(calls[2][1].files[0], 'file:///private/cache/exports/backup.json');
  await window.JiabanNative.copy('test-code'); assert.equal(calls.at(-1)[1].string, 'test-code');
  window.JiabanApp = { back: () => true }; listeners.backButton(); assert.notEqual(calls.at(-1)[0], 'exit');
  window.JiabanApp = { back: () => false }; listeners.backButton(); assert.equal(calls.at(-1)[0], 'exit');
  calls.length = 0; window.JiabanUpdate = { back: () => true, resume: () => calls.push(['check-update']) };
  listeners.backButton(); assert.equal(calls.length, 0);
  listeners.appStateChange({ isActive: true }); assert.equal(calls[0][0], 'check-update');
});

test('模拟原生桥可与网页双向同步，备份和返回键仍保留记录草稿', async t => {
  const native = await browser.newContext({ viewport: { width: 390, height: 844 } }), web = await browser.newContext();
  t.after(async () => { await native.close(); await web.close(); });
  await native.addInitScript(() => {
    window.nativeCalls = [];
    window.JiabanNative = { request: async (path, method, body, headers) => fetch(path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) }), copy: async value => { window.copiedCode = value; }, download: async (content, filename) => window.nativeCalls.push({ content, filename }) };
  });
  const a = await native.newPage(), b = await web.newPage(), errors = [];
  for (const page of [a, b]) page.on('pageerror', e => errors.push(e.message));
  await Promise.all([a.goto(base), b.goto(base)]);
  await a.locator('#dHours').fill('7'); await a.locator('#dOT').fill('2'); await a.locator('#btnDaySave').click();
  await a.locator('nav [data-view="set"]').click(); await a.locator('#syncCard > summary').click(); await a.locator('#syncCreate').click();
  await a.waitForFunction(() => document.getElementById('syncStatus').textContent.startsWith('已同步'));
  await a.locator('#syncCopy').click(); const code = await a.evaluate(() => window.copiedCode);
  await b.locator('nav [data-view="set"]').click(); await b.locator('#syncCard > summary').click(); await b.locator('#syncJoinDetails > summary').click(); await b.locator('#syncJoinCode').fill(code); await b.locator('#syncJoin').click();
  await b.waitForFunction(() => document.getElementById('syncStatus').textContent.startsWith('已同步'));
  assert.equal(await b.evaluate(() => Object.values(S.records)[0].hours), 9);
  await b.locator('nav [data-view="cal"]').click(); await b.locator('#dHours').fill('8'); await b.locator('#btnDaySave').click();
  await b.evaluate(() => JiabanSync.run()); await a.evaluate(() => JiabanSync.run());
  assert.equal(await a.evaluate(() => Object.values(S.records)[0].hours), 10);
  await a.locator('#backupSettings > summary').click(); await a.locator('#btnExport').click();
  assert.equal(await a.evaluate(() => Object.values(JSON.parse(nativeCalls[0].content).records)[0].hours), 10);
  assert.equal(await a.evaluate(() => JiabanApp.back()), true);
  await a.locator('#dHours').fill('6'); a.once('dialog', dialog => dialog.dismiss());
  assert.equal(await a.evaluate(() => JiabanApp.back()), true, '拒绝放弃草稿时不退出 App');
  assert.equal(await a.locator('#dHours').inputValue(), '6');
  a.once('dialog', dialog => dialog.accept()); assert.equal(await a.evaluate(() => JiabanApp.back()), false);
  assert.deepEqual(errors, []);
});

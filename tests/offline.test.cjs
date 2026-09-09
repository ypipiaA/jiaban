const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

const PUBLIC = path.resolve(__dirname, '../public');
let browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser?.close(); });

async function installedApp(t) {
  let unavailable = false;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (unavailable || url.pathname.startsWith('/api/')) {
      res.writeHead(503, { 'Content-Type': 'text/plain', 'X-Test-Origin': 'unavailable', 'Cache-Control': 'no-store' });
      res.end(`maintenance:${req.method}:${url.pathname}`);
      return;
    }
    try {
      const filename = path.resolve(PUBLIC, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1)));
      if (!filename.startsWith(PUBLIC + path.sep)) { res.writeHead(403).end(); return; }
      const body = await fs.readFile(filename);
      const type = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' }[path.extname(filename)];
      res.writeHead(200, { 'Content-Type': type || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const context = await browser.newContext({ serviceWorkers: 'allow' });
  t.after(() => context.close());
  const page = await context.newPage();
  const base = `http://127.0.0.1:${server.address().port}`;
  await page.goto(base);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  return { page, base, failOrigin: () => { unavailable = true; } };
}

test('静态资源返回 503 时从缓存打开页面且仍可录入', async t => {
  const { page, base, failOrigin } = await installedApp(t);
  failOrigin();
  const response = await page.goto(base);
  assert.equal(response.status(), 200);
  assert.equal(response.fromServiceWorker(), true);
  await page.locator('#dHours').fill('8');
  await page.locator('#dOT').fill('2');
  await page.locator('#btnDaySave').click();
  assert.deepEqual(await page.evaluate(() => {
    const record = Object.values(JSON.parse(localStorage.getItem('jiaban.v1')).records)[0];
    return [record.hours, record.ot];
  }), [10, 2], '应用脚本也通过缓存加载，录入可正常保存');
  const icon = await page.evaluate(async () => {
    const response = await fetch('/icon-192.png');
    return { status: response.status, type: response.headers.get('content-type'), bytes: (await response.arrayBuffer()).byteLength };
  });
  assert.equal(icon.status, 200);
  assert.equal(icon.type, 'image/png');
  assert.ok(icon.bytes > 0);
});

test('没有静态缓存时保留原始 503，API 请求始终直达服务器', async t => {
  const { page, failOrigin } = await installedApp(t);
  await page.evaluate(async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('jiaban-')) await (await caches.open(key)).delete('/icon-512.png');
    }
  });
  failOrigin();
  const icon = await page.evaluate(async () => {
    const response = await fetch('/icon-512.png');
    return { status: response.status, text: await response.text(), origin: response.headers.get('x-test-origin') };
  });
  assert.deepEqual(icon, { status: 503, text: 'maintenance:GET:/icon-512.png', origin: 'unavailable' });
  for (const method of ['GET', 'POST']) {
    const received = page.waitForResponse(response => response.url().endsWith('/api/health') && response.request().method() === method);
    const api = await page.evaluate(async method => {
      const response = await fetch('/api/health', { method });
      return { status: response.status, text: await response.text() };
    }, method);
    assert.deepEqual(api, { status: 503, text: `maintenance:${method}:/api/health` });
    assert.equal((await received).fromServiceWorker(), false, `${method} API 不被离线缓存拦截`);
  }
  assert.equal(await page.evaluate(async () => {
    for (const key of await caches.keys()) if (await (await caches.open(key)).match('/api/health')) return true;
    return false;
  }), false, 'API 错误响应不进入缓存');
  const download = await page.goto(new URL('/downloads/jiaban-1.2.0.apk', page.url()).href);
  assert.equal(download.status(), 503, '安装包下载失败时不返回主页 HTML');
  assert.equal(download.fromServiceWorker(), false, '安装包不进入离线缓存');
  const latest = await page.goto(new URL('/downloads/android-latest.json', page.url()).href);
  assert.equal(latest.status(), 503, '断网不能返回缓存的旧更新清单');
  assert.equal(latest.fromServiceWorker(), false, '更新清单始终直达服务器');
});

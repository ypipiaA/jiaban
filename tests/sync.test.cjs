const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { chromium } = require('playwright');
const Core = require('../sync-core.js');
const { createServer } = require('../dev-server.cjs');
let server, browser, base;
const work = (h, note = '') => ({ type: 'work', hours: h, ot: Math.max(0, h - 8), otMode: 'comp', note });
before(async () => {
  server = await createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  await fs.mkdir(path.resolve(__dirname, '../test-results'), { recursive: true });
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });
async function devices(t, count = 2) {
  const pages = [];
  for (let i = 0; i < count; i++) {
    const c = await browser.newContext({ viewport: { width: i ? 390 : 1280, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    t.after(() => c.close()); const p = await c.newPage(); const errors = [];
    p.on('pageerror', e => errors.push(e.message)); t.after(() => assert.deepEqual(errors, []));
    await p.goto(base); await p.locator('nav [data-view="set"]').click();
    assert.equal(await p.locator('#syncCard').evaluate(el => el.open), false);
    await p.locator('#syncCard > summary').click(); pages.push(p);
  }
  return pages;
}
async function create(page) {
  await page.locator('#syncCreate').click(); await page.waitForFunction(() => document.getElementById('syncStatus').textContent.startsWith('已同步'));
  return page.evaluate(() => JSON.parse(localStorage.getItem('jiaban.sync.v1')).code);
}
async function join(page, code, conflict = false) {
  if (!await page.locator('#syncJoinDetails').evaluate(el => el.open)) await page.locator('#syncJoinDetails > summary').click();
  await page.locator('#syncJoinCode').fill(code); await page.locator('#syncJoin').click();
  await page.waitForFunction(conflict => document.getElementById('syncStatus').textContent.startsWith(conflict ? '有 ' : '已同步'), conflict);
}
async function run(page) { await page.evaluate(() => JiabanSync.run()); }
async function change(page, date, hours, note = '') {
  await page.evaluate(({ date, hours, note }) => updateData(next => { next.records[date] = { type: 'work', hours, ot: Math.max(0, hours - 8), otMode: 'comp', note }; }), { date, hours, note });
}
const data = page => page.evaluate(() => JSON.parse(localStorage.getItem('jiaban.v1')));
async function api(code, method = 'GET', body, suffix = '') {
  const r = await fetch(base + '/api/sync' + suffix, { method, headers: { Authorization: 'Bearer ' + code, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, value: await r.json() };
}

test('三方合并保留不同日期、独立调整、删除和同项冲突', () => {
  const baseData = Core.empty(); baseData.records['2026-09-01'] = work(8);
  const local = structuredClone(baseData), remote = structuredClone(baseData);
  local.records['2026-09-02'] = work(10); remote.records['2026-09-03'] = work(12);
  local.adjust.push({ id: 'a', d: '2026-09-01', h: 2, note: '' }); remote.adjust.push({ id: 'b', d: '2026-09-01', h: 4, note: '' });
  delete local.records['2026-09-01'];
  const merged = Core.merge(baseData, local, remote);
  assert.equal(merged.conflicts.length, 0); assert.equal(Object.keys(merged.data.records).length, 2); assert.equal(merged.data.adjust.length, 2);
  remote.records['2026-09-01'] = work(9);
  const conflict = Core.merge(baseData, local, remote);
  assert.equal(conflict.conflicts.length, 1);
  assert.equal(Core.merge(baseData, local, remote, { 'record:2026-09-01': 'remote' }).data.records['2026-09-01'].hours, 9);
});

test('两台独立设备双向同步、离线补传、删除传播与历史恢复副本', async t => {
  const [a, b] = await devices(t);
  await change(a, '2026-09-07', 10);
  const code = await create(a); await join(b, code);
  await a.locator('#syncCard > summary').click();
  assert.equal(await a.locator('#syncNow').isVisible(), false);
  assert.equal(await a.locator('#syncSummary').textContent(), '已同步');
  assert.equal((await data(b)).records['2026-09-07'].hours, 10);
  await a.context().setOffline(true); await b.context().setOffline(true);
  await change(a, '2026-09-08', 11); await change(b, '2026-09-09', 12);
  await a.context().setOffline(false); await run(a);
  await b.context().setOffline(false); await run(b);
  await run(a);
  assert.deepEqual(await data(a), await data(b));
  assert.equal(await a.locator('#syncCard').evaluate(el => el.open), false, '折叠后仍可同步，完成后不自动展开');
  await a.locator('#syncCard > summary').click();
  assert.equal(Object.keys((await data(a)).records).length, 3);
  await a.evaluate(() => updateData(next => { delete next.records['2026-09-07']; }));
  await run(a); await run(b);
  assert.equal((await data(b)).records['2026-09-07'], undefined);
  const history = await api(code, 'GET', undefined, '/history');
  assert.ok(history.value.versions.length >= 3);
  const old = await api(code, 'GET', undefined, '/history?revision=1');
  assert.equal(old.value.data.records['2026-09-07'].hours, 10);
  assert.ok(await b.evaluate(() => JSON.parse(localStorage.getItem('jiaban.recovery.v1')).length > 0));
  await b.screenshot({ path: path.resolve(__dirname, '../test-results/sync-connected-mobile.png'), fullPage: true });
});

test('日期卡片草稿暂停云端应用，直接保存的独立加班可双向同步', async t => {
  const [a, b] = await devices(t);
  await change(a, '2026-09-07', 10, '旧备注'); const code = await create(a); await join(b, code);
  await b.locator('nav [data-view="cal"]').click(); await b.locator('#calMonth').fill('2026-09');
  await b.locator('[data-ds="2026-09-07"]').click();
  await b.locator('#dHours').fill('7.5'); await b.locator('#dOT').fill('3');
  await change(a, '2026-09-08', 9); await run(a); await run(b);
  assert.match(await b.locator('#syncStatus').textContent(), /请先保存填写内容/);
  assert.equal((await data(b)).records['2026-09-08'], undefined, '草稿期间不刷新本机数据或表单');
  assert.equal(await b.locator('#dHours').inputValue(), '7.5');
  assert.equal(await b.locator('#dOT').inputValue(), '3');
  await b.locator('#btnDaySave').click(); await run(b); await run(a);
  assert.deepEqual(await data(a), await data(b));
  assert.deepEqual((await data(a)).records['2026-09-07'], { type: 'work', hours: 10.5, ot: 3, otMode: 'comp', note: '旧备注' });
  assert.equal((await data(b)).records['2026-09-08'].hours, 9);
  assert.equal(await b.locator('#dHours').inputValue(), '7.5');
  assert.equal(await b.locator('#dOT').inputValue(), '3');
});

test('同一天离线并发修改需人工选择，舍弃的本机版本仍可恢复', async t => {
  const [a, b] = await devices(t);
  await change(a, '2026-09-07', 8); const code = await create(a); await join(b, code);
  await a.context().setOffline(true); await b.context().setOffline(true);
  await change(a, '2026-09-07', 10, '设备 A'); await change(b, '2026-09-07', 12, '设备 B');
  await a.context().setOffline(false); await run(a);
  await b.context().setOffline(false); await run(b);
  assert.equal(await b.locator('#syncConflicts').isVisible(), true);
  assert.equal((await data(b)).records['2026-09-07'].hours, 12);
  assert.equal((await api(code)).value.data.records['2026-09-07'].hours, 10);
  await b.screenshot({ path: path.resolve(__dirname, '../test-results/sync-conflict-mobile.png'), fullPage: true });
  await b.locator('input[name="sync-conflict-0"][value="remote"]').check();
  await b.locator('#syncResolve').click();
  await b.waitForFunction(() => document.getElementById('syncStatus').textContent.startsWith('已同步'));
  assert.equal((await data(b)).records['2026-09-07'].hours, 10);
  assert.equal(await b.evaluate(() => JSON.parse(localStorage.getItem('jiaban.recovery.v1'))[0].data.records['2026-09-07'].hours), 12);
  await b.locator('#syncAdvanced > summary').click();
  await b.locator('#syncRecovery').click();
  const downloaded = b.waitForEvent('download'); await b.locator('#syncHistoryList [data-local="0"]').click();
  assert.equal(JSON.parse(await fs.readFile(await (await downloaded).path(), 'utf8')).records['2026-09-07'].hours, 12);
});

test('连接前已有的不同本机记录也会合并；错码和断开不清空数据', async t => {
  const [a, b] = await devices(t); await change(a, '2026-09-07', 8); await change(b, '2026-09-08', 10);
  const code = await create(a);
  await b.locator('#syncJoinDetails > summary').click();
  await b.locator('#syncJoinCode').fill('jb1_' + Core.randomId()); await b.locator('#syncJoin').click();
  await b.waitForFunction(() => document.getElementById('syncStatus').textContent.includes('不存在'));
  assert.equal(Object.keys((await data(b)).records).length, 1);
  await join(b, code); await run(a); assert.deepEqual(await data(a), await data(b));
  await b.locator('#backupSettings > summary').click();
  await b.locator('#btnClear').click(); assert.equal(Object.keys((await data(b)).records).length, 2, '连接时不能误清空所有设备');
  await b.locator('#syncAdvanced > summary').click();
  b.once('dialog', d => d.accept()); await b.locator('#syncDisconnect').click();
  assert.equal(Object.keys((await data(b)).records).length, 2); assert.equal((await api(code)).status, 200);
});

test('服务端拒绝旧版本覆盖、非法请求及越权读取', async () => {
  const code = 'jb1_' + Core.randomId(); const initial = Core.empty();
  initial.records['2026-09-07'] = work(8);
  assert.equal((await api(code, 'POST', { data: initial })).status, 201);
  const one = structuredClone(initial), two = structuredClone(initial); one.records['2026-09-07'] = work(10); two.records['2026-09-07'] = work(12);
  const results = await Promise.all([api(code, 'PUT', { revision: 1, data: one }), api(code, 'PUT', { revision: 1, data: two })]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  assert.equal((await api(code)).value.revision, 2);
  assert.equal((await api('wrong')).status, 401);
  assert.equal((await api('jb1_' + Core.randomId())).status, 404);
  const bad = structuredClone(initial); bad.records['2026-09-07'].hours = -1;
  assert.equal((await api(code, 'PUT', { revision: 2, data: bad })).status, 400);
  const cross = await fetch(base + '/api/sync', { headers: { Origin: 'https://untrusted.invalid', Authorization: 'Bearer ' + code } });
  assert.equal(cross.status, 403);
  assert.equal((await fetch(base + '/_worker.js')).status, 404);
});

test('云端保留最近 30 个历史版本', async () => {
  const code = 'jb1_' + Core.randomId(), initial = Core.empty();
  await api(code, 'POST', { data: initial });
  for (let revision = 1; revision <= 33; revision++) { initial.settings.comp0 = revision; assert.equal((await api(code, 'PUT', { revision, data: initial })).status, 200); }
  const history = (await api(code, 'GET', undefined, '/history')).value.versions;
  assert.equal(history.length, 30); assert.equal(history[0].revision, 33); assert.equal(history.at(-1).revision, 4);
});

test('上传过程中继续录入不会丢失新修改', async t => {
  const [a] = await devices(t, 1); const code = await create(a);
  await change(a, '2026-09-07', 10);
  let entered, release;
  const ready = new Promise(resolve => entered = resolve), gate = new Promise(resolve => release = resolve);
  await a.route('**/api/sync', async route => { if (route.request().method() === 'PUT') { entered(); await gate; } await route.continue(); });
  const sync = run(a); await ready;
  await change(a, '2026-09-08', 12); release(); await sync; await a.unroute('**/api/sync'); await run(a);
  assert.equal((await data(a)).records['2026-09-08'].hours, 12);
  assert.equal((await api(code)).value.data.records['2026-09-08'].hours, 12);
});

test('上传期间同日连续修改，刷新后保留后续录入并接收远端其他日期的新增和修改', async t => {
  const [a] = await devices(t, 1);
  await change(a, '2026-09-07', 8); await change(a, '2026-09-09', 8);
  const code = await create(a), remote = (await api(code)).value;
  remote.data.records['2026-09-08'] = work(12, '另一设备新增');
  remote.data.records['2026-09-09'] = work(11, '另一设备修改');
  assert.equal((await api(code, 'PUT', { revision: remote.revision, data: remote.data })).status, 200);
  await change(a, '2026-09-07', 10, '第一次保存');
  let entered, release;
  const ready = new Promise(resolve => entered = resolve), gate = new Promise(resolve => release = resolve);
  await a.route('**/api/sync', async route => { if (route.request().method() === 'PUT') { entered(); await gate; } await route.continue(); });
  const syncing = run(a); await ready;
  await change(a, '2026-09-07', 11, '上传中继续保存'); release(); await syncing;
  await a.unroute('**/api/sync');
  assert.equal((await data(a)).records['2026-09-08'], undefined, '远端内容还没有应用到本机');
  assert.equal((await data(a)).records['2026-09-07'].hours, 11);
  await a.reload();
  await a.waitForFunction(() => document.getElementById('syncStatus').textContent.startsWith('已同步'));
  const final = await data(a);
  assert.equal(final.records['2026-09-07'].hours, 11);
  assert.equal(final.records['2026-09-07'].note, '上传中继续保存');
  assert.equal(final.records['2026-09-08'].hours, 12);
  assert.equal(final.records['2026-09-09'].hours, 11);
  assert.deepEqual((await api(code)).value.data, final);
  assert.equal(await a.locator('#syncConflictRows .conflict-item').count(), 0, '不把本设备较早上传的版本误报为冲突');
});

test('上传期间同日修改之后另一设备也修改同日，仍要求确认真实冲突', async t => {
  const [a] = await devices(t, 1); await change(a, '2026-09-07', 8); const code = await create(a);
  await change(a, '2026-09-07', 10, '已发出的版本');
  let entered, release;
  const ready = new Promise(resolve => entered = resolve), gate = new Promise(resolve => release = resolve);
  await a.route('**/api/sync', async route => { if (route.request().method() === 'PUT') { entered(); await gate; } await route.continue(); });
  const syncing = run(a); await ready;
  await change(a, '2026-09-07', 11, '此设备继续保存'); release(); await syncing;
  await a.unroute('**/api/sync');
  const remote = (await api(code)).value;
  remote.data.records['2026-09-07'] = work(12, '另一设备的新修改');
  assert.equal((await api(code, 'PUT', { revision: remote.revision, data: remote.data })).status, 200);
  await run(a);
  assert.match(await a.locator('#syncStatus').textContent(), /^有 1 项修改冲突/);
  assert.equal((await data(a)).records['2026-09-07'].hours, 11);
  assert.equal((await api(code)).value.data.records['2026-09-07'].hours, 12);
  assert.match(await a.locator('#syncConflictRows').innerText(), /此设备继续保存/);
  assert.match(await a.locator('#syncConflictRows').innerText(), /另一设备的新修改/);
});

test('精简月报只列记录、直接编辑及完整 CSV 导出', async t => {
  const [a] = await devices(t, 1);
  await change(a, '2026-09-07', 10, '=1+1');
  await a.locator('nav [data-view="cal"]').click(); await a.locator('#calMonth').fill('2026-09'); await a.locator('nav [data-view="rep"]').click();
  assert.equal(await a.locator('#rRows tr').count(), 1);
  assert.equal(await a.locator('.daily-table thead th').count(), 9);
  assert.deepEqual(await a.locator('#rRows tr td').allTextContents(), ['2026-09-07', '周一', '上班', '8', '2', '10', '2', '—', '=1+1']);
  await a.locator('#rRows [data-edit="2026-09-07"]').click(); await a.locator('#fHours').fill('12'); await a.locator('#btnSave').click();
  assert.match(await a.locator('#rRows tr').textContent(), /12/);
  const downloaded = a.waitForEvent('download'); await a.locator('#rExport').click();
  const file = await downloaded; const csv = await fs.readFile(await file.path(), 'utf8');
  assert.ok(csv.includes("'=1+1")); assert.ok(csv.includes('2026-09-30')); assert.ok(csv.includes('合计'));
  assert.ok(csv.includes('"2026-09-07","周一","上班","12","2","14","2",""'), 'CSV 分别导出上班、加班、合计和调休');
  await a.screenshot({ path: path.resolve(__dirname, '../test-results/monthly-table-desktop.png'), fullPage: true });
  await a.setViewportSize({ width: 390, height: 844 });
  assert.equal(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await a.locator('.full-report').evaluate(el => { el.scrollLeft = el.scrollWidth; });
  assert.equal(await a.locator('#rRows .report-note').evaluate(el => { const box = el.getBoundingClientRect(), parent = el.closest('.full-report').getBoundingClientRect(); return box.right <= parent.right + 1 && box.left >= parent.left; }), true, '手机可在表格内滑到完整备注');
  assert.equal(await a.locator('#rRows .report-date').evaluate(el => Math.abs(el.getBoundingClientRect().left - el.closest('.full-report').getBoundingClientRect().left) < 2), true, '滑动时仍能对照日期');
  await a.locator('.full-report').evaluate(el => { el.scrollLeft = 0; });
  await a.screenshot({ path: path.resolve(__dirname, '../test-results/monthly-table-mobile.png'), fullPage: true });
});


test('云端历史与本机副本可以折叠，收起后的迟到请求不会展开列表', async t => {
  const [a] = await devices(t, 1);
  await a.setViewportSize({ width: 390, height: 844 });
  await create(a);
  await a.locator('#syncAdvanced > summary').click();
  const codeBefore = await a.evaluate(() => localStorage.getItem('jiaban.sync.v1'));
  const before = await data(a);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  let requests = 0;
  await a.route('**/api/sync/history', async route => {
    requests++;
    if (requests === 1) await gate;
    await route.fulfill({ json: { versions: Array.from({ length: 30 }, (_, i) => ({ revision: 30 - i, updatedAt: '2026-09-09T01:00:00Z' })) } });
  });
  await a.locator('#syncHistory').click();
  await a.waitForFunction(() => document.getElementById('syncHistoryList').getAttribute('aria-busy') === 'true');
  await a.locator('#syncHistory').click();
  assert.equal(await a.locator('#syncHistoryList').isVisible(), false);
  assert.equal(await a.locator('#syncHistory').getAttribute('aria-expanded'), 'false');
  const response = a.waitForResponse(r => r.url().endsWith('/api/sync/history'));
  release(); await response;
  await a.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await a.locator('#syncHistoryList').isVisible(), false, '迟到响应不重新打开列表');
  await a.locator('#syncHistory').click();
  await a.locator('#syncHistoryList [data-version]').first().waitFor();
  assert.equal(await a.locator('#syncHistoryList [data-version]').count(), 30);
  assert.equal(await a.locator('#syncHistory').getAttribute('aria-expanded'), 'true');
  assert.ok(await a.locator('#syncHistoryList').evaluate(el => el.clientHeight <= 320 && el.scrollHeight > el.clientHeight));
  await a.screenshot({ path: path.resolve(__dirname, '../test-results/collapsible-cloud-history.png'), fullPage: false });
  await a.locator('#syncRecovery').click();
  assert.equal(await a.locator('#syncHistory').getAttribute('aria-expanded'), 'false');
  assert.equal(await a.locator('#syncRecovery').getAttribute('aria-expanded'), 'true');
  assert.match(await a.locator('#syncHistoryList').textContent(), /尚无恢复副本/);
  await a.locator('#syncRecovery').click();
  assert.equal(await a.locator('#syncHistoryList').isVisible(), false);
  await a.unroute('**/api/sync/history');
  // 再验证云端请求未完成时切到本机副本，不会把本机列表替换掉。
  let finish;
  const delayed = new Promise(resolve => { finish = resolve; });
  t.after(() => finish());
  await a.route('**/api/sync/history', async route => { await delayed; await route.fulfill({ json: { versions: [{ revision: 99, updatedAt: '2026-09-09T01:00:00Z' }] } }); });
  await a.locator('#syncHistory').click(); await a.locator('#syncRecovery').click();
  const late = a.waitForResponse(r => r.url().endsWith('/api/sync/history'));
  finish(); await late;
  await a.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.match(await a.locator('#syncHistoryList').textContent(), /尚无恢复副本/);
  assert.equal(await a.locator('#syncHistoryList [data-version]').count(), 0);
  assert.deepEqual(await data(a), before);
  assert.equal(await a.evaluate(() => localStorage.getItem('jiaban.sync.v1')), codeBefore);
});

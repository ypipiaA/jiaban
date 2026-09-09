const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
let server, browser, base;
const fixture = {
  settings: { daily: 8, comp0: 4 },
  records: {
    '2026-09-07': { type: 'work', hours: 10, ot: 2, otMode: 'comp', note: '项目上线' },
    '2026-09-08': { type: 'comp', compHours: 4, note: '下午调休' },
    '2026-09-12': { type: 'work', hours: 8, ot: 8, otMode: 'pay', note: '' },
    '2026-08-31': { type: 'work', hours: 9, ot: 1, otMode: 'comp', note: '' }
  },
  adjust: [{ id: 1750000000000, d: '2026-09-01', h: 3, note: '余额补记' }]
};
before(async () => {
  server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const name = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1));
      const file = path.resolve(ROOT, 'public', name);
      if (!file.startsWith(path.join(ROOT, 'public') + path.sep)) { res.writeHead(403).end(); return; }
      const body = await fs.readFile(file);
      const type = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' }[path.extname(file)];
      res.writeHead(200, { 'Content-Type': type || 'application/octet-stream' }).end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  await fs.mkdir(path.join(ROOT, 'test-results'), { recursive: true });
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); });

async function session(t, { data, width = 390, height = 844, serviceWorkers = 'block' } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, serviceWorkers, reducedMotion: 'reduce' });
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  t.after(() => assert.deepEqual(errors, [], '没有未捕获的页面异常'));
  await page.goto(base);
  if (data !== undefined) {
    await page.evaluate(raw => localStorage.setItem('jiaban.v1', raw), typeof data === 'string' ? data : JSON.stringify(data));
    await page.reload();
  }
  return { page, context };
}
async function selectDate(page, date) {
  await page.locator('#calMonth').fill(date.slice(0, 7));
  await page.locator(`[data-ds="${date}"]`).click();
}
const readData = page => page.evaluate(() => JSON.parse(localStorage.getItem('jiaban.v1')));
const text = (page, id) => page.locator(`#${id}`).textContent();

test('源页面与发布页面完全一致', async () => {
  assert.deepEqual(await fs.readFile(path.join(ROOT, '加班记录.html')), await fs.readFile(path.join(ROOT, 'public/index.html')));
  assert.ok(!(await fs.readFile(path.join(ROOT, 'public/index.html'), 'utf8')).includes('id="installLink"'));
});

test('手机空状态、键盘可达性及窄屏无横向溢出', async t => {
  const { page } = await session(t);
  assert.equal(await page.evaluate(() => localStorage.getItem('jiaban.v1')), null, '启动不自动覆盖数据');
  await page.screenshot({ path: path.join(ROOT, 'test-results/mobile-empty.png'), fullPage: true });
  for (const width of [320, 390, 720, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    for (const view of ['cal', 'rep', 'set']) {
      await page.locator(`nav [data-view="${view}"]`).click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}px ${view} 无横向溢出`);
    }
  }
  await page.setViewportSize({ width: 320, height: 640 });
  await page.locator('nav [data-view="cal"]').click();
  await page.locator('[data-action="edit"]').click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, '320px 编辑面板无横向溢出');
  assert.equal(await page.locator('#main').evaluate(el => el.inert), true);
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.locator('#btnSave').evaluate(el => el === document.activeElement), true, '焦点循环留在面板内');
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('#btnClose').evaluate(el => el === document.activeElement), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#sheet').getAttribute('aria-hidden'), 'true');
});

async function applyNativeInsets(page, { top = 0, right = 0, bottom = 0, left = 0 }) {
  await page.evaluate(insets => {
    for (const [side, value] of Object.entries(insets)) document.documentElement.style.setProperty(`--safe-area-inset-${side}`, `${value}px`);
  }, { top, right, bottom, left });
}

test('安卓系统边距动态生效，标题、导航和弹窗避开系统栏且不重复留白', async t => {
  const { page } = await session(t, { data: fixture, width: 393, height: 873 });
  await selectDate(page, '2026-09-07');
  const baseTitle = await page.locator('h1').boundingBox();
  await applyNativeInsets(page, { top: 36, bottom: 24 });
  const title = await page.locator('h1').boundingBox();
  assert.equal(title.y - baseTitle.y, 36, '顶部跟随原生边距增加，不依赖 WebView env');
  for (const view of ['cal', 'rep', 'set']) {
    await page.locator(`nav [data-view="${view}"]`).click();
    await page.evaluate(() => scrollTo(0, 0));
    assert.ok((await page.locator('h1').boundingBox()).y >= 48);
    const nav = await page.locator(`nav [data-view="${view}"]`).boundingBox();
    assert.ok(nav.y + nav.height <= 873 - 24, '导航按钮不进入手势区域');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  await page.locator('nav [data-view="cal"]').click();
  await page.screenshot({ path: path.join(ROOT, 'test-results/native-safe-area-mobile.png'), fullPage: false });
  await page.locator('[data-action="edit"]').click();
  const sheet = await page.locator('#sheet').boundingBox();
  assert.ok(sheet.y >= 48, '编辑面板避开顶部状态栏');
  const save = await page.locator('#btnSave').boundingBox();
  assert.ok(save.y + save.height <= 849, '保存按钮避开底部系统栏');
  await page.screenshot({ path: path.join(ROOT, 'test-results/native-safe-area-editor.png'), fullPage: false });
  await page.keyboard.press('Escape');
  await page.evaluate(() => scrollTo(0, 200));
  assert.deepEqual(await page.evaluate(() => {
    const s = getComputedStyle(document.body, '::before');
    return [s.position, s.height, s.backgroundColor, s.pointerEvents];
  }), ['fixed', '36px', 'rgb(245, 246, 248)', 'none'], '滚动时系统栏保留纯色背景');
  await applyNativeInsets(page, {});
  await page.evaluate(() => scrollTo(0, 0));
  assert.equal((await page.locator('h1').boundingBox()).y, baseTitle.y, '已由旧系统处理的零边距不再加空白');
});

test('带系统栏的常用手机首屏完整展示保存按钮，保留日历触控大小', async t => {
  const { page } = await session(t, { width: 393, height: 873 });
  await selectDate(page, '2026-09-07');
  await applyNativeInsets(page, { top: 36, bottom: 24 });
  await page.evaluate(() => scrollTo(0, 0));
  const save = await page.locator('#btnDaySave').boundingBox();
  const nav = await page.locator('nav').boundingBox();
  assert.ok(save.y + save.height + 8 <= nav.y, '保存按钮完整位于底部导航上方');
  assert.ok((await page.locator('.day.sel').boundingBox()).height >= 44);
  assert.ok(save.height >= 44);
  await page.screenshot({ path: path.join(ROOT, 'test-results/native-safe-area-empty.png') });
});

test('横屏刘海、小屏和软键盘下弹窗可滚动保存，月报仅表格内部横向滚动', async t => {
  const { page } = await session(t, { data: fixture });
  for (const screen of [
    { width: 873, height: 393, top: 0, right: 12, bottom: 24, left: 36, name: 'landscape' },
    { width: 320, height: 640, top: 28, right: 0, bottom: 24, left: 0, name: 'small' },
    { width: 393, height: 380, top: 36, right: 0, bottom: 0, left: 0, name: 'keyboard' }
  ]) {
    await page.setViewportSize({ width: screen.width, height: screen.height });
    await applyNativeInsets(page, screen);
    await page.locator('nav [data-view="cal"]').click();
    await page.evaluate(() => scrollTo(0, 0));
    const title = await page.locator('h1').boundingBox();
    assert.ok(title.x >= screen.left + 14 && title.y >= screen.top + 12);
    await selectDate(page, '2026-09-07');
    await page.locator('[data-action="edit"]').click();
    const sheet = await page.locator('#sheet').boundingBox();
    assert.ok(sheet.y >= screen.top + 11, screen.name + ' 弹窗不进入状态栏');
    assert.ok(sheet.x >= screen.left && sheet.x + sheet.width <= screen.width - screen.right);
    await page.locator('#fHours').fill('8'); await page.locator('#fOT').fill('2');
    await page.locator('#btnSave').scrollIntoViewIfNeeded();
    const save = await page.locator('#btnSave').boundingBox();
    assert.ok(save.y >= screen.top && save.y + save.height <= screen.height - screen.bottom, screen.name + ' 保存按钮能滚入可用区域');
    await page.screenshot({ path: path.join(ROOT, `test-results/native-safe-area-${screen.name}.png`), fullPage: false });
    await page.locator('#btnSave').click();
    assert.equal((await readData(page)).records['2026-09-07'].hours, 10);
    assert.equal((await readData(page)).records['2026-09-07'].ot, 2);
    await page.locator('nav [data-view="rep"]').click();
    assert.equal(await page.locator('.daily-table thead th').count(), 9);
    await page.locator('.full-report').evaluate(el => { el.scrollLeft = el.scrollWidth; });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    if (screen.width < 760) assert.ok(await page.locator('.full-report').evaluate(el => el.scrollLeft > 0));
  }
});

test('月份切换同步所选日期，二月和月报保持一致', async t => {
  const { page } = await session(t);
  await selectDate(page, '2026-01-31');
  await page.locator('#calNext').click();
  assert.equal(await page.locator('.day.sel').getAttribute('data-ds'), '2026-02-28');
  assert.match(await text(page, 'dayCard'), /2月28日/);
  await page.locator('nav [data-view="rep"]').click();
  assert.equal(await text(page, 'rTitle'), '2026年2月');
  await page.locator('nav [data-view="cal"]').click();
  await selectDate(page, '2028-02-29');
  assert.equal(await page.locator('.day[data-ds]').count(), 29);
  await page.locator('#calToday').click();
  assert.equal(await page.locator('.day.sel').getAttribute('data-ds'), await page.evaluate(() => today()));
});

test('直接记录、独立加班校验、换调休及刷新持久化', async t => {
  const { page } = await session(t);
  await selectDate(page, '2026-09-07');
  await page.locator('#btnDaySave').click();
  assert.equal((await readData(page)).records['2026-09-07'].hours, 8);
  await page.locator('[data-action="edit"]').click();
  await page.locator('#fHours').fill('-1');
  await page.locator('#btnSave').click();
  assert.equal(await page.locator('#formError').isVisible(), true);
  assert.equal((await readData(page)).records['2026-09-07'].hours, 8);
  await page.locator('#hourPresets [data-hours="10"]').click();
  assert.equal(await page.locator('#fOT').inputValue(), '0');
  await page.locator('#fMore > summary').click();
  await page.locator('#fOT').fill('15');
  await page.locator('#btnSave').click();
  assert.match(await text(page, 'formError'), /合计不能超过 24/);
  await page.locator('#fHours').fill('8');
  await page.locator('#fOT').fill('2');
  await page.locator('#fComp').click();
  await page.locator('#fNote').fill('项目上线');
  await page.screenshot({ path: path.join(ROOT, 'test-results/mobile-edit.png'), fullPage: true });
  await page.locator('#btnSave').click();
  assert.equal(await text(page, 'mComp'), '2');
  await page.reload();
  assert.deepEqual((await readData(page)).records['2026-09-07'], { type: 'work', hours: 10, ot: 2, otMode: 'comp', note: '项目上线' });
  await selectDate(page, '2026-09-12');
  await page.locator('#btnDaySave').click();
  assert.equal((await readData(page)).records['2026-09-12'].ot, 0, '周末也不自动产生加班');
});

test('日期卡片拆开旧记录并保留备注余额，支持独立加班和总时数上限', async t => {
  const { page } = await session(t, { data: fixture });
  await selectDate(page, '2026-09-07');
  assert.equal(await page.locator('#dHours').inputValue(), '8');
  assert.equal(await page.locator('#dOT').inputValue(), '2');
  const original = await readData(page), balance = await text(page, 'mComp');
  await page.locator('#btnDaySave').click();
  assert.deepEqual((await readData(page)).records, original.records, '直接保存旧记录不改变记录时数与备注');
  assert.equal(await text(page, 'mComp'), balance);
  await page.locator('#dHours').fill('9');
  assert.equal(await page.locator('#dOT').inputValue(), '2');
  await page.locator('#btnDaySave').click();
  assert.deepEqual((await readData(page)).records['2026-09-07'], { ...fixture.records['2026-09-07'], hours: 11 });
  await page.locator('#dHours').fill('23');
  await page.locator('#btnDaySave').click();
  assert.match(await text(page, 'dayError'), /合计不能超过 24/);
  assert.equal((await readData(page)).records['2026-09-07'].hours, 11);
  await page.locator('#dHours').fill('0');
  await page.locator('#btnDaySave').click();
  assert.deepEqual((await readData(page)).records['2026-09-07'], { ...fixture.records['2026-09-07'], hours: 2 });
  assert.equal(await text(page, 'mComp'), balance);
  await page.reload(); await selectDate(page, '2026-09-07');
  assert.equal(await page.locator('#dHours').inputValue(), '0');
  assert.equal(await page.locator('#dOT').inputValue(), '2');
});

test('直接输入未保存时，切换日期月份和页面可取消，切回窗口保留草稿', async t => {
  const { page } = await session(t, { data: fixture });
  await selectDate(page, '2026-09-07'); await page.locator('#dHours').fill('6.5'); await page.locator('#dOT').fill('1.5');
  let prompts = 0;
  page.on('dialog', async d => { prompts++; await d.dismiss(); });
  await page.locator('[data-ds="2026-09-08"]').click();
  await page.locator('#calMonth').fill('2026-10');
  await page.locator('nav [data-view="rep"]').click();
  assert.equal(prompts, 3);
  assert.equal(await page.locator('#calMonth').inputValue(), '2026-09');
  assert.equal(await page.locator('.day.sel').getAttribute('data-ds'), '2026-09-07');
  assert.equal(await page.locator('#v-cal').isVisible(), true);
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  assert.equal(await page.locator('#dHours').inputValue(), '6.5');
  await page.locator('[data-action="edit"]').click();
  assert.equal(await page.locator('#fHours').inputValue(), '6.5');
  assert.equal(await page.locator('#fOT').inputValue(), '1.5');
  await page.locator('#btnSave').click();
  assert.deepEqual((await readData(page)).records['2026-09-07'], { ...fixture.records['2026-09-07'], hours: 8, ot: 1.5 });
  await page.locator('nav [data-view="rep"]').click();
  assert.equal(prompts, 3, '保存后可正常切换');
});

test('统计卡片统一底色，页面限制缩放且保留普通滚动和输入', async t => {
  const { page } = await session(t);
  assert.deepEqual(await page.locator('.sum .metric').evaluateAll(nodes => nodes.map(el => getComputedStyle(el).backgroundColor)), Array(3).fill('rgb(255, 255, 255)'));
  assert.match(await page.locator('meta[name="viewport"]').getAttribute('content'), /maximum-scale=1, user-scalable=no/);
  const prevented = await page.evaluate(() => {
    const events = [new WheelEvent('wheel', { ctrlKey: true, cancelable: true }), new WheelEvent('wheel', { cancelable: true }), new KeyboardEvent('keydown', { key: '+', ctrlKey: true, cancelable: true }), new KeyboardEvent('keydown', { key: '-', metaKey: true, cancelable: true }), new KeyboardEvent('keydown', { key: '8', cancelable: true }), new Event('gesturestart', { cancelable: true })];
    return events.map(e => { document.dispatchEvent(e); return e.defaultPrevented; });
  });
  assert.deepEqual(prevented, [true, false, true, true, false, true]);
});

test('滚动不误改数字，直接录入清楚显示待保存状态', async t => {
  const { page } = await session(t, { data: fixture, width: 1280 });
  await selectDate(page, '2026-09-07');
  assert.equal(await page.locator('#dayCard .tag').textContent(), '已保存');
  await page.locator('#dHours').click();
  await page.mouse.wheel(0, 100);
  assert.equal(await page.locator('#dHours').inputValue(), '8');
  await page.locator('#dHours').fill('7.5');
  assert.equal(await page.locator('#dayCard .tag').textContent(), '待保存');
  assert.equal(await page.locator('#btnDaySave').textContent(), '保存修改');
  await page.locator('nav [data-view="cal"]').click();
  assert.equal(await page.locator('#dHours').inputValue(), '7.5', '点击当前导航保留输入');
  await page.locator('#btnDaySave').click();
  assert.equal(await page.locator('#dayCard .tag').textContent(), '已保存');
  await page.locator('[data-action="edit"]').click();
  await page.locator('#fOT').click(); await page.mouse.wheel(0, -100);
  assert.equal(await page.locator('#fOT').inputValue(), '2');
  await page.locator('#btnClose').click();
  await page.locator('nav [data-view="set"]').click(); await page.locator('#rulesSettings > summary').click();
  await page.locator('#sDaily').click(); await page.mouse.wheel(0, 100);
  assert.equal(await page.locator('#sDaily').inputValue(), '8');
});

test('工时设置草稿在切页及其他窗口保存时受保护，保存后可正常离开', async t => {
  const { page, context } = await session(t, { data: fixture });
  await page.locator('nav [data-view="set"]').click(); await page.locator('#rulesSettings > summary').click();
  await page.locator('#sDaily').fill('7.5'); await page.locator('#sComp0').fill('6');
  assert.equal(await text(page, 'rulesLabel'), '待保存');
  page.once('dialog', d => d.dismiss());
  await page.locator('nav [data-view="cal"]').click();
  assert.equal(await page.locator('#v-set').isVisible(), true);
  await page.locator('nav [data-view="set"]').click();
  assert.equal(await page.locator('#sDaily').inputValue(), '7.5');
  const other = await context.newPage(); await other.goto(base);
  await selectDate(other, '2026-09-09'); await other.locator('#btnDaySave').click();
  await page.waitForFunction(() => document.getElementById('toast').textContent.includes('其他页面的数据已变化'));
  assert.equal(await page.locator('#sDaily').inputValue(), '7.5');
  assert.equal(await page.locator('#sComp0').inputValue(), '6');
  assert.equal(await page.evaluate(() => { const e = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(e); return e.defaultPrevented; }), true);
  await page.locator('#btnSaveSet').click();
  assert.match(await text(page, 'toast'), /其他页面变化/);
  page.once('dialog', d => d.accept()); await page.reload();
  await page.locator('nav [data-view="set"]').click(); await page.locator('#rulesSettings > summary').click();
  await page.locator('#sDaily').fill('7.5'); await page.locator('#btnSaveSet').click();
  await page.locator('nav [data-view="cal"]').click();
  assert.equal((await readData(page)).settings.daily, 7.5);
  assert.equal((await readData(page)).records['2026-09-09'].hours, 8);
});

test('旧版零小时调休保留记录，但不计入调休天数', async t => {
  const data = structuredClone(fixture);
  data.records['2026-09-09'] = { type: 'comp', compHours: 0, note: '旧记录' };
  const { page } = await session(t, { data });
  await selectDate(page, '2026-09-07'); await page.locator('nav [data-view="rep"]').click();
  assert.equal(await text(page, 'rCompDays'), '1 天 · 4 小时');
  assert.deepEqual((await readData(page)).records['2026-09-09'], data.records['2026-09-09']);
});

test('长备注完整显示，月报翻页回到表格顶部且月份切换回到日期列', async t => {
  const data = structuredClone(fixture);
  for (let day = 10; day <= 20; day++) data.records[`2026-09-${day}`] = { type: 'work', hours: 8, ot: 0, otMode: 'pay', note: ('完整备注\n').repeat(15) };
  const { page } = await session(t, { data });
  await selectDate(page, '2026-09-07'); await page.locator('nav [data-view="rep"]').click();
  const table = page.locator('.full-report');
  await table.evaluate(el => { el.scrollTop = el.scrollHeight; el.scrollLeft = el.scrollWidth; });
  assert.ok(await table.evaluate(el => el.scrollTop > 0));
  assert.equal(await page.locator('#rRows .report-note').first().textContent(), ('完整备注\n').repeat(15));
  await page.locator('#rPageNext').click();
  assert.equal(await table.evaluate(el => el.scrollTop), 0);
  assert.ok(await table.evaluate(el => el.scrollLeft > 0), '翻页保留正在看的栏目');
  await page.locator('#rPrev').click();
  assert.equal(await table.evaluate(el => el.scrollLeft), 0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});

test('取消保护、半天调休与删除记录', async t => {
  const { page } = await session(t, { data: fixture });
  await selectDate(page, '2026-09-09');
  await page.locator('[data-action="edit"]').click();
  await page.locator('#fMore > summary').click();
  await page.locator('#fNote').fill('未保存的内容');
  page.once('dialog', d => d.dismiss());
  await page.locator('#btnCancel').click();
  assert.equal(await page.locator('#sheet').getAttribute('aria-hidden'), 'false');
  await page.locator('#fType [data-v="comp"]').click();
  await page.locator('#compPresets [data-hours="4"]').click();
  await page.locator('#btnSave').click();
  assert.equal(await text(page, 'mComp'), '2');
  await page.locator('[data-action="edit"]').click();
  page.once('dialog', d => d.accept());
  await page.locator('#btnDel').click();
  assert.equal((await readData(page)).records['2026-09-09'], undefined);
  assert.equal(await text(page, 'mComp'), '6');
});

test('月报统计、完整调休流水和桌面布局', async t => {
  const data = structuredClone(fixture);
  for (let i = 0; i < 15; i++) data.adjust.push({ id: i + 1, d: '2026-08-01', h: 1, note: '历史余额调整' });
  const { page } = await session(t, { data, width: 1280, height: 1000 });
  await selectDate(page, '2026-09-07');
  assert.equal(await text(page, 'mHours'), '18');
  assert.equal(await text(page, 'mOT'), '10');
  assert.equal(await text(page, 'mComp'), '21');
  await page.screenshot({ path: path.join(ROOT, 'test-results/desktop-calendar.png'), fullPage: true });
  await page.locator('nav [data-view="rep"]').click();
  assert.equal(await text(page, 'rDays'), '2 天');
  assert.equal(await text(page, 'rAvg'), '9 小时');
  assert.equal(await text(page, 'rCompDays'), '1 天 · 4 小时');
  assert.equal(await page.locator('#cList .it').count(), 5);
  await page.locator('#balanceDetails > summary').click();
  await page.locator('#cPageNext').click();
  assert.equal(await page.locator('#cList .it').count(), 5);
  assert.equal(await text(page, 'cPageLabel'), '2 / 4');
  await page.locator('#balanceDetails > summary').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(ROOT, 'test-results/mobile-report.png'), fullPage: true });
});

test('满月记录保持一屏、分页完整且整月合计不随翻页改变', async t => {
  const data = { settings: { daily: 8, comp0: 0 }, records: {}, adjust: [] };
  for (let day = 1; day <= 31; day++) data.records[`2026-08-${String(day).padStart(2, '0')}`] = { type: 'work', hours: 10, ot: 2, otMode: 'comp', note: day === 1 ? '旧记录仍可找到' : '' };
  const { page } = await session(t, { data });
  await selectDate(page, '2026-08-31'); await page.locator('nav [data-view="rep"]').click();
  const total = await text(page, 'rTotals');
  assert.equal(await page.locator('#rRows tr').count(), 5);
  assert.equal(await text(page, 'rPageLabel'), '1 / 7');
  for (const width of [320, 390, 1280]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}px 无横向滚动`);
    assert.equal(await page.locator('.daily-table thead th').count(), 9, '完整字段');
    if (width >= 900) assert.equal(await page.locator('.daily-table').evaluate(el => el.scrollWidth <= el.parentElement.clientWidth), true, '桌面全部字段可见');
    if (width >= 390) assert.equal(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight), true, `${width}px 满月默认页面一屏放下`);
  }
  await page.screenshot({ path: path.join(ROOT, 'test-results/simple-full-month-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(ROOT, 'test-results/simple-full-month-mobile.png'), fullPage: true });
  const seen = [];
  for (let i = 0; i < 7; i++) {
    seen.push(...await page.locator('#rRows [data-edit]').evaluateAll(nodes => nodes.map(n => n.dataset.edit)));
    assert.equal(await text(page, 'rTotals'), total);
    if (i < 6) await page.locator('#rPageNext').click();
  }
  assert.equal(new Set(seen).size, 31); assert.equal(seen[0], '2026-08-31'); assert.equal(seen.at(-1), '2026-08-01');
  assert.equal(await page.locator('#rPageNext').isDisabled(), true);
  await page.locator('#rNext').click();
  assert.equal(await page.locator('#rRows [data-edit]').count(), 0);
  assert.equal(await page.locator('#rPager').isVisible(), false);
  assert.equal(await page.locator('#rRows tr').count(), 1, '空月份只有一条空状态，不生成 30 行');
  await page.locator('[data-go-record]').click();
  assert.equal(await text(page, 'calTitle'), '2026年9月');
});

test('上班与加班独立显示，修改上班不改变加班，备注保留', async t => {
  const { page } = await session(t);
  await selectDate(page, '2026-09-07'); await page.locator('[data-action="edit"]').click();
  assert.equal(await page.locator('#fMore').evaluate(el => el.open), false);
  assert.equal(await page.locator('#compSwitchRow').isVisible(), false);
  assert.equal(await page.locator('#sheet input').evaluateAll(nodes => nodes.filter(n => n.checkVisibility()).length), 2);
  assert.equal(await page.locator('#sheet').evaluate(el => el.scrollHeight <= el.clientHeight), true);
  await page.screenshot({ path: path.join(ROOT, 'test-results/simple-editor-mobile.png'), fullPage: true });
  await page.locator('#hourPresets [data-hours="10"]').click();
  assert.equal(await page.locator('#fOT').inputValue(), '0');
  await page.locator('#fOT').fill('2');
  assert.equal(await page.locator('#compSwitchRow').isVisible(), true);
  assert.match(await text(page, 'workTotal'), /合计 12 小时/);
  await page.locator('#hourPresets [data-hours="8"]').click();
  assert.equal(await page.locator('#fOT').inputValue(), '2');
  await page.locator('#fMore > summary').click(); await page.locator('#fOT').fill('0'); await page.locator('#fNote').fill('调班，不计加班');
  await page.locator('#btnSave').click(); await page.locator('[data-action="edit"]').click();
  assert.equal(await page.locator('#fMore').evaluate(el => el.open), true);
  assert.equal(await page.locator('#fOT').inputValue(), '0'); assert.equal(await page.locator('#fNote').inputValue(), '调班，不计加班');
  await page.locator('#fMore > summary').click(); await page.locator('#btnSave').click();
  assert.equal((await readData(page)).records['2026-09-07'].ot, 0);
  assert.equal((await readData(page)).records['2026-09-07'].note, '调班，不计加班');
  await page.locator('nav [data-view="set"]').click();
  assert.equal(await page.locator('#rulesSettings').evaluate(el => el.open), false);
  assert.equal(await page.locator('#backupSettings').evaluate(el => el.open), false);
  await page.screenshot({ path: path.join(ROOT, 'test-results/simple-settings-mobile.png'), fullPage: true });
});

test('损坏的本机数据保持原样并阻止覆盖', async t => {
  const raw = '{损坏的备份';
  const { page } = await session(t, { data: raw });
  assert.equal(await page.locator('#dataWarning').isVisible(), true);
  await page.locator('#btnDaySave').click();
  assert.equal(await page.evaluate(() => localStorage.getItem('jiaban.v1')), raw);
  const downloadEvent = page.waitForEvent('download');
  await page.locator('#btnRawExport').click();
  const download = await downloadEvent;
  assert.equal(await fs.readFile(await download.path(), 'utf8'), raw);
});

test('存储空间异常时保留旧数据和未保存面板', async t => {
  const { page } = await session(t, { data: fixture });
  await selectDate(page, '2026-09-07');
  await page.locator('[data-action="edit"]').click();
  await page.locator('#fHours').fill('12');
  await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException('Full', 'QuotaExceededError'); }; });
  await page.locator('#btnSave').click();
  assert.equal((await readData(page)).records['2026-09-07'].hours, 10);
  assert.equal(await page.locator('#sheet').getAttribute('aria-hidden'), 'false');
  assert.match(await text(page, 'toast'), /保存失败/);
});

test('校验导入、兼容旧备份、注入文本安全及备份往返', async t => {
  const { page } = await session(t, { data: fixture });
  await page.locator('nav [data-view="set"]').click();
  await page.locator('#backupSettings > summary').click();
  const original = await readData(page);
  const upload = data => page.locator('#fileImport').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(data)) });
  for (const bad of [ { records: { '2026-02-30': { type: 'work', hours: 8 } } }, { ...fixture, settings: { daily: -8 } }, { records: { '2026-09-01': null } }, { ...fixture, adjust: {} } ]) {
    await upload(bad);
    await page.waitForFunction(() => document.getElementById('toast').textContent.startsWith('备份无效'));
    assert.deepEqual(await readData(page), original);
  }
  const legacy = { records: { '2026-09-07': { type: 'work', start: '22:00', end: '06:00', brk: 60, ot: '2', otMode: 'comp', note: '<img src=x onerror="window.injected=1">' } }, adjust: [{ id: '1);window.injected=1;//', d: '2026-09-07', h: '3', note: '<script>window.injected=1</script>' }] };
  page.once('dialog', d => d.accept());
  await upload(legacy);
  await page.waitForFunction(() => document.getElementById('toast').textContent.startsWith('导入成功'));
  const normalized = await readData(page);
  assert.equal(normalized.records['2026-09-07'].hours, 7);
  assert.equal(normalized.adjust[0].h, 3);
  await page.locator('nav [data-view="cal"]').click();
  await selectDate(page, '2026-09-07');
  assert.equal(await page.locator('#dayCard img').count(), 0);
  await page.locator('nav [data-view="rep"]').click();
  assert.equal(await page.locator('#cList script').count(), 0);
  assert.equal(await page.evaluate(() => window.injected), undefined);
  await page.locator('nav [data-view="set"]').click();
  const downloaded = page.waitForEvent('download');
  await page.locator('#btnExport').click();
  assert.deepEqual(JSON.parse(await fs.readFile(await (await downloaded).path(), 'utf8')), normalized);
});

test('设置非法工时不会覆盖已有规则', async t => {
  const { page } = await session(t, { data: fixture });
  await page.locator('nav [data-view="set"]').click();
  await page.locator('#rulesSettings > summary').click();
  await page.locator('#sDaily').fill('0');
  await page.locator('#btnSaveSet').click();
  assert.equal((await readData(page)).settings.daily, 8);
  assert.equal(await page.locator('#setError').isVisible(), true);
  await page.locator('#sDaily').fill('7.5');
  await page.locator('#btnSaveSet').click();
  assert.equal((await readData(page)).settings.daily, 7.5);
  assert.equal((await readData(page)).records['2026-09-07'].ot, 2);
  await page.screenshot({ path: path.join(ROOT, 'test-results/mobile-settings.png'), fullPage: true });
});

test('多窗口保存冲突不会悄悄覆盖', async t => {
  const { page, context } = await session(t, { data: fixture });
  await selectDate(page, '2026-09-07');
  await page.locator('[data-action="edit"]').click();
  await page.locator('#fHours').fill('12');
  const other = await context.newPage();
  await other.goto(base);
  await selectDate(other, '2026-09-09');
  await other.locator('#btnDaySave').click();
  await page.locator('#btnSave').click();
  assert.match(await text(page, 'toast'), /其他页面变化/);
  assert.equal((await readData(page)).records['2026-09-09'].hours, 8);
  assert.equal((await readData(page)).records['2026-09-07'].hours, 10);
});

test('离线启动和图标缓存，保留同源其他应用缓存', async t => {
  const { page, context } = await session(t, { serviceWorkers: 'allow' });
  await page.evaluate(async () => { await caches.open('other-app-cache'); await navigator.serviceWorker.ready; });
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await selectDate(page, '2026-09-07');
  await page.locator('#btnDaySave').click();
  await context.setOffline(true);
  await page.waitForFunction(() => document.getElementById('netStatus').textContent === '离线可用');
  await page.reload();
  assert.equal(await page.locator('#calGrid .day').count() > 0, true);
  assert.equal((await readData(page)).records['2026-09-07'].hours, 8);
  // Chromium 的离线模拟在导航后会重置 navigator.onLine，实际用离线请求验证缓存。
  assert.equal(await page.evaluate(async () => (await caches.keys()).includes('other-app-cache')), true);
  assert.equal(await page.evaluate(async () => (await fetch('icon-192.png')).headers.get('content-type')), 'image/png');
});


test('今天圆点不覆盖日期或小数工时，空备注列紧凑且保留全栏', async t => {
  const { page } = await session(t, { width: 390, height: 873 });
  await page.locator('#dHours').fill('9'); await page.locator('#dOT').fill('0.4');
  await page.locator('#btnDaySave').click();
  for (const width of [320, 390, 768]) {
    await page.setViewportSize({ width, height: 873 });
    const clear = await page.locator('.day.today').evaluate(day => {
      const r = day.getBoundingClientRect(), p = getComputedStyle(day, '::after'), b = getComputedStyle(day);
      const dot = { left: r.right - parseFloat(b.borderRightWidth) - parseFloat(p.right) - parseFloat(p.width), top: r.top + parseFloat(b.borderTopWidth) + parseFloat(p.top) };
      const number = day.querySelector('.n'), original = number.textContent;
      const clear = [original, '29'].every(value => {
        number.textContent = value;
        return ['.n', '.h'].every(selector => {
          const text = day.querySelector(selector).getBoundingClientRect();
          return dot.left + parseFloat(p.width) <= text.left || dot.left >= text.right || dot.top + parseFloat(p.height) <= text.top || dot.top >= text.bottom;
        });
      });
      number.textContent = original;
      return clear;
    });
    assert.equal(clear, true, `${width}px 圆点和文字互不重叠`);
  }
  await page.setViewportSize({ width: 390, height: 873 });
  await applyNativeInsets(page, { top: 36, bottom: 24 });
  await page.waitForFunction(() => !document.getElementById('toast').classList.contains('show'));
  await page.screenshot({ path: path.join(ROOT, 'test-results/today-dot-clear.png') });
  await page.evaluate(() => updateData(next => {
    for (let d = 1; d <= 9; d++) next.records[`2026-09-${String(d).padStart(2, '0')}`] = { type: 'work', hours: 9, ot: 0, otMode: 'pay', note: d === 1 ? '完整备注内容需要保留并换行显示' : '' };
  }));
  await selectDate(page, '2026-09-09'); await page.locator('nav [data-view="rep"]').click();
  const table = page.locator('.daily-table');
  assert.equal(await table.locator('thead th').count(), 9);
  assert.ok((await table.boundingBox()).width <= 570, '无备注时减少横向滚动距离');
  assert.ok((await page.locator('#rRows .report-note').first().boundingBox()).width <= 76, '空备注不再占据一大块区域');
  await page.locator('.full-report').evaluate(el => { el.scrollLeft = el.scrollWidth; });
  await page.screenshot({ path: path.join(ROOT, 'test-results/compact-report-empty-notes.png') });
  await page.locator('#rPageNext').click();
  assert.equal(await table.evaluate(el => el.classList.contains('has-notes')), true);
  assert.ok((await page.locator('#rRows .report-note').last().boundingBox()).width >= 150);
  assert.equal(await page.locator('#rRows .report-note').last().textContent(), '完整备注内容需要保留并换行显示');
  await page.setViewportSize({ width: 320, height: 844 });
  await page.locator('.full-report').evaluate(el => { el.scrollLeft = el.scrollWidth; });
  const date = await page.locator('#rRows .report-date').last().boundingBox(), note = await page.locator('#rRows .report-note').last().boundingBox();
  assert.ok(note.x >= date.x + date.width - 1, '最窄手机上备注不被固定日期列遮挡');
  await page.setViewportSize({ width: 1280, height: 900 });
  assert.ok((await page.locator('#rRows .report-note').first().boundingBox()).width < 300, '桌面备注也不独占剩余宽度');
});

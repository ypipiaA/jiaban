/* Browser / Worker / Node 共用的数据校验与三方合并，无网络或存储副作用。 */
(function (root) {
  'use strict';
  const empty = () => ({ settings: { daily: 8, comp0: 0 }, records: {}, adjust: [] });
  const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(id);
  const validCode = code => typeof code === 'string' && /^jb1_[A-Za-z0-9_-]{43}$/.test(code);
  function date(value) {
    if (typeof value !== 'string' || !/^[2-9]\d{3}-\d{2}-\d{2}$|^19\d{2}-\d{2}-\d{2}$/.test(value)) return false;
    const d = new Date(value + 'T12:00:00Z');
    return !Number.isNaN(d.valueOf()) && d.toISOString().slice(0, 10) === value;
  }
  function num(n, min, max) { return typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max; }
  function validate(data) {
    if (!object(data) || !object(data.settings) || !object(data.records) || !Array.isArray(data.adjust)) throw new Error('数据结构不正确');
    if (!num(data.settings.daily, 0.01, 24) || !num(data.settings.comp0, -1e6, 1e6)) throw new Error('工时设置不正确');
    const out = empty(); out.settings = { daily: data.settings.daily, comp0: data.settings.comp0 };
    for (const [key, r] of Object.entries(data.records)) {
      if (!date(key) || !object(r) || typeof r.note !== 'string') throw new Error('记录内容不正确');
      if (r.type === 'work' && num(r.hours, 0, 24) && num(r.ot, 0, r.hours) && ['pay', 'comp'].includes(r.otMode)) out.records[key] = { type: r.type, hours: r.hours, ot: r.ot, otMode: r.otMode, note: r.note };
      else if (r.type === 'comp' && num(r.compHours, 0, 24)) out.records[key] = { type: r.type, compHours: r.compHours, note: r.note };
      else throw new Error('工时或记录类型不正确');
    }
    const ids = new Set();
    out.adjust = data.adjust.map(a => {
      if (!object(a) || !validId(a.id) || ids.has(a.id) || !date(a.d) || !num(a.h, -1e6, 1e6) || typeof a.note !== 'string') throw new Error('余额调整内容不正确');
      ids.add(a.id); return { id: a.id, d: a.d, h: a.h, note: a.note };
    });
    if (new TextEncoder().encode(JSON.stringify(out)).length > 256 * 1024) throw new Error('同步数据超过 256 KB，请先导出备份并整理历史记录');
    return out;
  }
  function stable(value) {
    if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
    if (object(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
    return JSON.stringify(value);
  }
  const equal = (a, b) => stable(a) === stable(b);
  function entities(data) {
    return new Map([
      ...Object.entries(data.settings).map(([key, value]) => ['setting:' + key, value]),
      ...Object.entries(data.records).map(([key, value]) => ['record:' + key, value]),
      ...data.adjust.map(a => ['adjust:' + a.id, a])
    ]);
  }
  function fromEntities(map) {
    const out = empty();
    for (const [key, value] of map) {
      if (value === undefined) continue;
      if (key.startsWith('setting:')) out.settings[key.slice(8)] = value;
      else if (key.startsWith('record:')) out.records[key.slice(7)] = value;
      else out.adjust.push(value);
    }
    out.adjust.sort((a, b) => a.id.localeCompare(b.id));
    return out;
  }
  function label(key) { return key.startsWith('record:') ? key.slice(7) + ' 的记录' : key === 'setting:daily' ? '每天标准工时' : key === 'setting:comp0' ? '初始调休余额' : '余额调整'; }
  function merge(base, local, remote, choices = {}) {
    const b = entities(base), l = entities(local), r = entities(remote), result = new Map(), conflicts = [];
    for (const key of new Set([...b.keys(), ...l.keys(), ...r.keys()])) {
      const bv = b.get(key), lv = l.get(key), rv = r.get(key);
      if (equal(lv, rv) || equal(rv, bv)) result.set(key, lv);
      else if (equal(lv, bv)) result.set(key, rv);
      else if (choices[key] === 'local' || choices[key] === 'remote') result.set(key, choices[key] === 'local' ? lv : rv);
      else { conflicts.push({ key, label: label(key), local: lv, remote: rv }); result.set(key, lv); }
    }
    return { data: fromEntities(result), conflicts };
  }
  function randomId() {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
  }
  root.SyncCore = { empty, validate, validCode, validId, equal, merge, randomId };
  if (typeof module !== 'undefined') module.exports = root.SyncCore;
})(globalThis);

/* 部署时由 sync_public.py 将 sync-core.js 内联到此 Worker 前面。 */
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
const snapshot = row => ({ revision: row.revision, data: JSON.parse(row.data), updatedAt: row.updated_at || row.created_at });
async function keyFor(code) {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}
async function payload(request) {
  if (!(request.headers.get('content-type') || '').includes('application/json')) throw new Error('需要 JSON 请求');
  if (Number(request.headers.get('content-length')) > 300000) throw new Error('请求过大');
  // 无 Content-Length 的流式请求也必须限制长度。
  const reader = request.body?.getReader(); if (!reader) throw new Error('缺少请求内容');
  const chunks = []; let length = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.byteLength; if (length > 300000) { await reader.cancel(); throw new Error('请求过大'); } chunks.push(value); }
  const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return JSON.parse(new TextDecoder().decode(bytes));
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) {
      const response = await env.ASSETS.fetch(request);
      const installer = /^\/downloads\/(jiaban-\d+\.\d+\.\d+\.apk)(\.sha256)?$/.exec(url.pathname);
      const installPage = url.pathname === '/install.html' || url.pathname === '/install';
      const updateManifest = url.pathname === '/downloads/android-latest.json';
      if (!response.ok || (!installer && !installPage && !updateManifest)) return response;
      const headers = new Headers(response.headers);
      if (installer) {
        headers.set('Content-Type', installer[2] ? 'text/plain; charset=utf-8' : 'application/vnd.android.package-archive');
        if (!installer[2]) headers.set('Content-Disposition', `attachment; filename="${installer[1]}"`);
        headers.set('X-Content-Type-Options', 'nosniff');
        headers.set('Cache-Control', 'public, max-age=31536000, immutable');
      } else if (updateManifest) {
        headers.set('Content-Type', 'application/json; charset=utf-8');
        headers.set('X-Content-Type-Options', 'nosniff');
        headers.set('Cache-Control', 'no-store');
      } else headers.set('Cache-Control', 'no-cache');
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
    }
    if (!['/api/health', '/api/sync', '/api/sync/history'].includes(url.pathname)) return json({ error: '接口不存在' }, 404);
    if (request.headers.get('origin') && request.headers.get('origin') !== url.origin) return json({ error: '不允许跨站请求' }, 403);
    if (!env.DB) return json({ error: '同步数据库尚未配置' }, 503);
    try {
      if (url.pathname === '/api/health') {
        if (request.method !== 'GET') return json({ error: '请求方式不支持' }, 405);
        await env.DB.prepare('SELECT room FROM sync_rooms LIMIT 1').first();
        return json({ ready: true, version: 1 });
      }
      const code = (request.headers.get('authorization') || '').replace(/^Bearer /, '');
      if (!SyncCore.validCode(code)) return json({ error: '同步码格式不正确' }, 401);
      const room = await keyFor(code);
      const current = () => env.DB.prepare('SELECT * FROM sync_rooms WHERE room = ?').bind(room).first();
      if (url.pathname === '/api/sync/history') {
        if (request.method !== 'GET') return json({ error: '请求方式不支持' }, 405);
        if (!await current()) return json({ error: '同步空间不存在，请检查同步码' }, 404);
        if (url.searchParams.has('revision')) {
          const revision = Number(url.searchParams.get('revision'));
          if (!Number.isSafeInteger(revision) || revision < 1) return json({ error: '版本不正确' }, 400);
          const row = await env.DB.prepare('SELECT * FROM sync_history WHERE room = ? AND revision = ?').bind(room, revision).first();
          return row ? json(snapshot(row)) : json({ error: '此历史版本已不存在' }, 404);
        }
        const rows = await env.DB.prepare('SELECT revision, created_at FROM sync_history WHERE room = ? ORDER BY revision DESC LIMIT 30').bind(room).all();
        return json({ versions: rows.results.map(row => ({ revision: row.revision, updatedAt: row.created_at })) });
      }
      if (request.method === 'GET') { const row = await current(); return row ? json(snapshot(row)) : json({ error: '同步空间不存在，请检查同步码' }, 404); }
      if (!['POST', 'PUT'].includes(request.method)) return json({ error: '请求方式不支持' }, 405);
      let body, data;
      try { body = await payload(request); data = JSON.stringify(SyncCore.validate(body.data)); } catch (e) { return json({ error: e.message || '数据不正确' }, 400); }
      const now = new Date().toISOString();
      if (request.method === 'POST') {
        const created = await env.DB.prepare('INSERT OR IGNORE INTO sync_rooms (room, revision, data, created_at, updated_at) VALUES (?, 1, ?, ?, ?)').bind(room, data, now, now).run();
        return json(snapshot(await current()), created.meta.changes ? 201 : 409);
      }
      if (!Number.isSafeInteger(body.revision) || body.revision < 1) return json({ error: '同步版本不正确' }, 400);
      // D1 batch 为事务：保存旧版本与条件更新一并完成，两个设备不能同时覆盖同一版本。
      const result = await env.DB.batch([
        env.DB.prepare('INSERT OR IGNORE INTO sync_history (room, revision, data, created_at) SELECT room, revision, data, updated_at FROM sync_rooms WHERE room = ? AND revision = ?').bind(room, body.revision),
        env.DB.prepare('UPDATE sync_rooms SET data = ?, revision = revision + 1, updated_at = ? WHERE room = ? AND revision = ?').bind(data, now, room, body.revision),
        env.DB.prepare('DELETE FROM sync_history WHERE room = ? AND revision NOT IN (SELECT revision FROM sync_history WHERE room = ? ORDER BY revision DESC LIMIT 30)').bind(room, room)
      ]);
      if (!result[1].meta.changes) { const row = await current(); return row ? json(snapshot(row), 409) : json({ error: '同步空间不存在' }, 404); }
      // 返回本次提交的确切版本，不能把后续设备的新版本当成本次提交结果。
      return json({ revision: body.revision + 1, data: JSON.parse(data), updatedAt: now });
    } catch { return json({ error: '同步服务暂时不可用，本机数据仍保留' }, 503); }
  }
};

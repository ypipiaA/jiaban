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

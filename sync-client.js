/* 同步状态与本机记录分开保存；任何失败都不撤销已保存的本机记录。 */
(() => {
  'use strict';
  const KEY = 'jiaban.sync.v1', RECOVERY = 'jiaban.recovery.v1';
  let config = null, busy = false, timer, pending = null, applying = false, blockedConfig = false;
  let historyKind = null, historyRequest = 0;
  function showHistory(kind, html = '', loading = false) {
    historyKind = kind; historyRequest++;
    const list = $('syncHistoryList');
    list.classList.toggle('hide', !kind); list.innerHTML = html; list.scrollTop = 0;
    list.setAttribute('aria-busy', String(loading));
    $('syncHistory').setAttribute('aria-expanded', String(kind === 'cloud'));
    $('syncRecovery').setAttribute('aria-expanded', String(kind === 'local'));
    return historyRequest;
  }
  const editing = () => document.body.classList.contains('open') || inlineDirty() || settingsDirty();
  function summary() {
    const label = $('syncSummary'); if (!label) return;
    const message = $('syncStatus').textContent, error = $('syncStatus').classList.contains('error');
    label.textContent = pending ? '有冲突' : config && !navigator.onLine ? '离线保存' : error ? '待处理' : !config ? '未连接' : message.startsWith('已同步') ? '已同步' : busy ? '同步中' : /等待同步|请先保存|新修改/.test(message) ? '待同步' : '已连接';
    label.style.color = error || pending ? 'var(--ot)' : '';
  }
  function status(message, error = false) {
    $('syncStatus').textContent = message; $('syncStatus').classList.toggle('error', error);
    summary();
    if (config) { $('netStatus').textContent = message.startsWith('已同步') ? '云端已同步' : error ? '同步待处理' : busy ? '正在同步' : '本机已保存'; $('netStatus').classList.toggle('offline', error); }
  }
  try {
    const stored = localStorage.getItem(KEY);
    if (stored) {
      config = JSON.parse(stored);
      if (!SyncCore.validCode(config.code) || !Number.isSafeInteger(config.revision) || config.revision < 0) throw new Error();
      config.base = SyncCore.validate(config.base);
    }
  } catch { config = null; blockedConfig = true; status('同步配置无法读取。请另存已有同步码，重置连接配置后重新连接；本机记录不会被清空。', true); }
  if (blockedConfig) {
    const reset = document.createElement('button'); reset.className = 'btn ghost'; reset.style.marginTop = '12px'; reset.textContent = '重置此设备的连接配置';
    $('syncSetup').append(reset);
    reset.onclick = () => {
      if (!confirm('仅重置此设备的同步连接配置，本机和云端记录保留。请确认已另存原同步码。')) return;
      try { const raw = localStorage.getItem(KEY); if (raw) localStorage.setItem(KEY + '.unreadable', raw); localStorage.removeItem(KEY); blockedConfig = false; reset.remove(); status('连接配置已重置，可使用原同步码重新连接。'); }
      catch { status('无法重置，请检查浏览器存储空间。', true); }
    };
  }
  function saveConfig(next) {
    // 多标签页的连接设置不可在后台互相覆盖。
    const current = localStorage.getItem(KEY);
    if (config && current && JSON.parse(current).code !== config.code) throw new Error('同步空间在其他页面发生变化，请刷新');
    localStorage.setItem(KEY, JSON.stringify(next)); config = next;
  }
  function render() {
    $('syncSetup').classList.toggle('hide', !!config); $('syncConnected').classList.toggle('hide', !config);
    for (const id of ['syncCreate', 'syncJoin', 'syncNow', 'syncDisconnect', 'syncResolve']) $(id).disabled = busy;
    if (config && !$('syncCode').classList.contains('hide')) $('syncCode').value = config.code;
    $('syncConflicts').classList.toggle('hide', !pending);
    summary();
  }
  async function api(path, method = 'GET', body, code = config?.code) {
    if (location.protocol === 'file:') throw new Error('同步需要在已部署的网站中使用；本地开发请运行 npm start');
    const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const headers = { 'Authorization': 'Bearer ' + code, ...(body ? { 'Content-Type': 'application/json' } : {}) };
      const response = window.JiabanNative ? await window.JiabanNative.request(path, method, body, headers) : await fetch(path, { method, cache: 'no-store', signal: controller.signal, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
      let value; try { value = await response.json(); } catch { throw new Error('当前地址没有同步服务，请使用正式网站或 npm start 启动本地服务'); }
      if (!response.ok && response.status !== 409) throw new Error(value.error || `同步失败（${response.status}）`);
      if (value.data) { value.data = SyncCore.validate(value.data); if (!Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error('云端版本不正确'); }
      return { ...value, conflict: response.status === 409 };
    } catch (error) { if (error.name === 'AbortError') throw new Error('同步超时，本机记录已保留，稍后会重试'); throw error; }
    finally { clearTimeout(timeout); }
  }
  function recovery(data) {
    let copies = [];
    const raw = localStorage.getItem(RECOVERY);
    if (raw) { try { copies = JSON.parse(raw); if (!Array.isArray(copies)) throw new Error(); } catch { throw new Error('本机恢复副本无法读取，请先处理存储内容'); } }
    if (copies.length && SyncCore.equal(copies[0].data, data)) return;
    copies.unshift({ savedAt: new Date().toISOString(), data });
    try { localStorage.setItem(RECOVERY, JSON.stringify(copies.slice(0, 3))); } catch { throw new Error('空间不足，无法保存同步前副本；请先导出备份并整理浏览器存储'); }
  }
  function sameConnection(code) { return config?.code === code && JSON.parse(localStorage.getItem(KEY) || 'null')?.code === code; }
  function describe(value) {
    if (value === undefined) return '已删除 / 未记录';
    if (typeof value === 'number') return `${value} 小时`;
    if (value.type === 'work') return `上班 ${f1(regularHours(value))}h，加班 ${f1(value.ot)}h，合计 ${f1(value.hours)}h${value.otMode === 'comp' ? '（换调休）' : ''}${value.note ? ' · ' + value.note : ''}`;
    if (value.type === 'comp') return `调休 ${f1(value.compHours)}h${value.note ? ' · ' + value.note : ''}`;
    return `${value.d} · ${f1(value.h)}h · ${value.note || '余额调整'}`;
  }
  function conflicts(local, remote, raw, result) {
    pending = { local, remote, raw, conflicts: result.conflicts };
    $('syncConflictRows').innerHTML = result.conflicts.map((c, i) => `<div class="conflict-item"><h3>${esc(c.label)}</h3><label class="conflict-option"><input type="radio" name="sync-conflict-${i}" value="local"><span><small>此设备</small>${esc(describe(c.local))}</span></label><label class="conflict-option"><input type="radio" name="sync-conflict-${i}" value="remote"><span><small>云端 / 另一台设备</small>${esc(describe(c.remote))}</span></label></div>`).join('');
    status(`有 ${result.conflicts.length} 项修改冲突，请在下方选择；其他记录仍保存在本机。`, true); render();
  }
  function schedule(delay = 1000) { clearTimeout(timer); if (config && !pending) timer = setTimeout(() => sync(), delay); }
  async function sync(resolutions = null) {
    if (!config || busy || (pending && !resolutions)) return;
    if (loadFailed) { status('本机数据尚未恢复，暂停同步，避免覆盖云端记录。', true); return; }
    if (!navigator.onLine) { status('当前离线，记录已在本机保存；联网后自动补同步。', true); return; }
    if (editing()) { status('请先保存填写内容，随后自动同步。'); schedule(3000); return; }
    busy = true; render(); status('正在同步…');
    const code = config.code;
    try {
      if (config.creating) {
        await api('/api/sync', 'POST', { data: SyncCore.validate(S) }, code);
        if (!sameConnection(code)) return;
        saveConfig({ ...config, creating: false });
      }
      for (let attempt = 0; attempt < 4; attempt++) {
        const remote = await api('/api/sync', 'GET', undefined, code);
        if (!sameConnection(code)) return;
        if (editing()) { schedule(3000); status('请先保存填写内容，随后自动同步。'); return; }
        const local = SyncCore.validate(S), capturedRaw = rawData, capturedConfigRaw = localStorage.getItem(KEY);
        let choices = {};
        // 用户的选择只适用于已展示的两个版本；后台新修改会重新提示。
        if (resolutions && pending && pending.raw === capturedRaw && pending.remote.revision === remote.revision) choices = resolutions;
        const result = SyncCore.merge(config.base, local, remote.data, choices);
        if (result.conflicts.length) { conflicts(local, remote, capturedRaw, result); return; }
        if (localStorage.getItem(LS) !== capturedRaw) throw new Error('本机数据已在其他页面变化，请刷新后同步');
        const needsApply = !SyncCore.equal(local, result.data);
        if (needsApply) recovery(local);
        let saved = remote, uploaded = false;
        if (!SyncCore.equal(result.data, remote.data)) {
          saved = await api('/api/sync', 'PUT', { revision: remote.revision, data: result.data }, code);
          if (saved.conflict) { resolutions = null; continue; }
          uploaded = true;
        }
        if (!sameConnection(code)) return;
        if (rawData !== capturedRaw || localStorage.getItem(LS) !== capturedRaw || editing()) {
          // 确认上传成功后，以当时的本机快照为基线，保留之后的同日修改。
          // 不能用 saved.data：其中的远端记录尚未应用到本机，会被误认为本机删除。
          // 其他标签页若已推进连接状态，保留它的新基线。
          if (uploaded && localStorage.getItem(KEY) === capturedConfigRaw) saveConfig({ ...config, base: local, revision: saved.revision });
          pending = null; schedule(1000); status('本机有新修改，正在准备下一次同步…'); return;
        }
        if (needsApply) {
          applying = true;
          try { if (!commit(result.data)) throw new Error('云端已保留，本机写入失败，请稍后重试'); refresh(); }
          finally { applying = false; }
        }
        saveConfig({ code, base: saved.data, revision: saved.revision, lastSynced: new Date().toISOString(), creating: false });
        pending = null; status(`已同步 · ${new Date(config.lastSynced).toLocaleTimeString('zh-CN', { hour12: false })} · 云端版本 ${config.revision}`); render(); return;
      }
      throw new Error('其他设备正在频繁修改，稍后将自动重试');
    } catch (error) { status(error.message || '网络连接失败，本机记录已保留，稍后重试。', true); }
    finally { busy = false; render(); }
  }
  async function connect(create) {
    if (busy || config) return;
    if (loadFailed || blockedConfig) { status('本机数据或同步配置无法读取，请先恢复并导出备份。', true); return; }
    const code = create ? 'jb1_' + SyncCore.randomId() : $('syncJoinCode').value.trim();
    if (!SyncCore.validCode(code)) { status('请粘贴完整的 jb1_ 开头的同步码。', true); return; }
    busy = true; render(); status(create ? '正在创建同步空间…' : '正在连接同步空间…');
    try {
      SyncCore.validate(S);
      if (create) await api('/api/health', 'GET', undefined, code);
      else await api('/api/sync', 'GET', undefined, code);
      // 创建请求之前落盘同步码；请求成功但响应丢失时仍能重试找回空间。
      saveConfig({ code, base: SyncCore.empty(), revision: 0, creating: create, lastSynced: null });
      $('syncJoinCode').value = '';
    } catch (error) { status(error.message || '连接失败，请检查网络。', true); }
    finally { busy = false; render(); }
    if (config) await sync();
  }
  $('syncCreate').onclick = () => connect(true); $('syncJoin').onclick = () => connect(false); $('syncNow').onclick = () => sync();
  $('syncCopy').onclick = async () => {
    try { if (window.JiabanNative) await window.JiabanNative.copy(config.code); else await navigator.clipboard.writeText(config.code); toast('同步码已复制，请在另一台设备中粘贴'); }
    catch { $('syncAdvanced').open = true; $('syncCode').value = config.code; $('syncCode').classList.remove('hide'); $('syncCode').select(); toast('请长按或使用 Ctrl+C 复制同步码'); }
  };
  $('syncReveal').onclick = () => { const hidden = $('syncCode').classList.toggle('hide'); $('syncCode').value = hidden ? '' : config.code; $('syncReveal').textContent = hidden ? '显示同步码' : '隐藏同步码'; };
  $('syncDisconnect').onclick = () => {
    if (busy || !confirm('断开后此设备将停止同步，本机和云端记录都会保留。请确认已另存同步码，以便重新连接。')) return;
    try { localStorage.removeItem(KEY); config = null; pending = null; clearTimeout(timer); $('syncCode').value = ''; $('syncCode').classList.add('hide'); showHistory(null); status('已断开此设备，本机和云端记录已保留。'); updateHeader(); render(); } catch { status('无法修改本机存储，断开失败。', true); }
  };
  $('syncResolve').onclick = () => {
    if (!pending) return;
    const choices = {};
    for (const [index, c] of pending.conflicts.entries()) { const radio = document.querySelector(`input[name="sync-conflict-${index}"]:checked`); if (!radio) { toast('请为每一项冲突选择要保留的版本'); return; } choices[c.key] = radio.value; }
    sync(choices);
  };
  $('syncRecovery').onclick = () => {
    if (historyKind === 'local') { showHistory(null); return; }
    showHistory('local');
    try { const copies = JSON.parse(localStorage.getItem(RECOVERY) || '[]'); $('syncHistoryList').innerHTML = copies.length ? '<p class="hint">同步前的本机恢复副本（最近 3 份）</p>' + copies.map((copy, index) => `<div class="kv"><span>${esc(new Date(copy.savedAt).toLocaleString('zh-CN'))}</span><button class="link-btn" data-local="${index}">下载</button></div>`).join('') : '<p class="hint">尚无恢复副本；接收云端修改前会自动保留。</p>'; }
    catch { $('syncHistoryList').innerHTML = '<p class="hint">无法读取本机恢复副本。</p>'; }
  };
  $('syncHistory').onclick = async () => {
    if (historyKind === 'cloud') { showHistory(null); return; }
    const code = config?.code, request = showHistory('cloud', '<p class="hint">正在加载云端历史…</p>', true);
    try {
      const result = await api('/api/sync/history');
      // 收起或切到本机副本后，迟到的请求不能重新展开或替换列表。
      if (request !== historyRequest || code !== config?.code) return;
      $('syncHistoryList').innerHTML = result.versions.map(v => `<div class="kv"><span>版本 ${v.revision} · ${esc(new Date(v.updatedAt).toLocaleString('zh-CN'))}</span><button class="link-btn" data-version="${v.revision}">下载</button></div>`).join('') || '<p class="hint">尚无历史版本。每次云端更新前保留旧版，最多 30 份。</p>';
    } catch (error) {
      if (request !== historyRequest || code !== config?.code) return;
      $('syncHistoryList').innerHTML = `<p class="hint">${esc(error.message)}；可收起后重试。</p>`;
    } finally { if (request === historyRequest) $('syncHistoryList').setAttribute('aria-busy', 'false'); }
  };
  $('syncHistoryList').onclick = async e => {
    const local = e.target.closest('[data-local]');
    if (local) { try { const copies = JSON.parse(localStorage.getItem(RECOVERY) || '[]'); const copy = copies[Number(local.dataset.local)]; if (!copy) throw new Error(); download(JSON.stringify(copy.data, null, 2), exportName('同步前本机恢复副本')); } catch { toast('副本已变化，请重新打开恢复副本列表'); } return; }
    const button = e.target.closest('[data-version]'); if (!button) return;
    try { const result = await api('/api/sync/history?revision=' + encodeURIComponent(button.dataset.version)); download(JSON.stringify(result.data, null, 2), exportName(`云端备份-v${result.revision}`)); } catch (error) { status(error.message, true); }
  };
  window.addEventListener('jiaban-change', () => { if (!applying && config) { if (pending) { status('本机已有新修改，请先确认冲突；提交时会重新核对版本。', true); } else { status('已保存在本机，等待同步…'); schedule(); } } });
  window.addEventListener('online', () => schedule(100));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(100); });
  window.addEventListener('storage', e => {
    if (e.key === KEY || e.key === null) {
      try { const next = JSON.parse(localStorage.getItem(KEY) || 'null'); if (next && (!SyncCore.validCode(next.code) || !SyncCore.validate(next.base))) throw new Error(); if (next?.code !== config?.code) showHistory(null); config = next; pending = null; render(); schedule(200); }
      catch { config = null; blockedConfig = true; showHistory(null); status('其他页面的同步配置无法读取，请刷新。', true); }
    } else if (e.key === LS) schedule(200);
  });
  setInterval(() => { if (!document.hidden) sync(); }, 60000);
  window.JiabanSync = { connected: () => !!config, run: sync };
  render(); if (config) { status('已连接，正在检查待同步记录…'); schedule(300); }
})();

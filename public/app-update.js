/* In-app updates never alter records or synchronization credentials. */
(() => {
  'use strict';
  const native = window.JiabanNative, updater = native?.updater;
  const $ = id => document.getElementById(id);
  const DAY = 86400000;
  const style = document.createElement('style');
  style.textContent = `
    #appUpdate[hidden],#webUpdate[hidden]{display:none!important}
    #appUpdate{position:fixed;inset:0;z-index:50;background:#16243b66;display:flex;align-items:center;justify-content:center;padding:calc(20px + var(--safe-top,0px)) calc(20px + var(--safe-right,0px)) calc(20px + var(--safe-bottom,0px)) calc(20px + var(--safe-left,0px));overscroll-behavior:contain}
    .update-panel{width:100%;max-width:360px;max-height:100%;overflow-y:auto;background:var(--card,#fff);border-radius:20px;padding:24px;box-shadow:0 12px 50px #182a4326}
    .update-panel h2{font-size:20px;line-height:1.4;margin:0 0 6px}.update-meta{font-size:12px;color:var(--muted,#707b8d)}
    .update-notes{font-size:14px;white-space:pre-line;overflow-wrap:anywhere;margin:18px 0;color:var(--text,#202c3b)}
    #updateMessage{margin:12px 0;min-height:22px;font-size:12px;color:var(--muted,#707b8d);overflow-wrap:anywhere}
    #updateProgress{display:block;width:100%;height:7px;margin:16px 0;accent-color:var(--pri,#285cde)}#updateProgress[hidden]{display:none}
    .update-actions{display:flex;gap:10px;margin-top:18px}.update-actions .btn{flex:1;min-width:0}
    #appUpdateSettings .update-setting-row{display:flex;gap:12px;align-items:center;justify-content:space-between}#appUpdateSettings h2{font-size:14px}#appUpdateStatus{margin-top:5px;font-size:11px;color:var(--muted,#707b8d)}
    #webUpdate{position:fixed;z-index:25;left:max(12px,var(--safe-left,0px));right:max(12px,var(--safe-right,0px));bottom:calc(70px + var(--safe-bottom,0px));max-width:480px;margin:auto;display:flex;gap:10px;align-items:center;background:var(--card,#fff);border:1px solid #cbd9ff;box-shadow:0 4px 24px #182a4326;border-radius:14px;padding:12px 14px;font-size:13px}
    #webUpdate>span{flex:1}#webUpdate button{flex:none;min-height:40px}#webUpdateDismiss{border:0;background:none;color:var(--muted,#707b8d);padding:6px;font-size:12px}
  `;
  document.head.append(style);
  const canRestart = () => window.JiabanApp?.canRestart?.() !== false;

  if (updater) {
    const settings = document.createElement('section');
    settings.id = 'appUpdateSettings'; settings.className = 'card';
    settings.innerHTML = '<div class="update-setting-row"><div><h2>应用更新</h2><p class="update-meta">打开时自动检查</p></div><button class="btn sec sm" id="checkAppUpdate" type="button">检查更新</button></div><p id="appUpdateStatus" role="status" aria-live="polite"></p>';
    $('v-set')?.insertBefore(settings, $('appVersion'));
    const modal = document.createElement('div');
    modal.id = 'appUpdate'; modal.hidden = true;
    modal.innerHTML = '<section class="update-panel" role="dialog" aria-modal="true" aria-labelledby="updateTitle" aria-describedby="updateMessage" tabindex="-1"><h2 id="updateTitle">发现新版本</h2><p id="updateVersion" class="update-meta"></p><p id="updateNotes" class="update-notes"></p><progress id="updateProgress" max="100" value="0" aria-label="下载进度" hidden></progress><p id="updateMessage" role="status" aria-live="polite"></p><div class="update-actions"><button class="btn ghost" id="updateLater" type="button">稍后再说</button><button class="btn" id="updateNow" type="button">下载更新</button></div></section>';
    document.body.append(modal);
    let release = null, phase = 'idle', checking = false, lastCheck = 0, lastAttempt = 0, progress = 0;
    let compatible = true, errorText = '', focusBefore = null, permissionOpened = false;
    let busyInstall = false, currentVersion = '', inertBefore = [], overflowBefore = '';
    const status = message => { $('appUpdateStatus').textContent = message; };
    const displayVersion = () => { if (currentVersion && $('appVersionLabel')) $('appVersionLabel').textContent = 'v' + currentVersion; };
    native.appInfo?.().then(info => { currentVersion = info.version; displayVersion(); }).catch(() => {});
    function render() {
      if (!release) return;
      $('updateTitle').textContent = phase === 'ready' || phase === 'permission' ? '更新已下载' : phase === 'downloading' ? '正在下载更新' : '发现新版本';
      $('updateVersion').textContent = `v${release.version} · ${(release.size / 1048576).toFixed(1)} MB`;
      $('updateNotes').textContent = release.notes || '体验优化与问题修复';
      $('updateProgress').hidden = phase !== 'downloading'; $('updateProgress').value = progress;
      $('updateNow').disabled = phase === 'downloading' || busyInstall || !compatible;
      $('updateNow').textContent = !compatible ? '暂不支持' : phase === 'permission' ? (permissionOpened ? '继续安装' : '去允许安装') : phase === 'ready' ? '安装更新' : phase === 'downloading' ? `下载中 ${progress}%` : phase === 'error' ? '重新下载' : '下载更新';
      $('updateLater').textContent = phase === 'downloading' ? '后台下载' : '稍后再说';
      $('updateMessage').textContent = !compatible ? '新版需要更高的安卓系统，当前版本仍可正常记工时。' : phase === 'permission'
        ? '请在手机设置中允许「加班记录」安装应用，返回后点「继续安装」。'
        : phase === 'ready' ? '安装时选择更新，已有记录会保留。若已关闭安装窗口，可再次点击。'
        : phase === 'downloading' ? '请保持联网，下载完成后需要你确认安装。'
        : phase === 'error' ? errorText : '直接在这里更新，已有记录和同步连接会保留。';
    }
    function show() {
      render();
      if (!modal.hidden) return;
      focusBefore = document.activeElement; overflowBefore = document.body.style.overflow;
      inertBefore = [...document.body.children].filter(el => el !== modal && !['SCRIPT', 'STYLE'].includes(el.tagName)).map(el => [el, el.inert]);
      for (const [el] of inertBefore) el.inert = true;
      document.body.style.overflow = 'hidden'; modal.hidden = false; $('updateLater').focus();
    }
    function close() {
      if (modal.hidden) return false;
      modal.hidden = true; document.body.style.overflow = overflowBefore;
      for (const [el, value] of inertBefore) el.inert = value;
      inertBefore = []; focusBefore?.focus?.();
      if (release) try { localStorage.setItem('jiaban-update-dismissed', JSON.stringify({ code: release.versionCode, time: Date.now() })); } catch {}
      return true;
    }
    function shouldPrompt() {
      try { const dismissed = JSON.parse(localStorage.getItem('jiaban-update-dismissed') || 'null'); return !dismissed || dismissed.code !== release.versionCode || Date.now() - dismissed.time >= DAY; } catch { return true; }
    }
    async function check(manual = false) {
      if (checking || phase === 'downloading' || busyInstall) { if (manual && release) show(); return; }
      if (manual && (phase === 'ready' || phase === 'permission')) { show(); return; }
      if (!manual && (phase === 'ready' || phase === 'permission' || Date.now() - lastAttempt < 900000 || Date.now() - lastCheck < 21600000)) return;
      checking = true; lastAttempt = Date.now(); $('checkAppUpdate').disabled = true;
      if (manual) status('正在检查…');
      try {
        const result = await updater.check(); lastCheck = Date.now();
        currentVersion = result.currentVersion || currentVersion;
        displayVersion();
        if (!result.available) { status('已是最新版本'); return; }
        release = result.release; compatible = result.compatible !== false; phase = 'available';
        status(compatible ? `有新版 v${release.version}，点「检查更新」查看` : '新版需要更高的安卓系统');
        if (manual || (compatible && shouldPrompt())) show();
      } catch { if (manual) status('暂时无法检查更新，请联网后重试'); }
      finally { checking = false; $('checkAppUpdate').disabled = false; }
    }
    async function install() {
      if (busyInstall || !canRestart()) return;
      busyInstall = true; render();
      try {
        const result = await updater.install();
        phase = result.permissionRequired ? 'permission' : 'ready'; permissionOpened = false;
      } catch (error) { phase = 'error'; errorText = error.message || '安装未完成，请重新下载后重试'; }
      finally { busyInstall = false; render(); }
    }
    async function action() {
      if (!compatible || phase === 'downloading' || busyInstall) return;
      if (phase === 'permission' && !permissionOpened) {
        try { await updater.openInstallSettings(); permissionOpened = true; render(); }
        catch (error) { $('updateMessage').textContent = error.message || '无法打开手机设置，请手动允许安装'; }
        return;
      }
      if (phase === 'ready' || phase === 'permission') { await install(); return; }
      phase = 'downloading'; progress = 0; render(); status('正在下载更新…');
      try {
        await updater.download(); phase = 'ready'; status('新版已下载，点「检查更新」安装'); render();
        if (!modal.hidden && !document.hidden) await install();
      } catch (error) { phase = 'error'; errorText = error.message || '下载中断，请联网后重试'; status('更新未完成，可点「检查更新」重试'); render(); }
    }
    updater.addListener('progress', event => { progress = Math.max(0, Math.min(100, Math.round(Number(event.percent) || 0))); if (phase === 'downloading') render(); }).catch(() => {});
    $('checkAppUpdate').onclick = () => check(true); $('updateNow').onclick = action; $('updateLater').onclick = close;
    document.addEventListener('keydown', event => {
      if (modal.hidden) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(); }
      if (event.key === 'Tab') {
        const buttons = [...modal.querySelectorAll('button:not(:disabled)')], first = buttons[0], last = buttons.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
    }, true);
    window.JiabanUpdate = { back: close, resume: () => check(false) };
    window.addEventListener('online', () => { if (!lastCheck) lastAttempt = 0; check(false); });
    setTimeout(() => check(false), 1800);
  } else if (!native && location.protocol.startsWith('http') && 'serviceWorker' in navigator) {
    let controlled = !!navigator.serviceWorker.controller, lastCheck = 0;
    const banner = document.createElement('div'); banner.id = 'webUpdate'; banner.hidden = true;
    banner.setAttribute('role', 'status');
    banner.innerHTML = '<span>新版已就绪</span><button id="webUpdateNow" class="btn sec sm" type="button">立即更新</button><button id="webUpdateDismiss" type="button">稍后</button>';
    document.body.append(banner);
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (controlled) banner.hidden = false; controlled = true; });
    $('webUpdateNow').onclick = () => window.JiabanApp.reload();
    $('webUpdateDismiss').onclick = () => { banner.hidden = true; };
    const check = async () => {
      if (Date.now() - lastCheck < 900000) return; lastCheck = Date.now();
      try { const registration = await navigator.serviceWorker.getRegistration(); await registration?.update(); } catch {}
    };
    document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
    window.addEventListener('online', check);
  }
})();

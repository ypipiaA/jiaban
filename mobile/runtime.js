import { Capacitor, CapacitorHttp, SystemBars, SystemBarsStyle, registerPlugin } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Clipboard } from '@capacitor/clipboard';
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';
import { Share } from '@capacitor/share';

// The installed app keeps its UI on the device and calls only the existing HTTPS sync service.
const API_ORIGIN = 'https://jiaban-x2m.pages.dev';
if (Capacitor.isNativePlatform()) {
  const updater = registerPlugin('AppUpdater');
  window.JiabanNative = {
    updater,
    appInfo: () => App.getInfo(),
    async request(path, method, body, headers) {
      if (!/^\/api\/(health|sync(?:\/history)?)(?:\?|$)/.test(path)) throw new Error('同步地址不正确');
      try {
        const response = await CapacitorHttp.request({
          url: API_ORIGIN + path, method, headers, data: body,
          connectTimeout: 12000, readTimeout: 12000, disableRedirects: true, responseType: 'json'
        });
        return { status: response.status, ok: response.status >= 200 && response.status < 300,
          json: async () => typeof response.data === 'string' ? JSON.parse(response.data) : response.data };
      } catch (error) {
        if (/timeout|timed out/i.test(error.message || '')) throw new DOMException('Sync timeout', 'AbortError');
        throw error;
      }
    },
    async download(content, filename) {
      // Only app-private cache is used; no access to the user's photo library or shared storage.
      const safeName = filename.replace(/[\\/:*?"<>|]/g, '_');
      const file = await Filesystem.writeFile({ path: 'exports/' + safeName, data: content,
        directory: Directory.Cache, encoding: Encoding.UTF8, recursive: true });
      await Share.share({ title: filename, files: [file.uri], dialogTitle: '保存或发送备份' });
    },
    copy: text => Clipboard.write({ string: text })
  };
  App.addListener('appStateChange', ({ isActive }) => { if (isActive) { window.JiabanSync?.run(); window.JiabanUpdate?.resume(); } });
  App.addListener('backButton', () => { if (window.JiabanUpdate?.back()) return; if (window.JiabanApp && !window.JiabanApp.back()) App.exitApp(); });
  SystemBars.setStyle({ style: SystemBarsStyle.Light }).catch(() => {});
}

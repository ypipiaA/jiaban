const { test } = require('node:test');
const assert = require('node:assert/strict');

test('安卓下载返回安装包类型及附件名称，安装页及时刷新，错误不伪装为成功', async () => {
  const worker = (await import('../sync-worker.mjs')).default;
  const env = { ASSETS: { fetch: async () => new Response('apk-bytes', { headers: { 'Content-Type': 'application/octet-stream' } }) } };
  const apk = await worker.fetch(new Request('https://test.invalid/downloads/jiaban-1.2.0.apk'), env);
  assert.equal(apk.headers.get('content-type'), 'application/vnd.android.package-archive');
  assert.equal(apk.headers.get('content-disposition'), 'attachment; filename="jiaban-1.2.0.apk"');
  assert.equal(await apk.text(), 'apk-bytes');
  const checksum = await worker.fetch(new Request('https://test.invalid/downloads/jiaban-1.2.0.apk.sha256'), env);
  assert.equal(checksum.headers.get('content-type'), 'text/plain; charset=utf-8');
  const latest = await worker.fetch(new Request('https://test.invalid/downloads/android-latest.json'), env);
  assert.equal(latest.headers.get('content-type'), 'application/json; charset=utf-8');
  assert.equal(latest.headers.get('cache-control'), 'no-store');
  assert.equal(latest.headers.get('content-disposition'), null);
  for (const page of ['/install.html', '/install']) {
    const install = await worker.fetch(new Request('https://test.invalid' + page), env);
    assert.equal(install.headers.get('cache-control'), 'no-cache');
  }
  env.ASSETS.fetch = async () => new Response('missing', { status: 404 });
  const missing = await worker.fetch(new Request('https://test.invalid/downloads/jiaban-1.2.0.apk'), env);
  assert.equal(missing.status, 404); assert.equal(missing.headers.get('content-disposition'), null);
});

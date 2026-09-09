/* 本地开发服务器使用 SQLite 运行与线上相同的 Worker；仅暴露 public/ 静态资源。 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');
require('./sync-core.js');

function database(filename) {
  const db = new DatabaseSync(filename);
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  class Statement {
    constructor(sql, args = []) { this.sql = sql; this.args = args; }
    bind(...args) { return new Statement(this.sql, args); }
    async first() { return db.prepare(this.sql).get(...this.args) || null; }
    async all() { return { results: db.prepare(this.sql).all(...this.args), success: true }; }
    async run() { const r = db.prepare(this.sql).run(...this.args); return { success: true, meta: { changes: Number(r.changes) } }; }
  }
  return { prepare: sql => new Statement(sql), async batch(statements) { db.exec('BEGIN'); try { const out = []; for (const s of statements) out.push(await s.run()); db.exec('COMMIT'); return out; } catch (e) { db.exec('ROLLBACK'); throw e; } }, close: () => db.close() };
}
async function createServer({ filename = ':memory:' } = {}) {
  const worker = (await import(pathToFileURL(path.join(__dirname, 'sync-worker.mjs')))).default;
  const DB = database(filename);
  const ASSETS = { async fetch(request) {
    const name = decodeURIComponent(new URL(request.url).pathname.slice(1) || 'index.html');
    if (!['index.html', 'install.html', 'sync-core.js', 'sync-client.js', 'app-update.js', 'downloads/android-latest.json', 'sw.js', 'manifest.json', 'icon.svg', 'icon-192.png', 'icon-512.png'].includes(name) && !/^downloads\/jiaban-\d+\.\d+\.\d+\.apk(?:\.sha256)?$/.test(name)) return new Response('Not found', { status: 404 });
    try { const body = fs.readFileSync(path.join(__dirname, 'public', name)); const type = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.apk': 'application/vnd.android.package-archive', '.sha256': 'text/plain; charset=utf-8' }[path.extname(name)]; return new Response(body, { headers: { 'Content-Type': type } }); } catch { return new Response('Not found', { status: 404 }); }
  } };
  // 与 D1 的事务队列一致，防止本地异步请求在同一个 SQLite 连接交错执行事务。
  let queue = Promise.resolve();
  const server = http.createServer(async (req, res) => {
    try {
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 300000) { res.writeHead(413).end(); return; } chunks.push(chunk); }
      const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers: req.headers, ...(chunks.length ? { body: Buffer.concat(chunks) } : {}) });
      const responsePromise = queue.then(() => worker.fetch(request, { DB, ASSETS }));
      queue = responsePromise.catch(() => {});
      const response = await responsePromise;
      res.writeHead(response.status, Object.fromEntries(response.headers)); res.end(Buffer.from(await response.arrayBuffer()));
    } catch { res.writeHead(500).end('Server error'); }
  });
  server.on('close', () => DB.close());
  return server;
}
module.exports = { createServer };
if (require.main === module) {
  fs.mkdirSync(path.join(__dirname, '.local'), { recursive: true });
  createServer({ filename: path.join(__dirname, '.local', 'sync.sqlite') }).then(server => {
    const port = Number(process.env.PORT || 8765);
    server.listen(port, '127.0.0.1', () => console.log(`加班记录（含本地同步服务）：http://127.0.0.1:${port}`));
  });
}

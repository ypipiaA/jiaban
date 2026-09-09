import { readFile, writeFile, mkdir, copyFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'esbuild';

const mobile = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(mobile), out = path.join(mobile, 'www');
await mkdir(out, { recursive: true });
const allowed = ['index.html', 'sync-core.js', 'sync-client.js', 'app-update.js', 'native-runtime.js', 'manifest.json', 'icon.svg', 'icon-192.png', 'icon-512.png'];
for (const name of await readdir(out)) if (!allowed.includes(name)) throw new Error('Unexpected file in mobile/www: ' + name);
let html = await readFile(path.join(root, '加班记录.html'), 'utf8');
html = html.replace('<script src="sync-core.js">', '<script src="native-runtime.js"></script>\n<script src="sync-core.js">');
html = html.replace(/<p class="footnote" id="installLink">[\s\S]*?<\/p>/, '');
await writeFile(path.join(out, 'index.html'), html);
for (const name of ['sync-core.js', 'sync-client.js', 'app-update.js']) await copyFile(path.join(root, name), path.join(out, name));
for (const name of ['manifest.json', 'icon.svg', 'icon-192.png', 'icon-512.png']) await copyFile(path.join(root, 'public', name), path.join(out, name));
await build({ entryPoints: [path.join(mobile, 'runtime.js')], outfile: path.join(out, 'native-runtime.js'), bundle: true,
  format: 'iife', target: 'es2020', platform: 'browser', minify: true, legalComments: 'none' });
console.log('Mobile assets prepared; credentials, cloud worker and development data excluded.');

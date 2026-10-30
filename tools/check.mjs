import { readFile, access, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(await readFile(join(root, 'extension/manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3) throw new Error('Manifest V3 required');
const contentScript = await readFile(join(root, 'extension/content.js'), 'utf8');
if (!contentScript.includes(`const BUILD = '${manifest.version}'`)) throw new Error('Content script build must match manifest version');
const files = [manifest.background.service_worker, manifest.options_ui.page, 'content.js', 'options.js', 'options.css', manifest.side_panel.default_path, 'sidepanel.js', 'sidepanel.css', 'icons/book.svg', ...Object.values(manifest.icons)];
for (const file of files) await access(resolve(root, 'extension', file));
async function checkJS(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await checkJS(path);
    else if (/\.(m?js)$/.test(entry.name)) execFileSync(process.execPath, ['--check', path], { stdio: 'pipe' });
  }
}
await checkJS(join(root, 'extension'));
for (const page of ['options.html', 'sidepanel.html']) {
  const html = await readFile(join(root, 'extension', page), 'utf8');
  if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html) || /\son\w+=/i.test(html)) throw new Error('Inline script violates extension CSP');
}
if (manifest.host_permissions || manifest.content_scripts || manifest.externally_connectable) throw new Error('Unexpected broad or externally accessible permissions');
console.log('PASS: manifest, entry points, icons, JavaScript syntax, CSP and permission boundaries.');

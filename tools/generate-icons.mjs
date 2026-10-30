// Render the code-native book SVG with an existing Chromium installation.
// The extension ships the output PNGs; end users need no rendering tools.
import {mkdir, readFile, writeFile, access, unlink} from 'node:fs/promises';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const work = join(root, '.test-artifacts', 'icon-generation');
await mkdir(join(work, 'temp'), {recursive:true});
process.env.TEMP = join(work, 'temp'); process.env.TMP = process.env.TEMP;
const require = createRequire(import.meta.url);
const {chromium} = require(process.env.PLAYWRIGHT_MODULE_PATH || 'playwright');
const executablePath = process.env.BROWSER_EXECUTABLE;
if (!executablePath) throw new Error('Set BROWSER_EXECUTABLE to an existing Chromium/Edge/Chrome executable.');
await access(executablePath);
const svg = await readFile(join(root, 'extension/icons/book.svg'), 'utf8');
const context = await chromium.launchPersistentContext(join(work, 'profile'), {
  executablePath, headless:true,
  args:[`--disk-cache-dir=${join(work,'cache')}`,`--crash-dumps-dir=${join(work,'crashes')}`,'--disable-breakpad','--disable-component-update']
});
try {
  const page = await context.newPage();
  for (const size of [16,32,48,128]) {
    await page.setViewportSize({width:size,height:size});
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    await page.evaluate(() => document.fonts.ready);
    if (size === 128) {
      const ink = await page.evaluate(() => {
        const text = document.querySelector('text'), style = getComputedStyle(text);
        const canvas = document.createElement('canvas'), context = canvas.getContext('2d');
        context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
        const m = context.measureText(text.textContent), x = Number(text.getAttribute('x')) - m.width / 2;
        const y = Number(text.getAttribute('y'));
        return {left:x-m.actualBoundingBoxLeft,right:x+m.actualBoundingBoxRight,
          top:y-m.actualBoundingBoxAscent,bottom:y+m.actualBoundingBoxDescent};
      });
      if (ink.left < 26 || ink.right > 102 || ink.top < 37 || ink.bottom > 91) {
        throw new Error(`The 译 glyph must stay inside the book pages with padding: ${JSON.stringify(ink)}`);
      }
      await writeFile(join(work, 'glyph-bounds.json'), JSON.stringify(ink,null,2));
    }
    await page.screenshot({path:join(root,`extension/icons/book-${size}.png`),omitBackground:true});
  }
} finally { await context.close(); }
const contentPath = join(root, 'extension/content.js');
const content = await readFile(contentPath, 'utf8');
await writeFile(contentPath, content.replace(/^  const BRAND_SVG = .*;$/m, () => `  const BRAND_SVG = ${JSON.stringify(svg)};`));
for (const size of [16,32,48,128]) await unlink(join(root,`extension/icons/${size}.png`)).catch(error => {if(error.code!=='ENOENT')throw error;});
console.log('Generated open-book + 译 icons at 16/32/48/128 px and synchronized the inline popup logo.');

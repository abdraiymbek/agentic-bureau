// Contact sheets for review: render stills of a composition every --step seconds
// (or at --times) and tile them, labelled with their time, into PNG sheets.
//
//   node scripts/sheet.mjs --comp launch --step 0.5 --out /tmp/sheets
//   node scripts/sheet.mjs --comp launch --format 9x16 --from 8 --to 14 --step 0.25 --out /tmp/s
//   node scripts/sheet.mjs --comp launch --times 1.2,3.4 --out /tmp/s --full   (full-size PNGs only)
//   --only open        build only that launch scene (faster; other scenes are absent)
import { chromium } from 'playwright-core';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from './serve.mjs';

const args = process.argv.slice(2);
const opt = (name, d) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : d;
};
const comp = opt('--comp', 'launch');
const format = opt('--format', '16x9');
const out = path.resolve(opt('--out', 'out/sheets'));
const step = Number(opt('--step', 0.5));
const cols = Number(opt('--cols', format === '9x16' ? 8 : 4));
const rows = Number(opt('--rows', format === '9x16' ? 2 : 4));
const full = args.includes('--full');
fs.mkdirSync(out, { recursive: true });

const SIZE = format === '9x16' ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };
const { server, port } = await startServer();
const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--force-color-profile=srgb'],
});
try {
  const page = await browser.newPage({ viewport: SIZE, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error('[page]', e.message));
  page.on('console', (m) => m.type() === 'error' && console.error('[console]', m.text()));
  const only = opt('--only');
  await page.goto(`http://127.0.0.1:${port}/videos/${comp}/?render&format=${format}${only ? `&only=${only}` : ''}`);
  await page.waitForFunction(() => typeof window.__render === 'function', null, { timeout: 120000 });
  const duration = await page.evaluate(() => window.__duration);
  const from = Number(opt('--from', 0));
  const to = Number(opt('--to', duration));
  const times = opt('--times')
    ? opt('--times').split(',').map(Number)
    : Array.from({ length: Math.floor((to - from) / step + 1e-6) + 1 }, (_, i) => +(from + i * step).toFixed(3)).filter((t) => t < duration);
  const files = [];
  for (const t of times) {
    await page.evaluate(
      ([tt, label]) => {
        window.__render(tt);
        let el = document.getElementById('__sheet_label');
        if (!el) {
          el = document.createElement('div');
          el.id = '__sheet_label';
          el.style.cssText = 'position:fixed;left:0;top:0;z-index:99999;font:600 44px/1 monospace;color:#fff;background:rgba(0,0,0,.7);padding:10px 14px';
          document.body.appendChild(el);
        }
        el.style.display = label ? 'block' : 'none';
        el.textContent = tt.toFixed(2);
      },
      [t, !full],
    );
    const file = path.join(out, `${format}-t${t.toFixed(2)}.png`);
    await page.screenshot({ path: file, clip: { x: 0, y: 0, ...SIZE }, timeout: 180000 });
    files.push([t, file]);
  }
  if (full) {
    files.forEach(([, f]) => console.log(f));
  } else {
    const per = cols * rows;
    const tw = format === '9x16' ? 274 : 484;
    for (let s = 0; s * per < files.length; s++) {
      const chunk = files.slice(s * per, (s + 1) * per);
      const inputs = chunk.flatMap(([, f]) => ['-i', f]);
      const label = chunk
        .map((_, i) => `[${i}]scale=${tw}:-1,pad=iw+4:ih+4:2:2:white[v${i}]`)
        .join(';');
      const pads = chunk.map((_, i) => `[v${i}]`).join('');
      const sheet = path.join(out, `sheet-${format}-${String(s + 1).padStart(2, '0')}.png`);
      const lay = chunk
        .map((_, i) => {
          const x = (i % cols) * tw;
          const y = Math.floor(i / cols);
          return `${x}_${y === 0 ? 0 : Array(y).fill('h0').join('+')}`;
        })
        .join('|');
      const filter =
        chunk.length > 1
          ? `${label};${pads}xstack=inputs=${chunk.length}:layout=${lay}:fill=white`
          : `${label};[v0]null`;
      execFileSync('ffmpeg', ['-v', 'error', '-y', ...inputs, '-filter_complex', filter, sheet]);
      console.log(sheet);
    }
    for (const [, f] of files) fs.rmSync(f);
  }
} finally {
  await browser.close();
  server.close();
}

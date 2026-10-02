// Frame-exact render: drive window.__render(t) in headless Chromium, stream
// frames into ffmpeg, blend sub-frames for motion blur, and mux the soundtrack.
//
//   node scripts/render.mjs                 final: 120 fps → 60 fps with 2-sample blur
//   node scripts/render.mjs --draft         quick: 30 fps, no blur
//   node scripts/render.mjs --still 5.4,9   PNG stills into out/stills/
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';
import { writeSoundtrack } from './audio.mjs';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(DIR, 'out');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const draft = flag('--draft');
const stills = opt('--still');
const WORKERS = Number(opt('--workers') ?? 6);
const OUT_FPS = draft ? 30 : 60;
const SUB = draft ? 1 : 2;
const FPS = OUT_FPS * SUB;

fs.mkdirSync(OUT, { recursive: true });

const { server, port } = await startServer();
const url = `http://127.0.0.1:${port}/videos/trailer/?render`;
const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--force-color-profile=srgb'],
});

async function openPage() {
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error('[page]', e.message));
  page.on('console', (m) => m.type() === 'error' && console.error('[console]', m.text()));
  await page.goto(url);
  await page.evaluate(() => window.__trailer);
  return page;
}

const shot = (page, t, type) =>
  page
    .evaluate((tt) => window.__render(tt), t)
    .then(() => page.screenshot({ type, ...(type === 'jpeg' ? { quality: 96 } : {}), clip: { x: 0, y: 0, width: 1920, height: 1080 } }));

try {
  if (stills) {
    const page = await openPage();
    const dir = opt('--still-dir') ?? path.join(OUT, 'stills');
    fs.mkdirSync(dir, { recursive: true });
    for (const s of stills.split(',')) {
      const file = path.join(dir, `t${Number(s).toFixed(2)}.png`);
      fs.writeFileSync(file, await shot(page, Number(s), 'png'));
      console.log(file);
    }
  } else {
    const page0 = await openPage();
    const duration = await page0.evaluate(() => window.__duration);
    const audioFile = path.join(OUT, 'trailer-audio.wav');
    writeSoundtrack(audioFile, duration);

    const total = Math.round(duration * FPS);
    const file = path.join(DIR, draft ? 'out/omen-flow-trailer-draft.mp4' : 'omen-flow-trailer.mp4');
    const vf = SUB > 1 ? `tmix=frames=${SUB},fps=${OUT_FPS},format=yuv420p` : 'format=yuv420p';
    const ff = spawn(
      'ffmpeg',
      [
        '-y', '-loglevel', 'error',
        '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
        '-i', audioFile,
        '-vf', vf,
        '-c:v', 'libx264', '-preset', draft ? 'veryfast' : 'slow', '-crf', draft ? '22' : '14',
        '-profile:v', 'high', '-tune', 'film', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
        '-c:a', 'aac', '-b:a', '320k',
        '-t', String(duration), '-movflags', '+faststart',
        file,
      ],
      { stdio: ['pipe', 'inherit', 'inherit'] },
    );
    const ffDone = new Promise((res, rej) => ff.on('close', (c) => (c === 0 ? res() : rej(new Error(`ffmpeg exited ${c}`)))));

    const pages = [page0, ...(await Promise.all(Array.from({ length: WORKERS - 1 }, openPage)))];
    const ready = new Map();
    let next = 0;
    let written = 0;
    let wake = null;
    const started = Date.now();

    const worker = async (page) => {
      for (;;) {
        const i = next++;
        if (i >= total) return;
        // Keep the reorder buffer bounded.
        while (i - written > WORKERS * 6) await new Promise((r) => setTimeout(r, 15));
        ready.set(i, await shot(page, i / FPS, 'jpeg'));
        wake?.();
      }
    };
    const writer = async () => {
      while (written < total) {
        const buf = ready.get(written);
        if (!buf) {
          await new Promise((r) => (wake = r));
          continue;
        }
        ready.delete(written);
        if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
        written++;
        if (written % FPS === 0 || written === total) {
          const el = (Date.now() - started) / 1000;
          process.stdout.write(`\r${written}/${total} frames · ${el.toFixed(0)} s elapsed · ~${((el / written) * (total - written)).toFixed(0)} s left   `);
        }
      }
      ff.stdin.end();
    };
    await Promise.all([...pages.map(worker), writer()]);
    await ffDone;
    console.log(`\n${file}`);
  }
} finally {
  await browser.close();
  server.close();
}

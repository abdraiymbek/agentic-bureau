// Frame-exact render: drive window.__render(t) in headless Chromium, stream
// frames into ffmpeg, blend sub-frames for motion blur, and mux the soundtrack.
//
//   node scripts/render.mjs                         trailer, final: 120 fps → 60 fps with 2-sample blur
//                                                   (the launch film uses 4 samples: 240 fps → 60 fps)
//   node scripts/render.mjs --draft                 quick: 30 fps, no blur
//   node scripts/render.mjs --still 5.4,9           PNG stills into out/stills/
//   node scripts/render.mjs --comp launch           the launch film (16:9)
//   node scripts/render.mjs --comp launch --format 9x16
//   node scripts/render.mjs --comp launch --draft --range 4,12   a slice of a draft
//   --only open,pieces                               build only these launch scenes (faster)
//   --silent                                         mux a silent track instead of the score
//   --samples n                                      motion-blur sub-frames per output frame
//   --out path.mp4                                   write the video somewhere else
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from './serve.mjs';
import { writeWav, wav, SR } from './synth.mjs';

const DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(DIR, 'out');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const comp = opt('--comp') ?? 'trailer';
// Scores load only when a video is rendered, so stills never depend on them.
const COMPS = {
  trailer: { page: 'videos/trailer/', file: 'omen-flow-trailer', audio: 'trailer-audio.wav', samples: 2, score: async () => (await import('./audio.mjs')).writeSoundtrack },
  launch: { page: 'videos/launch/', file: 'omen-flow-launch', audio: 'launch-audio.wav', samples: 4, score: async () => (await import('./launch-audio.mjs')).writeLaunchSoundtrack },
};
if (!COMPS[comp]) throw new Error(`unknown --comp ${comp}`);
const format = opt('--format') ?? '16x9';
const vertical = format === '9x16';
const draft = flag('--draft');
const stills = opt('--still');
const range = opt('--range')?.split(',').map(Number);
const WORKERS = Number(opt('--workers') ?? 6);
const OUT_FPS = draft ? 30 : 60;
// Sub-frames per output frame, blended for a 360° shutter (the launch film's
// whip moves need 4 to blur rather than ghost).
const SUB = draft ? 1 : Number(opt('--samples') ?? COMPS[comp].samples);
const FPS = OUT_FPS * SUB;

fs.mkdirSync(OUT, { recursive: true });

const { server, port } = await startServer();
const only = opt('--only');
const url = `http://127.0.0.1:${port}/${COMPS[comp].page}?render&format=${format}${only ? `&only=${only}` : ''}`;
const browser = await chromium.launch({
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--force-color-profile=srgb'],
});

let SIZE = vertical ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };

async function openPage() {
  const page = await browser.newPage({ viewport: SIZE, deviceScaleFactor: 1 });
  page.on('pageerror', (e) => console.error('[page]', e.message));
  page.on('console', (m) => m.type() === 'error' && console.error('[console]', m.text()));
  await page.goto(url);
  await page.waitForFunction(() => typeof window.__render === 'function', null, { timeout: 120000 });
  return page;
}

const shot = (page, t, type) =>
  page
    .evaluate((tt) => window.__render(tt), t)
    .then(() =>
      page.screenshot({ type, ...(type === 'jpeg' ? { quality: 96 } : {}), clip: { x: 0, y: 0, ...SIZE }, timeout: 180000 }),
    );

try {
  if (stills) {
    const page = await openPage();
    const dir = opt('--still-dir') ?? path.join(OUT, 'stills');
    fs.mkdirSync(dir, { recursive: true });
    for (const s of stills.split(',')) {
      const file = path.join(dir, `${comp === 'trailer' ? '' : `${format}-`}t${Number(s).toFixed(2)}.png`);
      fs.writeFileSync(file, await shot(page, Number(s), 'png'));
      console.log(file);
    }
  } else {
    const page0 = await openPage();
    const duration = await page0.evaluate(() => window.__duration);
    let audioFile;
    if (flag('--silent')) {
      audioFile = path.join(OUT, `silence-${process.pid}.wav`);
      writeWav(audioFile, wav(Buffer.alloc(Math.ceil(duration * SR) * 4)));
    } else {
      audioFile = path.join(OUT, COMPS[comp].audio);
      (await COMPS[comp].score())(audioFile, duration);
    }

    const [from, to] = range ?? [0, duration];
    const total = Math.round((to - from) * FPS);
    const name = `${COMPS[comp].file}${vertical ? '-vertical' : ''}`;
    const file = opt('--out') ?? path.join(DIR, draft || range ? `out/${name}-draft.mp4` : `${name}.mp4`);
    // Motion blur: each output frame averages the SUB sub-frames that START at its
    // own time (t, t + 1/FPS, …), never the one before it, so a hard cut on an
    // output frame stays a clean cut instead of a double exposure.
    const vf =
      SUB > 1
        ? `tmix=frames=${SUB},select=eq(mod(n\\,${SUB})\\,${SUB - 1}),setpts=N/(${OUT_FPS}*TB),format=yuv420p`
        : 'format=yuv420p';
    const ff = spawn(
      'ffmpeg',
      [
        '-y', '-loglevel', 'error',
        '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
        '-ss', String(from), '-i', audioFile,
        '-vf', vf,
        '-c:v', 'libx264', '-preset', draft ? 'veryfast' : 'slow', '-crf', draft ? '22' : '14',
        '-profile:v', 'high', '-tune', 'film', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709',
        '-r', String(OUT_FPS),
        '-c:a', 'aac', '-b:a', '320k',
        '-t', String(to - from), '-movflags', '+faststart',
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
        ready.set(i, await shot(page, from + i / FPS, 'jpeg'));
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
    if (flag('--silent')) fs.rmSync(audioFile, { force: true });
    console.log(`\n${file}`);
  }
} finally {
  await browser.close();
  server.close();
}

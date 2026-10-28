// Omen Flow launch film. Every visual property is a pure function of time, so
// the preview and the frame-by-frame render are identical.
//
//   ?format=16x9 (default, 1920 × 1080) or ?format=9x16 (1080 × 1920)
//   ?render     hide the controls and expose window.__render for scripts/render.mjs
//   ?t=12.5     start the preview at a time
import { $, clamp, rng, show, loadIcons } from './lib/core.js';
import { DURATION, BPM, loadScenes, fx } from './scenes/index.js';

const params = new URLSearchParams(location.search);
const FORMAT = params.get('format') === '9x16' ? '9x16' : '16x9';
const portrait = FORMAT === '9x16';
const W = portrait ? 1080 : 1920;
const H = portrait ? 1920 : 1080;
const renderMode = params.has('render');
document.body.classList.toggle('render', renderMode);

const ctx = { W, H, portrait, format: FORMAT, BPM, beat: 60 / BPM, DURATION };

let stageEl;
let F; // finishing layer elements
let SCENES = [];
const mounted = [];

async function boot() {
  stageEl = $('#stage');
  stageEl.style.setProperty('--W', `${W}px`);
  stageEl.style.setProperty('--H', `${H}px`);
  stageEl.classList.add(portrait ? 'portrait' : 'landscape');

  SCENES = await loadScenes(params.get('only'));
  try {
    await loadIcons([...new Set(SCENES.flatMap((s) => s.icons ?? []))]);
  } catch (err) {
    console.error('[icons]', err);
  }

  const style = document.createElement('style');
  style.textContent = SCENES.map((s) => s.css ?? '').join('\n');
  document.head.appendChild(style);

  for (const [i, s] of SCENES.entries()) {
    const root = document.createElement('div');
    root.id = `s-${s.id}`;
    root.className = `scene${s.paper ? ' paper' : ''}`;
    root.style.zIndex = String(s.z ?? i + 1);
    stageEl.appendChild(root);
    mounted.push({ s, root, on: false });
  }

  const fxEl = document.createElement('div');
  fxEl.id = 'fx';
  fxEl.className = 'layer';
  fxEl.innerHTML = `<canvas class="grain" width="${W / 3}" height="${H / 3}"></canvas><div class="vignette"></div><div class="flash"></div><div class="black"></div>`;
  stageEl.appendChild(fxEl);
  const grain = fxEl.querySelector('.grain');
  F = {
    grain,
    gctx: grain.getContext('2d'),
    vignette: fxEl.querySelector('.vignette'),
    flash: fxEl.querySelector('.flash'),
    black: fxEl.querySelector('.black'),
  };
  // Grain is one image re-seeded every 1/120 s (it never loops): white specks
  // at a random alpha on graphite, black specks on Paper. Plain alpha looks like
  // a screen / multiply blend at this strength and composites far faster.
  F.img = F.gctx.createImageData(grain.width, grain.height);

  await document.fonts.ready;
  await Promise.all(
    ['400 16px Geist', '500 16px Geist', '600 16px Geist', '400 16px "IBM Plex Mono"', '500 16px "IBM Plex Mono"'].map((f) =>
      document.fonts.load(f),
    ),
  );

  // Build every scene up front (some create WebGL contexts or measure text).
  for (const m of mounted) {
    m.root.classList.add('on');
    try {
      await m.s.build(m.root, ctx);
    } catch (err) {
      console.error(`[build ${m.s.id}]`, err);
      m.broken = err;
      m.root.innerHTML = `<pre style="position:absolute;inset:40px;font:22px/1.4 monospace;color:#f3928a;white-space:pre-wrap"></pre>`;
      m.root.firstChild.textContent = `${m.s.id} build failed\n\n${err?.stack ?? err}`;
    }
    m.root.classList.remove('on');
  }
  render(0);
}

const visible = (s, t) => t >= s.span[0] && t < s.span[1];

function renderFx(t, top) {
  const f = fx(t, ctx, SCENES);
  const paper = top?.s.paper;
  const g = (f.grain ?? 1) * 0.05;
  if (show(F.grain, g)) {
    const r = rng(Math.round(t * 120) * 7919 + 7);
    const d = F.img.data;
    const c = paper ? 0 : 255;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = d[i + 1] = d[i + 2] = c;
      d[i + 3] = (r() * 255) | 0;
    }
    F.gctx.putImageData(F.img, 0, 0);
  }
  show(F.vignette, (f.vignette ?? 1) * (paper ? 0.25 : 1));
  show(F.flash, f.flash ?? 0);
  show(F.black, f.black ?? 0);
}

export function render(t) {
  t = clamp(t, 0, DURATION);
  let top = null;
  for (const m of mounted) {
    const on = visible(m.s, t);
    if (on !== m.on) {
      m.root.classList.toggle('on', on);
      m.on = on;
    }
    if (on) {
      if (!m.broken) {
        try {
          m.s.render(t, ctx);
        } catch (err) {
          console.error(`[render ${m.s.id} @${t.toFixed(3)}]`, err);
        }
      }
      top = m;
    }
  }
  renderFx(t, top);
}

window.__launch = boot().then(() => {
  window.__render = render;
  window.__duration = DURATION;
  window.__size = { width: W, height: H };
  if (renderMode) return;

  // Interactive preview: play, scrub, and loop with the rendered soundtrack.
  const fit = () => {
    const k = Math.min(innerWidth / W, (innerHeight - 56) / H);
    stageEl.style.transform = `scale(${k})`;
  };
  addEventListener('resize', fit);
  fit();
  const fmt = $('#fmt');
  const other = portrait ? '16x9' : '9x16';
  fmt.textContent = `${FORMAT} → ${other}`;
  fmt.href = `?format=${other}`;
  const audio = new Audio('../out/launch-audio.wav');
  const scrub = $('#scrub');
  const label = $('#time');
  const beatLabel = $('#beat');
  let playing = !params.has('t');
  let t0 = performance.now();
  let tNow = Number(params.get('t') ?? 0);
  const start = () => {
    t0 = performance.now() - tNow * 1000;
    audio.currentTime = tNow;
    audio.play().catch(() => {});
  };
  if (playing) start();
  const frame = () => {
    if (playing) {
      tNow = (performance.now() - t0) / 1000;
      if (tNow > DURATION) {
        tNow = 0;
        start();
      }
    }
    render(tNow);
    scrub.value = String(tNow);
    label.textContent = tNow.toFixed(2);
    const b = Math.floor(tNow / ctx.beat);
    const live = mounted.filter((m) => m.on).map((m) => m.s.id);
    beatLabel.textContent = `${Math.floor(b / 4) + 1}.${(b % 4) + 1} ${live.at(-1) ?? ''}`;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  const toggle = () => {
    playing = !playing;
    if (playing) start();
    else audio.pause();
  };
  scrub.max = String(DURATION);
  scrub.addEventListener('input', () => {
    tNow = Number(scrub.value);
    playing = false;
    audio.pause();
  });
  $('#play').addEventListener('click', toggle);
  addEventListener('keydown', (e) => {
    if (e.code === 'Space') toggle();
    if (e.code === 'ArrowRight' || e.code === 'ArrowLeft') {
      playing = false;
      audio.pause();
      tNow = clamp(tNow + (e.code === 'ArrowRight' ? 1 : -1) / (e.shiftKey ? 2 : 60), 0, DURATION);
    }
  });
});

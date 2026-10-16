// Genera un video del recorrido por la página (sin botones) en formato horizontal y vertical.
// Uso: npm run video            → ambos formatos
//      npm run video -- vertical → solo uno (horizontal | vertical)
import { chromium } from 'playwright';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'video');
const PORT = 4329;
// Misma base que astro.config.mjs ('/Portafolio-Med/' en github.io, '/' con dominio propio)
const BASE = readFileSync(path.join(ROOT, 'astro.config.mjs'), 'utf8').match(/base:\s*['"]([^'"]+)['"]/)?.[1] ?? '/';
const URL = `http://127.0.0.1:${PORT}${BASE}`;
const FPS = 30;

const FORMATS = {
  horizontal: { viewport: { width: 1440, height: 810 }, scale: 4 / 3, isMobile: false }, // 1920×1080
  vertical: { viewport: { width: 432, height: 768 }, scale: 2.5, isMobile: true },       // 1080×1920
};

// Elementos interactivos que no deben salir en el video
const HIDDEN = [
  '.navbar', '.scroll-top', '.hero__actions',
  '.about__arrow', '.office__zoom', '.procedures__cta', '.contact__map-btn',
  '.services__card-btn', '.services__footer-link',
  '.appt__btn-whatsapp', '.appt__btn-call',
  '.footer__link', '.footer__social-btn', '.cookies',
];

const VIDEO_CSS = `
  ${HIDDEN.join(',\n  ')} { display: none !important; }
  *, *::before, *::after { transition: none !important; animation: none !important; }
  html { scroll-behavior: auto !important; scrollbar-width: none; }
  ::-webkit-scrollbar { display: none; }
`;

// Tiempos (segundos)
const HOLD_START = 2.5;
const HOLD_SECTION = 2.2;
const HOLD_INNER = 1.3;
const HOLD_END = 2.5;
const ABOUT_SLIDE = 1.8;  // tiempo por foto del carrusel
const ABOUT_FADE = 0.6;

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function startServer() {
  const proc = spawn(process.execPath, [path.join(ROOT, 'node_modules/astro/bin/astro.mjs'), 'preview', '--port', String(PORT), '--host', '127.0.0.1'], {
    cwd: ROOT,
    stdio: 'ignore',
  });
  return proc;
}

async function waitForServer() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(URL);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`El servidor no respondió en ${URL}`);
}

// Construye la lista de "paradas" de scroll a partir de las secciones de la página
async function buildTimeline(page) {
  const info = await page.evaluate(() => {
    const vh = window.innerHeight;
    const max = document.documentElement.scrollHeight - vh;
    const blocks = [...document.querySelectorAll('section, footer')].map((el) => ({
      id: el.id || el.className.split(' ')[0],
      top: el.getBoundingClientRect().top + window.scrollY,
      height: el.offsetHeight,
    }));
    const about = document.querySelector('.about__img-wrapper');
    const aboutRect = about.getBoundingClientRect();
    return {
      vh,
      max,
      blocks,
      aboutImgTop: aboutRect.top + window.scrollY,
      aboutImgHeight: aboutRect.height,
      aboutCount: document.querySelectorAll('.about__img').length,
    };
  });

  const { vh, max } = info;
  const stops = [];
  const add = (y, hold, extra = {}) => {
    y = Math.round(Math.min(Math.max(y, 0), max));
    const last = stops[stops.length - 1];
    if (last && Math.abs(last.y - y) < vh * 0.15) {
      last.hold = Math.max(last.hold, hold);
      Object.assign(last, extra);
      return;
    }
    stops.push({ y, hold, ...extra });
  };

  add(0, HOLD_START);
  for (const b of info.blocks) {
    if (b.top <= 1) continue;
    add(b.top, b.id === 'about' ? 0.6 : HOLD_SECTION);

    // Parada especial para el carrusel de fotos de "Sobre mí"
    if (b.id === 'about') {
      const imgCenter = info.aboutImgTop + info.aboutImgHeight / 2 - vh / 2;
      const y = info.aboutImgHeight > vh ? info.aboutImgTop - vh * 0.05 : imgCenter;
      add(y, info.aboutCount * ABOUT_SLIDE, { carousel: true });
    }

    // Secciones más altas que la pantalla: paradas repartidas hasta mostrar el final
    if (b.height > vh * 1.05) {
      const end = b.top + b.height - vh;
      const steps = Math.ceil((end - b.top) / (vh * 0.8));
      for (let k = 1; k <= steps; k++) add(b.top + ((end - b.top) * k) / steps, HOLD_INNER);
    }
  }
  add(max, HOLD_END);

  // Convertir paradas en una línea de tiempo de cuadros
  const frames = [];
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i];
    const holdFrames = Math.round(s.hold * FPS);
    for (let f = 0; f < holdFrames; f++) {
      frames.push({ y: s.y, carousel: s.carousel ? f / FPS : null });
    }
    const next = stops[i + 1];
    if (!next) break;
    const dist = Math.abs(next.y - s.y);
    const dur = Math.min(Math.max((dist / vh) * 1.3, 0.9), 3.2);
    const moveFrames = Math.round(dur * FPS);
    for (let f = 1; f <= moveFrames; f++) {
      frames.push({ y: s.y + (next.y - s.y) * easeInOut(f / moveFrames), carousel: s.carousel ? 'end' : null });
    }
  }
  return frames;
}

async function record(name) {
  const fmt = FORMATS[name];
  const width = Math.round(fmt.viewport.width * fmt.scale);
  const height = Math.round(fmt.viewport.height * fmt.scale);
  const out = path.join(OUT_DIR, `recorrido-${name}.mp4`);

  const browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: fmt.viewport,
    deviceScaleFactor: fmt.scale,
    isMobile: fmt.isMobile,
    hasTouch: fmt.isMobile,
  });

  await page.goto(URL, { waitUntil: 'networkidle' });
  await page.addStyleTag({ content: VIDEO_CSS });
  await page.evaluate(async () => {
    document.querySelectorAll('[class*="__animate"]').forEach((el) => el.classList.add('visible'));
    const imgs = [...document.querySelectorAll('img')];
    imgs.forEach((img) => { img.loading = 'eager'; });
    await Promise.all(imgs.map((img) => (img.complete ? img.decode().catch(() => {}) : new Promise((r) => { img.onload = img.onerror = r; }))));
    await document.fonts.ready;
  });

  const frames = await buildTimeline(page);
  const total = frames.length;
  const duration = total / FPS;
  console.log(`[${name}] ${width}×${height}, ${total} cuadros (${duration.toFixed(1)} s)`);

  const ffmpeg = spawn(ffmpegPath, [
    '-y', '-loglevel', 'error',
    '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-',
    '-vf', `scale=${width}:${height}:flags=lanczos,fade=t=in:st=0:d=0.6,fade=t=out:st=${(duration - 0.8).toFixed(2)}:d=0.8`,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-r', String(FPS), '-movflags', '+faststart',
    out,
  ], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((resolve, reject) => {
    ffmpeg.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg terminó con código ${code}`))));
  });

  const aboutCount = await page.locator('.about__img').count();
  for (let i = 0; i < total; i++) {
    const { y, carousel } = frames[i];
    await page.evaluate(({ y, carousel, count, slide, fade }) => {
      window.scrollTo(0, y);

      // Carrusel de "Sobre mí": fundido entre fotos según el tiempo
      if (carousel !== null) {
        const imgs = document.querySelectorAll('.about__img');
        const t = carousel === 'end' ? count * slide : carousel;
        imgs.forEach((img, idx) => {
          let o;
          if (idx === 0) o = 1;
          else {
            const start = idx * slide - fade;
            o = Math.min(Math.max((t - start) / fade, 0), 1);
          }
          img.style.opacity = String(o);
        });
      }

      // Zoom suave de las fotos de las galerías al entrar en pantalla
      const vh = window.innerHeight;
      document.querySelectorAll('.office__img, .procedures__img, .contact__photo-img').forEach((img) => {
        const r = img.parentElement.getBoundingClientRect();
        const p = Math.min(Math.max((vh - r.top) / (vh + r.height), 0), 1);
        img.style.transform = `scale(${(1.08 - 0.08 * p).toFixed(4)})`;
      });
    }, { y, carousel, count: aboutCount, slide: ABOUT_SLIDE, fade: ABOUT_FADE });

    const buf = await page.screenshot({ type: 'jpeg', quality: 92 });
    if (!ffmpeg.stdin.write(buf)) await new Promise((r) => ffmpeg.stdin.once('drain', r));
    if (i % 150 === 0) process.stdout.write(`\r[${name}] ${Math.round((i / total) * 100)}%`);
  }
  ffmpeg.stdin.end();
  await done;
  await browser.close();
  console.log(`\r[${name}] listo → ${path.relative(ROOT, out)}`);
}

const requested = process.argv[2];
const targets = requested ? [requested] : Object.keys(FORMATS);
for (const t of targets) {
  if (!FORMATS[t]) {
    console.error(`Formato desconocido: ${t} (usa horizontal o vertical)`);
    process.exit(1);
  }
}

mkdirSync(OUT_DIR, { recursive: true });
const server = startServer();
try {
  await waitForServer();
  for (const t of targets) await record(t);
} finally {
  server.kill();
}

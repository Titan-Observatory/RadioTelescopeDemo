import { mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';
import { createServer } from 'vite';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const frontendDir = path.resolve(scriptDir, '..');

function argValue(name, fallback) {
  const prefix = `--${name}=`;
  const arg = process.argv.find((item) => item.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : fallback;
}

const fps = Number(argValue('fps', '60'));
const seconds = Number(argValue('seconds', '18'));
const scale = Number(argValue('scale', '2'));
const outDir = path.resolve(frontendDir, argValue('out', 'dist/doppler-frames'));
const frameCount = Math.round(fps * seconds);

if (!Number.isFinite(fps) || fps <= 0) throw new Error(`Invalid --fps: ${fps}`);
if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`Invalid --seconds: ${seconds}`);
if (!Number.isFinite(scale) || scale <= 0) throw new Error(`Invalid --scale: ${scale}`);

async function clearOldFrames(dir) {
  await mkdir(dir, { recursive: true });
  const entries = await readdir(dir);
  await Promise.all(
    entries
      .filter((name) => /^frame-\d+\.png$/.test(name))
      .map((name) => rm(path.join(dir, name))),
  );
}

const server = await createServer({
  root: frontendDir,
  server: {
    host: '127.0.0.1',
    port: 0,
    strictPort: false,
  },
  logLevel: 'error',
});

let browser;
try {
  await clearOldFrames(outDir);
  await server.listen();
  const address = server.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('Vite did not expose a local port');
  const url = `http://127.0.0.1:${address.port}/?render=doppler`;

  browser = await chromium.launch();
  const page = await browser.newPage({
    viewport: { width: 900, height: 540 },
    deviceScaleFactor: scale,
  });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('.doppler-render-target > svg');
  await page.waitForFunction(() => typeof window.__setDopplerRenderTime === 'function');
  const target = page.locator('.doppler-render-target > svg');

  for (let i = 0; i < frameCount; i++) {
    const t = i / fps;
    await page.evaluate(async (timeSeconds) => {
      window.__setDopplerRenderTime?.(timeSeconds);
      await new Promise((resolve) => requestAnimationFrame(resolve));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }, t);
    const frameName = `frame-${String(i).padStart(5, '0')}.png`;
    await target.screenshot({ path: path.join(outDir, frameName), omitBackground: false });
    if (i === 0 || (i + 1) % fps === 0 || i + 1 === frameCount) {
      process.stdout.write(`Rendered ${i + 1}/${frameCount}\n`);
    }
  }

  process.stdout.write(`\nFrames written to ${outDir}\n`);
  process.stdout.write(`Encode example:\n`);
  process.stdout.write(`ffmpeg -framerate ${fps} -i "${path.join(outDir, 'frame-%05d.png')}" -c:v libvpx-vp9 -pix_fmt yuva420p "${path.resolve(frontendDir, 'dist/doppler-loop.webm')}"\n`);
} finally {
  if (browser) await browser.close();
  await server.close();
}

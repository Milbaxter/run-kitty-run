// Shared helpers for scripts/render-*.mjs (store art). Playwright is NOT a project dependency:
//   npm i --prefix /tmp/rkr-render playwright && npx --prefix /tmp/rkr-render playwright install chromium
//   PLAYWRIGHT_DIR=/tmp/rkr-render node scripts/render-icon.mjs
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PORT = Number(process.env.RENDER_PORT || 8092);
export const BASE = process.env.RENDER_BASE || `http://localhost:${PORT}`;

export async function loadPlaywright() {
  const dir = process.env.PLAYWRIGHT_DIR;
  try {
    if (dir) {
      if (!process.env.PLAYWRIGHT_BROWSERS_PATH && fs.existsSync(path.join(dir, 'browsers'))) process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(dir, 'browsers');
      return createRequire(path.join(dir, 'package.json'))('playwright');
    }
    return await import('playwright');
  } catch {
    console.error('Playwright not found. Install it outside the project and set PLAYWRIGHT_DIR (see top of scripts/render-lib.mjs).');
    process.exit(1);
  }
}

// Start the game server on PORT unless something already answers there. Returns a stop() function.
export async function ensureServer() {
  const up = async () => { try { return (await fetch(BASE + '/')).ok; } catch { return false; } };
  if (await up()) return () => {};
  const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: 'ignore' });
  for (let i = 0; i < 50 && !(await up()); i++) await new Promise((r) => setTimeout(r, 100));
  return () => child.kill();
}

// Headless chromium with software WebGL (SwiftShader) so it works on CI boxes without a GPU.
export async function launch(pw) {
  return pw.chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'] });
}

// importmap: the vendored three.js if present, else the CDN (same version as index.html)
export function importmap() {
  const local = fs.existsSync(path.join(ROOT, 'public/vendor/three/build/three.module.js'));
  const three = local ? '/vendor/three/build/three.module.js' : 'https://cdn.jsdelivr.net/npm/three@0.169.0/build/three.module.js';
  return `<script type="importmap">${JSON.stringify({ imports: { three } })}</script>`;
}

// Serve resources/src/* at BASE/__render/* (same origin as the game, so /js/models.js imports work).
export async function routeRenderSources(page) {
  await page.route(BASE + '/__render/**', (route) => {
    const rel = new URL(route.request().url()).pathname.replace(/^\/__render\//, '');
    const file = path.join(ROOT, 'resources/src', rel);
    if (!file.startsWith(path.join(ROOT, 'resources/src')) || !fs.existsSync(file)) return route.fulfill({ status: 404, body: 'nope' });
    let body = fs.readFileSync(file, 'utf8');
    if (file.endsWith('.html')) body = body.replace('<!--IMPORTMAP-->', importmap());
    route.fulfill({ status: 200, contentType: file.endsWith('.html') ? 'text/html' : 'text/javascript', body });
  });
}

export function savePng(dataUrl, out) {
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'));
}

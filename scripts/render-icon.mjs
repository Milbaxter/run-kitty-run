// Renders the app icon, adaptive-icon layers, splash screens, PWA icons and the Play feature graphic from
// resources/src/icon.html (which uses the game's own kitty model). Needs Playwright (see render-lib.mjs) + ImageMagick.
//   PLAYWRIGHT_DIR=/tmp/rkr-render node scripts/render-icon.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, BASE, loadPlaywright, ensureServer, launch, routeRenderSources, savePng } from './render-lib.mjs';

const R = (p) => path.join(ROOT, p);
const magick = (...a) => execFileSync('magick', a, { stdio: 'inherit' });

const pw = await loadPlaywright();
const stop = await ensureServer();
const browser = await launch(pw);
try {
  const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await routeRenderSources(page);
  await page.goto(BASE + '/__render/icon.html');
  await page.waitForFunction(() => window.artReady === true, null, { timeout: 30000 });
  const art = (layer, size) => page.evaluate((o) => window.renderArt(o), { layer, size });

  const tmp = R('resources/.tmp');
  fs.mkdirSync(tmp, { recursive: true });
  savePng(await art('full', 1024), path.join(tmp, 'full.png'));
  savePng(await art('fg', 1024), R('resources/icon-foreground.png'));
  savePng(await art('bg', 1024), path.join(tmp, 'bg.png'));
  savePng(await art('splash', 2732), path.join(tmp, 'splash.png'));
  savePng(await art('feature'), path.join(tmp, 'feature.png'));

  // App Store: opaque, no alpha channel
  const opaque = (src, out, ...resize) => magick(src, ...resize, '-background', '#0d1020', '-alpha', 'remove', '-alpha', 'off', '-strip', out);
  opaque(path.join(tmp, 'full.png'), R('resources/icon.png'));
  fs.copyFileSync(R('resources/icon.png'), R('resources/icon-only.png')); // name @capacitor/assets looks for
  opaque(path.join(tmp, 'bg.png'), R('resources/icon-background.png'));
  opaque(path.join(tmp, 'splash.png'), R('resources/splash.png'));
  fs.copyFileSync(R('resources/splash.png'), R('resources/splash-dark.png'));

  // web / PWA
  const icons = R('public/icons');
  fs.mkdirSync(icons, { recursive: true });
  for (const [name, s] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180], ['favicon-32.png', 32]]) {
    opaque(R('resources/icon.png'), path.join(icons, name), '-filter', 'Lanczos', '-resize', `${s}x${s}`);
  }
  // maskable: adaptive layers composited (kitty inside the safe zone)
  magick(R('resources/icon-background.png'), R('resources/icon-foreground.png'), '-composite', '-resize', '512x512', '-alpha', 'off', '-strip', path.join(icons, 'maskable-512.png'));

  // Google Play: 512 icon + 1024x500 feature graphic
  const play = R('fastlane/metadata/android/en-US/images');
  fs.mkdirSync(play, { recursive: true });
  magick(R('resources/icon.png'), '-filter', 'Lanczos', '-resize', '512x512', '-strip', 'PNG32:' + path.join(play, 'icon.png')); // 32-bit PNG
  opaque(path.join(tmp, 'feature.png'), path.join(play, 'featureGraphic.png'), '-filter', 'Lanczos', '-resize', '1024x500!');
  fs.mkdirSync(R('store'), { recursive: true });

  // preview of the icon at small sizes, for eyeballing
  magick(R('resources/icon.png'), '(', '+clone', '-resize', '180x180', ')', '(', '-clone', '0', '-resize', '60x60', ')', '-delete', '0', '-background', '#222', '+append', R('store/icon-preview-small.png'));
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('icon art written');
} finally {
  await browser.close();
  stop();
}

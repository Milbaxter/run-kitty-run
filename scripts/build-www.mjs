// Copies public/ -> www/ for Capacitor (webDir). Skips dotfiles/dirs (.well-known is server-only).
import { rm, mkdir, readdir, copyFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'public'), dst = join(root, 'www');

async function copyDir(from, to) {
  await mkdir(to, { recursive: true });
  let n = 0;
  for (const e of await readdir(from, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const a = join(from, e.name), b = join(to, e.name);
    if (e.isDirectory()) n += await copyDir(a, b);
    else if (e.isFile()) { await copyFile(a, b); n++; }
  }
  return n;
}

await rm(dst, { recursive: true, force: true });
const n = await copyDir(src, dst);
console.log(`build:www: copied ${n} files public/ -> www/`);

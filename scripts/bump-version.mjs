// Sets the app version everywhere it lives:
//   node scripts/bump-version.mjs 1.2.0            (version name; build number +1)
//   node scripts/bump-version.mjs patch|minor|major
//   node scripts/bump-version.mjs 1.2.0 --build 7  (explicit build number)
// Touches package.json "version", public/js/platform.js APP_VERSION, android versionName/versionCode,
// iOS MARKETING_VERSION/CURRENT_PROJECT_VERSION. CI overrides the build number with the workflow run number.
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = {
  pkg: 'package.json',
  platform: 'public/js/platform.js',
  gradle: 'android/app/build.gradle',
  pbx: 'ios/App/App.xcodeproj/project.pbxproj',
};
const read = (f) => readFile(join(root, f), 'utf8').catch(() => null);

const args = process.argv.slice(2);
const bi = args.indexOf('--build');
const buildArg = bi >= 0 ? Number(args.splice(bi, 2)[1]) : null;
const want = args[0];
if (!want) { console.error('usage: node scripts/bump-version.mjs <x.y.z|patch|minor|major> [--build N]'); process.exit(1); }

const src = Object.fromEntries(await Promise.all(Object.entries(FILES).map(async ([k, f]) => [k, await read(f)])));
const cur = src.platform?.match(/APP_VERSION = '([^']+)'/)?.[1] || JSON.parse(src.pkg).version || '1.0.0';
let next = want;
if (['patch', 'minor', 'major'].includes(want)) {
  const [a, b, c] = cur.split('.').map(Number);
  next = want === 'major' ? `${a + 1}.0.0` : want === 'minor' ? `${a}.${b + 1}.0` : `${a}.${b}.${(c || 0) + 1}`;
}
if (!/^\d+\.\d+\.\d+$/.test(next)) { console.error(`bad version "${next}" (want x.y.z)`); process.exit(1); }

// build.gradle may read the CI build number: versionCode Integer.parseInt(System.getenv('RKR_VERSION_CODE') ?: '1')
const GRADLE_CODE = /(versionCode\s+(?:Integer\.parseInt\(System\.getenv\('RKR_VERSION_CODE'\)\s*\?:\s*')?)(\d+)/;
const curBuild = Number(src.gradle?.match(GRADLE_CODE)?.[2] || src.pbx?.match(/CURRENT_PROJECT_VERSION = (\d+);/)?.[1] || 0);
const build = buildArg ?? curBuild + 1;
if (!Number.isInteger(build) || build < 1) { console.error('bad --build'); process.exit(1); }

const out = {};
if (src.pkg) {
  const { name, ...rest } = JSON.parse(src.pkg);
  const p = { name, version: next, ...rest };
  out.pkg = JSON.stringify(p, null, 2) + '\n';
}
if (src.platform) out.platform = src.platform.replace(/APP_VERSION = '[^']*'/, `APP_VERSION = '${next}'`);
if (src.gradle) out.gradle = src.gradle
  .replace(GRADLE_CODE, (_, pre) => pre + build)
  .replace(/versionName\s+"[^"]*"/, `versionName "${next}"`);
if (src.pbx) out.pbx = src.pbx
  .replace(/MARKETING_VERSION = [^;]+;/g, `MARKETING_VERSION = ${next};`)
  .replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, `CURRENT_PROJECT_VERSION = ${build};`);

for (const [k, text] of Object.entries(out)) {
  if (text !== src[k]) await writeFile(join(root, FILES[k]), text);
  console.log(`${text !== src[k] ? 'updated' : 'unchanged'}  ${FILES[k]}`);
}
console.log(`version ${cur} -> ${next}, build ${build}`);

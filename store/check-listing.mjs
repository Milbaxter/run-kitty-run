// Checks store listing text against App Store / Google Play limits:  node store/check-listing.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const M = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fastlane/metadata');
const LIMITS = {
  'ios/en-US/name.txt': 30, 'ios/en-US/subtitle.txt': 30, 'ios/en-US/keywords.txt': 100, 'ios/en-US/promotional_text.txt': 170,
  'ios/en-US/description.txt': 4000, 'ios/en-US/release_notes.txt': 4000,
  'android/en-US/title.txt': 30, 'android/en-US/short_description.txt': 80, 'android/en-US/full_description.txt': 4000,
  'android/en-US/changelogs/1.txt': 500,
};
let bad = 0;
for (const [f, max] of Object.entries(LIMITS)) {
  const t = fs.readFileSync(path.join(M, f), 'utf8').trim();
  const n = [...t].length;
  const ok = n > 0 && n <= max;
  if (!ok) bad++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${String(n).padStart(4)}/${max}  ${f}`);
}
// Apple 2.3.10: no other mobile platforms in App Store metadata
for (const f of fs.readdirSync(path.join(M, 'ios/en-US'))) {
  if (/android|google play/i.test(fs.readFileSync(path.join(M, 'ios/en-US', f), 'utf8'))) { bad++; console.log('FAIL other platform named in ios/en-US/' + f); }
}
const kw = fs.readFileSync(path.join(M, 'ios/en-US/keywords.txt'), 'utf8').trim();
if (/,\s/.test(kw)) { bad++; console.log('FAIL keywords: no spaces after commas'); }
process.exitCode = bad ? 1 : 0;

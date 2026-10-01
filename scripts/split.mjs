// One-off: split the single-file build into ES modules.
import fs from 'fs';
const src = fs.readFileSync(new URL('./original.html', import.meta.url), 'utf8');
const lines = src.split('\n');
const shared = new Set(['config', 'rng', 'maze', 'enemies', 'sim']);
const mods = [];
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^\/\/ ===== (\w+)\.js =====$/);
  if (m) mods.push({ name: m[1], start: i + 1 });
}
const scriptEnd = lines.findLastIndex((l) => l.startsWith('</script>'));
mods.forEach((m, i) => { m.end = i + 1 < mods.length ? mods[i + 1].start - 1 : scriptEnd; });
const exported = {}; // name -> module
const out = {};
for (const m of mods) {
  let body = lines.slice(m.start, m.end);
  let names = [];
  if (m.name !== 'main') {
    const hdr = body[0].match(/^const \{ (.*) \} = \(\(\) => \{$/);
    names = hdr[1].split(',').map((s) => s.trim());
    // drop header, trailing "return {...};" and "})();"
    while (!body[body.length - 1].startsWith('})();')) body.pop();
    body.pop(); body.pop();
    body = body.slice(1);
  } else {
    // drop wrapping block braces
    const f = body.indexOf('{'); body.splice(f, 1);
    let l = body.length - 1; while (body[l].trim() !== '}') l--; body.splice(l, 1);
  }
  const text = body.join('\n');
  const imports = {};
  for (const [n, from] of Object.entries(exported)) {
    if (new RegExp(`\\b${n}\\b`).test(text)) (imports[from] ||= []).push(n);
  }
  const isShared = shared.has(m.name);
  let head = '';
  if (/\bTHREE\./.test(text)) head += `import * as THREE from 'three';\n`;
  if (m.name === 'main') {
    head += `import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';\nimport { RenderPass } from 'three/addons/postprocessing/RenderPass.js';\nimport { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';\nimport { OutputPass } from 'three/addons/postprocessing/OutputPass.js';\n`;
  }
  for (const [from, ns] of Object.entries(imports)) {
    const path = isShared ? `./${from}.js` : (shared.has(from) ? `./shared/${from}.js` : `./${from}.js`);
    head += `import { ${ns.join(', ')} } from '${path}';\n`;
  }
  const tail = names.length ? `\nexport { ${names.join(', ')} };\n` : '\n';
  out[(isShared ? 'shared/' : '') + m.name + '.js'] = head + '\n' + text.replace(/^\n+/, '') + tail;
  for (const n of names) exported[n] = m.name;
}
for (const [f, t] of Object.entries(out)) fs.writeFileSync(new URL('../public/js/' + f, import.meta.url), t);
// index.html: head up to the module script, then a single module entry
const sIdx = lines.findIndex((l) => l.startsWith('<script type="module">'));
const html = lines.slice(0, sIdx).join('\n') + '\n<script type="module" src="js/main.js"></script>\n</body>\n</html>\n';
fs.writeFileSync(new URL('../public/index.html', import.meta.url), html);
console.log(Object.keys(out).join('\n'));

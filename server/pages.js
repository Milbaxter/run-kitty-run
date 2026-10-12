// Pages the server writes itself (not files in public/). The patch notes page is built from the same list the title
// screen shows (public/js/patchnotes.js), so it never falls behind; it only uses public/site.css, no scripts.
import { PATCH_NOTES } from '../public/js/patchnotes.js';

const SITE = 'https://runkittyrun.fun';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
// '2026-10-07' -> '7 October 2026'
const niceDate = (d) => { const m = /^(\d{4})-(\d\d)-(\d\d)$/.exec(d); return m ? `${+m[3]} ${MONTHS[+m[2] - 1]} ${m[1]}` : d; };

function patchNotesPage() {
  const latest = PATCH_NOTES[0];
  const notes = PATCH_NOTES.map((n) => `<section class="note" id="v${esc(n.version)}">
<h2>Version ${esc(n.version)}: ${esc(n.title)}</h2>
<p class="meta"><time datetime="${esc(n.date)}">${esc(niceDate(n.date))}</time></p>
<ul>
${n.items.map((t) => `<li>${esc(t)}</li>`).join('\n')}
</ul>
</section>`).join('\n');
  const desc = `What's new in Run Kitty Run. Latest: version ${latest.version}, ${latest.title} (${niceDate(latest.date)}). Every update to the free online co-op kitty game, newest first.`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0d1020">
<title>Run Kitty Run patch notes: what's new</title>
<meta name="description" content="${esc(desc)}">
<link rel="canonical" href="${SITE}/patch-notes">
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="apple-touch-icon" href="/icons/icon-180.png">
<meta property="og:type" content="article">
<meta property="og:site_name" content="Run Kitty Run">
<meta property="og:title" content="Run Kitty Run patch notes">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${SITE}/patch-notes">
<meta property="og:image" content="${SITE}/og-image.jpg">
<meta name="twitter:card" content="summary_large_image">
<link rel="stylesheet" href="/site.css">
</head>
<body>
<nav class="top" aria-label="Site">
  <a class="brand" href="/">🐾 Run Kitty Run</a>
  <a href="/about">About</a>
  <a href="/how-to-play">How to play</a>
  <a href="/patch-notes" aria-current="page">Patch notes</a>
  <a href="/">Play</a>
</nav>
<main>
<h1>Run Kitty Run patch notes</h1>
<p class="lede">Everything that changed in Run Kitty Run, newest first. The game updates itself: reload the page and you have the latest version.</p>
<div class="cta">
  <a class="play" href="/">▶ PLAY NOW</a>
  <small>Latest: version ${esc(latest.version)}, ${esc(niceDate(latest.date))}</small>
</div>
${notes}
<nav class="foot" aria-label="Footer"><a href="/">Play</a><a href="/about">About</a><a href="/how-to-play">How to play</a><a href="/warcraft-3-run-kitty-run">Warcraft 3 map</a><a href="/patch-notes">Patch notes</a><a href="/support">Support</a><a href="/terms">Terms of Use</a><a href="/privacy">Privacy Policy</a></nav>
</main>
</body>
</html>
`;
}

// path -> html, built once when the server starts (a deploy restarts it)
const SERVER_PAGES = { '/patch-notes': patchNotesPage() };

export { SERVER_PAGES };

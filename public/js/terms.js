// First-time-online notice: community rules (zero tolerance), links to Terms & Privacy.
// ensureTermsAccepted() resolves true once accepted (remembered in localStorage), false on "Not now".
// Styled with the rkr-* overlay look from ui.js (plus a fallback so it works on its own).

const KEY = 'rkr-terms-v1';
const PROD = 'https://80-47-225-25.nip.io';

const CSS = `
.rkt-modal{position:fixed;inset:0;z-index:60;pointer-events:auto;display:flex;align-items:center;justify-content:center;padding:20px 16px;overflow:auto;
  background:radial-gradient(ellipse at center,rgba(20,8,48,.55),rgba(8,2,22,.85));font-family:system-ui,-apple-system,sans-serif;}
.rkt-box{max-width:480px;width:100%;text-align:center;color:#fff;padding:24px 24px 20px;border-radius:28px;display:flex;flex-direction:column;gap:12px;align-items:center;
  background:linear-gradient(160deg,rgba(52,30,96,.98),rgba(26,12,52,.98)) !important;border:2px solid rgba(255,255,255,.2);box-shadow:0 20px 50px rgba(0,0,0,.5);}
.rkt-box h2{margin:0;font-weight:900;font-size:clamp(26px,4vw,36px) !important;line-height:1.05;color:#fff6d8;}
.rkt-list{margin:0;padding:0;list-style:none;text-align:left;display:flex;flex-direction:column;gap:7px;font-weight:700;font-size:15px;color:#efe7ff;line-height:1.35;}
.rkt-list li{padding-left:28px;position:relative;}
.rkt-list li::before{content:attr(data-i);position:absolute;left:0;}
.rkt-links{font-size:14px;font-weight:700;opacity:.9;}
.rkt-links a{color:#ffcf5a;}
.rkt-row{display:flex;gap:12px;justify-content:center;flex-wrap:wrap;margin-top:4px;}
.rkt-row .rkr-btn{font-size:18px;padding:10px 22px 12px;}
.rkt-fb{font:inherit;font-weight:900;font-size:17px;min-height:46px;padding:10px 22px;border-radius:18px;border:3px solid #3a1650;color:#3a1650;cursor:pointer;
  background:linear-gradient(180deg,#fff2a8,#ffc93c 55%,#ff9a3d);}
.rkt-fb.rkr-alt{background:linear-gradient(180deg,#e3f7ff,#7fd8ff 55%,#5b9dff);}
`;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

// In the native apps the page runs from capacitor://localhost or https://localhost, so link to the live site.
function pageUrl(name) {
  const local = location.protocol === 'capacitor:' || location.hostname === 'localhost';
  return local ? `${PROD}/${name}` : name;
}

function accepted() {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}

let pending = null;

function ensureTermsAccepted() {
  if (accepted()) return Promise.resolve(true);
  if (pending) return pending;
  pending = new Promise((resolve) => {
    if (!document.getElementById('rkt-css')) {
      const st = el('style');
      st.id = 'rkt-css';
      st.textContent = CSS;
      document.head.appendChild(st);
    }
    const modal = el('div', 'rkt-modal');
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    const box = el('div', 'rkr-glass rkt-box');
    const h = el('h2', null, 'PLAYING ONLINE');
    const list = el('ul', 'rkt-list');
    for (const [i, t] of [
      ['😺', 'Be kind. Online lobbies are for everyone.'],
      ['🚫', 'No offensive names or messages. We have zero tolerance for abusive players or objectionable content.'],
      ['🚩', 'Tap a player\'s name in chat to block or report them. Reported players can be muted or removed.'],
    ]) { const li = el('li', null, t); li.dataset.i = i; list.appendChild(li); }
    const links = el('div', 'rkt-links');
    const a1 = el('a', null, 'Terms of Use');
    a1.href = pageUrl('terms.html');
    const a2 = el('a', null, 'Privacy Policy');
    a2.href = pageUrl('privacy.html');
    for (const a of [a1, a2]) { a.target = '_blank'; a.rel = 'noopener'; }
    links.append('By continuing you agree to the ', a1, ' and ', a2, '.');
    // reuse the game's big button look when ui.js styles are present
    const hasGameCss = [...document.styleSheets].some((s) => { try { return [...s.cssRules].some((r) => r.selectorText === '.rkr-btn'); } catch { return false; } });
    const btnCls = hasGameCss ? 'rkr-btn' : 'rkt-fb';
    const yes = el('button', btnCls, 'I AGREE');
    const no = el('button', btnCls + ' rkr-alt', 'NOT NOW');
    const row = el('div', 'rkt-row');
    row.append(yes, no);
    box.append(h, list, links, row);
    modal.appendChild(box);
    const done = (ok) => {
      if (ok) { try { localStorage.setItem(KEY, '1'); } catch {} }
      modal.remove();
      pending = null;
      resolve(ok);
    };
    yes.addEventListener('click', () => done(true));
    no.addEventListener('click', () => done(false));
    // keys must not reach the game while the notice is up
    modal.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') done(false); });
    modal.addEventListener('keyup', (e) => e.stopPropagation());
    (document.getElementById('ui') || document.body).appendChild(modal);
    setTimeout(() => yes.focus(), 30);
  });
  return pending;
}

export { ensureTermsAccepted };

import { CFG } from './shared/config.js';
import { TOUCH } from './device.js';
import { PATCH_NOTES } from './patchnotes.js';

// Run Kitty Run — UI layer (DOM + injected CSS + 2D canvas minimap).
// Contract notes / interpretations:
// - onStart / onRestart / onResume callbacks: the UI also hides its own panel right after calling them
//   (hideTitle/hidePause/hideGameOver are idempotent, so main may call them too).
// - Keyboard handled by the UI: title (1 / 2 / Enter / Space, arrows or W/S to switch), pause (Enter),
//   game over (Enter / Space, armed after a short delay). P/Esc/M remain main.js's job.
// - setHUD may be called every frame: DOM nodes are cached and only written when values change.
// - Minimap maps world x -> canvas x, world z -> canvas y (camera: +Z is screen-down).

const FONT = "'Baloo 2','Fredoka','Trebuchet MS','Segoe UI',system-ui,sans-serif";

function hexColor(c) {
  if (typeof c === 'string') return c;
  return '#' + ((c >>> 0) & 0xffffff).toString(16).padStart(6, '0');
}
function rgba(c, a) {
  const n = typeof c === 'string' ? parseInt(c.replace('#', ''), 16) : (c >>> 0);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function fmtTime(t) {
  t = Math.max(0, Math.floor(t || 0));
  const m = Math.floor(t / 60), s = t % 60;
  return m + ':' + String(s).padStart(2, '0');
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

// ---------- inline SVG icons ----------
const INK = '#2b1840';
const ICONS = {
  cat: `<svg viewBox="0 0 40 40" class="rkr-cat"><path d="M5 4 L15 12 Q20 10.5 25 12 L35 4 L33.5 20 Q34 34.5 20 35.5 Q6 34.5 6.5 20 Z" fill="currentColor" stroke="${INK}" stroke-width="2.6" stroke-linejoin="round"/><path d="M8.5 9 L13 12.6 L9.6 15.5 Z M31.5 9 L27 12.6 L30.4 15.5 Z" fill="#ff9ec4"/><g class="rkr-eyes"><ellipse cx="14.3" cy="21.5" rx="2.3" ry="3.1" fill="${INK}"/><ellipse cx="25.7" cy="21.5" rx="2.3" ry="3.1" fill="${INK}"/><circle cx="15" cy="20.4" r=".9" fill="#fff"/><circle cx="26.4" cy="20.4" r=".9" fill="#fff"/></g><g class="rkr-xeyes" stroke="${INK}" stroke-width="2" stroke-linecap="round"><path d="M12 19 L16.6 23.6 M16.6 19 L12 23.6 M23.4 19 L28 23.6 M28 19 L23.4 23.6"/></g><path d="M18.2 26.4 L21.8 26.4 L20 28.6 Z" fill="#ff6f9f" stroke="${INK}" stroke-width="1" stroke-linejoin="round"/><path d="M20 28.6 Q18.5 31 16.5 30 M20 28.6 Q21.5 31 23.5 30" fill="none" stroke="${INK}" stroke-width="1.3" stroke-linecap="round"/><path d="M3 25 L11 26 M3.5 29 L11 28 M37 25 L29 26 M36.5 29 L29 28" stroke="${INK}" stroke-width="1.1" stroke-linecap="round" opacity=".55"/></svg>`,
  boots: `<svg viewBox="0 0 40 40"><path d="M3 15 Q9 9 15 14 Q10 13 8 17 Q12 15 15 18 Q10 18 9 21 Z" fill="#e8fbff" stroke="#2a8fb0" stroke-width="1.6" stroke-linejoin="round"/><path d="M15 6 L27 6 L27 22 Q36 23 37 30 L37 34 L13 34 L13 26 Q15 20 15 6 Z" fill="#33d6ff" stroke="#0b5d79" stroke-width="2.4" stroke-linejoin="round"/><path d="M13 30 L37 30" stroke="#0b5d79" stroke-width="2"/><path d="M15 10 L27 10" stroke="#fff" stroke-width="2" opacity=".7"/></svg>`,
  heart: `<svg viewBox="0 0 40 36"><path d="M20 33 C8 24 3 18 3 11.5 C3 6 7 3 11.5 3 C15 3 18 5 20 8.5 C22 5 25 3 28.5 3 C33 3 37 6 37 11.5 C37 18 32 24 20 33 Z" fill="#ff5c93" stroke="#8c1640" stroke-width="2.6" stroke-linejoin="round"/><path d="M9 10 Q10 7 13 6.5" stroke="#fff" stroke-width="2.4" fill="none" stroke-linecap="round" opacity=".8"/></svg>`,
  heartEmpty: `<svg viewBox="0 0 40 36"><path d="M20 33 C8 24 3 18 3 11.5 C3 6 7 3 11.5 3 C15 3 18 5 20 8.5 C22 5 25 3 28.5 3 C33 3 37 6 37 11.5 C37 18 32 24 20 33 Z" fill="rgba(255,255,255,.08)" stroke="rgba(255,255,255,.45)" stroke-width="2.6" stroke-dasharray="4 3" stroke-linejoin="round"/></svg>`,
  shield: `<svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="16" fill="rgba(90,170,255,.35)" stroke="#5aaaff" stroke-width="2.6"/><circle cx="20" cy="20" r="11" fill="none" stroke="#bfe0ff" stroke-width="1.4" opacity=".7"/><path d="M11 14 Q14 9 20 8.5" stroke="#fff" stroke-width="2.6" fill="none" stroke-linecap="round"/></svg>`,
  wolf: `<svg viewBox="0 0 40 40"><path d="M4 5 L14 13 L26 13 L36 5 L34 22 L26 34 L20 37 L14 34 L6 22 Z" fill="#7d8096" stroke="${INK}" stroke-width="2.4" stroke-linejoin="round"/><path d="M14 27 L20 37 L26 27 Q20 24 14 27 Z" fill="#c9cad6"/><path d="M11 19 L17 21 L12 23 Z M29 19 L23 21 L28 23 Z" fill="#ff3b3b"/><circle cx="20" cy="29" r="2" fill="${INK}"/></svg>`,
  revive: `<svg viewBox="0 0 40 40"><ellipse cx="20" cy="31" rx="16" ry="6" fill="rgba(255,179,71,.25)" stroke="#ffb347" stroke-width="2.2" stroke-dasharray="4 3"/><path d="M13 30 L13 15 Q13 7 20 7 Q27 7 27 15 L27 30 L24.5 27.5 L22 30 L20 27.5 L18 30 L15.5 27.5 Z" fill="rgba(255,255,255,.85)" stroke="#b9a4ff" stroke-width="1.6" stroke-linejoin="round"/><circle cx="17.3" cy="15.5" r="1.6" fill="${INK}"/><circle cx="22.7" cy="15.5" r="1.6" fill="${INK}"/></svg>`,
  paw: `<svg viewBox="0 0 40 40"><ellipse cx="20" cy="27" rx="9" ry="7.5"/><ellipse cx="8.5" cy="17" rx="3.6" ry="4.6" transform="rotate(-20 8.5 17)"/><ellipse cx="15.5" cy="10" rx="3.6" ry="4.8" transform="rotate(-6 15.5 10)"/><ellipse cx="24.5" cy="10" rx="3.6" ry="4.8" transform="rotate(6 24.5 10)"/><ellipse cx="31.5" cy="17" rx="3.6" ry="4.6" transform="rotate(20 31.5 17)"/></svg>`,
  clock: `<svg viewBox="0 0 40 40"><circle cx="20" cy="21" r="14" fill="rgba(255,255,255,.12)" stroke="currentColor" stroke-width="3"/><path d="M20 12 L20 21 L26 25" stroke="currentColor" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M16 4 L24 4" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>`,
  eye: `<svg viewBox="0 0 40 40"><path d="M3 20 Q20 4 37 20 Q20 36 3 20 Z" fill="none" stroke="currentColor" stroke-width="3.2" stroke-linejoin="round"/><circle cx="20" cy="20" r="6" fill="currentColor"/><path class="rkr-eslash" d="M7 33 L33 7" stroke="#ff5c7a" stroke-width="3.6" stroke-linecap="round"/></svg>`,
  menu: `<svg viewBox="0 0 40 40"><path d="M9 12 H31 M9 20 H31 M9 28 H31" stroke="currentColor" stroke-width="3.6" stroke-linecap="round"/></svg>`,
  speaker: `<svg viewBox="0 0 40 40"><path d="M6 15 L13 15 L22 7 L22 33 L13 25 L6 25 Z" fill="currentColor" stroke-linejoin="round"/><g class="rkr-waves" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"><path d="M27 14 Q31 20 27 26"/><path d="M31 10 Q38 20 31 30"/></g><g class="rkr-slash" stroke="#ff5c7a" stroke-width="3.4" stroke-linecap="round"><path d="M27 14 L37 26 M37 14 L27 26"/></g></svg>`,
};

const CSS = `
.rkr-root{font-family:${FONT};color:#fff;-webkit-font-smoothing:antialiased;user-select:none;-webkit-user-select:none;}
.rkr-root *{box-sizing:border-box;}
.rkr-root svg{display:block;}
.rkr-hidden{display:none !important;}

/* ---------------- HUD ---------------- */
.rkr-hud{position:absolute;inset:0;pointer-events:none;transition:opacity .4s;}
.rkr-hud.rkr-off{opacity:0;}
.rkr-tl{position:absolute;left:16px;top:14px;display:flex;flex-direction:column;gap:10px;align-items:flex-start;}
.rkr-lvlrow{display:flex;gap:8px;align-items:center;}
.rkr-level{position:relative;padding:4px 16px 6px;border-radius:16px;font-weight:900;font-size:22px;letter-spacing:.04em;
  background:linear-gradient(180deg,#ffcf5a,#ff8a3d);color:#4a1d06;border:3px solid #4a1d06;
  box-shadow:0 4px 0 #4a1d06,0 8px 18px rgba(0,0,0,.35);text-shadow:0 1px 0 rgba(255,255,255,.55);}
.rkr-level small{font-size:13px;margin-right:4px;opacity:.8;}
.rkr-level.rkr-pop{animation:rkr-pop .5s cubic-bezier(.2,1.6,.4,1);}
.rkr-timer{display:flex;align-items:center;gap:6px;padding:4px 12px;border-radius:14px;font-weight:800;font-size:18px;
  background:rgba(20,10,40,.55);border:2px solid rgba(255,255,255,.18);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);
  font-variant-numeric:tabular-nums;color:#e9e2ff;}
.rkr-timer svg{width:18px;height:18px;color:#cdbfff;}
.rkr-cards{display:flex;flex-direction:column;gap:8px;}
.rkr-cards.rkr-many{gap:4px;}
/* HUD toggle (hides everything but the corner buttons) + touch-only menu button */
.rkr-hudbtn,.rkr-menubtn{width:42px;height:42px;padding:8px;border-radius:14px;background:rgba(20,10,40,.55);border:2px solid rgba(255,255,255,.18);
  color:#fff;cursor:pointer;pointer-events:auto;}
.rkr-hudbtn .rkr-eslash{display:none;}
.rkr-hud.rkr-min .rkr-hudbtn .rkr-eslash{display:inline;}
.rkr-hud.rkr-min .rkr-tl,.rkr-hud.rkr-min .rkr-tc,.rkr-hud.rkr-min .rkr-map,.rkr-hud.rkr-min .rkr-scores,.rkr-hud.rkr-min .rkr-hint{display:none;}
.rkr-menubtn{display:none;}
html.rkr-touch .rkr-menubtn{display:block;}
html.rkr-touch .rkr-hint,html.rkr-touch .rkr-desk,html.rkr-touch .rkr-keyhint{display:none !important;}
.rkr-touchonly{display:none;}
html.rkr-touch .rkr-touchonly{display:block;}
.rkr-touchhint{font-weight:800;font-size:15px;color:#efe7ff;text-align:center;opacity:.9;}
.rkr-overlay{touch-action:pan-y;}
.rkr-scores{position:absolute;right:16px;top:58px;min-width:150px;max-width:220px;padding:6px 10px;border-radius:12px;
  background:rgba(10,4,30,.32);font-size:13px;font-weight:800;opacity:.85;pointer-events:none;}
.rkr-scores .rkr-sh{font-size:10px;letter-spacing:.14em;color:#ffcf5a;opacity:.9;margin-bottom:2px;}
.rkr-scores .rkr-sr{display:flex;gap:8px;align-items:center;line-height:1.5;}
.rkr-scores .rkr-sr span:first-child{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.rkr-scores .rkr-sr.rkr-me{text-decoration:underline;text-underline-offset:3px;}
.rkr-scores .rkr-best{opacity:.65;font-size:11px;margin-top:2px;}
.rkr-cards.rkr-many .rkr-card{zoom:.68;}
.rkr-card{--pc:#ffb347;position:relative;display:flex;align-items:center;gap:10px;min-width:210px;padding:8px 12px 8px 8px;border-radius:18px;
  background:linear-gradient(135deg,rgba(30,16,60,.72),rgba(30,16,60,.5));border:2px solid rgba(255,255,255,.14);
  box-shadow:inset 4px 0 0 var(--pc),0 6px 16px rgba(0,0,0,.3);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);
  transition:transform .25s,border-color .25s;}
.rkr-card .rkr-head{width:44px;height:44px;flex:none;color:var(--pc);filter:drop-shadow(0 2px 0 rgba(0,0,0,.35));}
.rkr-xeyes{display:none;}
.rkr-card.rkr-down .rkr-eyes{display:none;}
.rkr-card.rkr-down .rkr-xeyes{display:inline;}
.rkr-card.rkr-down{border-color:rgba(255,70,90,.8);animation:rkr-downpulse 1s ease-in-out infinite;}
.rkr-card.rkr-down .rkr-head{filter:grayscale(.6) drop-shadow(0 2px 0 rgba(0,0,0,.35));transform:rotate(-12deg);}
.rkr-cbody{display:flex;flex-direction:column;gap:3px;min-width:0;flex:1;}
.rkr-crow{display:flex;align-items:center;gap:8px;}
.rkr-name{font-weight:900;font-size:17px;color:var(--pc);text-shadow:0 2px 0 rgba(0,0,0,.45);white-space:nowrap;}
.rkr-status{font-size:11px;font-weight:900;letter-spacing:.08em;padding:1px 7px;border-radius:999px;background:#38d97a;color:#073a1c;}
.rkr-down .rkr-status{background:#ff3b5c;color:#fff;animation:rkr-blink .6s steps(2) infinite;}
.rkr-hearts{display:flex;gap:2px;margin-left:auto;}
.rkr-hearts span{width:18px;height:16px;}
.rkr-hearts span.rkr-new{animation:rkr-pop .5s cubic-bezier(.2,1.6,.4,1);}
.rkr-boots{display:flex;align-items:center;gap:4px;font-weight:800;font-size:13px;color:#9ff0ff;font-variant-numeric:tabular-nums;}
.rkr-boots svg{width:18px;height:18px;}
.rkr-boots.rkr-pop{animation:rkr-pop .5s cubic-bezier(.2,1.6,.4,1);}
.rkr-shield{display:flex;align-items:center;gap:5px;height:14px;}
.rkr-shield svg{width:14px;height:14px;}
.rkr-sbar{flex:1;height:7px;border-radius:9px;background:rgba(255,255,255,.12);overflow:hidden;}
.rkr-sfill{height:100%;width:100%;border-radius:9px;background:linear-gradient(90deg,#5aaaff,#bfe6ff);transform-origin:left center;box-shadow:0 0 8px #5aaaff;}

.rkr-tc{position:absolute;left:50%;top:12px;transform:translateX(-50%);display:flex;gap:10px;align-items:center;}
  background:linear-gradient(180deg,rgba(40,20,70,.8),rgba(40,20,70,.55));border:3px solid #ffc93c;color:#ffe08a;
  box-shadow:0 0 0 3px rgba(0,0,0,.25),0 6px 20px rgba(255,190,40,.25);text-shadow:0 2px 0 #6b3d00;font-variant-numeric:tabular-nums;}
.rkr-resc{display:flex;align-items:center;gap:5px;padding:4px 12px;border-radius:999px;font-weight:800;font-size:16px;
  background:rgba(40,20,70,.6);border:2px solid rgba(185,164,255,.6);color:#ddd2ff;font-variant-numeric:tabular-nums;}
.rkr-resc svg{width:22px;height:22px;}

.rkr-tr{position:absolute;right:16px;top:14px;display:flex;gap:8px;align-items:center;}
.rkr-mute{width:42px;height:42px;padding:8px;border-radius:14px;background:rgba(20,10,40,.55);border:2px solid rgba(255,255,255,.18);
  color:#fff;backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);pointer-events:auto;cursor:pointer;}
.rkr-mute:hover{border-color:rgba(255,255,255,.5);}
.rkr-mute .rkr-slash{display:none;}
.rkr-mute.rkr-muted{color:#ff9fb2;border-color:rgba(255,92,122,.6);}
.rkr-mute.rkr-muted .rkr-slash{display:inline;}
.rkr-mute.rkr-muted .rkr-waves{display:none;}
.rkr-hint{font-size:12px;font-weight:800;color:rgba(255,255,255,.7);display:flex;gap:6px;align-items:center;}

/* ---------------- minimap ---------------- */
.rkr-map{position:absolute;right:16px;bottom:16px;width:190px;height:190px;border-radius:50%;
  background:radial-gradient(circle at 50% 40%,rgba(50,30,90,.75),rgba(15,8,30,.82));
  border:3px solid rgba(255,255,255,.85);box-shadow:0 0 0 4px rgba(60,30,110,.6),0 10px 30px rgba(0,0,0,.45),inset 0 0 24px rgba(0,0,0,.5);}
.rkr-map canvas{position:absolute;inset:0;width:100%;height:100%;border-radius:50%;}

/* ---------------- banner & toasts ---------------- */
.rkr-banner{position:absolute;left:0;right:0;top:30%;display:flex;flex-direction:column;align-items:center;text-align:center;pointer-events:none;opacity:0;}
.rkr-banner .rkr-bt{font-weight:900;font-size:clamp(44px,9vw,110px);line-height:1;letter-spacing:.03em;color:#fff6d8;
  -webkit-text-stroke:3px #3a1650;paint-order:stroke fill;
  text-shadow:0 6px 0 #3a1650,0 10px 0 rgba(0,0,0,.25),0 0 40px rgba(255,200,90,.6);}
.rkr-banner .rkr-bs{margin-top:10px;font-weight:800;font-size:clamp(16px,2.6vw,26px);color:#ffe7f2;padding:4px 18px;border-radius:999px;
  background:rgba(40,16,70,.55);text-shadow:0 2px 0 rgba(0,0,0,.4);}
.rkr-banner.rkr-in{animation:rkr-slam .55s cubic-bezier(.2,1.4,.4,1) forwards;}
.rkr-banner.rkr-out{animation:rkr-flyout .45s cubic-bezier(.6,0,.8,.4) forwards;}
.rkr-toasts{position:absolute;left:50%;bottom:26px;transform:translateX(-50%);display:flex;flex-direction:column-reverse;align-items:center;gap:8px;pointer-events:none;}
.rkr-toast{--tc:#fff;display:flex;align-items:center;gap:8px;padding:7px 18px 8px;border-radius:999px;font-weight:800;font-size:17px;white-space:nowrap;
  background:rgba(25,12,50,.82);border:2px solid var(--tc);color:#fff;box-shadow:0 0 18px var(--tc-glow, rgba(255,255,255,.2)),0 6px 16px rgba(0,0,0,.35);
  animation:rkr-toastin .35s cubic-bezier(.2,1.5,.4,1);}
.rkr-toast i{width:10px;height:10px;border-radius:50%;background:var(--tc);box-shadow:0 0 8px var(--tc);}
.rkr-toast.rkr-bye{animation:rkr-toastout .4s ease-in forwards;}

/* ---------------- overlays ---------------- */
.rkr-overlay{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;pointer-events:auto;overflow:auto;padding:20px 16px;}
.rkr-title{background:radial-gradient(ellipse at 50% 35%,rgba(70,30,120,.3),rgba(14,6,34,.72) 75%),linear-gradient(180deg,rgba(20,8,48,.15),rgba(8,2,22,.6));
  animation:rkr-fadein .6s ease-out;}
.rkr-title.rkr-leaving{animation:rkr-fadeout .45s ease-in forwards;pointer-events:none;}
.rkr-tcol{display:flex;flex-direction:column;align-items:center;gap:18px;max-width:980px;width:100%;margin:auto;}
.rkr-logo{position:relative;display:flex;flex-wrap:wrap;justify-content:center;gap:0 .35em;font-weight:900;font-size:clamp(46px,9.5vw,118px);line-height:1.02;
  animation:rkr-logoin .9s cubic-bezier(.2,1.5,.4,1);}
.rkr-word{display:flex;}
.rkr-l{position:relative;display:inline-block;color:#3a1650;-webkit-text-stroke:.16em #3a1650;
  text-shadow:0 .09em 0 #3a1650,0 .16em 0 rgba(0,0,0,.3),0 0 .4em rgba(255,120,200,.35);
  animation:rkr-bounce 2.2s cubic-bezier(.35,0,.25,1) infinite;animation-delay:calc(var(--i) * 90ms);transform-origin:50% 100%;}
.rkr-l::after{content:attr(data-c);position:absolute;left:0;top:0;-webkit-text-stroke:0;text-shadow:none;color:transparent;
  background:linear-gradient(180deg,#fff7c2 0%,#ffd04a 38%,#ff8a3d 62%,#ff4f9a 100%);-webkit-background-clip:text;background-clip:text;}
.rkr-word.rkr-kitty .rkr-l::after{background:linear-gradient(180deg,#fff0fb 0%,#ffa8de 40%,#c77dff 70%,#7b5cff 100%);-webkit-background-clip:text;background-clip:text;}
.rkr-logocat{position:absolute;width:.9em;height:.9em;right:-.55em;top:-.45em;color:#ffb347;transform:rotate(14deg);animation:rkr-wiggle 2.4s ease-in-out infinite;
  filter:drop-shadow(0 .05em 0 rgba(0,0,0,.35));}
.rkr-sub{max-width:640px;text-align:center;font-weight:700;font-size:clamp(15px,2vw,21px);color:#f1e8ff;line-height:1.35;text-shadow:0 2px 0 rgba(0,0,0,.45);}
.rkr-sub b{color:#ffcf5a;}
.rkr-btns{display:flex;gap:18px;flex-wrap:wrap;justify-content:center;}
.rkr-btn{pointer-events:auto;cursor:pointer;font-family:inherit;font-weight:900;font-size:clamp(18px,2.4vw,26px);letter-spacing:.04em;
  padding:14px 30px 16px;border-radius:22px;border:4px solid #3a1650;color:#3a1650;
  background:linear-gradient(180deg,#fff2a8,#ffc93c 55%,#ff9a3d);box-shadow:0 7px 0 #3a1650,0 14px 26px rgba(0,0,0,.4);
  transition:transform .12s,box-shadow .12s,filter .12s;display:flex;flex-direction:column;align-items:center;gap:2px;}
.rkr-btn small{font-size:.55em;letter-spacing:.02em;opacity:.75;font-weight:800;}
.rkr-btn.rkr-alt{background:linear-gradient(180deg,#e3f7ff,#7fd8ff 55%,#5b9dff);}
.rkr-btn:hover,.rkr-btn.rkr-sel{transform:translateY(-3px) scale(1.04);filter:brightness(1.08);box-shadow:0 10px 0 #3a1650,0 18px 30px rgba(0,0,0,.45),0 0 0 5px rgba(255,255,255,.35);}
.rkr-btn:active{transform:translateY(4px) scale(.98);box-shadow:0 3px 0 #3a1650,0 6px 14px rgba(0,0,0,.4);}
.rkr-btn:focus{outline:none;}
.rkr-btn .rkr-kk{display:inline-block;margin-right:8px;padding:0 7px;border-radius:7px;font-size:.7em;background:rgba(58,22,80,.15);border:2px solid rgba(58,22,80,.35);}
.rkr-info{display:flex;gap:16px;flex-wrap:wrap;justify-content:center;width:100%;}
.rkr-panel{background:linear-gradient(160deg,rgba(255,255,255,.14),rgba(255,255,255,.05));border:2px solid rgba(255,255,255,.2);border-radius:22px;
  padding:14px 18px;backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);box-shadow:0 10px 30px rgba(0,0,0,.35);}
.rkr-panel h3{margin:0 0 10px;font-size:15px;font-weight:900;letter-spacing:.14em;color:#ffcf5a;text-transform:uppercase;}
.rkr-how{flex:1 1 380px;max-width:520px;}
.rkr-items{display:grid;grid-template-columns:1fr 1fr;gap:8px 14px;}
.rkr-item{display:flex;align-items:center;gap:9px;font-size:14px;font-weight:700;color:#efe7ff;line-height:1.15;}
.rkr-item b{display:block;font-size:15px;color:#fff;}
.rkr-ico{width:34px;height:34px;flex:none;display:flex;align-items:center;justify-content:center;border-radius:12px;background:rgba(0,0,0,.25);padding:4px;}
.rkr-ico svg{width:100%;height:100%;}
.rkr-ctl{flex:0 1 380px;}
.rkr-notes{flex:1 1 100%;max-width:916px;max-height:230px;overflow:auto;text-align:left;}
.rkr-note{margin-bottom:10px;}
.rkr-note .rkr-nh{display:flex;gap:10px;align-items:baseline;font-weight:900;font-size:15px;}
.rkr-note .rkr-nv{color:#ffcf5a;}
.rkr-note .rkr-nd{opacity:.5;font-size:12px;font-weight:700;}
.rkr-note ul{margin:4px 0 0;padding-left:20px;font-size:13.5px;font-weight:700;color:#efe7ff;line-height:1.45;}
@media (min-width:1100px){
  .rkr-tcol{max-width:1180px;}
  .rkr-info{flex-wrap:nowrap;align-items:stretch;}
  .rkr-how{flex:1 1 0;max-width:none;}
  .rkr-how .rkr-items{grid-template-columns:1fr;}
  .rkr-ctl{flex:0 0 auto;}
  .rkr-notes{flex:1.2 1 0;max-width:none;max-height:330px;}
}
.rkr-notes h3 + .rkr-note .rkr-nh::after{content:'NEW';font-size:10px;letter-spacing:.12em;background:#ff5c93;color:#fff;border-radius:6px;padding:1px 6px;}
.rkr-ctlgrid{display:grid;grid-template-columns:auto auto;gap:10px 18px;align-items:center;}
.rkr-ctlgrid .rkr-lab{font-weight:800;font-size:14px;color:#efe7ff;}
.rkr-ctlgrid .rkr-lab em{font-style:normal;font-weight:900;}
.rkr-keys{display:grid;grid-template-columns:repeat(3,auto);gap:3px;justify-content:start;}
.rkr-keys .rkr-k:nth-child(1){grid-column:2;grid-row:1;}
.rkr-keys .rkr-k:nth-child(2){grid-column:1;grid-row:2;}
.rkr-keys .rkr-k:nth-child(3){grid-column:2;grid-row:2;}
.rkr-keys .rkr-k:nth-child(4){grid-column:3;grid-row:2;}
.rkr-k{display:inline-flex;align-items:center;justify-content:center;min-width:28px;height:28px;padding:0 7px;border-radius:8px;
  font-family:inherit;font-weight:900;font-size:14px;color:#3a1650;background:linear-gradient(180deg,#ffffff,#ddd4f2);
  border:2px solid #3a1650;box-shadow:0 3px 0 #3a1650;line-height:1;}
.rkr-k.rkr-wide{min-width:46px;}
.rkr-krow{display:flex;gap:4px;align-items:center;flex-wrap:wrap;}
.rkr-paws{position:absolute;inset:0;overflow:hidden;pointer-events:none;}
.rkr-paws span{position:absolute;width:44px;height:44px;opacity:.09;fill:#fff;animation:rkr-drift linear infinite;}
.rkr-paws svg{width:100%;height:100%;}
.rkr-foot{font-size:13px;font-weight:700;color:rgba(255,255,255,.55);display:flex;gap:8px;align-items:center;}

.rkr-dim{background:radial-gradient(ellipse at center,rgba(20,8,48,.45),rgba(8,2,22,.78));animation:rkr-fadein .3s ease-out;}
.rkr-glass{position:relative;min-width:300px;max-width:440px;width:100%;padding:26px 28px 24px;border-radius:30px;text-align:center;
  background:linear-gradient(160deg,rgba(255,255,255,.2),rgba(255,255,255,.06));border:2px solid rgba(255,255,255,.3);
  backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);box-shadow:0 20px 60px rgba(0,0,0,.5),inset 0 1px 0 rgba(255,255,255,.4);
  animation:rkr-cardin .5s cubic-bezier(.2,1.4,.4,1);display:flex;flex-direction:column;align-items:center;gap:14px;margin:auto;}
.rkr-glass h2{margin:0;font-weight:900;font-size:clamp(40px,6vw,60px);line-height:1;color:#fff6d8;-webkit-text-stroke:2px #3a1650;paint-order:stroke fill;
  text-shadow:0 5px 0 #3a1650,0 0 30px rgba(255,200,90,.45);letter-spacing:.03em;}
.rkr-glass .rkr-gcat{width:74px;height:74px;color:#ffb347;margin-bottom:-6px;animation:rkr-wiggle 2.4s ease-in-out infinite;}
.rkr-gameover h2{color:#ffd6e3;text-shadow:0 5px 0 #3a1650,0 0 30px rgba(255,80,120,.55);}
.rkr-gsub{font-weight:700;font-size:16px;color:#efe7ff;opacity:.9;}
.rkr-stats{width:100%;display:flex;flex-direction:column;gap:7px;}
.rkr-stat{display:flex;align-items:center;gap:10px;padding:7px 12px;border-radius:14px;background:rgba(0,0,0,.22);font-weight:800;font-size:16px;
  opacity:0;transform:translateX(-14px);transition:opacity .35s,transform .35s cubic-bezier(.2,1.5,.4,1);}
.rkr-stat.rkr-show{opacity:1;transform:none;}
.rkr-stat .rkr-ico{width:30px;height:30px;}
.rkr-stat .rkr-sl{flex:1;text-align:left;color:#e2d8ff;}
.rkr-stat .rkr-sv{font-size:22px;font-weight:900;color:#fff;font-variant-numeric:tabular-nums;}
.rkr-keyhint{font-size:13px;font-weight:700;color:rgba(255,255,255,.65);display:flex;gap:6px;align-items:center;}

/* ---------------- keyframes ---------------- */
@keyframes rkr-bounce{0%,58%,100%{transform:translateY(0) scale(1,1);}
  8%{transform:translateY(0) scale(1.12,.86);}20%{transform:translateY(-.2em) scale(.92,1.1);}
  32%{transform:translateY(0) scale(1.08,.9);}42%{transform:translateY(-.05em) scale(.98,1.03);}50%{transform:translateY(0) scale(1,1);}}
@keyframes rkr-logoin{0%{transform:scale(.3) translateY(-80px);opacity:0;}100%{transform:none;opacity:1;}}
@keyframes rkr-wiggle{0%,100%{transform:rotate(14deg);}50%{transform:rotate(-8deg) translateY(-3px);}}
@keyframes rkr-fadein{from{opacity:0;}to{opacity:1;}}
@keyframes rkr-fadeout{to{opacity:0;transform:scale(1.04);}}
@keyframes rkr-pop{0%{transform:scale(1);}40%{transform:scale(1.28);}100%{transform:scale(1);}}
@keyframes rkr-blink{0%{opacity:1;}100%{opacity:.35;}}
@keyframes rkr-downpulse{0%,100%{box-shadow:inset 4px 0 0 #ff3b5c,0 0 0 0 rgba(255,59,92,.0),0 6px 16px rgba(0,0,0,.3);}
  50%{box-shadow:inset 4px 0 0 #ff3b5c,0 0 18px 4px rgba(255,59,92,.55),0 6px 16px rgba(0,0,0,.3);}}
@keyframes rkr-slam{0%{opacity:0;transform:scale(2.4);filter:blur(14px);}60%{opacity:1;transform:scale(.93);filter:blur(0);}
  80%{transform:scale(1.04);}100%{opacity:1;transform:scale(1);filter:blur(0);}}
@keyframes rkr-flyout{0%{opacity:1;transform:none;filter:blur(0);}100%{opacity:0;transform:translateY(-60px) scale(.75);filter:blur(10px);}}
@keyframes rkr-toastin{0%{opacity:0;transform:translateY(20px) scale(.7);}100%{opacity:1;transform:none;}}
@keyframes rkr-toastout{to{opacity:0;transform:translateY(-12px) scale(.9);}}
@keyframes rkr-cardin{0%{opacity:0;transform:translateY(40px) scale(.85);}100%{opacity:1;transform:none;}}
@keyframes rkr-drift{0%{transform:translateY(0) rotate(var(--r));}100%{transform:translateY(-120vh) rotate(var(--r));}}

@media (max-width:760px){
  .rkr-map{width:140px;height:140px;right:10px;bottom:10px;}
  .rkr-tl{left:10px;top:10px;}
  .rkr-card{min-width:170px;padding:6px 10px 6px 6px;}
  .rkr-card .rkr-head{width:34px;height:34px;}
  .rkr-name{font-size:15px;}
  .rkr-resc{display:none;}
  .rkr-hint{display:none;}
  .rkr-items{grid-template-columns:1fr;}
}
@media (max-height:640px){ .rkr-tcol{gap:10px;} .rkr-how,.rkr-ctl{padding:10px 14px;} }
@media (prefers-reduced-motion:reduce){ .rkr-l,.rkr-logocat,.rkr-paws span{animation:none !important;} }
/* phones in landscape: compact everything */
@media (max-height:500px){
  .rkr-map{width:110px;height:110px;}
  .rkr-tl{top:8px;gap:6px;}
  .rkr-tr{top:8px;}
  .rkr-scores{top:52px;}
  .rkr-cards .rkr-card{zoom:.75;}
  .rkr-tcol{gap:8px;}
  .rkr-logo{zoom:.6;}
  .rkr-sub{font-size:13px !important;}
  .rkr-info{display:none !important;}
  .rkr-btn{font-size:17px;}
  .rkr-glass{padding:14px 18px 14px;}
  .rkr-glass h2{font-size:34px !important;}
  .rkr-glass .rkr-gcat{width:44px;height:44px;}
  .rkr-stats{gap:2px;}
}
/* notches / rounded corners (after the base rules so these win) */
.rkr-tl{left:max(16px,env(safe-area-inset-left));}
.rkr-tr{right:max(16px,env(safe-area-inset-right));}
.rkr-scores{right:max(16px,env(safe-area-inset-right));}
.rkr-map{right:max(16px,env(safe-area-inset-right));bottom:max(16px,env(safe-area-inset-bottom));}
@media (max-width:760px){ .rkr-map{right:max(10px,env(safe-area-inset-right));bottom:max(10px,env(safe-area-inset-bottom));} }
`;

function injectStyle() {
  if (document.getElementById('rkr-ui-style')) return;
  const st = document.createElement('style');
  st.id = 'rkr-ui-style';
  st.textContent = CSS;
  document.head.appendChild(st);
}

function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
}

function restartAnim(node, cls) {
  node.classList.remove(cls);
  void node.offsetWidth; // reflow so the animation restarts (only on value changes)
  node.classList.add(cls);
}

// ---------------------------------------------------------------------------

function createUI(root) {
  injectStyle();
  root.classList.add('rkr-root');

  const state = { title: false, pause: false, gameOver: false };
  let onStartCb = null, onResumeCb = null, onRestartCb = null;
  // Title menu order (data-p = mode: 3 online, 1 solo, 2 local co-op); keys 1/2/3 follow this order.
  const TITLE_ORDER = [3, 1, 2];
  let titleSel = 3;
  let gameOverArmedAt = 0;

  // ================= HUD =================
  const hud = el('div', 'rkr-hud rkr-off');
  const tl = el('div', 'rkr-tl');
  const lvlRow = el('div', 'rkr-lvlrow');
  const levelEl = el('div', 'rkr-level', '<small>LEVEL</small><span>1</span>');
  const levelNum = levelEl.querySelector('span');
  const timerEl = el('div', 'rkr-timer', ICONS.clock + '<span>0:00</span>');
  const timerTxt = timerEl.querySelector('span');
  lvlRow.append(levelEl, timerEl);
  const cardsEl = el('div', 'rkr-cards');
  tl.append(lvlRow, cardsEl);

  const tc = el('div', 'rkr-tc');
  const rescEl = el('div', 'rkr-resc', ICONS.revive + '<span>0</span>');
  const rescTxt = rescEl.querySelector('span');
  rescEl.title = 'Rescues';
  tc.append(rescEl);

  const tr = el('div', 'rkr-tr');
  const hintEl = el('div', 'rkr-hint', '<span class="rkr-k">P</span>pause <span class="rkr-k">H</span>hud <span class="rkr-k">M</span><span class="rkr-snd">mute</span>');
  const muteEl = el('div', 'rkr-mute', ICONS.speaker);
  const hudBtn = el('div', 'rkr-hudbtn', ICONS.eye);
  hudBtn.title = 'Show / hide the HUD (H)';
  const menuBtn = el('div', 'rkr-menubtn', ICONS.menu);
  menuBtn.title = 'Menu';
  tr.append(hintEl, hudBtn, muteEl, menuBtn);

  const mapEl = el('div', 'rkr-map');
  const mapCanvas = document.createElement('canvas');
  mapEl.appendChild(mapCanvas);

  const scoresEl = el('div', 'rkr-scores');
  hud.append(tl, tc, tr, mapEl, scoresEl);
  // HUD on/off (remembered); phones start with it off
  let hudMin = TOUCH;
  try { const v = localStorage.getItem('rkr-hud'); if (v) hudMin = v === 'min'; } catch { /* ignore */ }
  function setHudMin(v) {
    hudMin = v;
    hud.classList.toggle('rkr-min', v);
    try { localStorage.setItem('rkr-hud', v ? 'min' : 'full'); } catch { /* ignore */ }
  }
  hud.classList.toggle('rkr-min', hudMin);
  hudBtn.addEventListener('click', () => setHudMin(!hudMin));
  let menuHandler = null;
  menuBtn.addEventListener('click', () => { if (menuHandler) menuHandler(); });

  const bannerEl = el('div', 'rkr-banner', '<div class="rkr-bt"></div><div class="rkr-bs"></div>');
  const bannerT = bannerEl.querySelector('.rkr-bt');
  const bannerS = bannerEl.querySelector('.rkr-bs');
  const toastsEl = el('div', 'rkr-toasts');

  root.append(hud, bannerEl, toastsEl);

  // ---- HUD state cache ----
  const H = {
    level: null, timeSec: null, rescues: null,
    cards: [], lastNow: 0, visible: false,
  };

  function makeCard() {
    const c = el('div', 'rkr-card',
      `<div class="rkr-head">${ICONS.cat}</div>
       <div class="rkr-cbody">
         <div class="rkr-crow"><span class="rkr-name"></span><span class="rkr-status">ALIVE</span><span class="rkr-hearts"></span></div>
         <div class="rkr-crow"><span class="rkr-boots">${ICONS.boots}<span>+0%</span></span></div>
         <div class="rkr-shield rkr-hidden">${ICONS.shield}<div class="rkr-sbar"><div class="rkr-sfill"></div></div></div>
       </div>`);
    const refs = {
      root: c,
      name: c.querySelector('.rkr-name'),
      status: c.querySelector('.rkr-status'),
      hearts: c.querySelector('.rkr-hearts'),
      boots: c.querySelector('.rkr-boots'),
      bootsTxt: c.querySelector('.rkr-boots > span'),
      shieldRow: c.querySelector('.rkr-shield'),
      shieldFill: c.querySelector('.rkr-sfill'),
      v: { name: null, color: null, alive: null, lives: null, speed: null, shield: null },
    };
    cardsEl.appendChild(c);
    return refs;
  }

  function updateCard(card, p) {
    const v = card.v;
    if (p.name !== v.name) { v.name = p.name; card.name.textContent = p.name; }
    if (p.color !== v.color) { v.color = p.color; card.root.style.setProperty('--pc', hexColor(p.color)); }
    const alive = !!p.alive;
    if (alive !== v.alive) {
      v.alive = alive;
      card.root.classList.toggle('rkr-down', !alive);
      card.status.textContent = alive ? 'ALIVE' : 'DOWN';
    }
    const lives = p.lives | 0;
    if (lives !== v.lives) {
      const gained = v.lives != null && lives > v.lives;
      v.lives = lives;
      const slots = Math.max(CFG.MAX_EXTRA_LIVES, lives);
      let h = '';
      for (let i = 0; i < slots; i++) {
        const filled = i < lives;
        h += `<span class="${filled && gained && i === lives - 1 ? 'rkr-new' : ''}">${filled ? ICONS.heart : ICONS.heartEmpty}</span>`;
      }
      card.hearts.innerHTML = h;
      card.hearts.title = lives + ' extra ' + (lives === 1 ? 'life' : 'lives');
    }
    const speed = Math.round(((p.speedMult || 1) - 1) * 100);
    if (speed !== v.speed) {
      const up = v.speed != null && speed > v.speed;
      v.speed = speed;
      card.bootsTxt.textContent = (speed >= 0 ? '+' : '') + speed + '% speed';
      if (up) restartAnim(card.boots, 'rkr-pop');
    }
    const sh = Math.max(0, p.shield || 0);
    const shq = sh > 0 ? Math.max(1, Math.round(sh / CFG.SHIELD_TIME * 100)) : 0;
    if (shq !== v.shield) {
      if ((shq > 0) !== (v.shield > 0)) card.shieldRow.classList.toggle('rkr-hidden', shq === 0);
      v.shield = shq;
      card.shieldFill.style.transform = `scaleX(${Math.min(1, shq / 100)})`;
    }
  }

  function setHUD(d) {
    if (!d) return;
    cardsEl.classList.toggle('rkr-many', (d.players || []).length > 4);
    if (!H.visible) { H.visible = true; hud.classList.remove('rkr-off'); }
    const now = performance.now();
    const dt = H.lastNow ? Math.min(0.1, (now - H.lastNow) / 1000) : 0;
    H.lastNow = now;

    if (d.level !== H.level) {
      const changed = H.level != null;
      H.level = d.level;
      levelNum.textContent = d.level;
      if (changed) restartAnim(levelEl, 'rkr-pop');
    }
    const ts = Math.floor(d.time || 0);
    if (ts !== H.timeSec) { H.timeSec = ts; timerTxt.textContent = fmtTime(ts); }

    const rs = d.rescues | 0;
    if (rs !== H.rescues) {
      const up = H.rescues != null && rs > H.rescues;
      H.rescues = rs;
      rescTxt.textContent = rs;
      if (up) restartAnim(rescEl, 'rkr-pop');
    }

    const ps = d.players || [];
    while (H.cards.length < ps.length) H.cards.push(makeCard());
    while (H.cards.length > ps.length) { const c = H.cards.pop(); c.root.remove(); }
    for (let i = 0; i < ps.length; i++) updateCard(H.cards[i], ps[i]);
  }
  function diffRound(shown, target) {
    // count toward target: floor when rising, ceil when falling, so the final value is exact.
    return shown <= target ? Math.floor(shown + 1e-6) : Math.ceil(shown - 1e-6);
  }

  // ================= minimap =================
  const M = {
    cssSize: 0, dpr: 0, ctx: mapCanvas.getContext('2d'),
    staticCanvas: document.createElement('canvas'), staticFor: null, sizeDirty: true,
    colorById: new Map(),
  };
  function measureMap() { M.sizeDirty = true; }
  window.addEventListener('resize', measureMap);

  function ensureMapSize() {
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    if (!M.sizeDirty && dpr === M.dpr) return false;
    M.sizeDirty = false;
    const size = mapEl.clientWidth || 190;
    M.cssSize = size; M.dpr = dpr;
    const px = Math.round(size * dpr);
    mapCanvas.width = px; mapCanvas.height = px;
    M.staticCanvas.width = px; M.staticCanvas.height = px;
    M.staticFor = null;
    return true;
  }

  function buildStatic(ld) {
    const S = M.cssSize, dpr = M.dpr;
    const g = M.staticCanvas.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, M.staticCanvas.width, M.staticCanvas.height);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cx = S / 2, cy = S / 2;
    const outer = ld.outerRadius || 20;
    const sc = (S / 2 - 9) / outer;
    M.scale = sc;

    // corridor bands (one rectangle per leg, alternating per loop)
    const W = ld.corridorWidth || 6, h = W / 2;
    for (const l of ld.legs || []) {
      const s0 = -h, s1 = l.len + h;
      const pt = (sv, v) => [cx + (l.ox + l.ux * sv + l.nx * v) * sc, cy + (l.oz + l.uz * sv + l.nz * v) * sc];
      g.beginPath();
      g.moveTo(...pt(s0, -h)); g.lineTo(...pt(s1, -h)); g.lineTo(...pt(s1, h)); g.lineTo(...pt(s0, h)); g.closePath();
      g.fillStyle = l.loop % 2 ? 'rgba(140,110,220,.16)' : 'rgba(110,200,170,.13)';
      g.fill();
    }
    // safe corners
    g.fillStyle = 'rgba(255,240,200,.38)';
    for (const c of ld.safeCorners || []) g.fillRect(cx + (c.x - h) * sc, cy + (c.z - h) * sc, W * sc, W * sc);
    // center goal glow
    const r0 = (ld.centerRadius || CFG.CENTER_RADIUS) * sc;
    const grd = g.createRadialGradient(cx, cy, 0, cx, cy, r0 * 1.1);
    grd.addColorStop(0, 'rgba(255,250,210,.95)');
    grd.addColorStop(0.45, 'rgba(255,200,90,.6)');
    grd.addColorStop(1, 'rgba(255,120,200,0)');
    g.fillStyle = grd;
    g.beginPath(); g.arc(cx, cy, r0 * 1.1, 0, Math.PI * 2); g.fill();

    // walls
    const lw = Math.max(1.6, CFG.WALL_THICKNESS * sc * 1.2);
    g.lineCap = 'round';
    g.strokeStyle = 'rgba(0,0,0,.45)';
    g.lineWidth = lw + 2;
    strokeWalls(g, ld, cx, cy, sc);
    g.strokeStyle = '#efe6ff';
    g.lineWidth = lw;
    strokeWalls(g, ld, cx, cy, sc);
  }
  function strokeWalls(g, ld, cx, cy, sc) {
    g.beginPath();
    for (const w of ld.walls || []) {
      g.moveTo(cx + w.ax * sc, cy + w.az * sc);
      g.lineTo(cx + w.bx * sc, cy + w.bz * sc);
    }
    g.stroke();
  }

  const ENEMY_COL = { patroller: '#ff4b4b', wanderer: '#ff7a33', orbiter: '#ff3d9a', sweeper: '#d81e1e' };
  const ITEM_COL = { boots: '#33e0ff', life: '#ff6fa8', shield: '#5aaaff' };

  function updateMinimap(ld, sim) {
    if (!ld) return;
    const resized = ensureMapSize();
    if (resized || M.staticFor !== ld) { buildStatic(ld); M.staticFor = ld; }
    const g = M.ctx, S = M.cssSize, dpr = M.dpr, sc = M.scale, cx = S / 2, cy = S / 2;
    const t = performance.now() / 1000;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, mapCanvas.width, mapCanvas.height);
    g.drawImage(M.staticCanvas, 0, 0);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);

    // pulsing center
    const R0 = (ld.centerRadius || CFG.CENTER_RADIUS) * sc;
    g.beginPath();
    g.arc(cx, cy, R0 * (0.35 + 0.15 * Math.sin(t * 3)), 0, Math.PI * 2);
    g.fillStyle = 'rgba(255,255,230,.55)';
    g.fill();
    if (!sim) return;

    // items
    const items = sim.items || [];
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.taken) continue;
      const x = cx + it.x * sc, y = cy + it.z * sc;
      g.fillStyle = ITEM_COL[it.type] || '#fff';
      {
        const r = 3 + 0.6 * Math.sin(t * 5 + i);
        g.beginPath();
        if (it.type === 'boots') { g.rect(x - r * .75, y - r * .75, r * 1.5, r * 1.5); }
        else if (it.type === 'life') { g.moveTo(x, y + r); g.lineTo(x - r, y - r * .2); g.arc(x - r / 2, y - r * .3, r / 2, Math.PI, 0); g.arc(x + r / 2, y - r * .3, r / 2, Math.PI, 0); g.closePath(); }
        else { g.arc(x, y, r * .85, 0, Math.PI * 2); }
        g.fill();
        g.lineWidth = 1; g.strokeStyle = 'rgba(255,255,255,.85)'; g.stroke();
      }
    }

    // player colors by id
    const players = sim.players || [];
    M.colorById.clear();
    for (const p of players) M.colorById.set(p.id, p.color);

    // revive circles
    const circles = sim.circles || [];
    for (let i = 0; i < circles.length; i++) {
      const c = circles[i];
      const col = M.colorById.has(c.playerId) ? M.colorById.get(c.playerId) : 0xffffff;
      const x = cx + c.x * sc, y = cy + c.z * sc;
      const ph = (t * 1.4 + i * 0.3) % 1;
      g.beginPath(); g.arc(x, y, 3 + ph * 8, 0, Math.PI * 2);
      g.strokeStyle = rgba(col, 1 - ph); g.lineWidth = 2; g.stroke();
      g.beginPath(); g.arc(x, y, 3.2, 0, Math.PI * 2);
      g.fillStyle = rgba(col, 0.55 + 0.45 * Math.sin(t * 8)); g.fill();
      g.lineWidth = 1.2; g.strokeStyle = '#fff'; g.stroke();
    }

    // enemies
    const en = sim.enemies || [];
    for (let i = 0; i < en.length; i++) {
      const e = en[i];
      const x = cx + e.x * sc, y = cy + e.z * sc;
      g.beginPath(); g.arc(x, y, 2.6, 0, Math.PI * 2);
      g.fillStyle = ENEMY_COL[e.type] || '#ff4b4b'; g.fill();
      g.lineWidth = 0.8; g.strokeStyle = 'rgba(40,0,0,.8)'; g.stroke();
    }

    // players
    for (let i = 0; i < players.length; i++) {
      const p = players[i];
      if (p.alive === false) continue;
      const x = cx + p.x * sc, y = cy + p.z * sc;
      const col = hexColor(p.color);
      g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2);
      g.fillStyle = rgba(p.color, 0.25 + 0.1 * Math.sin(t * 6 + i)); g.fill();
      g.beginPath(); g.arc(x, y, 4.2, 0, Math.PI * 2);
      g.fillStyle = col; g.fill();
      g.lineWidth = 1.8; g.strokeStyle = '#fff'; g.stroke();
    }
  }

  // ================= banner & toast =================
  let bannerTimers = [];
  function banner(title, subtitle, ms) {
    ms = ms || 1800;
    bannerTimers.forEach(clearTimeout); bannerTimers = [];
    bannerT.textContent = title || '';
    bannerS.textContent = subtitle || '';
    bannerS.classList.toggle('rkr-hidden', !subtitle);
    bannerEl.classList.remove('rkr-out');
    restartAnim(bannerEl, 'rkr-in');
    bannerTimers.push(setTimeout(() => {
      bannerEl.classList.remove('rkr-in');
      bannerEl.classList.add('rkr-out');
    }, Math.max(400, ms)));
  }

  function toast(text, color) {
    const c = color == null ? '#ffffff' : hexColor(color);
    const t = el('div', 'rkr-toast');
    t.style.setProperty('--tc', c);
    t.style.setProperty('--tc-glow', rgba(c, 0.35));
    t.append(el('i'), document.createTextNode(text));
    toastsEl.appendChild(t);
    while (toastsEl.children.length > 5) toastsEl.firstChild.remove();
    setTimeout(() => {
      t.classList.add('rkr-bye');
      setTimeout(() => t.remove(), 420);
    }, 2600);
  }

  // ================= title =================
  let titleEl = null, titleBtns = [];
  function notesHtml() {
    return PATCH_NOTES.map((n) => `<div class="rkr-note"><div class="rkr-nh"><span class="rkr-nv">v${esc(n.version)}</span><span>${esc(n.title)}</span><span class="rkr-nd">${esc(n.date)}</span></div><ul>${n.items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul></div>`).join('');
  }
  function buildTitle() {
    const o = el('div', 'rkr-overlay rkr-title');
    const paws = el('div', 'rkr-paws');
    for (let i = 0; i < 14; i++) {
      const s = el('span', null, ICONS.paw);
      s.style.left = (i * 7.3 + (i % 3) * 2) % 100 + '%';
      s.style.top = 100 + (i * 37) % 60 + '%';
      s.style.setProperty('--r', ((i * 53) % 70 - 35) + 'deg');
      s.style.animationDuration = 18 + (i * 7) % 14 + 's';
      s.style.animationDelay = -((i * 3.1) % 20) + 's';
      const sz = 30 + (i * 13) % 30;
      s.style.width = s.style.height = sz + 'px';
      paws.appendChild(s);
    }
    let li = 0;
    const word = (w, cls) => `<span class="rkr-word ${cls || ''}">${[...w].map((ch) => `<span class="rkr-l" style="--i:${li++}" data-c="${ch}">${ch}</span>`).join('')}</span>`;
    const item = (icon, name, desc) => `<div class="rkr-item"><div class="rkr-ico">${icon}</div><div><b>${name}</b>${desc}</div></div>`;
    o.innerHTML = `
      <div class="rkr-tcol">
        <div class="rkr-logo">${word('RUN')}${word('KITTY', 'rkr-kitty')}<span style="position:relative">${word('RUN')}<span class="rkr-logocat">${ICONS.cat}</span></span></div>
        <div class="rkr-sub">Reach the <b>heart of the labyrinth</b>. Don't touch the wolves. <b>Never leave a kitty behind.</b></div>
        <div class="rkr-btns">
          <button class="rkr-btn" data-p="3"><span><span class="rkr-kk">1</span>MULTIPLAYER</span><small>online, up to 8 kitties</small></button>
          <button class="rkr-btn" data-p="1"><span><span class="rkr-kk">2</span>SINGLE PLAYER</span><small>solo run</small></button>
          <button class="rkr-btn rkr-alt rkr-desk" data-p="2"><span><span class="rkr-kk">3</span>LOCAL CO-OP</span><small>2 players, one keyboard</small></button>
        </div>
        <div class="rkr-touchonly rkr-touchhint">Hold your thumb on the screen: your kitty follows it. Tap to run to a spot.</div>
        <div class="rkr-info rkr-desk">
          <div class="rkr-panel rkr-how"><h3>How to play</h3>
            <div class="rkr-items">
              ${item(ICONS.wolf, 'Wolves', 'one touch and you\'re down')}
              ${item(ICONS.revive, 'Revive circle', 'run over a friend\'s circle')}
              ${item(ICONS.boots, 'Speed boots', '+6% speed (one pair max)')}
              ${item(ICONS.heart, 'Extra life', 'one automatic revive')}
              ${item(ICONS.shield, 'Shield', '4 seconds of safety')}
            </div>
          </div>
          <div class="rkr-panel rkr-ctl"><h3>Controls</h3>
            <div class="rkr-ctlgrid">
              <div class="rkr-keys"><span class="rkr-k">W</span><span class="rkr-k">A</span><span class="rkr-k">S</span><span class="rkr-k">D</span></div>
              <div class="rkr-lab"><em style="color:${hexColor(0xffb347)}">Player 1</em><br>move</div>
              <div class="rkr-krow"><span class="rkr-k rkr-wide">Mouse</span></div>
              <div class="rkr-lab"><em style="color:${hexColor(0x6ec6ff)}">Player 2</em><br>click to run there · hold to steer</div>
              <div class="rkr-krow"><span class="rkr-k">M</span></div><div class="rkr-lab">sound on / off</div>
              <div class="rkr-krow"><span class="rkr-k">P</span><span class="rkr-k rkr-wide">Esc</span></div><div class="rkr-lab">pause</div>
              <div class="rkr-krow"><span class="rkr-k rkr-wide">Enter</span></div><div class="rkr-lab">chat (online)</div>
              <div class="rkr-krow"><span class="rkr-k">H</span></div><div class="rkr-lab">show / hide the HUD</div>
            </div>
          </div>
          <div class="rkr-panel rkr-notes"><h3>What's new</h3>${notesHtml()}</div>
        </div>
        <div class="rkr-foot rkr-desk">Press <span class="rkr-k">1</span>, <span class="rkr-k">2</span> or <span class="rkr-k">3</span> &middot; <span class="rkr-k rkr-wide">Enter</span> to start</div>
      </div>`;
    o.prepend(paws);
    titleBtns = [...o.querySelectorAll('.rkr-btn')];
    titleBtns.forEach((b) => {
      b.addEventListener('click', () => startGame(+b.dataset.p));
      b.addEventListener('mouseenter', () => selectTitle(+b.dataset.p));
    });
    return o;
  }
  function selectTitle(n) {
    titleSel = n;
    titleBtns.forEach((b) => b.classList.toggle('rkr-sel', +b.dataset.p === n));
  }
  function startGame(n) {
    if (!state.title) return;
    const cb = onStartCb;
    hideTitle();
    if (cb) cb({ players: n === 2 || n === 3 ? n : 1 });
  }
  function showTitle(onStart) {
    onStartCb = onStart || null;
    if (titleEl) titleEl.remove();
    titleEl = buildTitle();
    root.appendChild(titleEl);
    state.title = true;
    hud.classList.add('rkr-off');
    H.visible = false;
    selectTitle(titleSel);
  }
  function hideTitle() {
    if (!state.title || !titleEl) { state.title = false; return; }
    state.title = false;
    const node = titleEl;
    titleEl = null;
    node.classList.add('rkr-leaving');
    setTimeout(() => node.remove(), 460);
  }

  // ================= pause =================
  let pauseEl = null;
  function showPause(onResume, onLeave) {
    onResumeCb = onResume || null;
    if (pauseEl) pauseEl.remove();
    pauseEl = el('div', 'rkr-overlay rkr-dim');
    pauseEl.innerHTML = `<div class="rkr-glass">
        <div class="rkr-gcat">${ICONS.cat}</div>
        <h2>${onLeave ? 'MENU' : 'PAUSED'}</h2>
        <div class="rkr-gsub">${onLeave ? 'Online games keep running. Watch out!' : 'The kitties are taking a little nap.'}</div>
        <button class="rkr-btn">RESUME</button>
        ${onLeave ? '<button class="rkr-btn rkr-alt rkr-leave">LEAVE GAME</button>' : ''}
        <div class="rkr-keyhint"><span class="rkr-k rkr-wide">Enter</span> or <span class="rkr-k">P</span> to resume &middot; <span class="rkr-k">M</span> mute</div>
      </div>`;
    pauseEl.querySelector('.rkr-btn').addEventListener('click', resume);
    if (onLeave) pauseEl.querySelector('.rkr-leave').addEventListener('click', () => { hidePause(); onLeave(); });
    root.appendChild(pauseEl);
    state.pause = true;
  }
  function resume() {
    if (!state.pause) return;
    const cb = onResumeCb;
    hidePause();
    if (cb) cb();
  }
  function hidePause() {
    state.pause = false;
    if (pauseEl) { pauseEl.remove(); pauseEl = null; }
  }

  // ================= game over =================
  let goEl = null, goRaf = 0, goTimers = [];
  const GO_LINES = [
    'The wolves win this round...',
    'Nine lives? Not today.',
    'Every kitty deserves another try.',
    'So close to the glowing heart!',
  ];
  function showGameOver(stats, onRestart, buttonLabel) {
    stats = stats || {};
    onRestartCb = onRestart || null;
    hideGameOver();
    goEl = el('div', 'rkr-overlay rkr-dim');
    const rows = [
      { icon: ICONS.cat, label: 'Level reached', v: stats.level | 0, fmt: String, color: '#ffb347' },
      { icon: ICONS.clock, label: 'Time survived', v: Math.floor(stats.time || 0), fmt: fmtTime, color: '#cdbfff' },
      { icon: ICONS.revive, label: 'Kitties rescued', v: stats.rescues | 0, fmt: String },
      { icon: ICONS.wolf, label: 'Times caught', v: stats.deaths | 0, fmt: String },
    ];
    const line = GO_LINES[((stats.level | 0) + (stats.deaths | 0)) % GO_LINES.length];
    goEl.innerHTML = `<div class="rkr-glass rkr-gameover">
        <div class="rkr-gcat">${ICONS.cat}</div>
        <h2>GAME OVER</h2>
        <div class="rkr-gsub">${esc(line)}</div>
        <div class="rkr-stats">${rows.map((r) => `<div class="rkr-stat"><div class="rkr-ico" style="color:${r.color || '#fff'}">${r.icon}</div><span class="rkr-sl">${r.label}</span><span class="rkr-sv">${r.fmt(0)}</span></div>`).join('')}</div>
        <button class="rkr-btn">${esc(buttonLabel || 'TRY AGAIN')}</button>
        <div class="rkr-keyhint">press <span class="rkr-k rkr-wide">Enter</span></div>
      </div>`;
    // dead-cat eyes on the header cat
    const gcat = goEl.querySelector('.rkr-gcat');
    gcat.querySelector('.rkr-eyes').style.display = 'none';
    gcat.querySelector('.rkr-xeyes').style.display = 'inline';
    gcat.style.animation = 'rkr-wiggle 2.4s ease-in-out infinite';
    goEl.querySelector('.rkr-btn').addEventListener('click', restart);
    root.appendChild(goEl);
    state.gameOver = true;
    gameOverArmedAt = performance.now() + 700;

    const statEls = [...goEl.querySelectorAll('.rkr-stat')];
    const anims = rows.map((r, i) => ({ el: statEls[i], val: statEls[i].querySelector('.rkr-sv'), r, start: 350 + i * 220, last: -1 }));
    anims.forEach((a) => goTimers.push(setTimeout(() => a.el.classList.add('rkr-show'), a.start)));
    const t0 = performance.now();
    const tick = () => {
      const el0 = performance.now() - t0;
      let done = true;
      for (const a of anims) {
        const k = Math.max(0, Math.min(1, (el0 - a.start - 100) / 800));
        if (k < 1) done = false;
        const e = 1 - Math.pow(1 - k, 3);
        const v = Math.round(a.r.v * e);
        if (v !== a.last) { a.last = v; a.val.textContent = a.r.fmt(v); }
      }
      if (done) { clearInterval(goRaf); goRaf = 0; }
    };
    goRaf = setInterval(tick, 33); // interval (not rAF) so it also finishes in throttled/background tabs
  }
  function restart() {
    if (!state.gameOver) return;
    const cb = onRestartCb;
    hideGameOver();
    if (cb) cb();
  }
  function hideGameOver() {
    state.gameOver = false;
    if (goRaf) clearInterval(goRaf);
    goRaf = 0;
    goTimers.forEach(clearTimeout); goTimers = [];
    if (goEl) { goEl.remove(); goEl = null; }
  }

  // ================= scoreboard (top right) =================
  let scoresKey = '';
  let best = 0;
  try { best = parseInt(localStorage.getItem('rkr-best') || '0', 10) || 0; } catch { /* ignore */ }
  function setScores(list) {
    if (!list) { scoresEl.style.display = 'none'; scoresKey = ''; return; }
    scoresEl.style.display = '';
    const mine = list.filter((p) => p.me).reduce((m, p) => Math.max(m, p.score), -Infinity);
    if (mine > best) { best = mine; try { localStorage.setItem('rkr-best', String(best)); } catch { /* ignore */ } }
    const rows = [...list].sort((a, b) => b.score - a.score);
    const key = rows.map((p) => `${p.name}|${p.score}|${p.me}`).join(',') + '#' + best;
    if (key === scoresKey) return;
    scoresKey = key;
    scoresEl.textContent = '';
    scoresEl.appendChild(el('div', 'rkr-sh', 'SCORE'));
    for (const p of rows) {
      const r = el('div', 'rkr-sr' + (p.you ? ' rkr-me' : ''));
      const n = el('span'); n.textContent = p.name; n.style.color = hexColor(p.color);
      const v = el('span'); v.textContent = (p.score > 0 ? '+' : '') + p.score;
      r.append(n, v);
      scoresEl.appendChild(r);
    }
    const b = el('div', 'rkr-best'); b.textContent = `best ${best > 0 ? '+' : ''}${best}`;
    scoresEl.appendChild(b);
  }

  // ================= misc =================
  function setMutedIcon(m) {
    muteEl.classList.toggle('rkr-muted', !!m);
    muteEl.title = m ? 'Sound is off: click or press M to turn it on' : 'Sound on: click or press M to mute';
    hintEl.querySelector('.rkr-snd').textContent = m ? 'sound on' : 'mute';
  }
  let muteHandler = null;
  muteEl.addEventListener('click', () => { if (muteHandler) muteHandler(); });
  function onMuteClick(fn) { muteHandler = fn; }
  function onMenuClick(fn) { menuHandler = fn; }
  function isOverlayOpen() { return state.title || state.pause || state.gameOver; }

  window.addEventListener('keydown', (e) => {
    if (e.repeat) return;
    const k = e.key;
    if ((k === 'h' || k === 'H') && !state.title && !e.target.closest?.('input')) { setHudMin(!hudMin); return; }
    if (state.gameOver) {
      if ((k === 'Enter' || k === ' ') && performance.now() >= gameOverArmedAt) { e.preventDefault(); restart(); }
      return;
    }
    if (state.pause) {
      if (k === 'Enter') { e.preventDefault(); resume(); }
      return;
    }
    if (state.title) {
      const idx = TITLE_ORDER.indexOf(titleSel);
      if (k === '1' || k === '2' || k === '3') startGame(TITLE_ORDER[+k - 1]);
      else if (k === 'Enter' || k === ' ') { e.preventDefault(); startGame(titleSel); }
      else if (k === 'ArrowLeft' || k === 'ArrowUp' || k === 'a' || k === 'A' || k === 'w' || k === 'W') selectTitle(TITLE_ORDER[Math.max(0, idx - 1)]);
      else if (k === 'ArrowRight' || k === 'ArrowDown' || k === 'd' || k === 'D' || k === 's' || k === 'S') selectTitle(TITLE_ORDER[Math.min(TITLE_ORDER.length - 1, idx + 1)]);
    }
  });

  setMutedIcon(false);

  return {
    showTitle, hideTitle, setHUD, updateMinimap, banner, toast, setScores,
    showPause, hidePause, showGameOver, hideGameOver, setMutedIcon, isOverlayOpen, onMuteClick, onMenuClick,
  };
}

export { createUI };

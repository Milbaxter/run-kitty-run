// Controller navigation for the DOM menus (title, online lobby, single player / co-op setup, pause menu): a yellow
// highlight moved with the d-pad / left stick (to the nearest button that way on screen), A presses it, B means
// "back" (the caller decides what that is). The highlight only shows once a controller is used on that screen and
// goes away when the mouse moves, so mouse / keyboard / touch players never see it. main.js feeds it every frame.

const CSS = `
.rkr-padfocus{outline:3px solid #fff !important;outline-offset:3px !important;box-shadow:0 0 0 8px rgba(255,207,90,.55),0 0 18px 6px rgba(255,207,90,.45) !important;}
`;
const REPEAT_FIRST = 0.38, REPEAT_EVERY = 0.13;   // holding a direction: first repeat, then every (s)

// what a controller can land on: buttons, checkboxes and swatches; not text boxes (no typing with a pad)
const SELECTOR = 'button, input[type=checkbox], [data-padnav]';

function usable(e) {
  if (e.disabled || !e.getClientRects().length) return false;
  const st = getComputedStyle(e);
  return st.visibility !== 'hidden' && st.display !== 'none' && st.pointerEvents !== 'none';
}

function centre(e) {
  const r = e.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function createPadNav() {
  if (!document.getElementById('rkr-padnav-style')) {
    const s = document.createElement('style');
    s.id = 'rkr-padnav-style';
    s.textContent = CSS;
    document.head.appendChild(s);
  }
  let cur = null, root = null, shown = false;
  let held = '', heldT = 0, repeatT = 0;

  function set(e) {
    if (cur) cur.classList.remove('rkr-padfocus');
    cur = e;
    if (!e) return;
    e.classList.add('rkr-padfocus');
    if (e.scrollIntoView) e.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  function hide() { set(null); shown = false; }
  // the mouse takes over again
  window.addEventListener('pointermove', (e) => { if (shown && e.pointerType === 'mouse' && (e.movementX || e.movementY)) hide(); });

  const candidates = (r) => [...r.querySelectorAll(SELECTOR)].filter(usable);
  // where the highlight starts: the screen's main (yellow) button, else the first one
  function start(r) {
    const c = candidates(r);
    return c.find((e) => e.classList.contains('rkr-sel')) || c.find((e) => e.classList.contains('rkr-btn') && !e.classList.contains('rkr-alt')) || c[0] || null;
  }
  // the nearest candidate in direction (dx, dy): mostly that way (within ~55 degrees of it), a little sideways is fine
  function step(dx, dy) {
    if (!cur) return;
    const a = centre(cur);
    let best = null, bestS = Infinity;
    for (const e of candidates(root)) {
      if (e === cur) continue;
      const b = centre(e), vx = b.x - a.x, vy = b.y - a.y;
      const along = vx * dx + vy * dy, side = Math.abs(vx * dy - vy * dx);
      if (along <= 4 || side > along * 1.45) continue;
      const s = along + 2.2 * side;
      if (s < bestS) { bestS = s; best = e; }
    }
    if (best) set(best);
  }

  // r: the open menu's element (null: none). input: { dir: 'up'|'down'|'left'|'right'|'', a, b } with a / b true on
  // the frame the button went down. Returns 'back' when B was pressed (the caller handles it).
  function poll(r, input, dt) {
    if (r !== root) { hide(); root = r; held = ''; }
    if (!r) return null;
    if (cur && (!r.contains(cur) || !usable(cur))) set(null);
    const any = input.dir || input.a || input.b;
    if (any && !cur) {
      // the first touch shows where you are (A on the title starts the highlighted choice right away)
      shown = true;
      set(start(r));
      if (input.a && cur) cur.click();
      held = input.dir; heldT = 0; repeatT = 0;
      return input.b ? 'back' : null;
    }
    if (input.dir) {
      if (input.dir !== held) { held = input.dir; heldT = 0; repeatT = REPEAT_FIRST; move(input.dir); }
      else {
        heldT += dt;
        if (heldT >= repeatT) { repeatT += REPEAT_EVERY; move(input.dir); }
      }
    } else held = '';
    if (input.a && cur) {
      if (cur.matches('input[type=checkbox]')) { cur.checked = !cur.checked; cur.dispatchEvent(new Event('change', { bubbles: true })); }
      else cur.click();
    }
    return input.b ? 'back' : null;
  }
  function move(dir) {
    if (dir === 'up') step(0, -1);
    else if (dir === 'down') step(0, 1);
    else if (dir === 'left') step(-1, 0);
    else if (dir === 'right') step(1, 0);
  }

  return { poll, hide, active: () => shown };
}

export { createPadNav };

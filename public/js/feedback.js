// Feedback: a small button (shown while your kitty is down, and on the game-over screen) that opens
// a box to type ideas / bugs. Sent to the server (POST /api/feedback), which appends them to a file.

const CSS = `
.rkf-btn{position:absolute;left:50%;bottom:max(84px,calc(env(safe-area-inset-bottom) + 70px));transform:translateX(-50%);
  pointer-events:auto;cursor:pointer;font:inherit;font-weight:900;font-size:15px;letter-spacing:.04em;color:#2b1840;
  padding:9px 18px;border-radius:999px;border:0;background:linear-gradient(180deg,#fff3c4,#ffcf5a);box-shadow:0 4px 0 #3a1650,0 8px 18px rgba(0,0,0,.35);
  display:none;z-index:15;}
.rkf-btn.rkf-on{display:block;}
.rkf-btn:hover{filter:brightness(1.06);}
.rkf-modal{z-index:40;}
.rkf-box{max-width:520px;text-align:center;background:linear-gradient(160deg,rgba(52,30,96,.97),rgba(26,12,52,.97)) !important;}
.rkf-box h2{font-size:clamp(30px,4.5vw,44px) !important;}
.rkf-ta{width:100%;min-height:120px;resize:vertical;font:inherit;font-weight:700;font-size:16px;padding:12px 14px;border-radius:14px;
  border:2px solid rgba(255,255,255,.3);background:rgba(10,4,30,.6);color:#fff;outline:none;user-select:text;-webkit-user-select:text;}
.rkf-ta:focus{border-color:#ffcf5a;}
.rkf-row{display:flex;gap:10px;justify-content:center;flex-wrap:wrap;}
.rkf-count{font-size:12px;opacity:.6;text-align:right;width:100%;margin-top:-6px;}
.rkf-msg{min-height:20px;font-weight:800;}
.rkf-msg.rkf-err{color:#ff8fa3;}
.rkf-msg.rkf-ok{color:#9dff7a;}
@media (max-height:500px){ .rkf-ta{min-height:70px;} .rkf-btn{bottom:14px;} }
`;

const MAX = 1000;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function createFeedback(root, { getContext }) {
  const st = document.createElement('style');
  st.textContent = CSS;
  document.head.appendChild(st);

  const btn = el('button', 'rkf-btn', '💡 Feedback / ideas');
  btn.addEventListener('click', () => open());
  root.appendChild(btn);

  let modal = null;

  function setVisible(on) { btn.classList.toggle('rkf-on', !!on && !modal); }

  function close() {
    if (modal) modal.remove();
    modal = null;
  }

  function open() {
    if (modal) return;
    btn.classList.remove('rkf-on');
    modal = el('div', 'rkr-overlay rkr-dim rkf-modal');
    const box = el('div', 'rkr-glass rkf-box');
    const h = el('h2', null, 'FEEDBACK');
    const sub = el('div', 'rkr-gsub', 'Ideas, bugs, wishes: what would make the game better?');
    const ta = el('textarea', 'rkf-ta');
    ta.maxLength = MAX;
    ta.placeholder = 'Type here…';
    const count = el('div', 'rkf-count', `0 / ${MAX}`);
    const msg = el('div', 'rkf-msg');
    const send = el('button', 'rkr-btn', 'SEND');
    const cancel = el('button', 'rkr-btn rkr-alt', 'CLOSE');
    const row = el('div', 'rkf-row');
    row.append(send, cancel);
    box.append(h, sub, ta, count, row, msg);
    modal.appendChild(box);
    // typing must not move the kitty / trigger game keys
    modal.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') close(); });
    modal.addEventListener('keyup', (e) => e.stopPropagation());
    ta.addEventListener('input', () => { count.textContent = `${ta.value.length} / ${MAX}`; });
    cancel.addEventListener('click', close);
    send.addEventListener('click', async () => {
      const text = ta.value.trim();
      if (text.length < 2) { msg.className = 'rkf-msg rkf-err'; msg.textContent = 'Type a little more first.'; return; }
      send.disabled = true;
      msg.className = 'rkf-msg'; msg.textContent = 'Sending…';
      try {
        const r = await fetch('api/feedback', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, ...(getContext ? getContext() : {}) }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.ok) throw new Error(j.msg || 'Could not send right now.');
        msg.className = 'rkf-msg rkf-ok'; msg.textContent = 'Thank you! Sent. 🐾';
        ta.value = '';
        setTimeout(close, 1200);
      } catch (err) {
        msg.className = 'rkf-msg rkf-err'; msg.textContent = err.message || 'Could not send right now.';
        send.disabled = false;
      }
    });
    root.appendChild(modal);
    setTimeout(() => ta.focus(), 30);
  }

  return { open, close, setVisible, isOpen: () => !!modal };
}

export { createFeedback };

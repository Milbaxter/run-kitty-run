// Lobby/game chat box (bottom-left). Enter opens it, Enter sends, Esc closes.
// All message text is inserted with textContent.

const CSS = `
.rkc{position:absolute;left:16px;bottom:16px;width:min(360px,calc(100vw - 32px));display:flex;flex-direction:column;gap:6px;
  pointer-events:none;z-index:20;font-weight:800;font-size:15px;}
.rkc-log{display:flex;flex-direction:column;gap:3px;max-height:40vh;overflow:hidden;justify-content:flex-end;}
.rkc-line{padding:4px 10px;border-radius:10px;background:rgba(10,4,30,.55);color:#fff;text-shadow:0 1px 0 rgba(0,0,0,.6);
  word-wrap:break-word;overflow-wrap:anywhere;transition:opacity .6s;align-self:flex-start;max-width:100%;}
.rkc-line b{margin-right:6px;}
.rkc-line.rkc-sys{color:#cdbfff;font-style:italic;font-weight:700;}
.rkc-line.rkc-old{opacity:0;}
.rkc.rkc-open .rkc-line.rkc-old{opacity:.85;}
.rkc-in{pointer-events:auto;font:inherit;font-weight:800;font-size:15px;padding:8px 12px;border-radius:12px;
  border:2px solid #ffcf5a;background:rgba(10,4,30,.8);color:#fff;outline:none;display:none;user-select:text;-webkit-user-select:text;}
.rkc.rkc-open .rkc-in{display:block;}
.rkc-hint{opacity:.55;font-size:12px;font-weight:700;padding-left:4px;}
.rkc.rkc-open .rkc-hint{display:none;}
`;

const SHOW_MS = 10000;
const MAX_LINES = 40;

function hex(c) { return '#' + ((c >>> 0) & 0xffffff).toString(16).padStart(6, '0'); }

function createChat(root, { onSend, onOpen }) {
  const st = document.createElement('style');
  st.textContent = CSS;
  document.head.appendChild(st);

  const box = document.createElement('div');
  box.className = 'rkc';
  box.style.display = 'none';
  const log = document.createElement('div');
  log.className = 'rkc-log';
  const input = document.createElement('input');
  input.className = 'rkc-in';
  input.maxLength = 120;
  input.placeholder = 'Say something… (Enter to send, Esc to close)';
  const hint = document.createElement('div');
  hint.className = 'rkc-hint';
  hint.textContent = 'Press Enter to chat';
  box.append(log, input, hint);
  root.appendChild(box);

  let enabled = false;

  function isOpen() { return box.classList.contains('rkc-open'); }
  function open() {
    if (!enabled || isOpen()) return;
    box.classList.add('rkc-open');
    input.value = '';
    input.focus();
    if (onOpen) onOpen();
  }
  function close() {
    box.classList.remove('rkc-open');
    input.blur();
  }

  // Keys typed into the chat never reach the game's key handlers.
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') {
      e.preventDefault();
      const text = input.value.trim();
      if (text) onSend(text);
      close();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  });
  input.addEventListener('keyup', (e) => e.stopPropagation());
  input.addEventListener('blur', () => box.classList.remove('rkc-open'));

  function add(msg) {
    const line = document.createElement('div');
    line.className = 'rkc-line' + (msg.sys ? ' rkc-sys' : '');
    if (msg.sys) {
      line.textContent = msg.text;
    } else {
      const name = document.createElement('b');
      name.textContent = msg.name + ':';
      name.style.color = hex(msg.color);
      line.append(name, document.createTextNode(msg.text));
    }
    log.appendChild(line);
    while (log.children.length > MAX_LINES) log.firstChild.remove();
    setTimeout(() => line.classList.add('rkc-old'), SHOW_MS);
  }

  function setEnabled(on) {
    enabled = on;
    box.style.display = on ? '' : 'none';
    if (!on) close();
  }

  function clear() { log.textContent = ''; }

  return { open, close, isOpen, add, setEnabled, clear };
}

export { createChat };

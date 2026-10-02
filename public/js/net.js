// Thin WebSocket client for online lobbies. Reconnects on drop; messages are JSON objects with a `t` type.
import * as CONF from './shared/config.js';
import { wsUrl, PLATFORM, APP_VERSION } from './platform.js';

// Sent in the 'hi' handshake; the server gates modes on it (MODE_MIN_PROTOCOL in server/index.js).
const PROTOCOL_VERSION = CONF.PROTOCOL_VERSION;

// Per-tab token sent in 'hi': after a dropped connection the server recognises the kitty that comes back
// (it keeps its lives, and stays down if it was down). sessionStorage: survives a reload, not shared between tabs.
function tabToken() {
  const fresh = () => Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(36).padStart(2, '0')).join('');
  try {
    let t = sessionStorage.getItem('rkr-tok');
    if (!t || !/^[\w-]{8,64}$/.test(t)) { t = fresh(); sessionStorage.setItem('rkr-tok', t); }
    return t;
  } catch { return fresh(); }
}

function createNet() {
  const handlers = new Map();
  let ws = null;
  let wantOpen = false;
  let retryT = 0;
  let pingT = 0;
  let lastMsgAt = 0;
  let wakeT = 0;
  let tries = 0;       // failed connects in a row (backoff)
  let tok = '';
  // Messages sent while the very first socket is still connecting (openOnline sends a join right after connect()).
  // After a drop nothing is queued: stale lobby actions are dropped, the 'open' handler in main.js rejoins.
  const queue = [];
  const net = {
    outdated: false,
    connected: false,
    id: 0,
    rtt: 100,          // ms, smoothed
    on(type, fn) { handlers.set(type, fn); },
    connect() {
      if (net.outdated) return;
      wantOpen = true;
      if (ws && ws.readyState <= 1) return;
      clearTimeout(retryT);
      const sock = ws = new WebSocket(wsUrl());
      ws.onopen = () => {
        net.connected = true;
        tries = 0;
        lastMsgAt = performance.now();
        // handshake first: lets the server tell old app builds to update
        if (!tok) tok = tabToken();
        ws.send(JSON.stringify({ t: 'hi', v: PROTOCOL_VERSION, app: PLATFORM, ver: APP_VERSION, tok }));
        while (queue.length) ws.send(queue.shift());
        emit('open', {});
        clearInterval(pingT);
        pingT = setInterval(() => net.send({ t: 'ping', c: performance.now() }), 1000);
      };
      ws.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
        lastMsgAt = performance.now();
        if (msg.t === 'outdated') { net.outdated = true; wantOpen = false; clearTimeout(retryT); }
        if (msg.t === 'hello') net.id = msg.id;
        if (msg.t === 'pong') {
          const r = performance.now() - msg.c;
          net.rtt += (r - net.rtt) * 0.2;
        }
        emit(msg.t, msg);
      };
      ws.onclose = () => {
        if (ws && ws !== sock) return; // an old socket closing after disconnect() + connect()
        const was = net.connected;
        net.connected = false;
        if (was) queue.length = 0;
        clearInterval(pingT);
        if (was && !net.outdated) emit('close', {});
        // exponential backoff with jitter, so a restarted server isn't hit by everyone at once
        if (wantOpen) retryT = setTimeout(() => net.connect(), Math.min(30000, 1000 * 2 ** tries++) * (0.5 + Math.random()));
      };
      ws.onerror = () => {};
    },
    disconnect() {
      wantOpen = false;
      tries = 0;
      queue.length = 0;
      clearTimeout(wakeT);
      clearTimeout(retryT);
      clearInterval(pingT);
      if (ws) ws.close();
      ws = null;
      net.connected = false;
    },
    // Back from the background (app resumed / tab shown): sockets often die silently while suspended.
    // Reconnect right away if it is closed; if it looks open, ping it and reconnect if nothing comes back.
    wake() {
      if (!wantOpen) return;
      clearTimeout(wakeT);
      if (!ws || ws.readyState > 1) { clearTimeout(retryT); net.connect(); return; }
      if (ws.readyState !== 1) return;
      const sock = ws, mark = performance.now();
      net.send({ t: 'ping', c: mark });
      wakeT = setTimeout(() => {
        if (ws !== sock || lastMsgAt >= mark) return;
        // zombie socket: drop it without waiting for the OS to notice, then reconnect
        sock.onclose = null; sock.onmessage = null;
        try { sock.close(); } catch { /* ignore */ }
        ws = null;
        net.connected = false;
        clearInterval(pingT);
        emit('close', {});
        if (wantOpen) net.connect();
      }, 2500);
    },
    send(msg) {
      const s = JSON.stringify(msg);
      if (ws && ws.readyState === 1) ws.send(s);
      else if (ws && ws.readyState === 0 && tries === 0 && msg.t !== 'in' && msg.t !== 'ping' && queue.length < 8) queue.push(s);
    },
  };
  function emit(type, msg) {
    const fn = handlers.get(type);
    if (fn) fn(msg);
  }
  return net;
}

export { createNet };

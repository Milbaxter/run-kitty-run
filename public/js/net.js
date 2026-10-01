// Thin WebSocket client for online lobbies. Reconnects on drop; messages are JSON objects with a `t` type.
import * as CONF from './shared/config.js';
import { wsUrl, PLATFORM, APP_VERSION } from './platform.js';

const PROTOCOL_VERSION = CONF.PROTOCOL_VERSION ?? 1;

function createNet() {
  const handlers = new Map();
  let ws = null;
  let wantOpen = false;
  let retryT = 0;
  let pingT = 0;
  let lastMsgAt = 0;
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
      ws = new WebSocket(wsUrl());
      ws.onopen = () => {
        net.connected = true;
        lastMsgAt = performance.now();
        // handshake first: lets the server tell old app builds to update
        ws.send(JSON.stringify({ t: 'hi', v: PROTOCOL_VERSION, app: PLATFORM, ver: APP_VERSION }));
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
        const was = net.connected;
        net.connected = false;
        clearInterval(pingT);
        if (was && !net.outdated) emit('close', {});
        if (wantOpen) retryT = setTimeout(() => net.connect(), 1500);
      };
      ws.onerror = () => {};
    },
    disconnect() {
      wantOpen = false;
      clearTimeout(retryT);
      clearInterval(pingT);
      if (ws) ws.close();
      ws = null;
      net.connected = false;
    },
    // Back from the background (app resumed / tab shown): sockets often die silently while suspended.
    // Reconnect right away instead of waiting for the retry timer or a dead socket to time out.
    wake() {
      if (!wantOpen) return;
      if (ws && ws.readyState === 1 && performance.now() - lastMsgAt > 3000) {
        // pings go out every second: silence this long means a zombie socket
        const dead = ws;
        dead.onclose = null; dead.onmessage = null;
        try { dead.close(); } catch { /* ignore */ }
        ws = null;
        net.connected = false;
        clearInterval(pingT);
        emit('close', {});
      }
      if (!ws || ws.readyState > 1) { clearTimeout(retryT); net.connect(); }
    },
    send(msg) {
      const s = JSON.stringify(msg);
      if (ws && ws.readyState === 1) ws.send(s);
      else if (msg.t !== 'in' && msg.t !== 'ping') queue.push(s);
    },
  };
  function emit(type, msg) {
    const fn = handlers.get(type);
    if (fn) fn(msg);
  }
  return net;
}

export { createNet };

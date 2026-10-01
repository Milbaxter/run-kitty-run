// Thin WebSocket client for online lobbies. Reconnects on drop; messages are JSON objects with a `t` type.

function wsUrl() {
  const q = new URLSearchParams(location.search).get('server');
  if (q) return q;
  if (location.protocol === 'file:') return 'ws://localhost:8080/ws';
  return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
}

function createNet() {
  const handlers = new Map();
  let ws = null;
  let wantOpen = false;
  let retryT = 0;
  let pingT = 0;
  const queue = [];
  const net = {
    connected: false,
    id: 0,
    rtt: 100,          // ms, smoothed
    on(type, fn) { handlers.set(type, fn); },
    connect() {
      wantOpen = true;
      if (ws && ws.readyState <= 1) return;
      clearTimeout(retryT);
      ws = new WebSocket(wsUrl());
      ws.onopen = () => {
        net.connected = true;
        while (queue.length) ws.send(queue.shift());
        emit('open', {});
        clearInterval(pingT);
        pingT = setInterval(() => net.send({ t: 'ping', c: performance.now() }), 1000);
      };
      ws.onmessage = (e) => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }
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
        if (was) emit('close', {});
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

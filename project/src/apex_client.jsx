// Thin HTTP + WS client. Exposes window.APEX_CLIENT.
const BASE = `${location.protocol}//${location.host}`;
const WS_BASE = (location.protocol === "https:" ? "wss:" : "ws:") + "//" + location.host;

async function get(path) {
  const r = await fetch(BASE + path);
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}
async function post(path, body) {
  const r = await fetch(BASE + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body || {}),
  });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

function openSocket(onMessage) {
  let ws;
  let retry = 0;
  const connect = () => {
    ws = new WebSocket(WS_BASE + "/ws/telemetry");
    ws.onmessage = (ev) => { try { onMessage(JSON.parse(ev.data)); } catch {} };
    ws.onclose = () => {
      const delay = Math.min(1000 * (2 ** retry), 10000);
      retry = Math.min(retry + 1, 4);
      setTimeout(connect, delay);
    };
    ws.onopen = () => { retry = 0; };
  };
  connect();
  return { close: () => ws && ws.close() };
}

window.APEX_CLIENT = { get, post, openSocket };

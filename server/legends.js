// Legends board: every win of the final run becomes one "legend" (the whole team, by name), and each kitty on it may
// leave a line for SIGN_WINDOW_MS. Online wins are server-verified: everyone in the room at the moment of the win is on
// it and signs over ws. Offline (solo / local co-op) wins can't be verified, so they're signed over HTTP
// (POST /api/legends) with light checks: final-run mode, a plausible game time, one per IP per 10 minutes (index.js),
// edits by the id + secret key the server hands back. Online winners get the board over ws; anyone can read it with
// GET /api/legends (after an offline win, and from the main menu's LEGENDS button), the newest wins of each mode.
import crypto from 'node:crypto';
// State is one JSON file (newest MAX_WINS wins), saved atomically a moment after each change.
import fs from 'node:fs';

const MAX_WINS = 1000;          // stored
const SEND_WINS = 100;          // sent to clients (newest first)
const TEXT_MAX = 140;           // characters (code points) per line
const SIGN_WINDOW_MS = 15 * 60e3;
const SAVE_DELAY_MS = 2000;
const FINAL_MODES = ['mixed', 'ice', 'run'];  // modes whose level 9 is the final run
const MIN_GAME_S = 300;                 // offline: the whole game (sim.time, levels 1-9) takes longer than this
const MAX_GAME_S = 12 * 3600;
const MIN_RUN_S = 15;                   // offline: the final run alone
const OFFLINE_PLAYERS = 2;              // solo or local co-op

// single line, no control / bidi-override characters, collapsed spaces, capped; no other filtering (the apps mask)
function cleanText(v) {
  const s = String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, TEXT_MAX).join('').trim();
}

function createLegends(file) {
  let wins = [];   // oldest first: { id, at, mode, kind?: 'solo' | 'coop' (offline wins), runTime, entries: [{ name, color, text, at }] }
  try {
    const old = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(old.wins)) wins = old.wins.filter((w) => w && Array.isArray(w.entries)).slice(-MAX_WINS);
  } catch { /* first run, or unreadable: start fresh */ }
  // signer key (tab token / client id) -> { win, idx, until }; in memory only (a restart closes the signing windows)
  const elig = new Map();
  const offlineKeys = new Map(); // offline win id -> { key, until } (edit window; in memory only)
  let saveT = null, cache = null;

  function save() {
    saveT = null;
    const tmp = file + '.tmp';
    fs.writeFile(tmp, JSON.stringify({ wins }), (err) => {
      if (err) { console.error('legends save failed:', err.message); return; }
      fs.rename(tmp, file, (e) => { if (e) console.error('legends save failed:', e.message); });
    });
  }
  function changed() {
    cache = null;
    if (!saveT) saveT = setTimeout(save, SAVE_DELAY_MS);
  }
  function flush() {
    if (!saveT) return;
    clearTimeout(saveT); saveT = null;
    try { fs.writeFileSync(file, JSON.stringify({ wins })); } catch (e) { console.error('legends flush failed:', e.message); }
  }
  setInterval(() => {
    const now = Date.now();
    for (const [k, e] of elig) if (e.until < now) elig.delete(k);
    for (const [k, e] of offlineKeys) if (e.until < now) offlineKeys.delete(k);
  }, 60e3).unref();

  const keysOf = (c) => (c.tok ? [c.tok, 'id:' + c.id] : ['id:' + c.id]);
  // newest first, capped; cached as a string for the HTTP read
  // the newest SEND_WINS wins of each mode, newest first (the board has a tab per mode)
  const board = () => {
    const out = [], per = {};
    for (let i = wins.length - 1; i >= 0; i--) {
      const m = wins[i].mode || 'mixed';
      if ((per[m] = (per[m] || 0) + 1) <= SEND_WINS) out.push(wins[i]);
    }
    return out;
  };
  function boardJson() { return (cache ||= JSON.stringify({ ok: true, wins: board() })); }

  const newId = (now) => now.toString(36) + crypto.randomBytes(3).toString('hex');
  function addWin(win) {
    wins.push(win);
    if (wins.length > MAX_WINS) wins.splice(0, wins.length - MAX_WINS);
    changed();
  }

  // A room won: one legend with everyone in it (names only until they write something), and a signing window each.
  function recordWin(mode, runTime, members) {
    const now = Date.now();
    const win = {
      id: newId(now), at: new Date(now).toISOString(), mode,
      runTime: Number.isFinite(runTime) ? Math.round(runTime * 10) / 10 : null,
      entries: members.map((m) => ({ name: m.name, color: m.color, text: '', at: null })),
    };
    members.forEach((m, idx) => { for (const k of keysOf(m)) elig.set(k, { win, idx, until: now + SIGN_WINDOW_MS }); });
    addWin(win);
    return win;
  }

  // this client's open signing window (the newest win it was part of), or null
  function eligibility(c) {
    const now = Date.now();
    for (const k of keysOf(c)) {
      const e = elig.get(k);
      if (e && e.until > now && wins.includes(e.win)) return e;
    }
    return null;
  }

  // what a winner gets: the board plus its own slot (text so far, ms left to sign)
  function boardFor(c) {
    const e = eligibility(c);
    if (!e) return null;
    return { t: 'legends', wins: board(), can: { id: e.win.id, text: e.win.entries[e.idx].text, left: e.until - Date.now() } };
  }

  // sign (or replace / clear) this client's line; returns the updated win or an error message
  function sign(c, text) {
    const e = eligibility(c);
    if (!e) return { err: 'The signing window for your win has closed.' };
    const entry = e.win.entries[e.idx];
    entry.text = cleanText(text);
    entry.at = entry.text ? new Date().toISOString() : null;
    if (c.name) entry.name = c.name; // signed with the in-game name the server knows, never a client-picked one
    changed();
    return { win: e.win, entry };
  }

  // ---- offline wins (HTTP): m = { mode, runTime, time, players: [{ name, color, text }] } ----
  const cleanName = (n) => String(n ?? '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 14);
  const cleanColor = (c) => (Number.isInteger(c) && c >= 0 && c <= 0xffffff ? c : 0xffb347);
  function offlinePlayers(m) {
    const ps = Array.isArray(m.players) ? m.players.slice(0, OFFLINE_PLAYERS) : [];
    return ps.map((p, i) => ({ name: cleanName(p && p.name) || `Kitty ${i + 1}`, color: cleanColor(p && p.color), text: cleanText(p && p.text) }));
  }
  // checks only (index.js applies the per-IP limit before calling create)
  function checkOffline(m) {
    if (!m || !FINAL_MODES.includes(m.mode)) return 'That mode has no final run.';
    const time = +m.time, runTime = +m.runTime;
    if (!(time >= MIN_GAME_S && time <= MAX_GAME_S) || !(runTime >= MIN_RUN_S && runTime <= time)) return 'That run looks a little too quick for the board.';
    if (!Array.isArray(m.players) || !m.players.length || m.players.length > OFFLINE_PLAYERS) return 'Who won, though?';
    return null;
  }
  function createOffline(m) {
    const now = Date.now();
    const ps = offlinePlayers(m);
    const win = {
      id: newId(now), at: new Date(now).toISOString(), mode: m.mode, kind: ps.length > 1 ? 'coop' : 'solo',
      runTime: Math.round(+m.runTime * 10) / 10,
      entries: ps.map((p) => ({ name: p.name, color: p.color, text: p.text, at: p.text ? new Date(now).toISOString() : null })),
    };
    const key = crypto.randomBytes(12).toString('hex');
    offlineKeys.set(win.id, { key, until: now + SIGN_WINDOW_MS });
    addWin(win);
    return { win, key, left: SIGN_WINDOW_MS };
  }
  // edit the lines (same players, same order) of an offline win within its window
  function editOffline(m) {
    const k = offlineKeys.get(String(m && m.id || ''));
    const win = k && wins.find((w) => w.id === m.id);
    const key = Buffer.from(String(m && m.key || '')), want = k ? Buffer.from(k.key) : null;   // compare bytes: a non-ASCII key of the same length would throw
    if (!win || k.until < Date.now() || key.length !== want.length || !crypto.timingSafeEqual(key, want)) {
      return { err: 'The signing window for your win has closed.' };
    }
    const ps = Array.isArray(m.players) ? m.players : [];
    win.entries.forEach((e, i) => {
      if (!ps[i]) return;
      const text = cleanText(ps[i].text);
      if (text !== e.text) { e.text = text; e.at = text ? new Date().toISOString() : null; }
    });
    changed();
    return { win, left: k.until - Date.now() };
  }

  return { recordWin, eligibility, boardFor, sign, boardJson, flush, checkOffline, createOffline, editOffline, TEXT_MAX };
}

export { createLegends, cleanText };

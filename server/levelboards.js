// Level boards: the fastest clear of every level, a board each per
//   source      online (server-simulated, can't be faked) or local (reported by the game itself, on its own boards)
//   difficulty  normal or easy
//   mode        Run + Skate / Run only / Skate only
//   level       1-9 (level 9 only for players who have reached it themselves: it stays a secret for everyone else)
//   size        solo (one player) or team (two or more; local co-op is two kitties on one device)
// Every player keeps only their own best time on each board; a team's time counts for everyone in it. A board shows its
// fastest SHOW players, or only your starred friends ('friends': the friend ids the client sends) or the members of a
// group you're in (a name and a join code; anyone with the code can join, except players its owner removed). A group can
// be a fresh start: its board then only counts times set since it was made (or its owner restarted it), so friends can
// race from zero. No rewards come from these boards.
// Players are hashes of their account / browser ids (an account's own browser's times move to the account when it
// signs in), never sent anywhere; their friend ids (also hashes) are kept to find friends' times.
import crypto from 'node:crypto';
import fs from 'node:fs';

const MODES = ['mixed', 'run', 'ice'];
const LEVELS = 9, SECRET_LEVEL = 9;
const SHOW = 100;                       // a board's top list
const MIN_S = 5, MAX_S = 4 * 3600;      // a level's clear time (seconds)
const FRIENDS_MAX = 50;                 // fids a friends board looks at (the client keeps up to 50 starred friends)
const FIDS_MAX = 10;                    // friend ids kept per player (its newest browsers)
const GROUP_MAX = 100;                  // members per group
const GROUPS_PER_PLAYER = 10;
const GROUP_NAME_MAX = 24;
const CODE_ABC = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // join codes: no 0/O, 1/I
const CODE_LEN = 6;
const SAVE_DELAY_MS = 5000;
const FID = /^[\w-]{16}$/;
const PID = /^[a-z0-9]{24,40}$/;

// a board's key: 'o' / 'l' (online / local) + 'n' / 'e' (normal / easy), mode, level, 's' / 't' (solo / team)
const boardKey = (b) => (b.local ? 'l' : 'o') + (b.easy ? 'e' : 'n') + ':' + b.mode + ':' + b.level + ':' + (b.team ? 't' : 's');
function parseBoard(b) {
  if (!b || typeof b !== 'object' || !MODES.includes(b.mode)) return null;
  const level = Number(b.level);
  if (!Number.isInteger(level) || level < 1 || level > LEVELS) return null;
  return { local: !!b.local, easy: !!b.easy, mode: b.mode, level, team: !!b.team };
}
const cleanName = (n) => String(n ?? '').replace(/[\u0000-\u001f\u007f-\u009f<>‎‏‪-‮⁦-⁩]/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
const cleanColor = (c) => (Number.isInteger(c) && c >= 0 && c <= 0xffffff ? c : 0xffb347);
const round1 = (t) => Math.round(t * 10) / 10;

function createLevelBoards(file) {
  // players: key -> { n: name, c: color, f: [friend ids], r9?: 1 (has reached level 9), at: last seen (ms),
  //                   b: { boardKey: [time, at (ms), team size] } }
  // groups: id -> { name, code, owner: player key, m: [player keys], at, out?: [removed player keys],
  //                 fresh?: since (ms): only times set from then on, kept in b: { boardKey: { player key: [time, at, team] } } }
  let players = {}, groups = {};
  try {
    const old = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (old && typeof old.players === 'object' && old.players) players = old.players;
    if (old && typeof old.groups === 'object' && old.groups) groups = old.groups;
  } catch { /* first run, or unreadable: start fresh */ }
  const byCode = new Map(Object.entries(groups).map(([id, g]) => [g.code, id]));
  let saveT = null;
  const tops = new Map();   // boardKey -> sorted [[key, time, at, team]] (all of a board's players), dropped on change

  function save() {
    saveT = null;
    const tmp = file + '.tmp';
    fs.writeFile(tmp, JSON.stringify({ players, groups }), (err) => {
      if (err) { console.error('level boards save failed:', err.message); return; }
      fs.rename(tmp, file, (e) => { if (e) console.error('level boards save failed:', e.message); });
    });
  }
  function changed() { if (!saveT) saveT = setTimeout(save, SAVE_DELAY_MS); }
  function flush() {
    if (!saveT) return;
    clearTimeout(saveT); saveT = null;
    try { fs.writeFileSync(file, JSON.stringify({ players, groups })); } catch (e) { console.error('level boards flush failed:', e.message); }
  }

  const hash = (s) => crypto.createHash('sha256').update('rkr-levels:' + s).digest('hex').slice(0, 20);
  // who: { acct?, pid?, seat? (a local game's second kitty: its own player on this browser), fid?, name?, color? }
  // -> the player's key: the account's, else this browser's (seat 1: the browser's second kitty)
  function keyOf(who) {
    if (!who) return '';
    const pid = typeof who.pid === 'string' && PID.test(who.pid) ? who.pid : '';
    if (who.seat) return pid ? 'p' + hash('p:' + pid + ':' + who.seat) : '';
    if (who.acct) return 'a' + hash('a:' + who.acct);
    return pid ? 'p' + hash('p:' + pid) : '';
  }
  // an account playing in a browser that has times of its own: they move to the account (each board's better time)
  function adopt(who, key) {
    if (!who || !who.acct || who.seat || !key.startsWith('a')) return;
    const pid = typeof who.pid === 'string' && PID.test(who.pid) ? who.pid : '';
    const pk = pid && 'p' + hash('p:' + pid), g = pk && players[pk];
    if (!g) return;
    const a = (players[key] ||= { n: g.n, c: g.c, f: [], b: {}, at: g.at });
    for (const [bk, v] of Object.entries(g.b || {})) if (!a.b[bk] || v[0] < a.b[bk][0]) { a.b[bk] = v; tops.delete(bk); }
    if (g.r9) a.r9 = 1;
    for (const f of g.f || []) addFid(a, f);
    for (const gr of Object.values(groups)) {
      const i = gr.m.indexOf(pk);
      if (i >= 0) { if (gr.m.includes(key)) gr.m.splice(i, 1); else gr.m[i] = key; }
      if (gr.owner === pk) gr.owner = key;
      if (gr.out) gr.out = gr.out.map((k) => (k === pk ? key : k));
      if (gr.b) for (const t of Object.values(gr.b)) if (t[pk]) { if (!t[key] || t[pk][0] < t[key][0]) t[key] = t[pk]; delete t[pk]; }
    }
    delete players[pk];
    changed();
  }
  function addFid(p, f) {
    if (!f || !FID.test(f)) return;
    p.f = (p.f || []).filter((x) => x !== f);
    p.f.unshift(f);
    if (p.f.length > FIDS_MAX) p.f.length = FIDS_MAX;
  }
  // the player's record (made on first use when make); its name, colour and friend id brought up to date
  function playerOf(who, make) {
    const key = keyOf(who);
    if (!key) return null;
    adopt(who, key);
    let p = players[key];
    if (!p) {
      if (!make) return { key, p: null };
      p = players[key] = { n: cleanName(who.name) || 'Kitty', c: cleanColor(who.color), f: [], b: {}, at: Date.now() };
    }
    if (make) {
      const n = cleanName(who.name);
      if (n) p.n = n;
      if (Number.isInteger(who.color)) p.c = cleanColor(who.color);
      if (!who.seat) addFid(p, who.fid);
      p.at = Date.now();
    }
    return { key, p };
  }

  // a cleared level: ev = { local, easy, mode, level, time (s), team (players in the game) }; true when it's a new best
  function record(who, ev) {
    const b = parseBoard({ ...ev, team: ev && ev.team > 1 });
    const time = +(ev && ev.time);
    if (!b || !(time >= MIN_S && time <= MAX_S)) return false;
    const me = playerOf(who, true);
    if (!me) return false;
    const { key, p } = me;
    if (b.level === SECRET_LEVEL) p.r9 = 1;
    const bk = boardKey(b), had = p.b[bk];
    changed();
    // fresh-start groups keep their own bests (any time from their start on, even when it isn't the player's best ever)
    for (const g of Object.values(groups)) {
      if (!g.fresh || !g.m.includes(key)) continue;
      const gb = (g.b ||= {})[bk] ||= {}, mine = gb[key];
      if (!mine || round1(time) < mine[0]) gb[key] = [round1(time), Date.now(), Math.max(1, Math.min(99, ev.team | 0 || 1))];
    }
    if (had && had[0] <= round1(time)) return false;
    p.b[bk] = [round1(time), Date.now(), Math.max(1, Math.min(99, ev.team | 0 || 1))];
    tops.delete(bk);
    return !!key;
  }
  // reached the secret level (its tab shows from then on)
  function reach(who) {
    const me = playerOf(who, true);
    if (me && !me.p.r9) { me.p.r9 = 1; changed(); }
  }
  const can9 = (who) => { const me = playerOf(who, false); return !!(me && me.p && me.p.r9); };
  // played level 9 before these boards knew (index.js: the account's stats, or the browser says it saw it): from now on
  // it's known here too
  let reachedBefore = () => false;
  const setReachedBefore = (fn) => { reachedBefore = fn; };

  function sorted(bk) {
    let L = tops.get(bk);
    if (L) return L;
    L = [];
    for (const [k, p] of Object.entries(players)) { const v = p.b && p.b[bk]; if (v) L.push([k, v[0], v[1], v[2]]); }
    L.sort((x, y) => x[1] - y[1] || x[2] - y[2]);
    tops.set(bk, L);
    return L;
  }
  // the swag number of a player (its key) -> cents, or 0 (index.js: accounts whose number shows); on the board on hover
  let paidOf = () => 0;
  const setPaid = (fn) => { paidOf = fn; };
  const acctKey = (sub) => 'a' + hash('a:' + sub);
  const row = (r, me) => {
    const p = players[r[0]], paid = r[0][0] === 'a' ? paidOf(r[0]) : 0;
    return { name: p.n, color: p.c, time: r[1], at: new Date(r[2]).toISOString(), team: r[3], ...(paid ? { paid } : {}), ...(r[0] === me ? { me: true } : {}) };
  };

  // a board: q = { board: { local, easy, mode, level, team }, scope: 'all' | 'friends' | 'group', fids: [...], group: id }
  // -> { board, scope, group?, rows: [...] (rank order), me: { rank, time } | null, n (players on it), can9 }
  function query(who, q) {
    const b = parseBoard(q && q.board);
    let me = playerOf(who, false);
    if (!(me && me.p && me.p.r9) && reachedBefore(who)) { reach(who); me = playerOf(who, false); }
    const key = me ? me.key : '', mine = me && me.p;
    const out = { can9: !!(mine && mine.r9) };
    if (!b) return { ...out, err: 'No such board.' };
    if (b.level === SECRET_LEVEL && !out.can9) return { ...out, err: 'No such board.' };   // (not a word about it)
    const bk = boardKey(b);
    let L = sorted(bk);
    const scope = q.scope === 'friends' || q.scope === 'group' ? q.scope : 'all';
    if (scope === 'friends') {
      const fids = new Set((Array.isArray(q.fids) ? q.fids : []).slice(0, FRIENDS_MAX).filter((f) => typeof f === 'string' && FID.test(f)));
      L = L.filter((r) => r[0] === key || (players[r[0]].f || []).some((f) => fids.has(f)));
    } else if (scope === 'group') {
      const g = groups[q.group];
      if (!g || !key || !g.m.includes(key)) return { ...out, err: 'You are not in that group.' };
      const m = new Set(g.m);
      if (g.fresh) {   // (its own times, since its start)
        L = Object.entries((g.b && g.b[bk]) || {}).filter(([k]) => m.has(k) && players[k]).map(([k, v]) => [k, v[0], v[1], v[2]]);
        L.sort((x, y) => x[1] - y[1] || x[2] - y[2]);
      } else L = L.filter((r) => m.has(r[0]));
    }
    const at = key ? L.findIndex((r) => r[0] === key) : -1;
    return {
      ...out, board: b, scope, ...(scope === 'group' ? { group: q.group } : {}),
      rows: L.slice(0, SHOW).map((r) => row(r, key)), n: L.length,
      me: at >= 0 ? { rank: at + 1, time: L[at][1] } : null,
    };
  }

  // ---- groups
  const memberTok = (id, k) => crypto.createHash('sha256').update('rkr-member:' + id + ':' + k).digest('hex').slice(0, 12);
  const groupInfo = (id, key) => {
    const g = groups[id], own = g.owner === key;
    return {
      id, name: g.name, code: g.code, n: g.m.length, owner: own, ...(g.fresh ? { fresh: new Date(g.fresh).toISOString() } : {}),
      // (its owner sees who is in it, to remove someone)
      ...(own ? { members: g.m.map((k) => ({ t: memberTok(id, k), name: (players[k] && players[k].n) || 'Kitty', ...(k === key ? { me: true } : {}) })) } : {}),
    };
  };
  function groupsOf(who) {
    const key = keyOf(who);
    adopt(who, key);
    return key ? Object.keys(groups).filter((id) => groups[id].m.includes(key)).map((id) => groupInfo(id, key)) : [];
  }
  function newCode() {
    for (;;) {
      let c = '';
      for (const x of crypto.randomBytes(CODE_LEN)) c += CODE_ABC[x % CODE_ABC.length];
      if (!byCode.has(c)) return c;
    }
  }
  function createGroup(who, name, fresh) {
    const me = playerOf(who, true);
    if (!me) return { err: 'Could not make a group right now.' };
    const n = cleanName(name).slice(0, GROUP_NAME_MAX);
    if (!n) return { err: 'Give your group a name.' };
    if (groupsOf(who).length >= GROUPS_PER_PLAYER) return { err: `You can be in ${GROUPS_PER_PLAYER} groups at most. Leave one first.` };
    const id = crypto.randomBytes(6).toString('hex'), code = newCode();
    groups[id] = { name: n, code, owner: me.key, m: [me.key], at: Date.now(), ...(fresh ? { fresh: Date.now(), b: {} } : {}) };
    byCode.set(code, id);
    changed();
    return { group: groupInfo(id, me.key) };
  }
  function joinGroup(who, code) {
    const id = byCode.get(String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, ''));
    if (!id) return { err: 'No group has that code.' };
    const me = playerOf(who, true);
    if (!me) return { err: 'Could not join right now.' };
    const g = groups[id];
    if (g.m.includes(me.key)) return { group: groupInfo(id, me.key) };
    if ((g.out || []).includes(me.key)) return { err: 'You can\'t join that group.' };
    if (g.m.length >= GROUP_MAX) return { err: 'That group is full.' };
    if (groupsOf(who).length >= GROUPS_PER_PLAYER) return { err: `You can be in ${GROUPS_PER_PLAYER} groups at most. Leave one first.` };
    g.m.push(me.key);
    changed();
    return { group: groupInfo(id, me.key) };
  }
  // leave a group (the last one out closes it; its owner leaving hands it to the longest member)
  function leaveGroup(who, id) {
    const key = keyOf(who), g = groups[id];
    if (!key || !g || !g.m.includes(key)) return {};
    g.m = g.m.filter((k) => k !== key);
    if (!g.m.length) { byCode.delete(g.code); delete groups[id]; } else if (g.owner === key) g.owner = g.m[0];
    changed();
    return {};
  }

  // the owner: remove a member (it can't join again with the code), or restart the group's board fresh (from now on)
  function removeMember(who, id, tok) {
    const key = keyOf(who), g = groups[id];
    if (!g || !key || g.owner !== key) return { err: 'Only the group\'s owner can do that.' };
    const k = g.m.find((x) => memberTok(id, x) === tok);
    if (!k || k === key) return {};
    g.m = g.m.filter((x) => x !== k);
    (g.out ||= []).push(k);
    if (g.out.length > 500) g.out.shift();
    if (g.b) for (const bk of Object.keys(g.b)) delete g.b[bk][k];
    changed();
    return {};
  }
  function restartGroup(who, id) {
    const key = keyOf(who), g = groups[id];
    if (!g || !key || g.owner !== key) return { err: 'Only the group\'s owner can do that.' };
    g.fresh = Date.now(); g.b = {};
    changed();
    return {};
  }

  return { setPaid, setReachedBefore, acctKey, record, reach, can9, query, groupsOf, createGroup, joinGroup, leaveGroup, removeMember, restartGroup, flush, keyOf, boardKey, MIN_S, MAX_S, SECRET_LEVEL, LEVELS };
}

export { createLevelBoards, parseBoard };

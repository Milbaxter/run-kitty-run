// Chat / player-name filter (App Store 1.2, Play UGC policy). Small built-in list, tolerant of
// leetspeak, accents, stretched letters ("fuuuck") and spaced-out letters ("f u c k"), but
// word-boundary aware so "class", "Scunthorpe", "therapist" or "cocktail" stay untouched.
import { PLAYER_NAMES } from '../public/js/shared/config.js';

const MASK = '♥♥♥';

// Matched anywhere inside a word (distinctive enough that innocent words rarely contain them).
const INSIDE = `fuck fvck nigger nigga niggaz faggot cunt shit bitch whore slut twat dildo blowjob jizz porn vagina asshole arsehole
  pussy cocksucker bastard pedophil paedophil molest wetback raghead towelhead dickhead orgasm clitoris cumshot handjob
  killyourself killurself`.split(/\s+/);
// Matched only as a whole word (plus plain plurals): these hide inside innocent words.
const WHOLE = `fuk fuq fck fcuk phuk fukk fag fags faggy kike coon gook chink spic beaner tranny dyke negro paki retard retarded
  ass arse piss cum tit tits titty titties boob boobs boobies penis cock dick dicks sex sexy sexting horny wank wanker wanking
  bollocks rape raped raping rapist anal anus milf nude nudes boner clit semen thot kys nazi hitler heil pedo stfu`.split(/\s+/);
// Whole words that contain an INSIDE term but are fine.
const ALLOW = new Set(`scunthorpe shiitake shitake mishit mishits matsushita pussycat pussycats pussywillow retardant
  cockatoo cockatoos`.split(/\s+/));
const PHRASES = [/\bkill (?:your|ur|yo) ?self\b/, /\bgo die\b/];

const WHOLE_SET = new Set();
for (const w of WHOLE) { WHOLE_SET.add(w); WHOLE_SET.add(w + 's'); WHOLE_SET.add(w + 'es'); }

const LEET = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', 9: 'g', '@': 'a', $: 's', '!': 'i', '|': 'l', '+': 't' };
const TOKEN = /[\p{L}\p{N}@$*!|+]+/gu;

// Lower case, strip accents, map leetspeak. Returns [strict, loose] spelling variants: whole-word
// matches use strict ones ("assss" -> "ass"), inside matches also the fully de-doubled ones
// ("shiiit" -> "shit"; not for whole words, or "annals" would read as "anals").
function variants(tok) {
  const s = tok.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/^[!|+*@]+|[!|+*]+$/g, '');
  const strict = new Set(), loose = new Set();
  const add = (v) => {
    v = v.replace(/ph/g, 'f').replace(/[^a-z*]/g, '');
    if (!v) return;
    if (v.includes('*')) { if ((v.match(/\*/g) || []).length <= 2) for (const c of 'aeiou') add(v.replace('*', c)); return; }
    strict.add(v);
    strict.add(v.replace(/(.)\1{2,}/g, '$1$1')); // "fuuuuck" -> "fuuck"
    loose.add(v.replace(/(.)\1+/g, '$1'));       // -> "fuck"
  };
  const leet = (x) => x.replace(/[0-9@$!|+]/g, (c) => LEET[c] ?? c);
  add(leet(s));
  if (s.includes('1')) add(leet(s.replace(/1/g, 'l'))); // "he11"
  return [[...strict], [...strict, ...loose]];
}

function badWord(tok) {
  const [strict, all] = variants(tok);
  if (all.some((v) => ALLOW.has(v))) return false;
  if (strict.some((v) => WHOLE_SET.has(v))) return true;
  return all.some((v) => INSIDE.some((w) => v.includes(w)));
}

// Spans [start, end) of the original text that should be masked.
function badSpans(text) {
  const toks = [];
  for (const m of text.matchAll(TOKEN)) toks.push({ s: m.index, e: m.index + m[0].length, w: m[0] });
  const spans = [];
  for (const t of toks) if (badWord(t.w)) spans.push([t.s, t.e]);
  // runs of single letters with tiny separators: "f u c k", "s.h.i.t"
  for (let i = 0; i < toks.length;) {
    let j = i;
    while (j < toks.length && toks[j].w.length === 1 && (j === i || toks[j].s - toks[j - 1].e <= 2)) j++;
    if (j - i >= 3 && badWord(toks.slice(i, j).map((t) => t.w).join(''))) spans.push([toks[i].s, toks[j - 1].e]);
    i = Math.max(j, i + 1);
  }
  return spans;
}

const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|gg|xyz|ru|me|tv|ly|co|app|dev|info|biz|link|site|online|live|club|top|shop|de|uk|fr|cn|us|to|cc)\b(?:\/\S*)?/gi;

// Chat text: links -> [link], bad words -> ♥♥♥.
function filterChat(text) {
  let s = String(text).replace(URL_RE, '[link]');
  const spans = badSpans(s).sort((a, b) => b[0] - a[0]);
  let lastStart = Infinity;
  for (const [a, b] of spans) {
    if (b > lastStart) continue; // overlapping (spaced run + its own letters)
    s = s.slice(0, a) + MASK + s.slice(b);
    lastStart = a;
  }
  const flat = ' ' + s.toLowerCase().replace(/[^a-z]+/g, ' ') + ' ';
  if (PHRASES.some((re) => re.test(flat))) return MASK;
  return s;
}

function isOffensive(text) {
  const s = String(text);
  if (badSpans(s).length) return true;
  const flat = ' ' + s.toLowerCase().replace(/[^a-z]+/g, ' ') + ' ';
  return PHRASES.some((re) => re.test(flat));
}

// Names are stricter: also check the letters glued together ("Mr.Sh_it"). Offensive -> random safe name.
function filterName(name) {
  const glued = String(name).replace(/[\s._\-~'"`,:;]+/g, '');
  if (isOffensive(name) || (glued.length >= 3 && badWord(glued))) {
    return { name: PLAYER_NAMES[Math.floor(Math.random() * PLAYER_NAMES.length)], changed: true };
  }
  return { name, changed: false };
}

export { filterChat, filterName, isOffensive, MASK };

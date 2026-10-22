// Permanent unlocks on a swag account (server/accounts.js keeps the progress, the account menu shows it, the game puts
// the switched-on items on the kitty). Earned online only (the server runs those games), per player, in every mode:
//   l8: clearing level 8 having reached the goal yourself on every level of the run before it moved on (8 goals in
//       Run only and Skate only, 16 in Run + Skate: the day and night halves each), crowns or not
//   l9: winning the final run (level 9) having reached the goal yourself on every level, the final one included (not
//       carried into the victory party)
//   e8, e9: l8 and l9 in an easy game (a level starts over when everyone is down): the easy games' own unlocks. The
//           same done in a normal game counts for them too (featCount: EASY_ALSO)
//   win: the final run won, for every kitty in the game (crowns or not; easy games too)
//   rev: a kitty revived (by the rescuer; not its own other tab). A swag account also counts the revives its stats had
//        counted before this unlock existed ('past')
//   top1: number 1 on a legends board list of any mode (the first team to beat it; until 2026-10-16 also a fastest game
//         when it was made), kept for good: set by the server from the board (server/legends.js goldenFor), not counted by games
//   fast1: number 1 of a fastest list on the legends board (any mode; online or local, solo or team), kept for good: set
//         by the server too (legends.js bronzeFor)
// Run + Skate is both other modes in one (longer and harder): a feat done there counts in Run only and Skate only too.
// An item unlocks per mode: done `times` times in a mode, it's unlocked (and worn) in that mode only. (`any`: done in any
// mode, it's unlocked for good: the song. `all`: done in all three modes themselves, it's unlocked in every one: the
// chrome kitty.)
// `modes`: the modes it can be earned (and worn) in, when not all three. `total`: all modes added up, worn in every mode.
// A `song` is a new song for the soundtrack (picked in the settings), not something the kitty wears.
// `hidden`: not in the menu at all until it is unlocked (no "locked" row). `slot` + `metal`: one of a slot's items is worn
// at a time (slotMetal: the first switched on, in this order): the lion mane's, the fluffy tail tip's and the sunglasses'
// lenses' own metal (none switched on: the lenses in the kitty's own metal), worn
// on a metal kitty (the chrome / golden kitty, an easy game's bronze / golden one). A metal comes with its kitty (chrome
// with the Chrome kitty, gold with the Golden kitty, bronze with the Bronze kitty). `defaultOff`: not worn until switched on (isWorn; the others are worn as soon as they're unlocked).
const UNLOCK_MODES = ['run', 'ice', 'mixed'];
const UNLOCKS = [
  // the easy games' rewards first (a normal game counts for them too), then the normal games' own
  { id: 'specs', name: 'Reading glasses', feat: 'e8', times: 1 },
  { id: 'gboots', name: 'Golden boots', feat: 'e8', times: 2 },
  { id: 'sskates', name: 'Golden skates', feat: 'e8', times: 3, modes: ['ice', 'mixed'] },   // silver boots, golden blades
  { id: 'bow', name: 'Tail bow', feat: 'e9', times: 1 },
  { id: 'medal', name: 'Gold medal', feat: 'e9', times: 2 },
  { id: 'shades', name: 'Sunglasses', feat: 'l8', times: 1 },
  // a metal kitty's sunglasses without their moving shine: the switch 'Glasses shine' (invert: ON = not worn), with the
  // sunglasses and a metal kitty (chrome, golden or bronze: only their lenses shine)
  { id: 'nolensshine', name: 'Glasses shine', feat: 'l8', times: 1, hidden: true, defaultOff: true, invert: true, part: 'shades', metalKitty: true },
  { id: 'rboots', name: 'Rainbow boots', feat: 'l8', times: 2 },
  { id: 'gskates', name: 'Rainbow skates', feat: 'l8', times: 3, modes: ['ice', 'mixed'] },   // golden boots, rainbow blades (skates: not in Run only, which has no ice)
  { id: 'lion', name: 'Lion mane', feat: 'l9', times: 1 },
  { id: 'tail', name: 'Fluffy tail', feat: 'l9', times: 1 },
  // the fluffy tail tip's glow switched off: shown as the switch 'Tail tip glow' (invert: ON = not worn), with the tail
  { id: 'noglow', name: 'Tail tip glow', feat: 'l9', times: 1, hidden: true, defaultOff: true, invert: true, part: 'tail' },
  { id: 'chrome', name: 'Chrome kitty', feat: 'l9', times: 1, all: true, excl: 'body' },   // (done in all three modes, worn in every one; the mane is the Lion mane's own switch)
  { id: 'mchrome', name: 'Chrome mane', feat: 'l9', times: 1, all: true, hidden: true, defaultOff: true, slot: 'mane', metal: 'chrome' },
  { id: 'tchrome', name: 'Chrome tail tip', feat: 'l9', times: 1, all: true, hidden: true, defaultOff: true, slot: 'tip', metal: 'chrome' },
  { id: 'lchrome', name: 'Chrome lenses', feat: 'l9', times: 1, all: true, hidden: true, defaultOff: true, slot: 'lens', metal: 'chrome' },
  // `excl`: one of these worn at a time (switching one on switches the others off; worn more: golden, then bronze, then chrome)
  { id: 'gold', name: 'Golden kitty', feat: 'top1', times: 1, any: true, hidden: true, excl: 'body' },
  { id: 'mgold', name: 'Golden mane', feat: 'top1', times: 1, any: true, hidden: true, defaultOff: true, slot: 'mane', metal: 'gold' },
  { id: 'tgold', name: 'Golden tail tip', feat: 'top1', times: 1, any: true, hidden: true, defaultOff: true, slot: 'tip', metal: 'gold' },
  { id: 'lgold', name: 'Golden lenses', feat: 'top1', times: 1, any: true, hidden: true, defaultOff: true, slot: 'lens', metal: 'gold' },
  { id: 'bronze', name: 'Bronze kitty', feat: 'fast1', times: 1, any: true, hidden: true, excl: 'body' },
  { id: 'mbronze', name: 'Bronze mane', feat: 'fast1', times: 1, any: true, hidden: true, defaultOff: true, slot: 'mane', metal: 'bronze' },
  { id: 'tbronze', name: 'Bronze tail tip', feat: 'fast1', times: 1, any: true, hidden: true, defaultOff: true, slot: 'tip', metal: 'bronze' },
  { id: 'lbronze', name: 'Bronze lenses', feat: 'fast1', times: 1, any: true, hidden: true, defaultOff: true, slot: 'lens', metal: 'bronze' },
  { id: 'song5', name: 'New song: We Skate', feat: 'win', times: 1, any: true, song: true },
  // the medic badge on the player card (`medic`: its look; more revive rewards may add looks: the card shows the best)
  { id: 'medic', name: 'Medic badge', feat: 'rev', times: 3000, total: true, medic: 'base' },   // (in the kitty's colour)
];
// r9: reached level 9 (any game, easy too); h1: cleared a hell level. Neither unlocks an item: they open hell (hellOpen)
const FEAT_IDS = ['l8', 'l9', 'e8', 'e9', 'win', 'rev', 'r9', 'h1'];
// the medic badge looks, best first: the card shows the first one switched on (none: no badge)
const MEDIC_TIERS = UNLOCKS.filter((u) => u.medic).sort((a, b) => b.times - a.times);
const medicLook = (cos) => { for (const u of MEDIC_TIERS) if (cos.has(u.id)) return u.medic; return ''; };
// a total item's count: every mode's, plus what was counted before (rev.past)
const featTotal = (progress, feat) => { const p = (progress && progress[feat]) || {}; return UNLOCK_MODES.reduce((n, m) => n + (p[m] || 0), 0) + (Number(p.past) || 0); };
// is an unlocked item worn, by its switch (off: { id: true (switched off) / false (switched on) })
const isWorn = (u, off) => (u.defaultOff ? !!off && off[u.id] === false : !(off && off[u.id]));
// a slot's worn metal ('mane' / 'tip'): its first switched-on item's, or null (cos: a Set of worn ids)
const slotMetal = (cos, slot) => { for (const u of UNLOCKS) if (u.slot === slot && cos.has(u.id)) return u.metal; return null; };
const FEATS = { l8: 'Clear level 8 in a normal game reaching every goal', l9: 'Beat level 9 in a normal game reaching every goal', e8: 'Clear level 8 in an easy game reaching every goal', e9: 'Beat level 9 in an easy game reaching every goal', win: 'Clear the final level', rev: 'Revive kitties', r9: 'Reach level 9', h1: 'Clear a hell level' };
// the wins a kitty can have by level 8 (one per level, two per level in Run + Skate)
const winsNeeded = (mode) => (mode === 'mixed' ? 16 : 8);
// how often a feat counts as done in a mode: its own times, and in Run only and Skate only the Run + Skate ones too;
// an easy feat also counts the same feat done in a normal game (the harder one)
const EASY_ALSO = { e8: 'l8', e9: 'l9' };
const featOwn = (progress, feat, mode) => { const p = (progress && progress[feat]) || {}; return (p[mode] || 0) + (mode !== 'mixed' ? p.mixed || 0 : 0); };
const featCount = (progress, feat, mode) => featOwn(progress, feat, mode) + (EASY_ALSO[feat] ? featOwn(progress, EASY_ALSO[feat], mode) : 0);
// progress: { l8: { run, ice, mixed }, l9: { ... } } -> is this item unlocked in this mode? (no mode: in any mode,
// e.g. whether the menu shows its switch)
function isUnlocked(progress, item, mode = null) {
  const u = typeof item === 'string' ? UNLOCKS.find((x) => x.id === item) : item;
  if (!u) return false;
  const p = (progress && progress[u.feat]) || {};
  if (u.total) return featTotal(progress, u.feat) >= u.times;
  const modes = u.modes || UNLOCK_MODES;
  const done = (m) => modes.includes(m) && featCount(progress, u.feat, m) >= u.times;
  if (u.all) return modes.every((m) => (p[m] || 0) >= u.times);   // (each mode itself: Run + Skate doesn't stand in for the others)
  return u.any || !mode ? modes.some(done) : done(mode);
}

// hell (config.js HELL_MODES) in a mode: open once level 9 was reached in any mode (it opens both Hell Run and Hell
// Skate), or a hell level of this mode was cleared (in anyone's lobby)
const hellOpen = (progress, mode) => UNLOCK_MODES.some((m) => featCount(progress, 'r9', m) > 0) || featCount(progress, 'h1', mode) > 0;

export { UNLOCKS, UNLOCK_MODES, FEATS, FEAT_IDS, winsNeeded, isUnlocked, featTotal, featCount, medicLook, slotMetal, isWorn, hellOpen };

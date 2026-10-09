// Permanent unlocks on a swag account (server/accounts.js keeps the progress, the account menu shows it, the game puts
// the switched-on items on the kitty). Earned online only (the server runs those games), per player, in every mode:
//   l8: clearing level 8 having reached the goal yourself on every level of the run before it moved on (8 goals in
//       Run only and Skate only, 16 in Run + Skate: the day and night halves each), crowns or not
//   l9: winning the final run (level 9) having reached the goal yourself on every level, the final one included (not
//       carried into the victory party)
//   win: the final run won, for every kitty in the game (crowns or not)
//   rev: a kitty revived (by the rescuer; not its own other tab). A swag account also counts the revives its stats had
//        counted before this unlock existed ('past')
// An item unlocks per mode: done `times` times in a mode, it's unlocked (and worn) in that mode only. (`any`: done in any
// mode, it's unlocked for good: the song. `all`: done in all three modes, it's unlocked in every one: the chrome lion.)
// `modes`: the modes it can be earned (and worn) in, when not all three. `total`: all modes added up, worn in every mode.
// A `song` is a new song for the soundtrack (picked in the settings), not something the kitty wears.
const UNLOCK_MODES = ['run', 'ice', 'mixed'];
const UNLOCKS = [
  { id: 'shades', name: 'Sunglasses', feat: 'l8', times: 1 },
  { id: 'rboots', name: 'Rainbow boots', feat: 'l8', times: 2 },
  { id: 'gskates', name: 'Golden skates', feat: 'l8', times: 3, modes: ['ice', 'mixed'] },   // (skates: not in Run only, which has no ice)
  { id: 'lion', name: 'Lion mane', feat: 'l9', times: 1 },
  { id: 'tail', name: 'Fluffy tail', feat: 'l9', times: 1 },
  { id: 'chrome', name: 'Chrome lion', feat: 'l9', times: 1, all: true },   // (done in all three modes, worn in every one)
  { id: 'song5', name: 'New song: We Skate', feat: 'win', times: 1, any: true, song: true },
  // the medic badge on the player card (`medic`: its look; more revive rewards may add looks: the card shows the best)
  { id: 'medic', name: 'Medic badge', feat: 'rev', times: 3000, total: true, medic: 'base' },   // (in the kitty's colour)
];
const FEAT_IDS = ['l8', 'l9', 'win', 'rev'];
// the medic badge looks, best first: the card shows the first one switched on (none: no badge)
const MEDIC_TIERS = UNLOCKS.filter((u) => u.medic).sort((a, b) => b.times - a.times);
const medicLook = (cos) => { for (const u of MEDIC_TIERS) if (cos.has(u.id)) return u.medic; return ''; };
// a total item's count: every mode's, plus what was counted before (rev.past)
const featTotal = (progress, feat) => { const p = (progress && progress[feat]) || {}; return UNLOCK_MODES.reduce((n, m) => n + (p[m] || 0), 0) + (Number(p.past) || 0); };
const FEATS = { l8: 'Clear level 8 reaching every goal', l9: 'Beat level 9 reaching every goal', win: 'Clear the final level', rev: 'Revive kitties' };
// the wins a kitty can have by level 8 (one per level, two per level in Run + Skate)
const winsNeeded = (mode) => (mode === 'mixed' ? 16 : 8);
// progress: { l8: { run, ice, mixed }, l9: { ... } } -> is this item unlocked in this mode? (no mode: in any mode,
// e.g. whether the menu shows its switch)
function isUnlocked(progress, item, mode = null) {
  const u = typeof item === 'string' ? UNLOCKS.find((x) => x.id === item) : item;
  if (!u) return false;
  const p = (progress && progress[u.feat]) || {};
  if (u.total) return featTotal(progress, u.feat) >= u.times;
  const modes = u.modes || UNLOCK_MODES;
  const done = (m) => modes.includes(m) && (p[m] || 0) >= u.times;
  if (u.all) return modes.every(done);
  return u.any || !mode ? modes.some(done) : done(mode);
}

export { UNLOCKS, UNLOCK_MODES, FEATS, FEAT_IDS, winsNeeded, isUnlocked, featTotal, medicLook };

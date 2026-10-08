// Permanent unlocks on a swag account (server/accounts.js keeps the progress, the account menu shows it, the game puts
// the switched-on items on the kitty). Earned online only (the server runs those games), per player, in every mode:
//   l8: clearing level 8 having reached the goal yourself on every level of the run before it moved on (8 goals in
//       Run only and Skate only, 16 in Run + Skate: the day and night halves each), crowns or not
//   l9: winning the final run (level 9) having reached the goal yourself on every level, the final one included (not
//       carried into the victory party)
//   win: the final run won, for every kitty in the game (crowns or not)
// An item unlocks per mode: done `times` times in a mode, it's unlocked (and worn) in that mode only. (`any`: done in any
// mode, it's unlocked for good: the song. `all`: done in all three modes, it's unlocked in every one: the chrome lion.)
// A `song` is a new song for the soundtrack (picked in the settings), not something the kitty wears.
const UNLOCK_MODES = ['run', 'ice', 'mixed'];
const UNLOCKS = [
  { id: 'shades', name: 'Sunglasses', feat: 'l8', times: 1 },
  { id: 'rboots', name: 'Rainbow boots', feat: 'l8', times: 2 },
  { id: 'gskates', name: 'Golden skates', feat: 'l8', times: 3 },
  { id: 'lion', name: 'Lion mane', feat: 'l9', times: 1 },
  { id: 'tail', name: 'Fluffy tail', feat: 'l9', times: 1 },
  { id: 'chrome', name: 'Chrome lion', feat: 'l9', times: 1, all: true },   // (done in all three modes, worn in every one)
  { id: 'song5', name: 'New song: We Skate', feat: 'win', times: 1, any: true, song: true },
];
const FEAT_IDS = ['l8', 'l9', 'win'];
const FEATS = { l8: 'Clear level 8 reaching every goal', l9: 'Beat level 9 reaching every goal', win: 'Clear the final level' };
// the wins a kitty can have by level 8 (one per level, two per level in Run + Skate)
const winsNeeded = (mode) => (mode === 'mixed' ? 16 : 8);
// progress: { l8: { run, ice, mixed }, l9: { ... } } -> is this item unlocked in this mode? (no mode: in any mode,
// e.g. whether the menu shows its switch)
function isUnlocked(progress, item, mode = null) {
  const u = typeof item === 'string' ? UNLOCKS.find((x) => x.id === item) : item;
  if (!u) return false;
  const p = (progress && progress[u.feat]) || {};
  const done = (m) => (p[m] || 0) >= u.times;
  if (u.all) return UNLOCK_MODES.every(done);
  return u.any || !mode ? UNLOCK_MODES.some(done) : UNLOCK_MODES.includes(mode) && done(mode);
}

export { UNLOCKS, UNLOCK_MODES, FEATS, FEAT_IDS, winsNeeded, isUnlocked };

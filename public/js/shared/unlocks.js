// Permanent unlocks on a swag account (server/accounts.js keeps the progress, the account menu shows it, the game puts
// the switched-on items on the kitty). Earned online only (the server runs those games), per player, in every mode:
//   l8: clearing level 8 while holding all its wins: 8 in Run only and Skate only, 16 in Run + Skate (day crowns count)
//   l9: winning the final run (level 9) as one of the kitties that got to the end themselves, holding 8 crowns (16 in
//       Run + Skate) by then: the final run's own crown counts (the hardest one, it may make up for a missed one)
//   win: the final run won, for every kitty in the game (crowns or not)
// An item unlocks when its feat is done `times` times in each of the three modes (`any`: in any one of them).
// A `song` is a new song for the soundtrack (picked in the settings), not something the kitty wears.
const UNLOCK_MODES = ['run', 'ice', 'mixed'];
const UNLOCKS = [
  { id: 'shades', name: 'Sunglasses', feat: 'l8', times: 1 },
  { id: 'rboots', name: 'Rainbow boots', feat: 'l8', times: 2 },
  { id: 'gskates', name: 'Golden skates', feat: 'l8', times: 3 },
  { id: 'lion', name: 'Lion mane', feat: 'l9', times: 1 },
  { id: 'tail', name: 'Fluffy tail', feat: 'l9', times: 1 },
  { id: 'chrome', name: 'Chrome lion', feat: 'l9', times: 2 },
  { id: 'song5', name: 'New song: We Skate', feat: 'win', times: 1, any: true, song: true },
];
const FEAT_IDS = ['l8', 'l9', 'win'];
const FEATS = { l8: 'Clear level 8 with every win', l9: 'Beat level 9 with every win', win: 'Clear the final level' };
// the wins a kitty needs in a mode (one per level, two per level in Run + Skate)
const winsNeeded = (mode) => (mode === 'mixed' ? 16 : 8);
// progress: { l8: { run, ice, mixed }, l9: { ... } } -> is this item unlocked?
function isUnlocked(progress, item) {
  const u = typeof item === 'string' ? UNLOCKS.find((x) => x.id === item) : item;
  if (!u) return false;
  const p = (progress && progress[u.feat]) || {};
  return UNLOCK_MODES[u.any ? 'some' : 'every']((m) => (p[m] || 0) >= u.times);
}

export { UNLOCKS, UNLOCK_MODES, FEATS, FEAT_IDS, winsNeeded, isUnlocked };

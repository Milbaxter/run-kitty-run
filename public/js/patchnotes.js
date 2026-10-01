// Player-facing patch notes, newest first. Shown on the title screen (desktop).
// When you ship something players will notice, add a line to the top entry (or start a new one).
const PATCH_NOTES = [
  {
    version: '0.8', date: '2026-10-01', title: 'Ice skating (test)',
    items: [
      'Test build: every level is the Snowy Peaks ice rink',
      'On ice your kitty keeps sliding the way it faces until you click a new direction',
      'Turning around carves a small curve instead of flipping on the spot',
      'Safe stone squares and the goal room are not ice: walk normally there (and stop)',
    ],
  },
  {
    version: '0.7', date: '2026-10-01', title: 'Phones & the final stretch',
    items: [
      'Play on your phone: hold your thumb down and your kitty follows it (tap to run to a spot)',
      'Phones: landscape mode, hideable HUD (off by default) and lighter graphics',
      'Hide or show the HUD any time with the eye button or H',
      'The last stretch before the goal is much harder: more wolves and no safe corners on it at all',
      'Revives now take 0.5 s after a kitty goes down',
      'Two soundtrack songs on repeat, and music is on by default',
    ],
  },
  {
    version: '0.6', date: '2026-10-01', title: 'Smarter, faster wolves',
    items: [
      'Wolves run at about 80% of your speed',
      'No more warning before a wolf moves, and they no longer turn before setting off',
      'Wolves sometimes stand still for a few seconds',
      'Every wolf is a roaming wanderer',
      '20% more wolves, and it gets harder the closer you get to the middle',
    ],
  },
  {
    version: '0.5', date: '2026-10-01', title: 'Score & teamwork',
    items: [
      'Scoreboard (top right): +1 for every friend you save, -1 every time you are caught',
      'When one kitty reaches the goal, everyone respawns at the start of the next level',
      'Safe corners now have their own paw-print stone floor',
    ],
  },
  {
    version: '0.4', date: '2026-10-01', title: 'The square spiral',
    items: [
      'Brand new map: a square spiral from the top-left corner to the glowing heart',
      'Wider lanes and bigger wolves',
      'Corner squares are wolf-free safe spots',
    ],
  },
  {
    version: '0.3', date: '2026-10-01', title: 'Chat & cleanup',
    items: [
      'Lobby chat: press Enter to talk, speech bubbles appear over your kitty',
      'Golden fish removed; speed boots stack only once',
      'No invulnerability after a friend revives you',
    ],
  },
  {
    version: '0.2', date: '2026-10-01', title: 'Online multiplayer',
    items: [
      'Online lobbies for up to 8 kitties: create one, share the code or link, the host starts the run',
      'Join a run that is already going',
    ],
  },
];

export { PATCH_NOTES };

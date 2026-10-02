// Player-facing patch notes, newest first. Shown on the title screen (desktop).
// When you ship something players will notice, add a line to the top entry (or start a new one).
const PATCH_NOTES = [
  {
    version: '1.0', date: '2026-10-02', title: 'The final run',
    items: [
      'Skate only now has an ending: level 8 is THE FINAL RUN',
      'One long straight sheet of ice packed with wolves: no safe squares, no checkpoints, and you can never stop, only carve circles while you wait for a gap',
      'Halfway there is a single tree: climb under its branches to catch your breath, wolves can\'t reach you up there',
      'The camera flies down the whole run before you start (touch anything to skip)',
      'A progress bar replaces the minimap on the final run: start flag, the tree, the finish, every kitty as a dot in its colour and how many metres are left',
      'Reach the end and you beat Run Kitty Run: fireworks, confetti, a fanfare and a victory screen with your run time, rescues, and who got there first',
      'Every kitty that went down on the way is carried into the goal room for the party',
      'Menus and the game-over / victory screens work with a gamepad too (A to confirm, d-pad to switch)',
    ],
  },
  {
    version: '0.9', date: '2026-10-02', title: 'Wolf patterns on ice',
    items: [
      'Skate only: wolves don\'t wander anymore, they run fixed patterns you can learn',
      'Every wolf goes end to end: across the lane from wall to wall, or charging down its own lane from one safe square to the next',
      'Many more wolves on ice: rows of crossers and lanes of chargers, busier and faster toward the middle and on later levels',
      'Wolves never stand still: they turn straight round at each end. In many rooms one or two wolves run a little faster or slower than the rest, so the pattern slowly slides out of step and comes back together within a minute (there is always a gap)',
      'Watch from a safe square, spot the rhythm, then skate through the gap',
      'Fixed: a key or joystick still held when a level starts no longer shoots your kitty off the start square onto the ice (let go once, then skate)',
      'Run + Skate is unchanged',
      'Wolves no longer have a glowing ring around them, and no ring flashes when they start moving',
      'Fixed: the aura faded out on parts of the ice rink',
      'Fixed: clicking right after reaching a checkpoint (or holding the mouse as you arrive) could leave your kitty stuck there',
      'Your kitty\'s tail now swings out when you carve a turn on the ice, and streams behind you as you glide',
      'The minimap is now square, so you can see the whole maze, corners included',
      'Finish 4+ runs first and your aura leaves a short trail of flames in your kitty\'s colour behind you as you move',
      'Skate only: wolves no longer wear skates, they trot across the ice on their own paws like on every other level',
      'The crown you wear is a little smaller',
      'Winning a level (finishing first) is now worth +20 on the scoreboard',
      'Once you grab the crown you keep wearing it for the rest of the run, even after someone else grabs the next one',
      'New win rewards: from 2 wins your kitty leaves little paw prints in its own colour instead of dust, and its skate marks on the ice are in its colour too',
      'The aura now comes at 3 wins (was 2), and the flame trail at 4 (was 3)',
      'Your crown collects a gem for every win from 2 to 6: blue, yellow, red, purple and green',
      'Win 6 runs and your aura, flame trail, paw prints and skate marks cycle through every kitty colour',
    ],
  },
  {
    version: '0.8', date: '2026-10-01', title: 'Ice skating',
    items: [
      'New STATS page on the title screen (computer): how many people have played, runs, levels, play time and which modes people play',
      'The aura (finish 2+ runs first) is now a super-saiyan flame aura in your kitty\'s own colour, and it shows on snow and ice too',
      'You can see your speed boots: each pair you pick up puts a little red boot on one more paw',
      'Online lobbies now hold up to 32 kitties',
      'Autumn levels have a climbable tree in every lane: run under it to climb up, wolves can\'t reach you there (room for several kitties), and there\'s a pair of speed boots on top of each one',
      'The crown you wear is bigger and shinier',
      'The crown is now a real pickup: it floats just inside the goal room\'s door, in front of the portal, and whoever touches it first wears it',
      'Speed boots: carry up to 4 pairs now, +5% each (+20% with all four)',
      'Levels follow the seasons: summer, autumn, winter (the ice rink), then a brand-new spring level, and repeat',
      'On ice your kitty keeps sliding the way it faces until you click a new direction',
      'Turning around carves a small curve instead of flipping on the spot',
      'Safe stone squares and the goal room are not ice: walk normally there (and stop)',
      'Kitties wear ice skates on the rink and leave skate marks behind them',
      'Online: whoever creates a lobby picks the mode: Run + Skate, Run only, or Skate only',
      'Phones: a floating joystick appears wherever you put your thumb, so your finger never covers your kitty',
      'Ice levels have two checkpoint flags (a third of the way in, and five safe squares before the end): reaching one revives everyone and gathers the team there',
    ],
  },
  {
    version: '0.7', date: '2026-10-01', title: 'Phones & the final stretch',
    items: [
      'Bragging rights: whoever finished the last run wears a crown 👑, finish 2+ runs to get a glowing aura',
      'Speed boots: carry up to 2 pairs (+12%), but you lose them when you are caught',
      'Send us feedback and ideas: a button appears while your kitty is down and on game over',
      'New main menu order: 1 Multiplayer, 2 Single player, 3 Local co-op',
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

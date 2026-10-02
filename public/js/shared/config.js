
// Shared tuning constants. Pure data, no three.js.

const CFG = {
  TICK: 1 / 60,

  // Kitty
  KITTY_RADIUS: 0.4,
  KITTY_SPEED: 6.5,          // units / second at speedMult 1
  KITTY_ACCEL_TAU: 0.05,     // velocity smoothing time constant (s)
  KITTY_HIT_SCALE: 0.85,     // kitty hitbox = radius * this
  SPEED_BOOST: 0.05,         // +5% per boots
  SPEED_MULT_MAX: 1.2,       // four pairs of boots max (lost when caught)
  MAX_EXTRA_LIVES: 1,
  SPAWN_INVULN: 2.0,         // seconds after level start / revive
  SHIELD_TIME: 4.0,          // seconds from shield pickup

  // Ice (the snowy level): on ice a kitty keeps sliding at full speed in the way it faces and
  // can only turn at ICE_TURN_RATE, so reversing carves a small U-turn instead of flipping around.
  ICE_TURN_RATE: 5.5,        // rad/s (turn radius = speed / rate, ~1.2 units)
  ICE_ACCEL_TAU: 0.3,        // speed build-up time constant on ice (s)
  ICE_TEST: false,           // true = every level is the snowy ice level (for testing)

  // Revive
  REVIVE_DELAY: 0.5,         // seconds after going down before a friend can revive you
  REVIVE_RADIUS: 1.1,        // circle radius; living kitty center within REVIVE_RADIUS + KITTY_RADIUS revives

  // Maze geometry
  CENTER_RADIUS: 5.0,        // radius of goal area wall
  RING_WIDTH: 10.8,          // corridor width
  WALL_THICKNESS: 0.5,
  WALL_HEIGHT: 1.4,
  GAP_WIDTH: 2.8,            // linear width of a gap in a ring wall (units)
  START_SAFE_ARC: 7.0,       // linear arc length (units) on each side of start angle with no enemies

  // Enemies
  WOLF_RADIUS: 0.66,
  WOLF_HIT_SCALE: 0.8,

  // Items
  ITEM_RADIUS: 0.6,
  CROWN_RADIUS: 1.0,         // pickup radius of the crown over the goal room's middle
  TREE_RADIUS: 1.7,          // autumn levels: a kitty this close to a climbable tree's trunk is up in it (safe)         // pickup radius of the crown over the goal's center

  // Flow
  LEVEL_CLEAR_TIME: 2.4,     // seconds of celebration before next level
};

// Loops of the (fixed) square spiral map (see maze.js).
const MAP_RINGS = 6;

// Difficulty curve. level starts at 1.
function levelParams(level) {
  const L = Math.max(1, level | 0);
  // The map is the same every level (fixed spiral, see maze.js); only the wolves scale.
  // Every wolf is a wanderer (roams to random spots in its territory); levels scale speed/pauses/territory.
  const types = ['wanderer'];
  return {
    rings: MAP_RINGS,                                               // fixed: same map every level
    // Fixed wolf count on every level (~1 wolf per 4 units of the ~840-unit square spiral);
    // levels get harder through speed, shorter pauses, bigger territories and new wolf types.
    enemyCount: 216,
    enemySpeed: CFG.KITTY_SPEED * Math.min(0.8 * (1 + 0.025 * (L - 1)), 0.88), // ~80% of kitty speed, creeping up per level
    enemyPauseScale: Math.max(0.4, 1 - 0.07 * (L - 1)),             // wolves rest less each level
    enemyTypes: types,
    itemCount: 8 + Math.floor(L / 2),
    // Skate only mode: pattern wolves (maze.js placePatternEnemies). Level part of the room difficulty
    // (level 1's first legs are gentle lessons; each leg adds up to +0.5 toward the middle): faster wolves,
    // shorter holds, more crosser rows and charger lanes, tighter launch windows.
    patternHeat: Math.min(1.2, 0.2 + 0.17 * (L - 1)),
  };
}

// Kitty colors + default names for up to 32 players (online lobbies hold NET.MAX_PLAYERS).
const PLAYER_COLORS = [
  0xffb347, 0x6ec6ff, 0xff7eb6, 0x9dff7a, 0xc59bff, 0xfff06a, 0x5ff3d0, 0xff6b5b,
  0xffd9a0, 0x3d8bff, 0xd94fff, 0x4fd16a, 0xff9e3d, 0xa8f0ff, 0xffb3d1, 0xc8ff4f,
  0x8f7bff, 0xffe0f0, 0x2fd6b0, 0xff4f8b, 0xb8885a, 0x7fb4ff, 0xf2f2f2, 0xe8c547,
  0x6fe8e8, 0xff7a3d, 0xb0ffb0, 0xd0a8ff, 0xff9999, 0x9fe05f, 0x5fb8d6, 0xffc0ff,
];
const PLAYER_NAMES = [
  'Mittens', 'Biscuit', 'Pixel', 'Noodle', 'Pumpkin', 'Waffles', 'Mochi', 'Ziggy',
  'Pepper', 'Muffin', 'Socks', 'Tofu', 'Ginger', 'Luna', 'Peanut', 'Sushi',
  'Cookie', 'Bean', 'Olive', 'Nacho', 'Toast', 'Pickle', 'Maple', 'Clover',
  'Bubbles', 'Taco', 'Mango', 'Sprout', 'Dumpling', 'Kiwi', 'Pudding', 'Whiskers',
];

// Online play
const NET = {
  MAX_PLAYERS: 32,
  SNAP_EVERY: 3,       // server sends a snapshot every N ticks (20 Hz)
  INPUT_LEAD: 3,       // ticks of safety margin client inputs should arrive ahead of the server
};

export { CFG, MAP_RINGS, levelParams, PLAYER_COLORS, PLAYER_NAMES, NET };

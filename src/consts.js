// ---------------------------------------------------------------------------
// Everything the simulation measures against, in one place.
//
// Units are metres, seconds and metres per second. The game is Y-up with the
// field's length on X: Blue defends the goal at -X and attacks +X, Orange the
// reverse. A car's forward is its local +X, up is +Y and right is +Z.
//
// tools/blender/arena.py models the stadium against these same numbers, so
// changing a field dimension here means rebuilding the arena art too.
// ---------------------------------------------------------------------------

export const PROTO_VERSION = 4;
export const SIGNAL_PREFIX = 'turbokick-v1-';

export const TEAM = { BLUE: 0, ORANGE: 1 };
export const TEAM_NAME = ['Blue', 'Orange'];
export const TEAM_COLOR = [0x2f7cff, 0xff8a1f];
export const TEAM_CSS = ['#3d8bff', '#ff9431'];
export const MAX_TEAM = 4;

// ---------------------------------------------------------------- the field
export const FIELD = {
  L: 46,        // half-length: end walls at x = +-L
  W: 32,        // half-width: side walls at z = +-W
  H: 20,        // ceiling
  C: 8,         // corner chamfer, measured along each wall
  GW: 9,        // goal mouth half-width
  GH: 7.5,      // goal mouth height
  GD: 7,        // goal depth behind the line
  POST_R: 0.25, // radius of posts and crossbar
};

// -------------------------------------------------------------------- ball
export const BALL = {
  R: 1.9,
  GRAVITY: 15,
  DRAG: 0.03,         // per second, proportional
  MAX_SPEED: 55,
  BOUNCE: 0.62,       // restitution against the arena
  MU: 0.32,           // Coulomb friction against the arena (couples spin and travel)
  MU_CAR: 0.22,       // ... and against a car's bodywork
  INERTIA: 0.4,       // I = INERTIA * m * R^2 (solid sphere)
  SPIN_DRAG: 0.08,    // per second, in the air
  MAX_SPIN: 30,       // rad/s; about rolling at top speed
  ROLL_DECEL: 1.2,    // m/s^2 while rolling on the floor
  MASS: 1,
};

// --------------------------------------------------------------------- car
export const CAR = {
  HX: 1.75, HY: 0.6, HZ: 1.05,  // hitbox half-extents (length, height, width)
  RIDE: 0.9,          // hitbox centre height while on the ground
  WALL_R: 1.25,       // sphere used against walls and ceiling
  BUMP_R: 1.45,       // sphere used against other cars
  MASS: 4,

  THROTTLE_ACC: 17,   // at a standstill, tapering to 0 at MAX_DRIVE
  MAX_DRIVE: 16,      // top speed without boost
  REVERSE_MAX: 10,
  BRAKE: 34,
  COAST: 4.5,
  BOOST_ACC: 21,
  MAX_SPEED: 28,
  SUPERSONIC: 24,

  GRIP: 13,           // how fast sideways velocity dies (per second)
  DRIFT_GRIP: 2.2,
  TURN_R_SLOW: 3.4,   // turning radius at low speed ...
  TURN_R_FAST: 12,    // ... and at MAX_SPEED
  MAX_YAW_RATE: 3.6,
  DRIFT_TURN: 1.4,

  GRAVITY: 15,
  JUMP_V: 7.2,
  JUMP_HOLD_ACC: 26,  // extra lift while the button is held ...
  JUMP_HOLD_T: 0.2,   // ... for this long after take-off
  DOUBLE_V: 6.8,
  DODGE_WINDOW: 1.4,  // second jump must come within this long of the first
  DODGE_V: 9,
  DODGE_T: 0.62,      // how long the flip takes
  AIR_ACC: 13,        // angular acceleration from the stick, rad/s^2
  AIR_DAMP: 3.2,
  AIR_MAX_W: 5.5,
  AIR_BOOST_ACC: 19,

  BOOST_USE: 33,      // per second
  BOOST_START: 34,

  HIT_E: 0.55,        // restitution car -> ball
  // Extra ball speed per m/s of closing speed, by closing speed: strong for a
  // real hit, tapering for a full-speed smash, and ~0 base so a gentle touch
  // stays gentle (that's what lets a ball sit on a roof for a dribble).
  HIT_CURVE: [[0, 0.62], [23, 0.5], [46, 0.42]],
  HIT_FWD: 0.35,      // how much the nose's direction is taken out of the aim
  DODGE_HIT: 1.35,    // punch multiplier during a flip
  FLIP_CANCEL: 14,    // how fast stick-against-the-flip stops its rotation
  DEMO_SPEED: 22,     // closing speed an attacker needs to demolish
  RESPAWN_T: 3,
};

// ------------------------------------------------------------------ match
export const MATCH = {
  COUNTDOWN: 3,
  GOAL_PAUSE: 3.2,
  LENGTHS: [120, 180, 300],
};

// -------------------------------------------------------------- boost pads
// Mirrored across both axes, so neither team and neither side is favoured.
function mirrored(list, big) {
  const out = [];
  const seen = new Set();
  for (const [x, z] of list) {
    for (const sx of [1, -1]) for (const sz of [1, -1]) {
      const p = [x * sx, z * sz];
      const k = p.join(',');
      if (seen.has(k)) continue;
      seen.add(k);
      out.push({ x: p[0], z: p[1], big });
    }
  }
  return out;
}
export const PADS = [
  ...mirrored([[36.5, 24], [0, 28]], true),
  ...mirrored([[41, 10], [30, 0], [25, 15], [14, 25], [12, 8], [0, 12], [20, 0]], false),
];
export const PAD = {
  BIG: { amount: 100, r: 2.1, respawn: 10 },
  SMALL: { amount: 12, r: 1.4, respawn: 4 },
};

// ---------------------------------------------------------------- kickoff
// Blue's five kickoff spots; Orange's are the same points rotated 180 degrees.
export const KICKOFF_SPOTS = [
  { x: -26, z: -19 }, { x: -26, z: 19 },   // diagonals
  { x: -35, z: -2.5 }, { x: -35, z: 2.5 }, // off-centre
  { x: -41.5, z: 0 },                      // goalie
];
export const RESPAWN_SPOTS = [
  { x: -40, z: -20 }, { x: -40, z: 20 }, { x: -43, z: -9 }, { x: -43, z: 9 },
];

export const CAR_TYPES = [
  { id: 'comet', name: 'Comet', blurb: 'All-rounder. Tall cabin, easy to read in the air.' },
  { id: 'stinger', name: 'Stinger', blurb: 'Long and low. Sneaks under the ball.' },
  { id: 'bulldog', name: 'Bulldog', blurb: 'A brick with a bull bar. Owns the corners.' },
];

export const BOT_LEVELS = [
  { id: 0, name: 'Rookie' },
  { id: 1, name: 'Pro' },
  { id: 2, name: 'All-Star' },
];

// Input button bits.
export const BTN = { JUMP: 1, BOOST: 2, DRIFT: 4, ROLL_L: 8, ROLL_R: 16 };

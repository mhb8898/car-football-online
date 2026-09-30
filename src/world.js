// ---------------------------------------------------------------------------
// The simulation: cars, ball, boost pads, and the match around them.
//
// This file runs in two places and must behave identically in both:
//
//   HOST    - the authority. Owns the match: goals, kickoffs, the clock.
//   CLIENT  - a prediction. Loads each snapshot and replays its own
//             unacknowledged inputs on top, so the ball and every car are
//             drawn where they are *now* rather than a round trip ago.
//             `predict: true` turns off everything only the host may decide
//             (scoring and kickoff resets); the physics is shared line for
//             line.
//
// So: no Math.random() in the physics, no wall-clock time, no DOM. Everything
// a car needs to take its next step is a plain field on the car, because
// every one of those fields has to fit in a snapshot for the replay to land
// where the host did. The one thing a client cannot know - what other players
// will press next - is guessed as "the same as last time", and the next
// snapshot corrects it.
// ---------------------------------------------------------------------------

import {
  FIELD as F, BALL as B, CAR as K, MATCH, PADS, PAD, KICKOFF_SPOTS, RESPAWN_SPOTS, BTN, TEAM,
} from './consts.js';

export const TICK = 1 / 60;
const SUBSTEPS = 2;
const SQ2 = Math.SQRT2;

export const PHASE = { COUNTDOWN: 0, PLAY: 1, GOAL: 2, END: 3 };
export const EV = { HIT: 1, GOAL: 2, DEMO: 3, PAD: 4, BOUNCE: 5, JUMP: 6, DODGE: 7, KICKOFF: 8, END: 9 };

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;

// --------------------------------------------------------------- quaternions
// Minimal, allocation-free where it matters. q = { qx, qy, qz, qw } on a car.
const V = { x: 0, y: 0, z: 0 };
/** Rotate (x, y, z) by the car's orientation into `out`. */
export function rotate(c, x, y, z, out = V) {
  const { qx, qy, qz, qw } = c;
  const ix = qw * x + qy * z - qz * y;
  const iy = qw * y + qz * x - qx * z;
  const iz = qw * z + qx * y - qy * x;
  const iw = -qx * x - qy * y - qz * z;
  out.x = ix * qw + iw * -qx + iy * -qz - iz * -qy;
  out.y = iy * qw + iw * -qy + iz * -qx - ix * -qz;
  out.z = iz * qw + iw * -qz + ix * -qy - iy * -qx;
  return out;
}
/** Inverse rotation: world vector into the car's local frame. */
function unrotate(c, x, y, z, out = V) {
  const s = { qx: -c.qx, qy: -c.qy, qz: -c.qz, qw: c.qw };
  return rotate(s, x, y, z, out);
}
function setYaw(c, yaw) { c.qx = 0; c.qy = Math.sin(yaw / 2); c.qz = 0; c.qw = Math.cos(yaw / 2); }
/** Heading of the car's nose on the ground plane (0 = facing +X). */
export function yawOf(c) {
  const f = rotate(c, 1, 0, 0, {});
  if (f.x * f.x + f.z * f.z < 0.04) {
    // Nose straight up or down: use where the roof points instead.
    const u = rotate(c, 0, 1, 0, {});
    return Math.atan2(u.z * Math.sign(f.y), -u.x * Math.sign(f.y));
  }
  return Math.atan2(-f.z, f.x);
}
/** Apply a local-frame angular velocity for dt (q = q * dq). */
function spinLocal(c, wx, wy, wz, dt) {
  const ang = Math.hypot(wx, wy, wz) * dt;
  if (ang < 1e-9) return;
  const s = Math.sin(ang / 2) / (ang / dt);
  const dx = wx * s, dy = wy * s, dz = wz * s, dw = Math.cos(ang / 2);
  const { qx, qy, qz, qw } = c;
  c.qx = qw * dx + qx * dw + qy * dz - qz * dy;
  c.qy = qw * dy - qx * dz + qy * dw + qz * dx;
  c.qz = qw * dz + qx * dy - qy * dx + qz * dw;
  c.qw = qw * dw - qx * dx - qy * dy - qz * dz;
  const n = Math.hypot(c.qx, c.qy, c.qz, c.qw);
  c.qx /= n; c.qy /= n; c.qz /= n; c.qw /= n;
}

// ----------------------------------------------------------------- the arena
// Sphere-vs-arena contact. The arena is a box with chamfered corners, a hole
// in each end wall, a goal box behind each hole, and the hole's frame (posts
// and crossbar) as thin cylinders. Returns the deepest penetration found and
// leaves its normal in C.
const C = { nx: 0, ny: 0, nz: 0 };
let best = 0;
function consider(nx, ny, nz, depth) {
  if (depth > best) { best = depth; C.nx = nx; C.ny = ny; C.nz = nz; }
}
function segment(o, r, ax, ay, az, bx, by, bz) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const t = clamp(((o.x - ax) * dx + (o.y - ay) * dy + (o.z - az) * dz) / (dx * dx + dy * dy + dz * dz), 0, 1);
  const px = o.x - (ax + dx * t), py = o.y - (ay + dy * t), pz = o.z - (az + dz * t);
  const d = Math.hypot(px, py, pz);
  if (d < 1e-6) return;
  const depth = r + F.POST_R - d;
  if (depth > best) { best = depth; C.nx = px / d; C.ny = py / d; C.nz = pz / d; }
}
function arenaContact(o, r, floor) {
  best = 0;
  const { x, y, z } = o;
  if (floor) consider(0, 1, 0, r - y);
  consider(0, -1, 0, r - (F.H - y));
  consider(0, 0, 1, r - (z + F.W));
  consider(0, 0, -1, r - (F.W - z));
  for (const sx of [1, -1]) {
    for (const sz of [1, -1]) {
      const d = (F.L + F.W - F.C - (sx * x + sz * z)) / SQ2;
      consider(-sx / SQ2, 0, -sz / SQ2, r - d);
    }
    const ax = sx * x;                     // how far toward this end
    if (ax < F.L - r - F.POST_R - 0.5) continue;
    const mouth = Math.abs(z) < F.GW && y < F.GH;
    if (!mouth) {
      consider(-sx, 0, 0, r - (F.L - ax));
    } else if (ax > F.L) {
      consider(-sx, 0, 0, r - (F.L + F.GD - ax));
      consider(0, 0, 1, r - (z + F.GW));
      consider(0, 0, -1, r - (F.GW - z));
      consider(0, -1, 0, r - (F.GH - y));
    }
    const gx = sx * F.L;
    segment(o, r, gx, 0, -F.GW, gx, F.GH, -F.GW);
    segment(o, r, gx, 0, F.GW, gx, F.GH, F.GW);
    segment(o, r, gx, F.GH, -F.GW, gx, F.GH, F.GW);
  }
  return best;
}

/**
 * Push a sphere out of the arena and bounce it. Resting contact (a slow
 * approach) just cancels the inward speed: bouncing it would make a ball on
 * the floor jitter, and applying friction to it would stop a rolling ball dead.
 * Returns the hardest impact speed, for sound.
 */
function collideArena(o, r, floor, e, fric) {
  let impact = 0;
  for (let it = 0; it < 4; it++) {
    const d = arenaContact(o, r, floor);
    if (d <= 0) break;
    o.x += C.nx * d; o.y += C.ny * d; o.z += C.nz * d;
    const vn = o.vx * C.nx + o.vy * C.ny + o.vz * C.nz;
    if (vn >= 0) continue;
    const tx = o.vx - C.nx * vn, ty = o.vy - C.ny * vn, tz = o.vz - C.nz * vn;
    if (-vn > 2.5) {
      impact = Math.max(impact, -vn);
      const k = 1 - fric;
      o.vx = tx * k - C.nx * vn * e; o.vy = ty * k - C.ny * vn * e; o.vz = tz * k - C.nz * vn * e;
    } else {
      o.vx = tx; o.vy = ty; o.vz = tz;
    }
  }
  return impact;
}

// ------------------------------------------------------------------ helpers
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const NO_INPUT = Object.freeze({ t: 0, s: 0, b: 0 });

export function makeCar(id, team, type = 0) {
  return {
    id, team, type,
    x: 0, y: K.RIDE, z: 0, vx: 0, vy: 0, vz: 0,
    qx: 0, qy: 0, qz: 0, qw: 1,
    wx: 0, wy: 0, wz: 0,         // angular velocity, car-local frame
    boost: K.BOOST_START,
    grounded: true, jumped: false, doubled: false, dodging: false, jumpHeld: false,
    jumpT: 0, dodgeT: 0,
    demo: false, respawnT: 0,
    hitCd: 0,                    // seconds until this car may punch the ball again
    inp: NO_INPUT,               // the input applied on the last tick
    ack: 0,                      // seq of that input (for client reconciliation)
    stats: { score: 0, goals: 0, assists: 0, saves: 0, shots: 0, touches: 0, demos: 0 },
  };
}

// ===========================================================================
export class World {
  /**
   * @param opts.length   match length in seconds
   * @param opts.predict  true on clients: physics only, no scoring or resets
   * @param opts.seed     host-only randomness (kickoff spot shuffles)
   */
  constructor(opts = {}) {
    this.predict = !!opts.predict;
    this.length = opts.length || 180;
    this.rng = mulberry32(opts.seed ?? 1);
    this.tick = 0;
    this.phase = PHASE.COUNTDOWN;
    this.phaseT = MATCH.COUNTDOWN;
    this.clock = this.length;       // seconds left, or overtime seconds elapsed
    this.overtime = false;
    this.lastCall = false;           // clock hit zero: ends when the ball lands
    this.score = [0, 0];
    this.ball = { x: 0, y: B.R, z: 0, vx: 0, vy: 0, vz: 0, live: true };
    this.cars = [];
    this.pads = PADS.map((p) => ({ ...p, t: 0 }));  // t > 0: respawning
    this.events = [];
    this.touches = [];               // recent touches, newest last: { id, team, tick }
    this.lastGoal = null;
    this.winner = -1;
  }

  addCar(id, team, type = 0) {
    const c = makeCar(id, team, type);
    this.cars.push(c);
    this.placeForRespawn(c);
    return c;
  }
  removeCar(id) { this.cars = this.cars.filter((c) => c.id !== id); }
  car(id) { return this.cars.find((c) => c.id === id) || null; }

  emit(type, a = 0, b = 0, x = 0, y = 0, z = 0, v = 0) {
    this.events.push({ type, a, b, x, y, z, v });
  }
  drainEvents() { const e = this.events; this.events = []; return e; }

  // --------------------------------------------------------------- kickoff
  /** Reset for a kickoff. Host only: it spends randomness. */
  kickoff() {
    const b = this.ball;
    b.x = 0; b.y = B.R; b.z = 0; b.vx = b.vy = b.vz = 0; b.live = true;
    this.touches.length = 0;
    // Both teams draw the same spot indices, so the kickoff is mirror-fair.
    const order = [0, 1, 2, 3, 4];
    for (let i = order.length - 1; i > 0; i--) {
      const j = (this.rng() * (i + 1)) | 0;
      [order[i], order[j]] = [order[j], order[i]];
    }
    // With one or two a side, somebody must start on a diagonal or it's a
    // two-minute standoff between goalies.
    const n = Math.max(...[0, 1].map((t) => this.cars.filter((c) => c.team === t).length));
    if (n <= 2 && order.slice(0, n).every((k) => k >= 2)) {
      const d = order.indexOf(this.rng() < 0.5 ? 0 : 1);
      [order[0], order[d]] = [order[d], order[0]];
    }
    for (const team of [TEAM.BLUE, TEAM.ORANGE]) {
      const mine = this.cars.filter((c) => c.team === team).sort((p, q) => p.id - q.id);
      mine.forEach((c, i) => {
        const s = KICKOFF_SPOTS[order[i % order.length]];
        const sgn = team === TEAM.BLUE ? 1 : -1;
        this.place(c, s.x * sgn, s.z * sgn, Math.atan2(s.z * sgn, -s.x * sgn));
        c.boost = K.BOOST_START;
      });
    }
    for (const p of this.pads) p.t = 0;
    this.phase = PHASE.COUNTDOWN;
    this.phaseT = MATCH.COUNTDOWN;
    this.emit(EV.KICKOFF);
  }

  place(c, x, z, yaw) {
    c.x = x; c.y = K.RIDE; c.z = z;
    c.vx = c.vy = c.vz = 0; c.wx = c.wy = c.wz = 0;
    setYaw(c, yaw);
    c.grounded = true; c.jumped = c.doubled = c.dodging = false;
    c.jumpT = c.dodgeT = 0;
    c.demo = false; c.respawnT = 0;
  }

  placeForRespawn(c) {
    const s = RESPAWN_SPOTS[c.id % RESPAWN_SPOTS.length];
    const sgn = c.team === TEAM.BLUE ? 1 : -1;
    // Face the far goal.
    this.place(c, s.x * sgn, s.z * sgn, c.team === TEAM.BLUE ? 0 : Math.PI);
  }

  // ------------------------------------------------------------------ step
  /**
   * Advance one tick. `inputs` maps car id -> { t, s, b, seq? }; a car with
   * no entry repeats what it did last tick.
   */
  step(inputs) {
    this.tick++;
    const frozen = this.phase === PHASE.COUNTDOWN;
    for (const c of this.cars) {
      const inp = inputs?.get(c.id);
      if (inp) { c.inp = inp; if (inp.seq) c.ack = inp.seq; }
    }

    const dt = TICK / SUBSTEPS;
    for (let s = 0; s < SUBSTEPS; s++) {
      for (const c of this.cars) {
        if (frozen) { this.holdForKickoff(c); continue; }
        this.stepCar(c, dt, s === 0);
      }
      if (this.ball.live && this.phase !== PHASE.END) {
        this.stepBall(dt);
        if (!frozen) for (const c of this.cars) if (!c.demo) this.carBall(c);
      }
      if (!frozen) this.carCars();
    }
    this.stepPads();
    this.stepMatch();
  }

  holdForKickoff(c) {
    c.vx = c.vy = c.vz = 0;
    // Remember the button so holding jump through "GO" doesn't fire a jump.
    c.jumpHeld = !!(c.inp.b & BTN.JUMP);
  }

  // ------------------------------------------------------------------- car
  stepCar(c, dt, firstSub) {
    if (c.hitCd > 0) c.hitCd -= dt;
    if (c.demo) {
      c.respawnT -= dt;
      if (c.respawnT <= 0) this.placeForRespawn(c);
      return;
    }
    const inp = c.inp;
    const t = inp.t, s = inp.s;
    const jumpDown = !!(inp.b & BTN.JUMP);
    const jumpPressed = firstSub && jumpDown && !c.jumpHeld;
    if (firstSub) c.jumpHeld = jumpDown;
    const boosting = !!(inp.b & BTN.BOOST) && c.boost > 0;
    const drift = !!(inp.b & BTN.DRIFT);

    const fwd = rotate(c, 1, 0, 0, {});
    if (c.grounded) {
      // Ground driving. The nose is always level here (see landing below).
      const right = rotate(c, 0, 0, 1, {});
      const speed = c.vx * fwd.x + c.vz * fwd.z;
      let a = 0;
      if (boosting) a += K.BOOST_ACC;
      if (t !== 0) {
        if (Math.sign(t) !== Math.sign(speed) && Math.abs(speed) > 0.6) a += K.BRAKE * t;
        else if (t > 0) a += t * K.THROTTLE_ACC * clamp(1 - speed / K.MAX_DRIVE, 0, 1);
        else if (speed > -K.REVERSE_MAX) a += t * K.THROTTLE_ACC;
      } else if (!boosting) {
        a -= Math.sign(speed) * Math.min(K.COAST, Math.abs(speed) / dt);
      }
      c.vx += fwd.x * a * dt; c.vz += fwd.z * a * dt;

      // Tyres kill sideways slip; a drift mostly stops them doing so.
      const lat = c.vx * right.x + c.vz * right.z;
      const keep = 1 - Math.exp(-(drift ? K.DRIFT_GRIP : K.GRIP) * dt);
      c.vx -= right.x * lat * keep; c.vz -= right.z * lat * keep;

      // Steering by turning radius: tight at low speed, wide at full boost.
      const sp = Math.abs(speed);
      const radius = lerp(K.TURN_R_SLOW, K.TURN_R_FAST, clamp(sp / K.MAX_SPEED, 0, 1));
      let rate = Math.min(sp / radius, K.MAX_YAW_RATE) * Math.sign(speed || 1);
      if (drift) rate *= K.DRIFT_TURN;
      setYaw(c, yawOf(c) - s * rate * dt);

      if (jumpPressed) {
        c.vy = K.JUMP_V;
        c.grounded = false; c.jumped = true; c.doubled = false; c.jumpT = 0;
        this.emit(EV.JUMP, c.id);
      }
    } else {
      c.jumpT += dt;
      c.vy -= K.GRAVITY * dt;
      if (c.jumped && jumpDown && c.jumpT < K.JUMP_HOLD_T && !c.doubled) c.vy += K.JUMP_HOLD_ACC * dt;

      if (jumpPressed && !c.doubled && c.jumpT < K.DODGE_WINDOW) {
        c.doubled = true;
        const mag = Math.hypot(t, s);
        if (mag > 0.45) {
          // Dodge: a burst toward where the stick points, relative to the car's
          // heading, plus a full flip about the matching axis.
          const dx = t / mag, dz = s / mag;
          const yaw = yawOf(c);
          const fx = Math.cos(yaw), fz = -Math.sin(yaw);
          const rx = Math.sin(yaw), rz = Math.cos(yaw);
          c.vx += (fx * dx + rx * dz) * K.DODGE_V;
          c.vz += (fz * dx + rz * dz) * K.DODGE_V;
          c.vy = Math.max(c.vy * 0.25, 1.5);
          const flip = (Math.PI * 2) / K.DODGE_T;
          c.wx = dz * flip; c.wy = 0; c.wz = -dx * flip;
          c.dodging = true; c.dodgeT = 0;
          this.emit(EV.DODGE, c.id);
        } else {
          c.vy += K.DOUBLE_V;
          this.emit(EV.JUMP, c.id);
        }
      }

      if (c.dodging) {
        c.dodgeT += dt;
        if (c.dodgeT >= K.DODGE_T) { c.dodging = false; c.wx *= 0.1; c.wz *= 0.1; }
      } else {
        // Air control: stick pitches and yaws, drift+stick or the roll keys roll.
        let roll = ((inp.b & BTN.ROLL_R) ? 1 : 0) - ((inp.b & BTN.ROLL_L) ? 1 : 0);
        let yawIn = -s;
        if (drift) { roll = s; yawIn = 0; }
        c.wz += -t * K.AIR_ACC * dt;
        c.wy += yawIn * K.AIR_ACC * dt;
        c.wx += roll * K.AIR_ACC * 1.3 * dt;
        const damp = Math.exp(-K.AIR_DAMP * dt);
        c.wx *= damp; c.wy *= damp; c.wz *= damp;
        const w = Math.hypot(c.wx, c.wy, c.wz);
        if (w > K.AIR_MAX_W) { const k = K.AIR_MAX_W / w; c.wx *= k; c.wy *= k; c.wz *= k; }
      }
      spinLocal(c, c.wx, c.wy, c.wz, dt);
      if (boosting) {
        const f = rotate(c, 1, 0, 0, {});
        c.vx += f.x * K.AIR_BOOST_ACC * dt; c.vy += f.y * K.AIR_BOOST_ACC * dt; c.vz += f.z * K.AIR_BOOST_ACC * dt;
      }
    }

    if (boosting) c.boost = Math.max(0, c.boost - K.BOOST_USE * dt);
    const sp = Math.hypot(c.vx, c.vy, c.vz);
    if (sp > K.MAX_SPEED) { const k = K.MAX_SPEED / sp; c.vx *= k; c.vy *= k; c.vz *= k; }

    c.x += c.vx * dt; c.y += c.vy * dt; c.z += c.vz * dt;

    if (c.y <= K.RIDE) {
      c.y = K.RIDE;
      if (c.vy < 0) c.vy = 0;
      if (!c.grounded) {
        // Arcade landing: always wheels-down, keeping the heading.
        setYaw(c, yawOf(c));
        c.wx = c.wy = c.wz = 0;
        c.grounded = true; c.jumped = c.doubled = c.dodging = false;
      }
    } else if (c.grounded && c.y > K.RIDE + 0.05) {
      c.grounded = false; c.jumped = false; c.doubled = false; c.jumpT = 0;
    }
    collideArena(c, K.WALL_R, false, 0.15, 0.05);
  }

  // ------------------------------------------------------------------ ball
  stepBall(dt) {
    const b = this.ball;
    b.vy -= B.GRAVITY * dt;
    const drag = 1 - B.DRAG * dt;
    b.vx *= drag; b.vy *= drag; b.vz *= drag;
    if (b.y <= B.R + 0.02 && Math.abs(b.vy) < 1) {
      const h = Math.hypot(b.vx, b.vz);
      if (h > 0) { const k = Math.max(0, h - B.ROLL_DECEL * dt) / h; b.vx *= k; b.vz *= k; }
    }
    const sp = Math.hypot(b.vx, b.vy, b.vz);
    if (sp > B.MAX_SPEED) { const k = B.MAX_SPEED / sp; b.vx *= k; b.vy *= k; b.vz *= k; }
    b.x += b.vx * dt; b.y += b.vy * dt; b.z += b.vz * dt;
    const hit = collideArena(b, B.R, true, B.BOUNCE, B.FRICTION);
    if (hit > 4) this.emit(EV.BOUNCE, 0, 0, b.x, b.y, b.z, hit);
  }

  /**
   * Oriented box (the car) against a sphere (the ball). Momentum exchange
   * alone makes hits feel limp, so - like the game this is modelled on - a
   * fresh touch adds a "punch" along the line from the car to the ball, with
   * its vertical part flattened so the ball goes forward rather than up.
   */
  carBall(c) {
    const b = this.ball;
    const dx = b.x - c.x, dy = b.y - c.y, dz = b.z - c.z;
    if (dx * dx + dy * dy + dz * dz > (B.R + 2.2) ** 2) return;
    const l = unrotate(c, dx, dy, dz, {});
    const cx = clamp(l.x, -K.HX, K.HX), cy = clamp(l.y, -K.HY, K.HY), cz = clamp(l.z, -K.HZ, K.HZ);
    const p = rotate(c, cx, cy, cz, {});
    let nx = dx - p.x, ny = dy - p.y, nz = dz - p.z;
    let d = Math.hypot(nx, ny, nz);
    if (d >= B.R) return;
    if (d < 1e-5) {        // centre inside the box: push out along the nose
      const f = rotate(c, 1, 0, 0, {});
      nx = f.x; ny = f.y; nz = f.z; d = 0;
    } else { nx /= d; ny /= d; nz /= d; }

    const pen = B.R - d;
    const mt = B.MASS + K.MASS;
    b.x += nx * pen * (K.MASS / mt); b.y += ny * pen * (K.MASS / mt); b.z += nz * pen * (K.MASS / mt);
    c.x -= nx * pen * (B.MASS / mt); c.z -= nz * pen * (B.MASS / mt);
    if (!c.grounded) c.y -= ny * pen * (B.MASS / mt);

    const rvx = b.vx - c.vx, rvy = b.vy - c.vy, rvz = b.vz - c.vz;
    const vn = rvx * nx + rvy * ny + rvz * nz;
    if (vn >= 0) return;
    const fresh = c.hitCd <= 0;
    const before = fresh && !this.predict ? this.headingIntoGoal() : -1;
    const j = (-(1 + K.HIT_E) * vn) / (1 / B.MASS + 1 / K.MASS);
    b.vx += (nx * j) / B.MASS; b.vy += (ny * j) / B.MASS; b.vz += (nz * j) / B.MASS;
    c.vx -= (nx * j) / K.MASS; c.vz -= (nz * j) / K.MASS;
    if (!c.grounded) c.vy -= (ny * j) / K.MASS;

    if (!fresh) return;
    c.hitCd = 0.12;
    const close = Math.min(-vn, 46);
    let px = dx, py = dy * 0.35, pz = dz;
    const pl = Math.hypot(px, py, pz) || 1;
    px /= pl; py /= pl; pz /= pl;
    const punch = (K.HIT_BASE + close * K.HIT_PUNCH) * (c.dodging ? K.DODGE_HIT : 1);
    b.vx += px * punch; b.vy += py * punch; b.vz += pz * punch;
    this.emit(EV.HIT, c.id, 0, b.x - nx * B.R, b.y - ny * B.R, b.z - nz * B.R, close);
    if (!this.predict) this.creditTouch(c, before);
  }

  carCars() {
    const cars = this.cars;
    for (let i = 0; i < cars.length; i++) {
      const a = cars[i];
      if (a.demo) continue;
      for (let k = i + 1; k < cars.length; k++) {
        const b = cars[k];
        if (b.demo) continue;
        let nx = b.x - a.x, ny = b.y - a.y, nz = b.z - a.z;
        const d = Math.hypot(nx, ny, nz);
        const min = K.BUMP_R * 2;
        if (d >= min || d < 1e-6) continue;
        nx /= d; ny /= d; nz /= d;
        const pen = (min - d) / 2;
        a.x -= nx * pen; a.z -= nz * pen; b.x += nx * pen; b.z += nz * pen;
        if (!a.grounded) a.y -= ny * pen;
        if (!b.grounded) b.y += ny * pen;
        const va = a.vx * nx + a.vy * ny + a.vz * nz;
        const vb = b.vx * nx + b.vy * ny + b.vz * nz;
        const close = va - vb;
        if (close <= 0) continue;
        // A car at supersonic speed driving into an opponent destroys it.
        if (!this.predict && a.team !== b.team) {
          const sa = Math.hypot(a.vx, a.vy, a.vz), sb = Math.hypot(b.vx, b.vy, b.vz);
          if (va > K.DEMO_SPEED && sa >= K.SUPERSONIC && sa > sb) { this.demolish(a, b); continue; }
          if (-vb > K.DEMO_SPEED && sb >= K.SUPERSONIC && sb > sa) { this.demolish(b, a); continue; }
        }
        const j = close * 0.65;
        a.vx -= nx * j; a.vz -= nz * j; b.vx += nx * j; b.vz += nz * j;
        if (!a.grounded) a.vy -= ny * j;
        if (!b.grounded) b.vy += ny * j;
        // A little pop makes a bump read as one.
        if (b.grounded && close > 8) { b.vy += 2.5; b.grounded = false; b.jumped = false; b.jumpT = 0; }
        if (a.grounded && close > 8) { a.vy += 1.5; a.grounded = false; a.jumped = false; a.jumpT = 0; }
      }
    }
  }

  demolish(attacker, victim) {
    victim.demo = true;
    victim.respawnT = K.RESPAWN_T;
    victim.vx = victim.vy = victim.vz = 0;
    attacker.stats.demos++;
    attacker.stats.score += 25;
    this.emit(EV.DEMO, attacker.id, victim.id, victim.x, victim.y, victim.z);
  }

  // ------------------------------------------------------------------ pads
  stepPads() {
    for (let i = 0; i < this.pads.length; i++) {
      const p = this.pads[i];
      if (p.t > 0) { p.t -= TICK; continue; }
      const def = p.big ? PAD.BIG : PAD.SMALL;
      for (const c of this.cars) {
        if (c.demo || c.boost >= 100 || c.y > 3) continue;
        const dx = c.x - p.x, dz = c.z - p.z;
        if (dx * dx + dz * dz > def.r * def.r) continue;
        c.boost = Math.min(100, c.boost + def.amount);
        p.t = def.respawn;
        this.emit(EV.PAD, c.id, i, p.x, 0, p.z);
        break;
      }
    }
  }

  // ----------------------------------------------------------------- match
  stepMatch() {
    if (this.phase === PHASE.COUNTDOWN) {
      this.phaseT -= TICK;
      if (this.phaseT <= 0) { this.phase = PHASE.PLAY; this.phaseT = 0; }
      return;
    }
    if (this.phase === PHASE.GOAL) {
      this.phaseT -= TICK;
      if (this.phaseT <= 0 && !this.predict) {
        if (this.winner >= 0) { this.endMatch(); return; }
        // A goal that tied it with the clock already at zero: straight to
        // overtime rather than a kickoff that immediately needs another.
        if (this.clock <= 0 && !this.overtime) { this.overtime = true; this.lastCall = false; }
        this.kickoff();
      }
      return;
    }
    if (this.phase !== PHASE.PLAY) return;

    if (this.overtime) this.clock += TICK;
    else if (this.clock > 0) this.clock = Math.max(0, this.clock - TICK);

    if (this.predict) return;
    const b = this.ball;
    const past = Math.abs(b.x) - (F.L + B.R);
    if (past > 0 && Math.abs(b.z) < F.GW && b.y < F.GH) {
      this.goal(b.x > 0 ? TEAM.BLUE : TEAM.ORANGE);
      return;
    }
    if (!this.overtime && this.clock <= 0) {
      if (this.score[0] === this.score[1]) {
        this.overtime = true;
        this.clock = 0;
        this.kickoff();
      } else {
        // Time's up, but a ball in the air is still live: the match ends on
        // its next touch of the floor, which is what makes last-second saves
        // and buzzer-beaters possible.
        this.lastCall = true;
        if (b.y <= B.R + 0.1) this.endMatch();
      }
    }
  }

  goal(team) {
    const b = this.ball;
    this.score[team]++;
    const speed = Math.hypot(b.vx, b.vy, b.vz);
    // The scorer is the most recent toucher on the scoring team; an assist is
    // a different teammate's touch shortly before that.
    let scorer = null, assist = null;
    for (let i = this.touches.length - 1; i >= 0; i--) {
      const t = this.touches[i];
      if (t.team !== team) continue;
      if (!scorer) { scorer = t; continue; }
      if (t.id !== scorer.id && scorer.tick - t.tick < 60 * 6) { assist = t; break; }
    }
    const sc = scorer && this.car(scorer.id);
    const as = assist && this.car(assist.id);
    if (sc) { sc.stats.goals++; sc.stats.score += 100; }
    if (as) { as.stats.assists++; as.stats.score += 50; }
    this.lastGoal = { team, scorer: sc ? sc.id : -1, assist: as ? as.id : -1, speed };
    this.emit(EV.GOAL, team, sc ? sc.id : 255, b.x, b.y, b.z, speed);
    b.live = false;
    b.vx = b.vy = b.vz = 0;
    this.phase = PHASE.GOAL;
    this.phaseT = MATCH.GOAL_PAUSE;
    if (this.overtime || (this.lastCall && this.score[0] !== this.score[1])) {
      this.winner = this.score[0] > this.score[1] ? TEAM.BLUE : TEAM.ORANGE;
    }
  }

  endMatch() {
    this.phase = PHASE.END;
    this.phaseT = 0;
    this.winner = this.score[0] > this.score[1] ? TEAM.BLUE : TEAM.ORANGE;
    this.emit(EV.END, this.winner);
  }

  // ------------------------------------------------------------------ stats
  /**
   * Which goal the ball is on course for, if it were left alone: 0 = Blue's
   * (at -X), 1 = Orange's, -1 = neither. A coarse ballistic trace with floor
   * bounces, good enough to tell a shot from a clearance.
   */
  headingIntoGoal() {
    let { x, y, z, vx, vy, vz } = this.ball;
    const dt = 1 / 30;
    for (let i = 0; i < 75; i++) {
      vy -= B.GRAVITY * dt;
      x += vx * dt; y += vy * dt; z += vz * dt;
      if (y < B.R) { y = B.R; vy = -vy * B.BOUNCE; }
      if (y > F.H - B.R) { y = F.H - B.R; vy = -vy; }
      if (Math.abs(z) > F.W - B.R) return -1;
      if (Math.abs(x) > F.L) return Math.abs(z) < F.GW - 0.3 && y < F.GH ? (x < 0 ? 0 : 1) : -1;
    }
    return -1;
  }

  creditTouch(c, before) {
    const after = this.headingIntoGoal();
    const own = c.team;               // index of the goal this car defends
    const theirs = 1 - own;
    c.stats.touches++;
    c.stats.score += 2;
    if (after === theirs && before !== theirs) { c.stats.shots++; c.stats.score += 20; }
    // A save is stopping a real shot, not two cars touching at kickoff.
    const b = this.ball;
    const nearOwn = Math.abs(b.x - (own === 0 ? -F.L : F.L)) < 30;
    if (before === own && after !== own && nearOwn) { c.stats.saves++; c.stats.score += 50; this.emit(EV.HIT, c.id, 1); }
    this.touches.push({ id: c.id, team: c.team, tick: this.tick });
    if (this.touches.length > 8) this.touches.shift();
  }
}

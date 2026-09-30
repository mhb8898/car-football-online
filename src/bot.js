// ---------------------------------------------------------------------------
// Bots. They run on the host only and produce the same { t, s, b } input a
// player's keyboard does, so to the simulation - and to every client - a bot
// is indistinguishable from a person with a very steady hand.
//
// The play is a small set of roles re-decided every tick:
//
//   ATTACK   the teammate who can reach the ball first drives to a point just
//            behind it on the line toward the opponent goal, then through it.
//   DEFEND   when the ball is coming at our goal and we're not first to it,
//            get between the ball and the net.
//   SUPPORT  everyone else holds a spot between the ball and our goal, a bit
//            back, facing the play, and goes for boost when low.
//
// Difficulty only changes how precisely and how aggressively that is done -
// reaction lag, aim wobble, how willing it is to boost, jump and dodge.
// ---------------------------------------------------------------------------

import { FIELD as F, BALL as B, CAR as K, BTN, TEAM } from './consts.js';
import { PHASE, yawOf } from './world.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
function wrap(a) {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

const LEVELS = [
  { lag: 0.28, wobble: 0.35, boostDist: 34, jump: 0.35, dodge: false, speed: 0.85 },
  { lag: 0.14, wobble: 0.15, boostDist: 20, jump: 0.8, dodge: true, speed: 1 },
  { lag: 0.05, wobble: 0.05, boostDist: 10, jump: 1, dodge: true, speed: 1 },
];

export class Bot {
  constructor(carId, level = 1, seed = 1) {
    this.id = carId;
    this.cfg = LEVELS[clamp(level, 0, 2)];
    this.seed = seed;
    this.stuckT = 0;
    this.reverseT = 0;
    this.jumpT = 0;           // time since this bot pressed jump (air routine)
    this.inAir = false;
    this.lastInp = { t: 0, s: 0, b: 0 };
    this.memBall = null;      // ball state as the bot "saw" it, lag seconds ago
    this.hist = [];
  }

  /** Deterministic wobble per bot so bots don't all make the same mistake. */
  noise(t) { return Math.sin(t * 1.7 + this.seed * 12.9) * Math.sin(t * 0.63 + this.seed * 4.1); }

  think(world) {
    const c = world.car(this.id);
    if (!c || c.demo) return { t: 0, s: 0, b: 0 };
    const cfg = this.cfg;
    const now = world.tick / 60;

    // Reaction lag: act on where the ball was a moment ago.
    const b0 = world.ball;
    this.hist.push({ x: b0.x, y: b0.y, z: b0.z, vx: b0.vx, vy: b0.vy, vz: b0.vz });
    const lagTicks = Math.round(cfg.lag * 60);
    while (this.hist.length > lagTicks + 1) this.hist.shift();
    const ball = this.hist[0];

    if (world.phase === PHASE.COUNTDOWN) return { t: 0, s: 0, b: 0 };
    if (!b0.live) return this.cruise(c, world);

    const team = c.team;
    const dir = team === TEAM.BLUE ? 1 : -1;       // +1: we attack +X
    const ownGoalX = -dir * F.L;
    const oppGoalX = dir * F.L;

    // Where will the ball be when we could get there?
    const dist = Math.hypot(ball.x - c.x, ball.z - c.z);
    const carSpeed = Math.hypot(c.vx, c.vz);
    const eta = clamp(dist / Math.max(12, carSpeed + 6), 0, 1.6);
    const pb = predictBall(ball, eta);

    // Role: first to the ball on my team attacks.
    const mates = world.cars.filter((o) => o.team === team && !o.demo);
    let first = c, bestEta = Infinity;
    for (const o of mates) {
      const d = Math.hypot(pb.x - o.x, pb.z - o.z);
      // Favour cars on the right side of the ball (between it and their goal).
      const goalSide = (pb.x - o.x) * dir > -4 ? 0 : 14;
      const e = d + goalSide;
      if (e < bestEta) { bestEta = e; first = o; }
    }
    const attacking = first.id === c.id;
    const threat = ball.vx * dir < -6 && (ball.x - ownGoalX) * dir < 40;

    let tx, tz, wantSpeed = 1, allowBoost = true;
    if (attacking) {
      // Line up behind the ball toward the far post nearest the ball.
      const aimZ = clamp(pb.z * 0.3, -F.GW + 2.5, F.GW - 2.5) + this.noise(now) * cfg.wobble * 6;
      let ax = oppGoalX - pb.x, az = aimZ - pb.z;
      const al = Math.hypot(ax, az) || 1;
      ax /= al; az /= al;
      // If we're on the wrong side, go around rather than through: approach a
      // point beside the ball on the goal side.
      const behind = (c.x - pb.x) * ax + (c.z - pb.z) * az;   // >0 = we're past the ball
      const back = B.R + K.HX + 1.5;
      if (behind > 0 && dist < 18) {
        const side = Math.sign((c.z - pb.z) * ax - (c.x - pb.x) * az) || 1;
        tx = pb.x - ax * back * 1.4 - az * side * 6;
        tz = pb.z - az * back * 1.4 + ax * side * 6;
      } else {
        const lead = clamp(dist * 0.35, 0, 9);
        tx = pb.x - ax * Math.min(back, lead + 1);
        tz = pb.z - az * Math.min(back, lead + 1);
        if (dist < 9) { tx = pb.x - ax * 0.5; tz = pb.z - az * 0.5; }
      }
    } else if (threat) {
      // Shadow: between the ball and the middle of our goal.
      tx = ownGoalX + dir * 6;
      tz = clamp(ball.z * 0.35, -F.GW + 2, F.GW - 2);
      allowBoost = true;
    } else {
      // Support: hang back, or grab a big pad when low.
      const low = c.boost < 30;
      const pad = low ? nearestPad(world, c, true) : null;
      if (pad && Math.hypot(pad.x - c.x, pad.z - c.z) < 40) { tx = pad.x; tz = pad.z; }
      else {
        tx = clamp(pb.x - dir * 22, -F.L + 6, F.L - 6);
        tz = pb.z * 0.5;
        const d = Math.hypot(tx - c.x, tz - c.z);
        if (d < 5) wantSpeed = 0.2;
        else if (d < 12) wantSpeed = 0.6;
        allowBoost = d > 25;
      }
    }
    tx = clamp(tx, -F.L + 2, F.L - 2);
    tz = clamp(tz, -F.W + 2, F.W - 2);

    const inp = this.drive(c, tx, tz, wantSpeed * cfg.speed, allowBoost, now);

    // Aerial / jump for high balls that are close and ahead of us.
    const yaw = yawOf(c);
    const toBall = wrap(Math.atan2(-(ball.z - c.z), ball.x - c.x) - yaw);
    const near = Math.hypot(ball.x - c.x, ball.z - c.z);
    if (c.grounded) this.inAir = false;
    if (attacking && c.grounded && near < 7 && ball.y > 2.8 && ball.y < 7 && Math.abs(toBall) < 0.5 && this.chance(cfg.jump, now)) {
      inp.b |= BTN.JUMP; this.inAir = true; this.jumpT = 0;
    } else if (attacking && c.grounded && cfg.dodge && near < 6.5 && near > 3.5 && ball.y < 3 && Math.abs(toBall) < 0.25 && carSpeed > 10) {
      // Dodge into the ball for a harder shot.
      inp.b |= BTN.JUMP; this.inAir = true; this.jumpT = 0;
    }
    if (!c.grounded && this.inAir) {
      this.jumpT += 1 / 60;
      if (this.jumpT < 0.18) inp.b |= BTN.JUMP;                 // hold for height
      else if (cfg.dodge && this.jumpT > 0.24 && this.jumpT < 0.3 && !c.doubled && near < 6) {
        inp.b |= BTN.JUMP; inp.t = 1; inp.s = clamp(toBall * 1.5, -1, 1);
      } else { inp.t = 0; inp.s = 0; }
    }
    this.lastInp = inp;
    return quantize(inp);
  }

  chance(p, now) { return p >= 1 || (Math.sin(now * 3.1 + this.seed) * 0.5 + 0.5) < p; }

  /** Steer toward (tx, tz). */
  drive(c, tx, tz, speedFrac, allowBoost, now) {
    const yaw = yawOf(c);
    const want = Math.atan2(-(tz - c.z), tx - c.x);
    const err = wrap(want - yaw);
    const dist = Math.hypot(tx - c.x, tz - c.z);
    const speed = c.vx * Math.cos(yaw) - c.vz * Math.sin(yaw);
    const inp = { t: 1, s: clamp(-err * 2.2, -1, 1), b: 0 };

    // Unstick: pushing against a wall with no progress.
    if (Math.abs(speed) < 1.5 && c.grounded) this.stuckT += 1 / 60; else this.stuckT = 0;
    if (this.stuckT > 1.2) { this.reverseT = 0.8; this.stuckT = 0; }
    if (this.reverseT > 0) {
      this.reverseT -= 1 / 60;
      return { t: -1, s: clamp(err * 2, -1, 1), b: 0 };
    }

    if (Math.abs(err) > 2.2 && dist < 9) { inp.t = -1; inp.s = clamp(err * 2, -1, 1); }
    else if (Math.abs(err) > 1.3 && speed > 9) inp.b |= BTN.DRIFT;
    inp.t *= speedFrac;
    if (speedFrac < 0.5 && speed > 12 * speedFrac + 3) inp.t = -0.3;
    if (allowBoost && c.grounded && Math.abs(err) < 0.3 && c.boost > 0 && dist > this.cfg.boostDist && speedFrac > 0.9) inp.b |= BTN.BOOST;
    return inp;
  }

  cruise(c, world) {
    // Between goals: roll back toward our half.
    const dir = c.team === TEAM.BLUE ? 1 : -1;
    return quantize(this.drive(c, -dir * 20, 0, 0.5, false, world.tick / 60));
  }
}

/** Ballistic guess with floor bounces; plenty for choosing where to drive. */
function predictBall(b, t) {
  let { x, y, z, vx, vy, vz } = b;
  const steps = Math.ceil(t * 20);
  const dt = t / Math.max(steps, 1);
  for (let i = 0; i < steps; i++) {
    vy -= B.GRAVITY * dt;
    x += vx * dt; y += vy * dt; z += vz * dt;
    if (y < B.R) { y = B.R; vy = -vy * B.BOUNCE; }
    if (Math.abs(z) > F.W - B.R) { z = Math.sign(z) * (F.W - B.R); vz = -vz * B.BOUNCE; }
    if (Math.abs(x) > F.L - B.R && Math.abs(z) > F.GW) { x = Math.sign(x) * (F.L - B.R); vx = -vx * B.BOUNCE; }
  }
  return { x, y, z };
}

function nearestPad(world, c, bigOnly) {
  let best = null, bd = Infinity;
  world.pads.forEach((p) => {
    if (p.t > 0 || (bigOnly && !p.big)) return;
    const d = Math.hypot(p.x - c.x, p.z - c.z);
    if (d < bd) { bd = d; best = p; }
  });
  return best;
}

/** Match the precision the network carries, so host and client agree. */
export function quantize(inp) {
  return {
    t: Math.round(clamp(inp.t, -1, 1) * 127) / 127,
    s: Math.round(clamp(inp.s, -1, 1) * 127) / 127,
    b: inp.b | 0,
  };
}


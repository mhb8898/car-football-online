// ---------------------------------------------------------------------------
// Client-side prediction of the whole world.
//
// A game that only predicts your own avatar shows everything else in the
// past. In a ball game that's fatal: your car is drawn *now*, the ball a round
// trip ago, and you drive through a ball that then flies off on its own.
//
// So a client keeps its own World (in predict mode) and runs it every tick
// with its own input. When a snapshot arrives - authoritative, but already
// RTT/2 old - it is loaded as a save state and every input the host hasn't
// consumed yet is replayed on top. The ball, your car and everyone else come
// out in the present. Other players' next inputs are unknown, so they are
// assumed to hold what they held last; when that guess is wrong the next
// snapshot corrects it.
//
// Corrections would read as teleports, so they are absorbed into a per-entity
// visual offset that decays over a few frames. The simulation snaps; the
// picture glides.
// ---------------------------------------------------------------------------

import { World, EV } from './world.js';
import { loadSnapshot } from './protocol.js';

const MAX_PENDING = 150;      // 2.5 s of inputs; past that the prediction is fiction anyway
const SNAP_DIST = 6;          // corrections bigger than this are teleports (kickoff, respawn)
const HOST_ONLY = new Set([EV.GOAL, EV.DEMO, EV.KICKOFF, EV.END]);

export class Predictor {
  constructor(length) {
    this.world = new World({ predict: true, length });
    this.myId = -1;
    this.seq = 0;
    this.pending = [];
    this.lastTick = -1;
    this.err = new Map();       // id -> { x, y, z } visual offset; 'ball' for the ball
    this.lastSnapAt = 0;
    this.ready = false;         // first snapshot received
  }

  /** One local tick: record and apply our input. Returns fresh (predicted) events. */
  localTick(inp) {
    inp.seq = ++this.seq;
    this.pending.push(inp);
    if (this.pending.length > MAX_PENDING) this.pending.shift();
    if (!this.ready) return [];
    const m = new Map();
    if (this.myId >= 0) m.set(this.myId, inp);
    this.world.step(m);
    // The host is the only one who knows about goals and demolitions.
    return this.world.drainEvents().filter((e) => !HOST_ONLY.has(e.type));
  }

  /** Returns the host-only events carried by this snapshot. */
  onSnapshot(s) {
    if (s.tick <= this.lastTick) return [];   // late and superseded
    this.lastTick = s.tick;
    this.lastSnapAt = performance.now();
    const w = this.world;

    const before = new Map();
    for (const c of w.cars) before.set(c.id, { x: c.x, y: c.y, z: c.z });
    const bb = { x: w.ball.x, y: w.ball.y, z: w.ball.z };

    loadSnapshot(w, s);
    const me = w.car(this.myId);
    if (me) while (this.pending.length && this.pending[0].seq <= me.ack) this.pending.shift();
    else this.pending.length = 0;

    const m = new Map();
    for (const inp of this.pending) {
      if (me) m.set(this.myId, inp);
      w.step(m);
    }
    w.drainEvents();           // those ticks were already predicted once

    if (this.ready) {
      for (const c of w.cars) {
        const b = before.get(c.id);
        if (b) this.absorb(c.id, b, c);
      }
      this.absorb('ball', bb, w.ball);
    }
    this.ready = true;
    return s.events.filter((e) => HOST_ONLY.has(e.type));
  }

  absorb(id, from, to) {
    const e = this.err.get(id) || { x: 0, y: 0, z: 0 };
    e.x += from.x - to.x; e.y += from.y - to.y; e.z += from.z - to.z;
    if (Math.hypot(e.x, e.y, e.z) > SNAP_DIST) { e.x = e.y = e.z = 0; }
    this.err.set(id, e);
  }

  /** Let corrections fade: fast for our own car, slower for the rest. */
  decay(dt) {
    for (const [id, e] of this.err) {
      const k = Math.exp(-dt * (id === this.myId ? 18 : id === 'ball' ? 12 : 9));
      e.x *= k; e.y *= k; e.z *= k;
    }
  }

  offset(id) { return this.err.get(id); }

  get stale() { return this.lastSnapAt > 0 && performance.now() - this.lastSnapAt > 3000; }
}

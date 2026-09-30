// ---------------------------------------------------------------------------
// Binary wire format for the unreliable 's' channel.
//
// Unlike a game that only interpolates, a snapshot here is a *save state*:
// the client loads it into its own World and replays its pending inputs on
// top. Every field the physics reads on the next tick must therefore be in
// here - including the fiddly ones like "was jump already held" and the
// ball-punch cooldown - or the replay lands somewhere the host never was.
// That is why cars go as float32 rather than the int16 a pure renderer would
// get away with: ~82 bytes a car, well under 1 KB for a full 4v4.
//
// Inputs are sticks quantised to int8 and a button byte. The host's own
// input goes through the same quantisation (bot.js quantize), so a host and a
// client replaying the same input compute the same thing.
// ---------------------------------------------------------------------------

export const MSG = { SNAP: 1, INPUT: 2 };
export const INPUT_REDUNDANCY = 4;   // each input packet repeats the last N inputs

const CAR_FLAGS = ['grounded', 'jumped', 'doubled', 'dodging', 'jumpHeld', 'demo'];
const CAR_F32 = ['x', 'y', 'z', 'vx', 'vy', 'vz', 'qx', 'qy', 'qz', 'qw', 'wx', 'wy', 'wz',
  'boost', 'jumpT', 'dodgeT', 'respawnT', 'hitCd'];
const CAR_BYTES = 1 + 1 + 1 + 4 + CAR_F32.length * 4 + 3;
const EV_BYTES = 3 + 16;

const i8 = (v) => Math.round(Math.max(-1, Math.min(1, v)) * 127);

/** Serialise the whole world (host). */
export function encodeSnapshot(w, events) {
  const n = w.cars.length;
  const ev = events.slice(0, 32);
  const size = 1 + 4 + 1 + 4 + 4 + 2 + 4 + 24 + 1 + n * CAR_BYTES + 1 + ev.length * EV_BYTES;
  const buf = new ArrayBuffer(size);
  const d = new DataView(buf);
  let o = 0;
  d.setUint8(o, MSG.SNAP); o += 1;
  d.setUint32(o, w.tick, true); o += 4;
  d.setUint8(o, w.phase | (w.overtime ? 16 : 0) | (w.lastCall ? 32 : 0) | (w.ball.live ? 64 : 0)); o += 1;
  d.setFloat32(o, w.phaseT, true); o += 4;
  d.setFloat32(o, w.clock, true); o += 4;
  d.setUint8(o, w.score[0]); d.setUint8(o + 1, w.score[1]); o += 2;
  let mask = 0;
  w.pads.forEach((p, i) => { if (p.t <= 0) mask |= 1 << i; });
  d.setUint32(o, mask >>> 0, true); o += 4;
  const b = w.ball;
  for (const k of ['x', 'y', 'z', 'vx', 'vy', 'vz']) { d.setFloat32(o, b[k], true); o += 4; }
  d.setUint8(o, n); o += 1;
  for (const c of w.cars) {
    d.setUint8(o, c.id);
    d.setUint8(o + 1, c.team | (c.type << 1));
    let f = 0;
    CAR_FLAGS.forEach((k, i) => { if (c[k]) f |= 1 << i; });
    d.setUint8(o + 2, f);
    d.setUint32(o + 3, c.ack >>> 0, true);
    o += 7;
    for (const k of CAR_F32) { d.setFloat32(o, c[k], true); o += 4; }
    d.setInt8(o, i8(c.inp.t)); d.setInt8(o + 1, i8(c.inp.s)); d.setUint8(o + 2, c.inp.b); o += 3;
  }
  d.setUint8(o, ev.length); o += 1;
  for (const e of ev) {
    d.setUint8(o, e.type); d.setUint8(o + 1, e.a & 255); d.setUint8(o + 2, e.b & 255); o += 3;
    d.setFloat32(o, e.x, true); d.setFloat32(o + 4, e.y, true); d.setFloat32(o + 8, e.z, true); d.setFloat32(o + 12, e.v, true);
    o += 16;
  }
  return new Uint8Array(buf);
}

export function decodeSnapshot(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const d = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let o = 0;
  if (d.getUint8(o) !== MSG.SNAP) return null; o += 1;
  const s = {};
  s.tick = d.getUint32(o, true); o += 4;
  const ph = d.getUint8(o); o += 1;
  s.phase = ph & 15; s.overtime = !!(ph & 16); s.lastCall = !!(ph & 32); s.live = !!(ph & 64);
  s.phaseT = d.getFloat32(o, true); o += 4;
  s.clock = d.getFloat32(o, true); o += 4;
  s.score = [d.getUint8(o), d.getUint8(o + 1)]; o += 2;
  s.padMask = d.getUint32(o, true); o += 4;
  s.ball = {};
  for (const k of ['x', 'y', 'z', 'vx', 'vy', 'vz']) { s.ball[k] = d.getFloat32(o, true); o += 4; }
  const n = d.getUint8(o); o += 1;
  s.cars = [];
  for (let i = 0; i < n; i++) {
    const c = { id: d.getUint8(o) };
    const tt = d.getUint8(o + 1);
    c.team = tt & 1; c.type = tt >> 1;
    const f = d.getUint8(o + 2);
    CAR_FLAGS.forEach((k, j) => { c[k] = !!(f & (1 << j)); });
    c.ack = d.getUint32(o + 3, true);
    o += 7;
    for (const k of CAR_F32) { c[k] = d.getFloat32(o, true); o += 4; }
    c.inp = { t: d.getInt8(o) / 127, s: d.getInt8(o + 1) / 127, b: d.getUint8(o + 2) };
    o += 3;
    s.cars.push(c);
  }
  const ne = d.getUint8(o); o += 1;
  s.events = [];
  for (let i = 0; i < ne; i++) {
    const e = { type: d.getUint8(o), a: d.getUint8(o + 1), b: d.getUint8(o + 2) };
    o += 3;
    e.x = d.getFloat32(o, true); e.y = d.getFloat32(o + 4, true); e.z = d.getFloat32(o + 8, true); e.v = d.getFloat32(o + 12, true);
    o += 16;
    s.events.push(e);
  }
  return s;
}

/** Overwrite a (predicting) world with a decoded snapshot. */
export function loadSnapshot(w, s) {
  w.tick = s.tick;
  w.phase = s.phase; w.phaseT = s.phaseT; w.clock = s.clock;
  w.overtime = s.overtime; w.lastCall = s.lastCall;
  w.score[0] = s.score[0]; w.score[1] = s.score[1];
  Object.assign(w.ball, s.ball); w.ball.live = s.live;
  w.pads.forEach((p, i) => {
    // An inactive pad's timer isn't sent; park it until a snapshot says it's
    // back, so a prediction never hands out boost the host hasn't.
    if (s.padMask & (1 << i)) p.t = 0;
    else if (p.t <= 0) p.t = 999;
  });
  const keep = new Map(w.cars.map((c) => [c.id, c]));
  w.cars = s.cars.map((sc) => {
    const c = keep.get(sc.id) || { stats: {} };
    const stats = c.stats;
    Object.assign(c, sc);
    c.stats = stats;
    return c;
  });
}

// ------------------------------------------------------------------- input
/** @param list [{ seq, t, s, b }], oldest first */
export function encodeInput(list) {
  const buf = new ArrayBuffer(2 + list.length * 7);
  const d = new DataView(buf);
  d.setUint8(0, MSG.INPUT);
  d.setUint8(1, list.length);
  let o = 2;
  for (const i of list) {
    d.setUint32(o, i.seq >>> 0, true);
    d.setInt8(o + 4, i8(i.t)); d.setInt8(o + 5, i8(i.s)); d.setUint8(o + 6, i.b);
    o += 7;
  }
  return new Uint8Array(buf);
}

export function decodeInput(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const d = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8.byteLength < 2 || d.getUint8(0) !== MSG.INPUT) return null;
  const n = Math.min(d.getUint8(1), (u8.byteLength - 2) / 7 | 0);
  const out = [];
  for (let i = 0, o = 2; i < n; i++, o += 7) {
    out.push({ seq: d.getUint32(o, true), t: d.getInt8(o + 4) / 127, s: d.getInt8(o + 5) / 127, b: d.getUint8(o + 6) });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Procedural sound: every effect is synthesised with WebAudio, no files.
//
// The engine is a continuous voice (two detuned saws through a low-pass whose
// pitch follows speed); everything else is a one-shot built on demand. The
// crowd is filtered noise that swells on goals and near-misses.
// ---------------------------------------------------------------------------

let ctx = null, master = null, noiseBuf = null;
let engine = null, boostVoice = null, crowd = null;
let muted = false, volume = 0.8;

export function unlock() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
  try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return; }
  master = ctx.createGain();
  master.gain.value = muted ? 0 : volume;
  const comp = ctx.createDynamicsCompressor();
  master.connect(comp).connect(ctx.destination);
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  startEngine();
  startCrowd();
}

export function setMuted(m) { muted = m; if (master) master.gain.value = m ? 0 : volume; }
export function setVolume(v) { volume = v; if (master && !muted) master.gain.value = v; }
export const isMuted = () => muted;

function noise(dur) {
  const s = ctx.createBufferSource();
  s.buffer = noiseBuf;
  s.loop = dur > 2;
  return s;
}

function env(g, t0, a, peak, dec) {
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(peak, t0 + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + a + dec);
}

function startEngine() {
  const out = ctx.createGain(); out.gain.value = 0;
  const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 400; lp.Q.value = 3;
  const o1 = ctx.createOscillator(); o1.type = 'sawtooth';
  const o2 = ctx.createOscillator(); o2.type = 'sawtooth'; o2.detune.value = 14;
  const sub = ctx.createOscillator(); sub.type = 'square';
  const sg = ctx.createGain(); sg.gain.value = 0.3;
  o1.connect(lp); o2.connect(lp); sub.connect(sg).connect(lp); lp.connect(out).connect(master);
  o1.start(); o2.start(); sub.start();
  engine = { out, lp, o1, o2, sub };

  const bOut = ctx.createGain(); bOut.gain.value = 0;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 900; bp.Q.value = 0.8;
  const n = noise(10); n.connect(bp).connect(bOut).connect(master); n.start();
  boostVoice = { out: bOut, bp };
}

function startCrowd() {
  const out = ctx.createGain(); out.gain.value = 0.035;
  const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 700; bp.Q.value = 0.5;
  const n = noise(10); n.connect(bp).connect(out).connect(master); n.start();
  crowd = { out, bp };
}

/** Called every frame with the local car's state (or null when not driving). */
export function engineUpdate(speed, boosting, grounded) {
  if (!ctx || !engine) return;
  const t = ctx.currentTime;
  const on = speed !== null;
  const k = on ? Math.min(1, speed / 28) : 0;
  const f = 48 + k * 120 + (grounded ? 0 : 20);
  engine.o1.frequency.setTargetAtTime(f, t, 0.08);
  engine.o2.frequency.setTargetAtTime(f * 1.5, t, 0.08);
  engine.sub.frequency.setTargetAtTime(f / 2, t, 0.08);
  engine.lp.frequency.setTargetAtTime(300 + k * 1400, t, 0.1);
  engine.out.gain.setTargetAtTime(on ? 0.045 + k * 0.05 : 0, t, 0.1);
  boostVoice.out.gain.setTargetAtTime(on && boosting ? 0.12 : 0, t, 0.04);
  boostVoice.bp.frequency.setTargetAtTime(700 + k * 900, t, 0.1);
}

export function crowdSwell(level, dur = 2.5) {
  if (!ctx || !crowd) return;
  const t = ctx.currentTime;
  crowd.out.gain.cancelScheduledValues(t);
  crowd.out.gain.setTargetAtTime(0.035 + level * 0.25, t, 0.15);
  crowd.out.gain.setTargetAtTime(0.035, t + dur, 0.8);
  crowd.bp.frequency.setTargetAtTime(700 + level * 500, t, 0.2);
  crowd.bp.frequency.setTargetAtTime(700, t + dur, 0.8);
}

/** One-shots. `vol` 0..1 already accounts for distance where it matters. */
export const sfx = {
  hit(strength, vol = 1) {
    if (!ctx) return;
    const t = ctx.currentTime, k = Math.min(1, strength / 40);
    const o = ctx.createOscillator(); o.type = 'sine';
    o.frequency.setValueAtTime(180 + k * 120, t); o.frequency.exponentialRampToValueAtTime(55, t + 0.18);
    const g = ctx.createGain(); env(g, t, 0.004, (0.25 + k * 0.5) * vol, 0.22);
    o.connect(g).connect(master); o.start(t); o.stop(t + 0.3);
    const n = noise(0.2); const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 1500 + k * 2000;
    const ng = ctx.createGain(); env(ng, t, 0.002, (0.15 + k * 0.35) * vol, 0.09);
    n.connect(f).connect(ng).connect(master); n.start(t); n.stop(t + 0.15);
  },
  bounce(strength, vol = 1) {
    if (!ctx) return;
    const t = ctx.currentTime, k = Math.min(1, strength / 30);
    const o = ctx.createOscillator(); o.type = 'triangle';
    o.frequency.setValueAtTime(120 + k * 60, t); o.frequency.exponentialRampToValueAtTime(50, t + 0.15);
    const g = ctx.createGain(); env(g, t, 0.003, 0.18 * k * vol + 0.02, 0.16);
    o.connect(g).connect(master); o.start(t); o.stop(t + 0.25);
  },
  jump(vol = 1) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const n = noise(0.3); const f = ctx.createBiquadFilter(); f.type = 'bandpass';
    f.frequency.setValueAtTime(400, t); f.frequency.exponentialRampToValueAtTime(1800, t + 0.15);
    const g = ctx.createGain(); env(g, t, 0.01, 0.12 * vol, 0.15);
    n.connect(f).connect(g).connect(master); n.start(t); n.stop(t + 0.25);
  },
  dodge(vol = 1) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const n = noise(0.4); const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 2;
    f.frequency.setValueAtTime(1800, t); f.frequency.exponentialRampToValueAtTime(300, t + 0.35);
    const g = ctx.createGain(); env(g, t, 0.02, 0.16 * vol, 0.3);
    n.connect(f).connect(g).connect(master); n.start(t); n.stop(t + 0.45);
  },
  pad(big) {
    if (!ctx) return;
    const t = ctx.currentTime;
    for (const [i, fr] of (big ? [660, 880, 1320] : [990]).entries()) {
      const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = fr;
      const g = ctx.createGain(); env(g, t + i * 0.05, 0.005, 0.08, 0.18);
      o.connect(g).connect(master); o.start(t + i * 0.05); o.stop(t + i * 0.05 + 0.3);
    }
  },
  countdown(final) {
    if (!ctx) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'square'; o.frequency.value = final ? 880 : 440;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 2000;
    const g = ctx.createGain(); env(g, t, 0.005, 0.12, final ? 0.5 : 0.18);
    o.connect(f).connect(g).connect(master); o.start(t); o.stop(t + 0.7);
  },
  goal(ours) {
    if (!ctx) return;
    const t = ctx.currentTime;
    // Stadium horn: stacked detuned saws, then the crowd.
    for (const fr of [110, 138.6, 165, 220]) {
      const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = fr;
      const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 1200;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.07, t + 0.05);
      g.gain.setValueAtTime(0.07, t + 1.4); g.gain.exponentialRampToValueAtTime(0.0001, t + 2.2);
      o.connect(f).connect(g).connect(master); o.start(t); o.stop(t + 2.3);
    }
    const n = noise(0.6); const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 500;
    const g = ctx.createGain(); env(g, t, 0.005, 0.6, 0.9);
    n.connect(f).connect(g).connect(master); n.start(t); n.stop(t + 1);
    crowdSwell(ours ? 1 : 0.6, 3);
  },
  demo() {
    if (!ctx) return;
    const t = ctx.currentTime;
    const n = noise(0.8); const f = ctx.createBiquadFilter(); f.type = 'lowpass';
    f.frequency.setValueAtTime(3000, t); f.frequency.exponentialRampToValueAtTime(120, t + 0.7);
    const g = ctx.createGain(); env(g, t, 0.004, 0.7, 0.7);
    n.connect(f).connect(g).connect(master); n.start(t); n.stop(t + 0.9);
  },
  whistle() {
    if (!ctx) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 2200;
    const lfo = ctx.createOscillator(); lfo.frequency.value = 28;
    const lg = ctx.createGain(); lg.gain.value = 120; lfo.connect(lg).connect(o.frequency);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.12, t + 0.03);
    g.gain.setValueAtTime(0.12, t + 0.9); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
    o.connect(g).connect(master); o.start(t); lfo.start(t); o.stop(t + 1.2); lfo.stop(t + 1.2);
  },
  click() {
    if (!ctx) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 1200;
    const g = ctx.createGain(); env(g, t, 0.002, 0.05, 0.05);
    o.connect(g).connect(master); o.start(t); o.stop(t + 0.08);
  },
};

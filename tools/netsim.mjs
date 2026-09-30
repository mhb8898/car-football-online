// Prediction check: a host and a client in one process, joined by a fake
// network with latency and loss, both running the real World.
//
//   node tools/netsim.mjs --ms 60 --loss 0.05
//
// For every input the client sends, compare where the client predicted its
// own car and the ball would be after that input with where the host actually
// put them once it processed it. With no other humans in the room the only
// source of error is the quantisation of the snapshot, so this should be
// ~0; bots' changing inputs are the realistic source of drift.
import { World } from '../src/world.js';
import { Bot, quantize } from '../src/bot.js';
import { encodeSnapshot, decodeSnapshot, encodeInput, decodeInput } from '../src/protocol.js';
import { Predictor } from '../src/predict.js';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const LAT = Math.round(arg('ms', 60) / (1000 / 60)), LOSS = arg('loss', 0.05), BOTS = arg('bots', 3);
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

const host = new World({ length: 300, seed: 3 });
const ME = 1;
host.addCar(ME, 0);
const bots = [];
for (let i = 0; i < BOTS; i++) { host.addCar(2 + i, i % 2 ? 0 : 1); bots.push(new Bot(2 + i, 1, i)); }
host.kickoff();
const cl = new Predictor(300); cl.myId = ME;

const toHost = [], toClient = [];   // { at, bytes }
const queue = []; let lastSeq = 0;
const predicted = new Map();        // seq -> { car, ball }
const errCar = [], errBall = [];

for (let tick = 0; tick < 60 * 90; tick++) {
  // --- client tick: scripted "player" that chases the ball
  const me = cl.world.car(ME);
  const b = cl.world.ball;
  let inp = { t: 1, s: 0, b: 0 };
  if (me) {
    const yaw = Math.atan2(-2 * (me.qw * me.qy), 1 - 2 * me.qy * me.qy);
    const want = Math.atan2(-(b.z - me.z), b.x - me.x);
    let e = want - yaw; while (e > Math.PI) e -= 2 * Math.PI; while (e < -Math.PI) e += 2 * Math.PI;
    inp = { t: 1, s: Math.max(-1, Math.min(1, -e * 2)), b: (tick % 90 < 30 ? 2 : 0) | (tick % 120 === 0 ? 1 : 0) };
  }
  inp = quantize(inp);
  cl.localTick(inp);
  const mc = cl.world.car(ME);
  if (cl.ready && mc) predicted.set(inp.seq, { x: mc.x, z: mc.z, bx: cl.world.ball.x, by: cl.world.ball.y, bz: cl.world.ball.z });
  const send = cl.pending.slice(-4);
  if (rnd() > LOSS) toHost.push({ at: tick + LAT, bytes: encodeInput(send) });

  // --- network delivery
  while (toHost.length && toHost[0].at <= tick) {
    for (const i of decodeInput(toHost.shift().bytes)) if (i.seq > lastSeq) { queue.push(i); lastSeq = i.seq; }
  }
  while (toClient.length && toClient[0].at <= tick) cl.onSnapshot(decodeSnapshot(toClient.shift().bytes));

  // --- host tick
  const m = new Map(bots.map((bt) => [bt.id, bt.think(host)]));
  if (queue.length) m.set(ME, queue.shift());
  host.step(m);
  const hc = host.car(ME);
  const p = predicted.get(hc.ack);
  if (p && m.has(ME) && host.phase === 1) {
    errCar.push(Math.hypot(p.x - hc.x, p.z - hc.z));
    errBall.push(Math.hypot(p.bx - host.ball.x, p.by - host.ball.y, p.bz - host.ball.z));
    predicted.delete(hc.ack);
  }
  if (tick % 2 === 0 && rnd() > LOSS) toClient.push({ at: tick + LAT, bytes: encodeSnapshot(host, host.drainEvents()) });
}
const q = (a, f) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(f * (s.length - 1))] || 0; };
const fmt = (a) => `median ${q(a, 0.5).toFixed(3)}  p95 ${q(a, 0.95).toFixed(3)}  max ${q(a, 1).toFixed(2)} m`;
console.log(`latency ${LAT} ticks each way, loss ${LOSS * 100}%, ${BOTS} bots, samples ${errCar.length}`);
console.log('own car error: ' + fmt(errCar));
console.log('ball error:    ' + fmt(errBall));
console.log(`score ${host.score.join('-')}, pending at end ${cl.pending.length}`);

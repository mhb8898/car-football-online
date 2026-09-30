// Headless match runner: bots vs bots, no browser.
//
//   node tools/sim.mjs                        3v3 Pro, 5 minutes of play
//   node tools/sim.mjs --size 1 --level 2 --minutes 10 --runs 4
//
// What it is for: spotting physics or bot changes that break the game -
// no goals in ten minutes, the ball escaping the arena, cars stuck on walls -
// before a player does.
import { World, PHASE, TICK } from '../src/world.js';
import { Bot } from '../src/bot.js';
import { FIELD as F, BALL as B } from '../src/consts.js';

const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? Number(process.argv[i + 1]) : d; };
const size = arg('size', 3), level = arg('level', 1), minutes = arg('minutes', 5), runs = arg('runs', 1);

for (let r = 0; r < runs; r++) {
  const w = new World({ length: minutes * 60, seed: 100 + r });
  const bots = [];
  let id = 1;
  for (const team of [0, 1]) for (let i = 0; i < size; i++) { w.addCar(id, team); bots.push(new Bot(id, level, id + r * 7)); id++; }
  w.kickoff();
  let ticks = 0, escapes = 0, maxBall = 0, hits = 0, demos = 0, airTicks = 0;
  const t0 = performance.now();
  while (w.phase !== PHASE.END && ticks < 60 * 60 * (minutes + 5)) {
    const inputs = new Map(bots.map((b) => [b.id, b.think(w)]));
    w.step(inputs);
    ticks++;
    const b = w.ball;
    maxBall = Math.max(maxBall, Math.hypot(b.vx, b.vy, b.vz));
    if (b.y > 4) airTicks++;
    if (Math.abs(b.z) > F.W || b.y > F.H || b.y < B.R - 0.3 || Math.abs(b.x) > F.L + F.GD + 0.5) escapes++;
    for (const e of w.drainEvents()) { if (e.type === 1) hits++; if (e.type === 3) demos++; }
  }
  const ms = performance.now() - t0;
  const stats = w.cars.map((c) => `${c.team ? 'O' : 'B'}${c.id}:${c.stats.goals}g/${c.stats.shots}sh/${c.stats.saves}sv/${c.stats.touches}t`).join(' ');
  console.log(`run ${r}: ${w.score[0]}-${w.score[1]}${w.overtime ? ' (OT)' : ''} in ${(ticks * TICK / 60).toFixed(1)} min | hits ${hits} demos ${demos} | ball max ${maxBall.toFixed(1)} m/s, airborne ${(100 * airTicks / ticks).toFixed(0)}% | escapes ${escapes} | ${(ms / ticks * 1000).toFixed(0)} us/tick`);
  console.log('   ' + stats);
}

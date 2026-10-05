// Frame-rate and CPU benchmark in a real (headless) Chrome.
//
//   python3 tools/serve.py 8777 &
//   node tools/bench.mjs --url http://localhost:8777/ --size 4 --quality high
//
// Starts a solo match (bots on both sides) and, after a warm-up, measures
// for --seconds:
//
//   fps         frames per second. With --uncapped (the default) vsync and the
//               frame-rate limit are off, so this is throughput: how many
//               frames the machine *could* draw, which is what tells two
//               builds apart. --capped measures at the display's rate.
//   main CPU    Chrome's own count of the page's main-thread task time, as a
//               share of wall time (100% = one core flat out).
//   frame/draw  ms of JS per frame in the game's frame() and in renderer.draw.
//   calls/tris  WebGL draw calls and triangles in one frame, all passes.
//
// Needs Google Chrome; set CHROME=/path/to/chrome elsewhere than macOS.
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const argv = process.argv;
const arg = (k, d) => { const i = argv.indexOf('--' + k); return i > 0 ? argv[i + 1] : d; };
const URL_ = arg('url', 'http://localhost:8777/');
const SECONDS = Number(arg('seconds', 8));
const SIZE = Number(arg('size', 4));
const QUALITY = arg('quality', 'high');
const DPR = Number(arg('dpr', 2));
const [W, H] = arg('window', '1280x720').split('x').map(Number);
const UNCAPPED = !argv.includes('--capped');
const PROFILE = argv.includes('--profile');      // also print the hottest functions
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9300 + Math.floor(Math.random() * 500);

const profile = mkdtempSync(join(tmpdir(), 'tk-bench-'));
const chrome = spawn(CHROME, [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  `--window-size=${W},${H}`, `--force-device-scale-factor=${DPR}`,
  '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required',
  '--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=metal',
  ...(UNCAPPED ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : []),
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function cdp() {
  for (let i = 0; i < 50; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      const page = list.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not up yet */ }
    await sleep(200);
  }
  throw new Error('Chrome did not start');
}

let ws, id = 0;
const waiting = new Map();
const errors = [];
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const n = ++id;
    waiting.set(n, { resolve, reject });
    ws.send(JSON.stringify({ id: n, method, params }));
  });
}
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
}
async function metrics() {
  const { metrics: m } = await send('Performance.getMetrics');
  return Object.fromEntries(m.map((x) => [x.name, x.value]));
}

// Runs in the page: hooks the game's frame and renderer and counts.
const PROBE = `(() => {
  const g = window.game, R = g.renderer, gl = R.gl;
  const s = { frames: 0, frameMs: 0, drawMs: 0, deltas: [], calls: 0, tris: 0, last: 0 };
  const draw = R.draw.bind(R);
  R.draw = (v, dt) => {
    gl.info.autoReset = false; gl.info.reset();
    const t = performance.now(); draw(v, dt); s.drawMs += performance.now() - t;
    s.calls = gl.info.render.calls; s.tris = gl.info.render.triangles;
  };
  const frame = g.frame.bind(g);
  g.frame = (t) => {
    const t0 = performance.now(); frame(t); s.frameMs += performance.now() - t0;
    if (s.last) s.deltas.push(t - s.last);
    s.last = t; s.frames++;
  };
  window.__bench = s;
})()`;

try {
  ws = new WebSocket(await cdp());
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
    const w = waiting.get(msg.id);
    if (!w) return;
    waiting.delete(msg.id);
    if (msg.error) w.reject(new Error(msg.error.message)); else w.resolve(msg.result);
  });
  await send('Runtime.enable');
  await send('Performance.enable', { timeDomain: 'timeTicks' });
  await send('Page.navigate', { url: URL_ });
  for (let i = 0; i < 100 && !(await evaluate('!!window.game').catch(() => false)); i++) await sleep(100);
  await sleep(2500);                                   // models load
  const gpu = await evaluate(`(() => { const c = window.game.renderer.gl.getContext(); const e = c.getExtension('WEBGL_debug_renderer_info'); return e ? c.getParameter(e.UNMASKED_RENDERER_WEBGL) : '?'; })()`);
  await evaluate(`(() => { const g = window.game; g.renderer.setQuality(${JSON.stringify(QUALITY)}); g.startSolo(); g.lobby.opts = { size: ${SIZE}, level: 2, length: 300 }; g.hostStartMatch(); })()`);
  await sleep(4000);                                   // countdown and kickoff
  await evaluate(PROBE);
  if (PROFILE) { await send('Profiler.enable'); await send('Profiler.setSamplingInterval', { interval: 200 }); await send('Profiler.start'); }
  const m0 = await metrics();
  const t0 = Date.now();
  await sleep(SECONDS * 1000);
  const m1 = await metrics();
  const prof = PROFILE ? (await send('Profiler.stop')).profile : null;
  const wall = (Date.now() - t0) / 1000;
  const s = await evaluate('(() => { const s = window.__bench; return { ...s, deltas: s.deltas.slice().sort((a, b) => a - b) }; })()');
  const q = (f) => s.deltas[Math.min(s.deltas.length - 1, Math.floor(f * s.deltas.length))] || 0;
  const pct = (k) => ((m1[k] - m0[k]) / wall) * 100;
  console.log(`${URL_}  ${SIZE}v${SIZE} ${QUALITY} @${W}x${H}x${DPR} ${UNCAPPED ? 'uncapped' : 'vsync'}  [${gpu}]`);
  console.log(`  fps        ${(s.frames / wall).toFixed(1)}   (frame p50 ${q(0.5).toFixed(2)} ms, p95 ${q(0.95).toFixed(2)} ms, worst ${q(1).toFixed(1)} ms)`);
  console.log(`  main CPU   ${pct('TaskDuration').toFixed(0)}% of a core (script ${pct('ScriptDuration').toFixed(0)}%, layout ${pct('LayoutDuration').toFixed(1)}%, style ${pct('RecalcStyleDuration').toFixed(1)}%)`);
  console.log(`  JS/frame   ${(s.frameMs / s.frames).toFixed(2)} ms  (renderer.draw ${(s.drawMs / s.frames).toFixed(2)} ms)`);
  console.log(`  per frame  ${s.calls} draw calls, ${(s.tris / 1000).toFixed(0)}k triangles`);
  if (errors.length) console.log(`  PAGE ERRORS (${errors.length}):\n    ` + [...new Set(errors)].slice(0, 5).join('\n    '));
  if (prof) {
    // Self time per function, from the sample counts.
    const self = new Map(), byId = new Map(prof.nodes.map((n) => [n.id, n]));
    const counts = new Map();
    for (const sid of prof.samples) counts.set(sid, (counts.get(sid) || 0) + 1);
    let total = 0;
    for (const [nid, c] of counts) {
      const f = byId.get(nid).callFrame;
      const k = `${f.functionName || '(anon)'}  ${f.url.split('/').pop()}:${f.lineNumber + 1}`;
      self.set(k, (self.get(k) || 0) + c);
      total += c;
    }
    const who = arg('who', null);   // --who fn: print what calls fn
    if (who) {
      const parent = new Map();
      for (const n of prof.nodes) for (const c of n.children || []) parent.set(c, n.id);
      const chains = new Map();
      for (const [nid, c] of counts) {
        if (byId.get(nid).callFrame.functionName !== who) continue;
        const chain = [];
        for (let p = parent.get(nid); p && chain.length < 5; p = parent.get(p)) chain.push(byId.get(p).callFrame.functionName || '(anon)');
        const k = chain.join(' < ');
        chains.set(k, (chains.get(k) || 0) + c);
      }
      for (const [k, c] of [...chains].sort((a, b) => b[1] - a[1]).slice(0, 6)) console.log(`  ${who} <- ${k}  (${c})`);
    }
    console.log('  hottest (self time):');
    for (const [k, c] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 18)) console.log(`    ${((100 * c) / total).toFixed(1).padStart(5)}%  ${k}`);
  }
} finally {
  ws?.close();
  const exited = new Promise((r) => chrome.once('exit', r));
  chrome.kill();
  await Promise.race([exited, sleep(3000)]);
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome still flushing; it's in tmp */ }
}

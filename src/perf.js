// ---------------------------------------------------------------------------
// F3 readout: frame rate, and where the main thread's time goes.
//
// "CPU" here is the share of one core this tab's game code keeps busy:
// simulation (ticks, bots, snapshot replays) plus the frame itself (scene
// update and the WebGL calls that submit it). The GPU's own work and the
// browser's compositing aren't visible to JS, so a low CPU figure with a low
// frame rate means the GPU is the bottleneck - try a lower graphics setting.
// ---------------------------------------------------------------------------

export class PerfMeter {
  constructor(el) {
    this.el = el;
    this.on = false;
    this.sim = 0;          // ms spent stepping the world since the last report
    this.ticks = 0;
    this.start(performance.now());
  }

  start(t) {
    this.t0 = t;
    this.frames = 0;
    this.worst = 0;
    this.frameMs = 0;      // main-thread ms inside frame(), summed
    this.drawMs = 0;       // of which the renderer
    this.sim = 0;
    this.ticks = 0;
    this.lastT = t;
  }

  show(on) {
    this.on = on;
    this.el.classList.toggle('hidden', !on);
    this.start(performance.now());
  }

  /** Time a block of simulation work. */
  simulate(fn) {
    const t = performance.now();
    fn();
    this.sim += performance.now() - t;
  }

  /** Once per rendered frame, after it's done. */
  frame(t, frameMs, drawMs, info) {
    this.frames++;
    this.worst = Math.max(this.worst, t - this.lastT);
    this.lastT = t;
    this.frameMs += frameMs;
    this.drawMs += drawMs;
    const span = t - this.t0;
    if (span < 500) return;
    if (this.on) this.report(span, info);
    this.start(t);
  }

  report(span, info) {
    const fps = (this.frames * 1000) / span;
    const cpu = ((this.frameMs + this.sim) / span) * 100;
    const cls = (v, ok, bad) => (v >= bad ? 'bad' : v >= ok ? 'ok' : '');
    const fpsCls = fps < 30 ? 'bad' : fps < 55 ? 'ok' : '';
    const mem = performance.memory ? `\nheap   ${(performance.memory.usedJSHeapSize / 1048576).toFixed(0)} MB` : '';
    this.el.innerHTML =
      `<b class="${fpsCls}">${fps.toFixed(0)} fps</b>  worst ${this.worst.toFixed(0)} ms\n` +
      `cpu    <span class="${cls(cpu, 35, 70)}">${cpu.toFixed(0)}%</span> of a core\n` +
      `frame  ${(this.frameMs / this.frames).toFixed(2)} ms  (draw ${(this.drawMs / this.frames).toFixed(2)})\n` +
      `sim    ${(this.sim / Math.max(1, this.ticks)).toFixed(3)} ms/tick  ${((this.ticks * 1000) / span).toFixed(0)} Hz\n` +
      `gpu    ${info.calls} calls  ${(info.triangles / 1000).toFixed(0)}k tris` + mem;
  }
}

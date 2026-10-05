// ---------------------------------------------------------------------------
// Keyboard, gamepad and touch, folded into one { t, s, b } per tick.
//
//   t  throttle on the ground, pitch in the air   (-1..1, +1 = forward/nose down)
//   s  steer on the ground, yaw in the air         (-1..1, +1 = right)
//   b  buttons (BTN bits)
//
// Keys are matched by physical position (KeyboardEvent.code), so WASD stays
// WASD on AZERTY, Persian, Russian and every other layout.
// ---------------------------------------------------------------------------

import { BTN } from './consts.js';

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const DEAD = 0.14;
const dz = (v) => (Math.abs(v) < DEAD ? 0 : (v - Math.sign(v) * DEAD) / (1 - DEAD));

export class Input {
  constructor() {
    this.keys = new Set();
    this.mouse = 0;
    this.touch = { active: false, x: 0, y: 0, btn: 0 };
    this.onAction = null;        // (name) => void for one-shot actions
    this.enabled = true;
    this.padPrev = [];

    addEventListener('keydown', (e) => {
      if (isTyping(e)) return;
      if (!this.keys.has(e.code)) this.action(e.code);
      this.keys.add(e.code);
      if (/^(Space|Arrow|Tab)/.test(e.code) && this.enabled) e.preventDefault();
      if (e.code === 'F3') e.preventDefault();       // the browser's find-next
    });
    addEventListener('keyup', (e) => { this.keys.delete(e.code); });
    addEventListener('blur', () => { this.keys.clear(); this.mouse = 0; });
    addEventListener('mousedown', (e) => { if (e.target.tagName === 'CANVAS') this.mouse |= 1 << e.button; });
    addEventListener('mouseup', (e) => { this.mouse &= ~(1 << e.button); });
    addEventListener('contextmenu', (e) => { if (e.target.tagName === 'CANVAS') e.preventDefault(); });
  }

  action(code) {
    const map = { KeyB: 'ballcam', Escape: 'menu', Tab: 'scores', KeyM: 'mute', F3: 'perf' };
    if (map[code]) this.onAction?.(map[code]);
  }

  /** Sample everything into one input. */
  read() {
    if (!this.enabled) return { t: 0, s: 0, b: 0 };
    const k = this.keys;
    const has = (...c) => c.some((x) => k.has(x));
    let t = (has('KeyW', 'ArrowUp') ? 1 : 0) - (has('KeyS', 'ArrowDown') ? 1 : 0);
    let s = (has('KeyD', 'ArrowRight') ? 1 : 0) - (has('KeyA', 'ArrowLeft') ? 1 : 0);
    let b = 0;
    if (has('Space', 'KeyJ') || this.mouse & 4) b |= BTN.JUMP;
    if (has('ShiftLeft', 'ShiftRight', 'KeyK') || this.mouse & 1) b |= BTN.BOOST;
    if (has('ControlLeft', 'ControlRight', 'KeyL', 'KeyC')) b |= BTN.DRIFT;
    if (has('KeyQ')) b |= BTN.ROLL_L;
    if (has('KeyE')) b |= BTN.ROLL_R;

    // Gamepad: standard mapping. RT/LT drive, left stick steers and pitches.
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const gp of pads) {
      if (!gp || !gp.connected) continue;
      const bt = (i) => gp.buttons[i] && (gp.buttons[i].pressed || gp.buttons[i].value > 0.4);
      const val = (i) => (gp.buttons[i] ? gp.buttons[i].value : 0);
      const sx = dz(gp.axes[0] || 0), sy = dz(gp.axes[1] || 0);
      const trig = val(7) - val(6);
      if (Math.abs(sx) > Math.abs(s)) s = sx;
      // Stick up pitches the nose down in the air (and drives when no trigger is held).
      const pt = Math.abs(trig) > 0.05 ? trig : -sy;
      if (Math.abs(pt) > Math.abs(t)) t = pt;
      if (this.airborne && Math.abs(sy) > 0.2) t = -sy;
      if (bt(0)) b |= BTN.JUMP;
      if (bt(1)) b |= BTN.BOOST;
      if (bt(2)) b |= BTN.DRIFT;
      if (bt(4)) b |= BTN.ROLL_L;
      if (bt(5)) b |= BTN.ROLL_R;
      const prev = this.padPrev[gp.index] || [];
      if (bt(3) && !prev[3]) this.onAction?.('ballcam');
      if (bt(9) && !prev[9]) this.onAction?.('menu');
      if (bt(8) && !prev[8]) this.onAction?.('scores');
      this.padPrev[gp.index] = gp.buttons.map((_, i) => bt(i));
    }

    // Touch: virtual stick + buttons.
    if (this.touch.active) { t = -this.touch.y; s = this.touch.x; }
    b |= this.touch.btn;

    return { t: clamp(t, -1, 1), s: clamp(s, -1, 1), b };
  }

  /** Wire the on-screen controls (index.html #touch). */
  bindTouch(root) {
    const stick = root.querySelector('.stick');
    const knob = root.querySelector('.knob');
    let id = null, cx = 0, cy = 0;
    const R = 56;
    const move = (e) => {
      for (const tt of e.changedTouches) {
        if (tt.identifier !== id) continue;
        let dx = tt.clientX - cx, dy = tt.clientY - cy;
        const l = Math.hypot(dx, dy);
        if (l > R) { dx *= R / l; dy *= R / l; }
        knob.style.transform = `translate(${dx}px, ${dy}px)`;
        this.touch.x = dz(dx / R); this.touch.y = dz(dy / R);
      }
      e.preventDefault();
    };
    stick.addEventListener('touchstart', (e) => {
      const tt = e.changedTouches[0];
      id = tt.identifier;
      const r = stick.getBoundingClientRect();
      cx = r.left + r.width / 2; cy = r.top + r.height / 2;
      this.touch.active = true;
      move(e);
    }, { passive: false });
    stick.addEventListener('touchmove', move, { passive: false });
    const end = (e) => {
      for (const tt of e.changedTouches) if (tt.identifier === id) {
        id = null; this.touch.active = false; this.touch.x = this.touch.y = 0;
        knob.style.transform = '';
      }
    };
    stick.addEventListener('touchend', end);
    stick.addEventListener('touchcancel', end);
    for (const el of root.querySelectorAll('[data-btn]')) {
      const bit = BTN[el.dataset.btn];
      el.addEventListener('touchstart', (e) => { this.touch.btn |= bit; el.classList.add('on'); e.preventDefault(); }, { passive: false });
      const up = () => { this.touch.btn &= ~bit; el.classList.remove('on'); };
      el.addEventListener('touchend', up);
      el.addEventListener('touchcancel', up);
    }
    for (const el of root.querySelectorAll('[data-act]')) {
      el.addEventListener('touchstart', (e) => { this.onAction?.(el.dataset.act); e.preventDefault(); }, { passive: false });
    }
  }
}

function isTyping(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
}

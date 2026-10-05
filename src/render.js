// ---------------------------------------------------------------------------
// Three.js renderer: stadium, cars, ball, pads, effects, cameras.
//
// It draws a `view` - positions already interpolated and smoothed by main.js -
// and never reads the simulation directly, so the host (drawing its own
// authoritative world) and a client (drawing its prediction) use it
// identically.
//
// Art comes from assets/*.glb (built by tools/blender/*.py). Until those load,
// or if they never do, everything is drawn with procedural stand-ins, so a
// missing file costs looks, not the game.
// ---------------------------------------------------------------------------

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FIELD as F, BALL as B, TEAM_COLOR, CAR_TYPES, PADS, MAX_TEAM } from './consts.js';

const ASSETS = new URL('../assets/', import.meta.url);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const damp = (a, b, rate, dt) => a + (b - a) * (1 - Math.exp(-rate * dt));
function dampAngle(a, b, rate, dt) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * (1 - Math.exp(-rate * dt));
}

export const QUALITY = {
  low: { pr: 1, shadows: false, bloom: false, shadowSize: 0 },
  medium: { pr: 1.25, shadows: true, bloom: false, shadowSize: 1024 },
  high: { pr: 2, shadows: true, bloom: true, shadowSize: 2048 },
};

// ===========================================================================
// Particles: one Points object, additive, soft discs.
// ===========================================================================
class Particles {
  constructor(max, scene) {
    this.max = max;
    this.n = 0;
    this.p = new Float32Array(max * 3);
    this.v = new Float32Array(max * 3);
    this.c = new Float32Array(max * 3);
    this.life = new Float32Array(max);
    this.maxLife = new Float32Array(max);
    this.size = new Float32Array(max);
    this.grow = new Float32Array(max);
    this.drag = new Float32Array(max);
    this.grav = new Float32Array(max);
    this.alpha = new Float32Array(max);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.p, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.c, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.alpha, 1).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.ShaderMaterial({
      uniforms: { scale: { value: 600 } },
      vertexShader: `
        attribute float size; attribute float alpha; attribute vec3 color;
        varying vec3 vC; varying float vA; uniform float scale;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          gl_PointSize = size * scale / max(-mv.z, 0.1);
          vC = color; vA = alpha * smoothstep(0.6, 3.0, -mv.z);
        }`,
      fragmentShader: `
        varying vec3 vC; varying float vA;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float r = dot(d, d) * 4.0;
          if (r > 1.0) discard;
          float a = (1.0 - r) * (1.0 - r) * vA;
          gl_FragColor = vec4(vC * a, a);
        }`,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    scene.add(this.points);
  }

  spawn(x, y, z, vx, vy, vz, life, size, color, { grow = 0, drag = 1, grav = 0 } = {}) {
    let i = this.n;
    if (i >= this.max) i = (Math.random() * this.max) | 0; else this.n++;
    this.p[i * 3] = x; this.p[i * 3 + 1] = y; this.p[i * 3 + 2] = z;
    this.v[i * 3] = vx; this.v[i * 3 + 1] = vy; this.v[i * 3 + 2] = vz;
    this.c[i * 3] = color.r; this.c[i * 3 + 1] = color.g; this.c[i * 3 + 2] = color.b;
    this.life[i] = this.maxLife[i] = life;
    this.size[i] = size; this.grow[i] = grow; this.drag[i] = drag; this.grav[i] = grav;
  }

  update(dt) {
    let n = this.n;
    for (let i = 0; i < n; i++) {
      this.life[i] -= dt;
      if (this.life[i] <= 0) {
        n--;
        if (i !== n) this.copy(n, i);
        i--;
        continue;
      }
      const k = Math.exp(-this.drag[i] * dt);
      this.v[i * 3] *= k; this.v[i * 3 + 1] = this.v[i * 3 + 1] * k - this.grav[i] * dt; this.v[i * 3 + 2] *= k;
      this.p[i * 3] += this.v[i * 3] * dt; this.p[i * 3 + 1] += this.v[i * 3 + 1] * dt; this.p[i * 3 + 2] += this.v[i * 3 + 2] * dt;
      this.size[i] += this.grow[i] * dt;
      this.alpha[i] = Math.min(1, this.life[i] / this.maxLife[i] * 1.6);
    }
    this.n = n;
    this.points.visible = n > 0;
    if (n === 0) return;
    // Upload only the live particles, not the whole 4000-slot pool.
    const g = this.points.geometry;
    for (const k of ['position', 'color', 'size', 'alpha']) {
      const a = g.attributes[k];
      a.clearUpdateRanges();
      a.addUpdateRange(0, n * a.itemSize);
      a.needsUpdate = true;
    }
    g.setDrawRange(0, n);
  }

  copy(from, to) {
    for (let k = 0; k < 3; k++) {
      this.p[to * 3 + k] = this.p[from * 3 + k];
      this.v[to * 3 + k] = this.v[from * 3 + k];
      this.c[to * 3 + k] = this.c[from * 3 + k];
    }
    this.life[to] = this.life[from]; this.maxLife[to] = this.maxLife[from];
    this.size[to] = this.size[from]; this.grow[to] = this.grow[from];
    this.drag[to] = this.drag[from]; this.grav[to] = this.grav[from]; this.alpha[to] = this.alpha[from];
  }
}

// ===========================================================================
// Procedural stand-ins
// ===========================================================================
function fallbackCar() {
  const root = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ name: 'paint', color: 0x3a7bff, roughness: 0.4, metalness: 0.3 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x1a1c22, roughness: 0.8 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x0e1624, roughness: 0.1, metalness: 0.6 });
  const body = new THREE.Group(); body.name = 'body';
  const hull = new THREE.Mesh(new THREE.BoxGeometry(3.5, 0.7, 2.0), paint); hull.position.y = -0.1;
  const cab = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.55, 1.7), glass); cab.position.set(-0.3, 0.5, 0);
  body.add(hull, cab);
  root.add(body);
  const tire = new THREE.CylinderGeometry(0.45, 0.45, 0.4, 16).rotateX(Math.PI / 2);
  for (const [n, x, z] of [['wheel_fl', 1.15, -0.95], ['wheel_fr', 1.15, 0.95], ['wheel_rl', -1.15, -0.95], ['wheel_rr', -1.15, 0.95]]) {
    const w = new THREE.Mesh(tire, dark); w.name = n; w.position.set(x, -0.45, z); root.add(w);
  }
  const ex = new THREE.Object3D(); ex.name = 'exhaust'; ex.position.set(-1.8, -0.2, 0); root.add(ex);
  return root;
}

function fallbackBall() {
  const g = new THREE.IcosahedronGeometry(B.R, 3);
  return new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xdfe3ea, roughness: 0.4, flatShading: true }));
}

function fieldCanvas() {
  const cv = document.createElement('canvas');
  cv.width = 1024; cv.height = 712;
  const x = cv.getContext('2d');
  const sx = cv.width / (F.L * 2), sz = cv.height / (F.W * 2);
  for (let i = 0; i < 12; i++) {
    x.fillStyle = i % 2 ? '#2d6b3a' : '#327842';
    x.fillRect((i * cv.width) / 12, 0, cv.width / 12 + 1, cv.height);
  }
  x.fillStyle = 'rgba(40,110,255,0.10)'; x.fillRect(0, 0, cv.width / 2, cv.height);
  x.fillStyle = 'rgba(255,140,30,0.10)'; x.fillRect(cv.width / 2, 0, cv.width / 2, cv.height);
  x.strokeStyle = 'rgba(255,255,255,0.8)'; x.lineWidth = 4;
  x.beginPath(); x.moveTo(cv.width / 2, 0); x.lineTo(cv.width / 2, cv.height); x.stroke();
  x.beginPath(); x.ellipse(cv.width / 2, cv.height / 2, 9 * sx, 9 * sz, 0, 0, Math.PI * 2); x.stroke();
  x.strokeRect(0, (F.W - 15) * sz, 8 * sx, 30 * sz);
  x.strokeRect(cv.width - 8 * sx, (F.W - 15) * sz, 8 * sx, 30 * sz);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** The playable floor outline (chamfered rectangle) in the XZ plane. */
function floorShape() {
  const { L, W, C } = F;
  const s = new THREE.Shape();
  s.moveTo(-L + C, -W); s.lineTo(L - C, -W); s.lineTo(L, -W + C); s.lineTo(L, W - C);
  s.lineTo(L - C, W); s.lineTo(-L + C, W); s.lineTo(-L, W - C); s.lineTo(-L, -W + C); s.closePath();
  return s;
}

function fallbackArena() {
  const g = new THREE.Group();
  const geo = new THREE.ShapeGeometry(floorShape());
  geo.rotateX(-Math.PI / 2);  // shape XY -> XZ, facing up (the outline is symmetric)
  const uv = geo.attributes.uv, pos = geo.attributes.position;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (pos.getX(i) + F.L) / (2 * F.L), 1 - (pos.getZ(i) + F.W) / (2 * F.W));
  const floor = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ map: fieldCanvas(), roughness: 0.95 }));
  floor.name = 'field';
  g.add(floor);
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x1b2233, roughness: 0.7 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x9fc4ff, transparent: true, opacity: 0.06, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true });
  const add = (w, h, d, x, y, z, m = wallMat) => { const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m); b.position.set(x, y, z); g.add(b); return b; };
  add(2 * F.L, 3.5, 0.6, 0, 1.75, -F.W - 0.3); add(2 * F.L, 3.5, 0.6, 0, 1.75, F.W + 0.3);
  add(2 * F.L, F.H - 3.5, 0.1, 0, 3.5 + (F.H - 3.5) / 2, -F.W, glass); add(2 * F.L, F.H - 3.5, 0.1, 0, 3.5 + (F.H - 3.5) / 2, F.W, glass);
  for (const s of [-1, 1]) {
    const side = (F.W - F.GW);
    add(0.6, 3.5, side, s * (F.L + 0.3), 1.75, -(F.GW + side / 2));
    add(0.6, 3.5, side, s * (F.L + 0.3), 1.75, F.GW + side / 2);
    add(0.1, F.H - F.GH, 2 * F.W, s * F.L, F.GH + (F.H - F.GH) / 2, 0, glass);
    const gm = new THREE.MeshStandardMaterial({ color: TEAM_COLOR[s < 0 ? 0 : 1], emissive: TEAM_COLOR[s < 0 ? 0 : 1], emissiveIntensity: 2 });
    const post = new THREE.CylinderGeometry(F.POST_R, F.POST_R, F.GH, 10);
    for (const z of [-F.GW, F.GW]) { const p = new THREE.Mesh(post, gm); p.position.set(s * F.L, F.GH / 2, z); g.add(p); }
    const bar = new THREE.Mesh(new THREE.CylinderGeometry(F.POST_R, F.POST_R, 2 * F.GW, 10).rotateX(Math.PI / 2), gm);
    bar.position.set(s * F.L, F.GH, 0); g.add(bar);
    const net = new THREE.MeshStandardMaterial({ color: 0xd0d8e8, transparent: true, opacity: 0.25, side: THREE.DoubleSide, depthWrite: false, forceSinglePass: true });
    add(0.05, F.GH, 2 * F.GW, s * (F.L + F.GD), F.GH / 2, 0, net);
    add(F.GD, 0.05, 2 * F.GW, s * (F.L + F.GD / 2), F.GH, 0, net);
    add(F.GD, 0.05, 2 * F.GW, s * (F.L + F.GD / 2), 0.01, 0, wallMat);
  }
  return g;
}

// ===========================================================================
export class Renderer {
  constructor(canvas, quality = 'high') {
    this.canvas = canvas;
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.gl.toneMapping = THREE.ACESFilmicToneMapping;
    this.gl.toneMappingExposure = 1.05;
    this.gl.shadowMap.type = THREE.PCFSoftShadowMap;
    // Counted per frame (bloom renders several passes), reset in draw().
    this.gl.info.autoReset = false;
    // Reused every frame instead of allocating: a 60-120 Hz loop that makes
    // garbage pays for it in GC pauses.
    this.scratch = {
      q: new THREE.Quaternion(), q2: new THREE.Quaternion(), v: new THREE.Vector3(), v2: new THREE.Vector3(),
      v3: new THREE.Vector3(), c: new THREE.Color(), c2: new THREE.Color(), m4: new THREE.Matrix4(), m4b: new THREE.Matrix4(),
      e: new THREE.Euler(),
    };

    this.scene = new THREE.Scene();
    this.scene.fog = new THREE.Fog(0x0a0f22, 120, 330);
    this.camera = new THREE.PerspectiveCamera(78, 1, 0.1, 900);
    this.camera.position.set(0, 20, 60);

    const pm = new THREE.PMREMGenerator(this.gl);
    this.scene.environment = pm.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;

    this.buildSky();
    this.buildLights();
    this.arena = fallbackArena();
    this.scene.add(this.arena);
    this.arenaFromAssets = false;

    this.carTemplates = CAR_TYPES.map(() => fallbackCar());
    this.ballTemplate = fallbackBall();
    this.padTemplates = null;

    this.cars = new Map();     // id -> per-car visual state
    this.carBatches = [];      // type -> instanced parts (see carBatch)
    this.paint = new THREE.MeshPhysicalMaterial({
      name: 'team_paint', color: 0xffffff, roughness: 0.4, metalness: 0.2, clearcoat: 0.6, clearcoatRoughness: 0.2, envMapIntensity: 0.6,
    });
    this.depthInstanced = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    this.depthTinted = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    this.flameGeo = new THREE.ConeGeometry(0.34, 1.9, 14, 1, true).rotateZ(Math.PI / 2).translate(-0.95, 0, 0);
    this.flameCoreGeo = new THREE.ConeGeometry(0.18, 1.1, 10, 1, true).rotateZ(Math.PI / 2).translate(-0.55, 0, 0);
    this.flameCoreMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false });
    this.ball = this.makeBall();
    this.pads = null;
    this.buildPadsFallback();
    this.buildMarkers();

    this.fx = new Particles(4000, this.scene);
    this.rings = [];
    this.shake = 0;
    this.flash = null;

    this.cam = { yaw: 0, pos: new THREE.Vector3(0, 12, 40), look: new THREE.Vector3(), ballCam: true, fov: 78, dist: 8.6, height: 3.3 };
    this.showroomT = 0;

    this.autoRes = true;
    this.calm = true;          // the game says when a hitch wouldn't be felt
    this.setQuality(quality);
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.loadAssets();
  }

  // ---------------------------------------------------------------- setup
  buildSky() {
    const g = new THREE.SphereGeometry(600, 32, 16);
    const m = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: new THREE.Color(0x05081a) }, mid: { value: new THREE.Color(0x1a2350) }, low: { value: new THREE.Color(0x3a2a55) } },
      vertexShader: 'varying vec3 vP; void main(){ vP = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform vec3 top; uniform vec3 mid; uniform vec3 low; varying vec3 vP;
        void main(){ float h = vP.y; vec3 c = h > 0.08 ? mix(mid, top, smoothstep(0.08, 0.7, h)) : mix(low, mid, smoothstep(-0.2, 0.08, h));
        gl_FragColor = vec4(c, 1.0); }`,
    });
    this.sky = new THREE.Mesh(g, m);
    this.scene.add(this.sky);
    const n = 700, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const u = Math.random() * Math.PI * 2, v = 0.12 + Math.random() * 0.85;
      const r = 560;
      pos[i * 3] = Math.cos(u) * Math.sqrt(1 - v * v) * r; pos[i * 3 + 1] = v * r; pos[i * 3 + 2] = Math.sin(u) * Math.sqrt(1 - v * v) * r;
    }
    const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xbfd0ff, size: 1.6, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.8 }));
    this.scene.add(this.stars);
  }

  buildLights() {
    this.hemi = new THREE.HemisphereLight(0xaec4ff, 0x1c2230, 0.9);
    this.scene.add(this.hemi);
    const sun = new THREE.DirectionalLight(0xfff3e0, 2.6);
    sun.position.set(18, 70, 26);
    sun.target.position.set(0, 0, 0);
    const sc = sun.shadow.camera;
    sc.left = -62; sc.right = 62; sc.top = 44; sc.bottom = -44; sc.near = 10; sc.far = 140;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    this.sun = sun;
    this.scene.add(sun, sun.target);
    // Two coloured fills from the ends so each half reads as its team's.
    for (const [x, c] of [[-60, 0x3a7bff], [60, 0xff8a1f]]) {
      const l = new THREE.PointLight(c, 900, 110, 1.6);
      l.position.set(x, 18, 0);
      this.scene.add(l);
    }
    this.goalLight = new THREE.PointLight(0xffffff, 0, 60, 1.5);
    this.scene.add(this.goalLight);
  }

  buildMarkers() {
    // A ring under the ball: its size and fade tell you how high the ball is.
    const rg = new THREE.RingGeometry(1.5, 1.9, 40).rotateX(-Math.PI / 2);
    this.ballRing = new THREE.Mesh(rg, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.4, depthWrite: false }));
    this.ballRing.renderOrder = 2;
    this.scene.add(this.ballRing);
  }

  setQuality(q) {
    this.quality = QUALITY[q] ? q : 'high';
    const Q = QUALITY[this.quality];
    this.maxPr = Math.min(window.devicePixelRatio || 1, Q.pr);
    this.res = { pr: this.maxPr, frames: 0, slow: 0, t: 0, bad: 0, calm: 0, want: null, failedAt: 0, failedPr: Infinity, vsync: 1000 / 60 };
    this.gl.setPixelRatio(this.maxPr);
    this.gl.shadowMap.enabled = Q.shadows;
    this.sun.castShadow = Q.shadows;
    if (Q.shadows) {
      this.sun.shadow.mapSize.set(Q.shadowSize, Q.shadowSize);
      this.sun.shadow.map?.dispose();
      this.sun.shadow.map = null;
    }
    this.scene.traverse((o) => { if (o.material) o.material.needsUpdate = true; });
    if (Q.bloom && !this.composer) {
      this.composer = new EffectComposer(this.gl);
      this.composer.addPass(new RenderPass(this.scene, this.camera));
      this.bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.42, 0.35, 0.96);
      this.composer.addPass(this.bloom);
      this.composer.addPass(new OutputPass());
    }
    this.useBloom = Q.bloom;
    this.resize();
    if (this.fx) this.warmup();
  }

  /**
   * Auto resolution. The JS side of a frame is a couple of ms; what drops
   * frames is the GPU (bloom and shadows at full Retina resolution). So
   * watch the frame interval against the display's own and, when a fifth of
   * frames in a second miss it, render fewer pixels; after a long clean run,
   * try more again - but not back to a level that failed recently.
   *
   * A change is itself a hitch (the canvas and every bloom target are
   * reallocated, 50-150 ms), so it waits for a moment the player won't
   * feel it: `calm` is set by the game during kickoff countdowns, goal
   * replays and menus. Only a GPU that's been behind for several seconds of
   * live play gets its pixels cut there and then.
   */
  adaptResolution(gapMs) {
    const R = this.res;
    if (!this.autoRes || gapMs <= 0 || gapMs > 250) return;          // tab switch, not load
    R.vsync = gapMs < R.vsync ? gapMs : R.vsync + (gapMs - R.vsync) * 0.002; // ~ the fastest frames
    R.frames++;
    if (gapMs > R.vsync * 1.45) R.slow++;
    R.t += gapMs;
    const now = performance.now();
    if (R.t >= 1000) {
      const ratio = R.slow / R.frames;
      R.frames = R.slow = 0; R.t = 0;
      if (ratio > 0.2) { R.bad++; R.calm = 0; } else { R.bad = 0; if (ratio < 0.03) R.calm++; else R.calm = 0; }
      if (R.bad >= 2 && R.pr > 1) R.want = Math.max(1, R.pr - 0.25);
      else if (R.calm >= 15 && R.pr < this.maxPr) {
        const next = Math.min(this.maxPr, R.pr + 0.25);
        if (!(next >= R.failedPr && now - R.failedAt < 120000)) R.want = next;
        R.calm = 0;
      }
    }
    if (R.want === null || R.want === R.pr) return;
    const down = R.want < R.pr;
    if (!this.calm && !(down && R.bad >= 6)) return;
    if (down) { R.failedPr = R.pr; R.failedAt = now; }
    this.setPixelRatio(R.want);
    R.want = null; R.bad = 0; R.calm = 0;
  }

  setPixelRatio(pr) {
    this.res.pr = pr;
    this.gl.setPixelRatio(pr);
    this.resize();
  }

  /**
   * Compile every shader now, behind the menu, instead of on the frame where
   * it's first needed: the other car types, the boost flame, particles, goal
   * rings and the shadow pass's instanced variants. Left to the first frame
   * that shows them, they freeze the game for up to a second at kickoff.
   */
  async warmup() {
    const token = (this.warmToken = (this.warmToken || 0) + 1);
    const probes = CAR_TYPES.map((t, i) => {
      const v = this.makeCar(-1 - i, i % 2, i);
      v.root.position.set(i * 4, -30, 0);           // under the floor
      v.flame.visible = true;
      return v;
    });
    this.fx.spawn(0, -30, 0, 0, 0, 0, 0.5, 0.1, new THREE.Color(0));
    this.ring(0, -30, 0, 0xffffff, 1);
    const done = () => { for (const v of probes) this.disposeCar(v); };
    try {
      if (this.gl.compileAsync) await this.gl.compileAsync(this.scene, this.camera);
    } catch { /* compile on first use instead */ }
    if (token !== this.warmToken) { done(); return; }
    // One real frame through the same path, so the shadow pass and the
    // composer's variants are built too.
    probes.forEach((v, i) => this.placeCar(v, { type: i, team: i % 2 }));
    this.flushCars();
    this.present();
    done();
  }

  present() {
    if (this.useBloom && this.composer) this.composer.render(1 / 60);
    else this.gl.render(this.scene, this.camera);
  }

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.gl.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    if (this.composer) {
      this.composer.setPixelRatio(this.gl.getPixelRatio());
      this.composer.setSize(w, h);
      // The composer sizes every pass in device pixels; bloom is a blur, and
      // on a 2x screen that's 4x the fill for no visible gain. Size it in
      // CSS pixels instead (its blur chain then starts at w/2 x h/2).
      this.bloom?.setSize(w, h);
    }
    this.fx.mat.uniforms.scale.value = h * this.gl.getPixelRatio() / (2 * Math.tan((this.camera.fov * Math.PI) / 360));
  }

  // --------------------------------------------------------------- assets
  async loadAssets() {
    const loader = new GLTFLoader();
    const load = (f) => loader.loadAsync(new URL(f, ASSETS).href).then((g) => g.scene).catch((e) => { console.warn('[assets]', f, e.message); return null; });
    const [cars, ball, pads, arena] = await Promise.all(['cars.glb', 'ball.glb', 'pads.glb', 'arena.glb'].map(load));
    // Only the big shapes cast: glass, trim, glow strips and rims add a draw
    // call each to the shadow pass for a shadow nobody can see.
    const small = /glow|glass|trim|accent|rim|seam/;
    const shadowy = (root, cast, receive) => root.traverse((o) => {
      if (!o.isMesh) return;
      const names = (Array.isArray(o.material) ? o.material : [o.material]).map((m) => m.name).join(' ');
      o.castShadow = cast && !small.test(names);
      o.receiveShadow = receive;
    });

    if (arena) {
      arena.traverse((o) => {
        if (!o.isMesh) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) prepMaterial(m, 'arena');
        o.receiveShadow = /field|goal_floor|walls/.test(o.name) || /field|goal_floor|walls/.test(o.parent?.name || '');
        o.castShadow = false;
        if (mats.some((m) => m.map)) {
          for (const m of mats) if (m.map) { m.map.anisotropy = this.gl.capabilities.getMaxAnisotropy(); }
        }
      });
      // A material shared by meshes that disagree on receiveShadow gets its
      // shader state rebuilt at every switch - every frame. Settle each
      // material on one answer: receive if any of its meshes should.
      const recv = new Map();
      arena.traverse((o) => { if (o.isMesh) recv.set(o.material, (recv.get(o.material) || false) || o.receiveShadow); });
      arena.traverse((o) => { if (o.isMesh) o.receiveShadow = recv.get(o.material); });
      this.scene.remove(this.arena);
      this.arena = arena;
      this.scene.add(arena);
      this.arenaFromAssets = true;
    }
    if (cars) {
      CAR_TYPES.forEach((t, i) => {
        const root = cars.getObjectByName('car_' + t.id);
        if (!root) return;
        root.parent?.remove(root);
        root.position.set(0, 0, 0);
        root.traverse((o) => { if (o.isMesh) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => prepMaterial(m, 'car')); });
        shadowy(root, true, false);
        this.carTemplates[i] = root;
      });
      for (const [id, v] of this.cars) { this.disposeCar(v); this.cars.delete(id); }
      this.disposeCarBatches();
    }
    if (ball) {
      const m = ball.getObjectByName('ball') || ball;
      m.traverse((o) => { if (o.isMesh) (Array.isArray(o.material) ? o.material : [o.material]).forEach((mm) => prepMaterial(mm, 'ball')); });
      shadowy(m, true, false);
      m.position.set(0, 0, 0);
      this.ballTemplate = m;
      this.scene.remove(this.ball.root);
      this.ball = this.makeBall();
    }
    if (pads) {
      this.padTemplates = { big: pads.getObjectByName('pad_big'), small: pads.getObjectByName('pad_small') };
      if (this.padTemplates.big && this.padTemplates.small) {
        for (const r of Object.values(this.padTemplates)) r.traverse((o) => { if (o.isMesh) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => prepMaterial(m, 'pad')); });
        this.buildPadsFromAssets();
      }
    }
    this.warmup();
  }

  // ----------------------------------------------------------------- cars
  /**
   * Cars are drawn instanced. For each car type, every distinct (geometry,
   * material) in its model becomes one InstancedMesh that holds that part for
   * every car of the type - so eight cars cost the draw calls of one, in the
   * main pass and the shadow pass alike. Paint is one white material tinted
   * per instance with the team colour; wheels get their own spin and steer
   * through their instance matrices.
   */
  carBatch(type) {
    if (this.carBatches[type]) return this.carBatches[type];
    const tpl = this.carTemplates[type] || this.carTemplates[0];
    tpl.updateMatrixWorld(true);
    const inv = tpl.matrixWorld.clone().invert();
    const rel = (o) => inv.clone().multiply(o.matrixWorld);
    const wheels = ['wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr'].map((n) => tpl.getObjectByName(n)).filter(Boolean).map((w) => ({
      obj: w, parent: rel(w.parent), pos: w.position.clone(), base: w.rotation.clone(), scale: w.scale.clone(),
      inv: w.matrixWorld.clone().invert(), m: new THREE.Matrix4(),
    }));
    const wheelOf = (o) => {
      for (let p = o; p && p !== tpl; p = p.parent) { const i = wheels.findIndex((w) => w.obj === p); if (i >= 0) return i; }
      return -1;
    };
    const paint = (m) => (m.name === 'paint' ? this.paint : m);
    const groups = new Map();
    tpl.traverse((o) => {
      if (!o.isMesh) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const key = o.geometry.uuid + '|' + mats.map((m) => m.uuid).join(',');
      let g = groups.get(key);
      if (!g) {
        g = {
          geometry: o.geometry, cast: o.castShadow, parts: [],
          material: Array.isArray(o.material) ? o.material.map(paint) : paint(o.material),
          painted: mats.some((m) => m.name === 'paint'),
        };
        groups.set(key, g);
      }
      const wi = wheelOf(o);
      g.parts.push({ wheel: wi, local: wi >= 0 ? wheels[wi].inv.clone().multiply(o.matrixWorld) : rel(o) });
    });
    const cap = 2 * MAX_TEAM + 1;              // a full 4v4, or the showroom car
    const white = new THREE.Color(1, 1, 1);
    for (const g of groups.values()) {
      const im = new THREE.InstancedMesh(g.geometry, g.material, cap * g.parts.length);
      if (g.painted) for (let i = 0; i < cap * g.parts.length; i++) im.setColorAt(i, white);
      im.count = 0;
      im.frustumCulled = false;                // spread over the pitch; one draw either way
      im.castShadow = g.cast;
      // The shadow pass shares one depth material between every caster, and
      // a shader can't be both instanced and not, or tinted and not: each
      // switch rebuilds its state. Instanced casters get their own.
      im.customDepthMaterial = g.painted ? this.depthTinted : this.depthInstanced;
      this.scene.add(im);
      g.im = im;
    }
    let radius = 0.45;
    if (wheels[0]) {
      const bb = new THREE.Box3().setFromObject(wheels[0].obj);
      radius = Math.max(0.2, (bb.max.y - bb.min.y) / 2);
    }
    const ex = tpl.getObjectByName('exhaust');
    const exhaust = ex ? rel(ex) : new THREE.Matrix4().makeTranslation(-1.8, -0.2, 0);
    const b = { groups: [...groups.values()], wheels, radius, exhaust, n: 0 };
    this.carBatches[type] = b;
    return b;
  }

  disposeCarBatches() {
    for (const b of this.carBatches) if (b) for (const g of b.groups) { this.scene.remove(g.im); g.im.dispose(); }
    this.carBatches = [];
  }

  /** Per-car state the instances don't hold: smoothing, wheel spin, the boost flame. */
  makeCar(id, team, type) {
    const batch = this.carBatch(type);
    const exhaust = new THREE.Object3D();
    exhaust.matrixAutoUpdate = false;
    exhaust.matrix.copy(batch.exhaust);
    const flame = new THREE.Mesh(this.flameGeo, new THREE.MeshBasicMaterial({ color: 0xffb040, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }));
    flame.add(new THREE.Mesh(this.flameCoreGeo, this.flameCoreMat));
    flame.visible = false;
    exhaust.add(flame);
    const root = new THREE.Group();
    root.add(exhaust);
    this.scene.add(root);
    return {
      id, team, type, root, flame, exhaust, radius: batch.radius,
      q: new THREE.Quaternion(), spin: 0, steer: 0, trailT: 0,
    };
  }

  syncCars(list) {
    const seen = new Set();
    for (const c of list) {
      seen.add(c.id);
      let v = this.cars.get(c.id);
      if (v && (v.team !== c.team || v.type !== c.type)) { this.disposeCar(v); v = null; }
      if (!v) { v = this.makeCar(c.id, c.team, c.type); v.q.set(c.qx, c.qy, c.qz, c.qw); this.cars.set(c.id, v); }
    }
    for (const [id, v] of this.cars) if (!seen.has(id)) { this.disposeCar(v); this.cars.delete(id); }
  }

  disposeCar(v) { this.scene.remove(v.root); v.flame.material.dispose(); }

  /** Write one car's parts into its type's instance buffers. */
  placeCar(v, c) {
    const b = this.carBatch(c.type), S = this.scratch;
    const k = b.n++;
    const car = S.m4.compose(v.root.position, v.q, S.v3.set(1, 1, 1));
    b.wheels.forEach((w, i) => {
      S.e.set(w.base.x, w.base.y + (i < 2 ? v.steer : 0), w.base.z + v.spin, w.base.order);
      w.m.compose(w.pos, S.q2.setFromEuler(S.e), w.scale).premultiply(w.parent).premultiply(car);
    });
    const tint = S.c.set(TEAM_COLOR[c.team]);
    for (const g of b.groups) {
      const n = g.parts.length;
      for (let j = 0; j < n; j++) {
        const p = g.parts[j];
        g.im.setMatrixAt(k * n + j, S.m4b.multiplyMatrices(p.wheel >= 0 ? b.wheels[p.wheel].m : car, p.local));
        if (g.painted) g.im.setColorAt(k * n + j, tint);
      }
    }
  }

  /** Close out the frame's instance buffers: how many of each to draw. */
  flushCars() {
    for (const b of this.carBatches) {
      if (!b) continue;
      for (const g of b.groups) {
        g.im.count = b.n * g.parts.length;
        g.im.instanceMatrix.needsUpdate = true;
        if (g.im.instanceColor) g.im.instanceColor.needsUpdate = true;
      }
      b.n = 0;
    }
  }

  // ----------------------------------------------------------------- ball
  makeBall() {
    const root = new THREE.Group();
    const m = this.ballTemplate.clone(true);
    root.add(m);
    this.scene.add(root);
    return { root, model: m, q: new THREE.Quaternion() };
  }

  // ----------------------------------------------------------------- pads
  buildPadsFallback() {
    const base = new THREE.MeshStandardMaterial({ color: 0x2a2f3a, metalness: 0.6, roughness: 0.4 });
    const glow = new THREE.MeshStandardMaterial({ color: 0xffb020, emissive: 0xffa010, emissiveIntensity: 3 });
    const tpl = (big) => {
      const g = new THREE.Group();
      const r = big ? 1.6 : 0.9;
      const b = new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.1, 0.12, 20), base);
      b.position.y = 0.06;
      const o = new THREE.Mesh(big ? new THREE.SphereGeometry(0.6, 16, 12) : new THREE.CylinderGeometry(0.45, 0.45, 0.12, 16), glow);
      o.name = big ? 'pad_big_orb' : 'pad_small_orb';
      o.position.y = big ? 1.1 : 0.25;
      g.add(b, o);
      return g;
    };
    this.buildPads({ big: tpl(true), small: tpl(false) });
  }

  buildPadsFromAssets() { this.buildPads(this.padTemplates); }

  /**
   * Every pad of a kind is the same model, so each of the model's meshes is
   * drawn once for all of them (an InstancedMesh) - 28 pads in a handful of
   * draw calls rather than ~110. A collected orb is hidden by scaling its
   * instance to nothing; the big orbs bob and turn, the small ones only
   * change when they're taken or come back.
   */
  buildPads(templates) {
    if (this.padGroup) this.scene.remove(this.padGroup);
    const g = new THREE.Group();
    const m = new THREE.Matrix4();
    this.padOrbs = [];
    this.padShown = PADS.map(() => null);
    for (const big of [true, false]) {
      const tpl = big ? templates.big : templates.small;
      const list = PADS.map((p, i) => i).filter((i) => PADS[i].big === big);
      tpl.updateMatrixWorld(true);
      const inv = tpl.matrixWorld.clone().invert();
      tpl.traverse((o) => {
        if (!o.isMesh) return;
        const local = inv.clone().multiply(o.matrixWorld);
        const im = new THREE.InstancedMesh(o.geometry, o.material, list.length);
        list.forEach((pi, k) => im.setMatrixAt(k, m.makeTranslation(PADS[pi].x, 0, PADS[pi].z).multiply(local)));
        im.computeBoundingSphere();
        im.receiveShadow = !/_orb/.test(o.name);
        g.add(im);
        if (/_orb$/.test(o.name) || /_orb$/.test(o.parent?.name || '')) this.padOrbs.push({ im, local, list, big });
      });
    }
    this.padGroup = g;
    this.scene.add(g);
  }

  updatePads(on) {
    const t = performance.now() / 1000;
    const m = this.scratch.m4, r = this.scratch.m4b;
    // Small pads: only touch the buffer when one changes.
    let changed = false;
    for (let i = 0; i < PADS.length; i++) {
      const v = !!on[i];
      if (this.padShown[i] !== v) { this.padShown[i] = v; changed = true; }
    }
    for (const o of this.padOrbs) {
      if (!o.big && !changed) continue;
      o.list.forEach((pi, k) => {
        const p = PADS[pi];
        if (!this.padShown[pi]) m.makeScale(0, 0, 0);
        else if (o.big) m.makeTranslation(p.x, Math.sin(t * 2 + pi) * 0.12, p.z).multiply(r.makeRotationY(t)).multiply(o.local);
        else m.makeTranslation(p.x, 0, p.z).multiply(o.local);
        o.im.setMatrixAt(k, m);
      });
      o.im.instanceMatrix.needsUpdate = true;
    }
  }

  // ------------------------------------------------------------- effects
  onEvent(e, view) {
    const P = this.fx;
    const col = new THREE.Color();
    switch (e.type) {
      case 1: { // HIT
        const n = 10 + Math.min(30, e.v | 0);
        col.set(0xffffff);
        for (let i = 0; i < n; i++) {
          const a = Math.random() * Math.PI * 2, u = Math.random() * 2 - 1, s = 4 + Math.random() * e.v * 0.35;
          const r = Math.sqrt(1 - u * u);
          P.spawn(e.x, e.y, e.z, Math.cos(a) * r * s, u * s, Math.sin(a) * r * s, 0.25 + Math.random() * 0.25, 0.25, col, { drag: 3 });
        }
        if (e.v > 18) this.shake = Math.max(this.shake, Math.min(0.5, e.v / 80));
        break;
      }
      case 2: { // GOAL
        // Additive particles stack: keep each one dim so a burst right in
        // front of the camera reads as fireworks, not a white screen.
        col.set(TEAM_COLOR[e.a]).multiplyScalar(0.55);
        const white = new THREE.Color(0xffffff).multiplyScalar(0.45);
        for (let i = 0; i < 420; i++) {
          const a = Math.random() * Math.PI * 2, u = Math.random() * 2 - 1, s = 8 + Math.random() * 30;
          const r = Math.sqrt(1 - u * u);
          P.spawn(e.x, e.y, e.z, Math.cos(a) * r * s, u * s * 0.8 + 4, Math.sin(a) * r * s, 0.8 + Math.random() * 1.4, 0.6 + Math.random() * 0.9, i % 4 ? col : white, { drag: 1.6, grav: 4 });
        }
        this.ring(e.x, e.y, e.z, TEAM_COLOR[e.a], 26);
        this.ring(e.x, e.y, e.z, 0xffffff, 16);
        this.goalLight.color.set(TEAM_COLOR[e.a]);
        this.goalLight.position.set(e.x, e.y + 2, e.z);
        this.goalLight.intensity = 1800;
        this.shake = 1.2;
        break;
      }
      case 3: { // DEMO
        col.set(0xff6a20);
        const dark = new THREE.Color(0x553322);
        for (let i = 0; i < 160; i++) {
          const a = Math.random() * Math.PI * 2, u = Math.random(), s = 3 + Math.random() * 14;
          const r = Math.sqrt(1 - u * u);
          P.spawn(e.x, e.y, e.z, Math.cos(a) * r * s, u * s + 2, Math.sin(a) * r * s, 0.5 + Math.random() * 0.8, 0.5 + Math.random(), i % 3 ? col : dark, { drag: 2.2, grav: 6, grow: 1 });
        }
        this.ring(e.x, 0.3, e.z, 0xff7a30, 9);
        this.shake = Math.max(this.shake, 0.5);
        break;
      }
      case 4: { // PAD
        col.set(0xffb030);
        for (let i = 0; i < 18; i++) {
          const a = (i / 18) * Math.PI * 2;
          P.spawn(e.x, 0.5, e.z, Math.cos(a) * 5, 3 + Math.random() * 3, Math.sin(a) * 5, 0.4, 0.3, col, { drag: 3 });
        }
        break;
      }
      case 5: { // BOUNCE
        if (e.v < 10) break;
        col.set(0xbfe6ff);
        for (let i = 0; i < 8; i++) P.spawn(e.x, e.y, e.z, (Math.random() - 0.5) * 6, Math.random() * 3, (Math.random() - 0.5) * 6, 0.3, 0.3, col, { drag: 3 });
        break;
      }
      default:
    }
  }

  ring(x, y, z, color, size) {
    const m = new THREE.Mesh(
      new THREE.TorusGeometry(1, 0.08, 8, 48),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 1, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    m.position.set(x, y, z);
    m.lookAt(this.camera.position);
    this.scene.add(m);
    this.rings.push({ m, t: 0, size });
  }

  // --------------------------------------------------------------- draw
  /**
   * @param view { cars:[...], ball:{...}, pads:[bool], myId, phase, spectate }
   * @param dt   seconds since last frame
   */
  draw(view, dt) {
    dt = Math.min(dt, 0.1);
    this.gl.info.reset();
    const S = this.scratch;
    this.syncCars(view.cars);

    for (const c of view.cars) {
      const v = this.cars.get(c.id);
      v.root.visible = !c.demo;
      if (c.demo) continue;
      v.root.position.set(c.x, c.y, c.z);
      // Orientation glides toward the simulated one; the sim snaps on landing.
      const tq = S.q.set(c.qx, c.qy, c.qz, c.qw);
      v.q.slerp(tq, 1 - Math.exp(-dt * 22));
      v.root.quaternion.copy(v.q);
      const fwd = S.v.set(1, 0, 0).applyQuaternion(tq);
      const fs = c.vx * fwd.x + c.vy * fwd.y + c.vz * fwd.z;
      v.spin -= (c.grounded ? fs : fs * 0.3) / v.radius * dt;
      v.steer = damp(v.steer, -c.s * 0.5, 12, dt);
      this.placeCar(v, c);
      // Boost flame and trail.
      v.flame.visible = c.boosting;
      if (c.boosting) {
        const f = 0.85 + Math.random() * 0.35;
        v.flame.scale.set(f * (c.supersonic ? 1.35 : 1), 1, 1);
        v.flame.material.color.set(c.supersonic ? 0xfff0c0 : 0xffa030);
        v.trailT += dt;
        const ep = v.exhaust.getWorldPosition(S.v2);
        const back = S.v3.copy(fwd).multiplyScalar(-6);
        const tc = S.c.set(c.supersonic ? 0xfff2d0 : TEAM_COLOR[c.team]).lerp(S.c2.set(0xffa040), c.supersonic ? 0.2 : 0.5);
        for (let i = 0; i < 2; i++) {
          this.fx.spawn(ep.x + (Math.random() - 0.5) * 0.3, ep.y + (Math.random() - 0.5) * 0.3, ep.z + (Math.random() - 0.5) * 0.3,
            back.x + c.vx * 0.2, back.y + c.vy * 0.2 + Math.random(), back.z + c.vz * 0.2, 0.35 + Math.random() * 0.25, 0.55, tc, { grow: 1.8, drag: 2 });
        }
      }
    }

    this.flushCars();

    // Ball: turn it by its simulated spin (world-frame angular velocity).
    const b = view.ball;
    this.ball.root.visible = b.live;
    this.ballRing.visible = b.live;
    if (b.live) {
      this.ball.root.position.set(b.x, b.y, b.z);
      const w = Math.hypot(b.wx || 0, b.wy || 0, b.wz || 0);
      if (w > 1e-3) {
        this.ball.q.premultiply(S.q2.setFromAxisAngle(S.v.set(b.wx / w, b.wy / w, b.wz / w), w * dt)).normalize();
        this.ball.root.quaternion.copy(this.ball.q);
      }
      const h = b.y - B.R;
      this.ballRing.position.set(b.x, 0.03, b.z);
      const s = 1 + h * 0.05;
      this.ballRing.scale.set(s, 1, s);
      this.ballRing.material.opacity = clamp(0.55 - h * 0.025, 0.12, 0.55);
      const speed = Math.hypot(b.vx, b.vy, b.vz);
      if (speed > 30) {
        const tc = S.c.set(0x9fe8ff);
        this.fx.spawn(b.x, b.y, b.z, 0, 0, 0, 0.35, 2.2 * (speed - 30) / 25 + 0.5, tc, { grow: -3 });
      }
    }

    if (view.pads) this.updatePads(view.pads);

    // Rings and flashes.
    for (let i = this.rings.length - 1; i >= 0; i--) {
      const r = this.rings[i];
      r.t += dt;
      const k = r.t / 0.7;
      if (k >= 1) { this.scene.remove(r.m); r.m.geometry.dispose(); r.m.material.dispose(); this.rings.splice(i, 1); continue; }
      const s = r.size * (1 - (1 - k) ** 3);
      r.m.scale.set(s, s, s);
      r.m.material.opacity = 1 - k;
      r.m.lookAt(this.camera.position);
    }
    this.goalLight.intensity *= Math.exp(-dt * 2.5);
    this.fx.update(dt);

    this.updateCamera(view, dt);
    this.present();
  }

  // --------------------------------------------------------------- camera
  updateCamera(view, dt) {
    const cam = this.cam;
    const me = view.cars.find((c) => c.id === view.myId);
    const b = view.ball;
    const K = this.camScratch || (this.camScratch = {
      desired: new THREE.Vector3(), look: new THREE.Vector3(), car: new THREE.Vector3(), q: new THREE.Quaternion(),
      f: new THREE.Vector3(), dir: new THREE.Vector3(),
    });
    const desired = K.desired.set(0, 0, 0);
    const look = K.look.set(0, 0, 0);

    if (view.showroom) {
      // Menu backdrop: slow orbit of a car parked at centre field.
      this.showroomT += dt * 0.18;
      const a = this.showroomT;
      desired.set(Math.cos(a) * 11, 3.6, Math.sin(a) * 11);
      look.set(0, 1, 0);
      cam.pos.lerp(desired, 1 - Math.exp(-dt * 3));
      cam.look.lerp(look, 1 - Math.exp(-dt * 3));
    } else if (me && !me.demo) {
      const carPos = K.car.set(me.x, me.y, me.z);
      const f = K.f.set(1, 0, 0).applyQuaternion(K.q.set(me.qx, me.qy, me.qz, me.qw));
      // Car cam follows the heading (or the direction of travel in the air);
      // ball cam swings round to keep the ball dead ahead.
      let yaw;
      if (cam.ballCam && b.live) yaw = Math.atan2(-(b.z - me.z), b.x - me.x);
      else if (me.grounded || Math.hypot(f.x, f.z) > 0.3) yaw = Math.atan2(-f.z, f.x);
      else yaw = Math.atan2(-me.vz, me.vx);
      cam.yaw = dampAngle(cam.yaw, yaw, cam.ballCam ? 7 : 5, dt);
      const dir = K.dir.set(Math.cos(cam.yaw), 0, -Math.sin(cam.yaw));
      desired.copy(carPos).addScaledVector(dir, -cam.dist);
      desired.y += cam.height;
      if (cam.ballCam && b.live) {
        const hd = Math.hypot(b.x - me.x, b.z - me.z);
        // Raise the camera for a high ball so it stays in frame.
        desired.y += clamp((b.y - me.y) / Math.max(hd, 4) * 2.2, -1, 4);
        // Aim along the car->ball line but only a few metres out, so the car
        // stays low and centred in frame and the ball sits above it.
        const up = clamp((b.y - me.y) / Math.max(hd, 3), -0.3, 1.4);
        look.copy(carPos).addScaledVector(dir, 6);
        look.y += 1.4 + up * 4;
      } else {
        look.copy(carPos).addScaledVector(dir, 4);
        look.y += 1.3;
      }
      cam.pos.lerp(desired, 1 - Math.exp(-dt * 11));
      cam.look.lerp(look, 1 - Math.exp(-dt * 14));
    } else {
      // Spectating or respawning: a high orbit that keeps the ball in view.
      const t = performance.now() / 1000 * 0.1;
      desired.set(b.x - Math.cos(t) * 26, 16, b.z + Math.sin(t) * 26 * 0.6);
      look.set(b.x, b.y, b.z);
      cam.pos.lerp(desired, 1 - Math.exp(-dt * 2));
      cam.look.lerp(look, 1 - Math.exp(-dt * 4));
    }

    // Keep the lens inside the stadium (goal boxes excepted).
    const inGoal = Math.abs(cam.pos.z) < F.GW - 0.6 && cam.pos.y < F.GH - 0.6;
    const lim = inGoal ? F.L + F.GD - 0.6 : F.L - 0.6;
    cam.pos.x = clamp(cam.pos.x, -lim, lim);
    cam.pos.z = clamp(cam.pos.z, -F.W + 0.6, F.W - 0.6);
    cam.pos.y = clamp(cam.pos.y, 0.6, F.H - 0.6);

    this.camera.position.copy(cam.pos);
    if (this.shake > 0) {
      const s = this.shake * 0.35;
      this.camera.position.x += (Math.random() - 0.5) * s;
      this.camera.position.y += (Math.random() - 0.5) * s;
      this.camera.position.z += (Math.random() - 0.5) * s;
      this.shake = Math.max(0, this.shake - dt * 2.2);
    }
    this.camera.lookAt(cam.look);
    const speed = me ? Math.hypot(me.vx, me.vy, me.vz) : 0;
    const fov = cam.fov + clamp((speed - 14) * 0.45, 0, 7);
    if (Math.abs(this.camera.fov - fov) > 0.05) {
      this.camera.fov = damp(this.camera.fov, fov, 4, dt);
      this.camera.updateProjectionMatrix();
    }
  }

  /** Screen position of a world point, for DOM overlays. null if behind us. */
  project(x, y, z) {
    const v = this.scratch.v3.set(x, y, z).project(this.camera);
    if (v.z > 1) return null;
    return { x: (v.x * 0.5 + 0.5) * window.innerWidth, y: (-v.y * 0.5 + 0.5) * window.innerHeight, behind: false };
  }
}

/** Make Blender's flat materials behave in Three. */
function prepMaterial(m, kind) {
  if (!m) return;
  const n = m.name || '';
  if (/_glow/.test(n)) {
    // Emission carries the colour; keep the base so bloom has something to catch.
    if (m.emissive && m.emissive.getHex() === 0) m.emissive.copy(m.color);
    // Blender's emission strengths (2-5) are tuned for Cycles; in a
    // tone-mapped real-time scene they blow out every edge into white haze.
    m.emissiveIntensity = Math.min(m.emissiveIntensity || 1, kind === 'arena' ? 1.1 : 1.6);
  }
  // Thin see-through panes: drawing back faces then front faces (Three's
  // default for transparent double-sided) costs a shader rebuild per mesh per
  // pass, for a sort order nobody could see.
  if (kind === 'arena' && n.startsWith('glass')) {
    m.transparent = true; m.opacity = 0.05; m.depthWrite = false; m.side = THREE.DoubleSide; m.forceSinglePass = true;
    m.color.set(0x6f8fc8); m.metalness = 0; m.roughness = 0.2; m.envMapIntensity = 0.15;
  }
  if (n.startsWith('net')) { m.transparent = true; m.opacity = 0.55; m.depthWrite = false; m.side = THREE.DoubleSide; m.forceSinglePass = true; }
  if (kind === 'arena' && n === 'field') { m.roughness = 0.92; m.metalness = 0; }
  if (m.transparent && m.side === THREE.DoubleSide) m.forceSinglePass = true;
}

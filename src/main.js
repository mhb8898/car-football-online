// ---------------------------------------------------------------------------
// Entry point: modes, lobby, the simulation clock, and the render loop.
//
//   SOLO    you are the host of a room nobody else can join. Same code path
//           as hosting, minus the network.
//   HOST    you run the authoritative World, feed it your input, the bots'
//           and every client's queued inputs, and broadcast snapshots.
//   CLIENT  you run a *predicting* World (predict.js) with your own input,
//           and correct it from every snapshot that arrives.
//
// The host draws its own world directly. That differs from the reference
// project (which encodes and decodes even in solo), because here the host's
// world is simply the truth in the present - there is nothing to predict and
// nothing to interpolate toward. tools/netsim.mjs covers the protocol path
// instead, headless.
// ---------------------------------------------------------------------------

import { World, PHASE, EV, TICK } from './world.js';
import { Bot, quantize } from './bot.js';
import { Predictor } from './predict.js';
import { encodeSnapshot, decodeSnapshot, encodeInput, decodeInput, INPUT_REDUNDANCY } from './protocol.js';
import { Host, Client, makeRoomCode, makeToken, b64ToBytes } from './net.js';
import { Renderer } from './render.js';
import { Input } from './input.js';
import * as audio from './audio.js';
import * as settings from './settings.js';
import * as ui from './ui.js';
import { $ } from './ui.js';
import { CAR_TYPES, BTN, MAX_TEAM, TEAM_NAME, CAR as K } from './consts.js';

const TICK_MS = TICK * 1000;
const SNAP_EVERY = 2;              // 60 Hz sim / 2 = 30 Hz snapshots
const MODE = { MENU: 0, LOBBY: 1, MATCH: 2 };
const BOT_NAMES = ['Nova', 'Blitz', 'Turbo', 'Echo', 'Viper', 'Rook', 'Jinx', 'Bolt', 'Ace', 'Zip', 'Flux', 'Dash'];
const SNAP_DIST = 6;

// A refresh mid-match should put you back in your car. sessionStorage is per
// tab, so two tabs of one browser (host + client while testing) don't collide.
const SESSION_KEY = 'tk_session';
function loadSession() {
  try {
    const s = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    return s && s.code && s.pid && s.token && Date.now() - s.at < 20 * 60 * 1000 ? s : null;
  } catch { return null; }
}
function saveSession(s) { try { sessionStorage.setItem(SESSION_KEY, JSON.stringify({ ...s, at: Date.now() })); } catch { /* noop */ } }
function clearSession() { try { sessionStorage.removeItem(SESSION_KEY); } catch { /* noop */ } }

/**
 * A clock that keeps running in a background tab. rAF stops there and a
 * main-thread setInterval is throttled to ~1 Hz, either of which would freeze
 * the match for everyone when the host alt-tabs. Worker timers are not.
 */
function makeTicker(ms, fn) {
  const src = 'let id=null;onmessage=(e)=>{clearInterval(id);if(e.data)id=setInterval(()=>postMessage(0),e.data)}';
  try {
    const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    const w = new Worker(url);
    URL.revokeObjectURL(url);
    w.onmessage = fn;
    w.postMessage(ms);
    return () => w.terminate();
  } catch {
    const id = setInterval(fn, ms);
    return () => clearInterval(id);
  }
}

class Game {
  constructor() {
    this.cfg = settings.get();
    this.renderer = new Renderer($('game'), this.cfg.quality);
    this.renderer.cam.fov = this.cfg.fov;
    this.renderer.cam.dist = this.cfg.dist;
    this.input = new Input();
    this.input.onAction = (a) => this.onAction(a);
    if (settings.isTouch) this.input.bindTouch($('touch'));
    audio.setVolume(this.cfg.volume);
    audio.setMuted(this.cfg.muted);

    this.mode = MODE.MENU;
    this.online = false;
    this.isHost = false;
    this.host = null;
    this.client = null;
    this.myPid = 1;
    this.token = makeToken();
    this.lobby = { players: new Map(), opts: { size: 3, level: 1, length: 300 } };

    this.world = null;         // host: the authority
    this.pred = null;          // client: the prediction
    this.roster = [];          // [{ id, pid, name, team, type, bot }]
    this.bots = new Map();     // carId -> Bot
    this.queues = new Map();   // carId -> pending remote inputs
    this.lastSeq = new Map();  // carId -> newest seq queued
    this.myCar = -1;
    this.snapEvents = [];
    this.stats = new Map();    // client: carId -> stats

    this.acc = 0;
    this.lastT = performance.now();
    this.prev = new Map();     // entity -> position before the last tick
    this.lastCount = null;
    this.ended = false;

    this.bindMenu();
    this.stopTicker = makeTicker(4, () => this.pump());
    requestAnimationFrame((t) => this.frame(t));
    setTimeout(() => $('loading').classList.add('done'), 300);

    const params = new URLSearchParams(location.search);
    const room = (params.get('room') || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
    if (room) {
      $('codeIn').value = room;
      const s = loadSession();
      if (s && s.code === room) this.join(room, s);
      else if (this.cfg.name) this.join(room);
      else { $('menuMsg').textContent = `Enter a name, then press Join to enter room ${room}.`; $('nameIn').focus(); }
    }
  }

  // ================================================================== menu
  bindMenu() {
    const name = $('nameIn');
    name.value = this.cfg.name || '';
    name.addEventListener('input', () => settings.set({ name: name.value.trim().slice(0, 14) }));
    const setCar = (d) => {
      const n = CAR_TYPES.length;
      this.cfg = settings.set({ car: (this.cfg.car + d + n) % n });
      $('carName').textContent = CAR_TYPES[this.cfg.car].name;
      $('carBlurb').textContent = CAR_TYPES[this.cfg.car].blurb;
      audio.sfx.click();
      if (this.mode === MODE.LOBBY) this.sendCarType();
    };
    setCar(0);
    $('carPrev').onclick = () => setCar(-1);
    $('carNext').onclick = () => setCar(1);
    $('soloBtn').onclick = () => this.startSolo();
    $('hostBtn').onclick = () => this.startHost();
    $('joinBtn').onclick = () => this.join($('codeIn').value);
    $('codeIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') this.join($('codeIn').value); });
    $('codeIn').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); });

    $('startBtn').onclick = () => this.hostStartMatch();
    $('leaveLobby').onclick = () => this.leave();
    $('switchTeam').onclick = () => {
      if (this.isHost) this.lobbySwitch(this.myPid);
      else this.client?.sendControl({ t: 'team' });
    };
    for (const id of ['optSize', 'optLevel', 'optLength']) $(id).onchange = () => this.readLobbyOpts();
    $('copyLink').onclick = () => {
      const url = `${location.origin}${location.pathname}?room=${this.lobby.code}`;  // never the dev flags
      navigator.clipboard?.writeText(url).then(() => ui.toast('Invite link copied'), () => ui.toast(url, '', 8000));
    };

    $('rematchBtn').onclick = () => this.hostStartMatch();
    $('toLobbyBtn').onclick = () => this.hostToLobby();
    $('endLeaveBtn').onclick = () => this.leave();
    $('resumeBtn').onclick = () => this.closeOverlay();
    $('quitBtn').onclick = () => this.leave();
    $('pauseSettings').onclick = () => this.openOverlay('settings');
    $('pauseControls').onclick = () => this.openOverlay('controls');
    $('settingsBtn').onclick = () => this.openOverlay('settings');
    $('controlsBtn').onclick = () => this.openOverlay('controls');
    $('settingsDone').onclick = () => this.closeOverlay();
    $('controlsDone').onclick = () => this.closeOverlay();
    this.bindSettings();
    addEventListener('pointerdown', () => audio.unlock(), { once: false });
    addEventListener('keydown', () => audio.unlock());
  }

  bindSettings() {
    const c = this.cfg;
    $('setQuality').value = c.quality;
    $('setFov').value = c.fov;
    $('setDist').value = c.dist;
    $('setVol').value = c.volume;
    $('setBallCam').checked = c.ballCam;
    $('setPlates').checked = c.plates;
    const out = () => {
      $('setFovOut').textContent = $('setFov').value;
      $('setDistOut').textContent = Number($('setDist').value).toFixed(1);
      $('setVolOut').textContent = Math.round($('setVol').value * 100);
    };
    out();
    $('setQuality').onchange = (e) => { this.cfg = settings.set({ quality: e.target.value }); this.renderer.setQuality(e.target.value); };
    $('setFov').oninput = (e) => { this.cfg = settings.set({ fov: +e.target.value }); this.renderer.cam.fov = +e.target.value; out(); };
    $('setDist').oninput = (e) => { this.cfg = settings.set({ dist: +e.target.value }); this.renderer.cam.dist = +e.target.value; out(); };
    $('setVol').oninput = (e) => { this.cfg = settings.set({ volume: +e.target.value }); audio.setVolume(+e.target.value); out(); };
    $('setBallCam').onchange = (e) => { this.cfg = settings.set({ ballCam: e.target.checked }); };
    $('setPlates').onchange = (e) => { this.cfg = settings.set({ plates: e.target.checked }); };
  }

  playerName() {
    const n = ($('nameIn').value || '').trim().slice(0, 14);
    if (n) return n;
    const gen = 'Player' + ((Math.random() * 900 + 100) | 0);
    $('nameIn').value = gen;
    settings.set({ name: gen });
    return gen;
  }

  openOverlay(id) {
    this.overlayBack = ['pause', 'settings', 'controls'].find((s) => ui.isShown(s) && s !== id) || null;
    for (const s of ['pause', 'settings', 'controls']) ui.toggle(s, s === id);
    this.input.enabled = false;
  }
  closeOverlay() {
    for (const s of ['pause', 'settings', 'controls']) ui.toggle(s, false);
    if (this.overlayBack === 'pause' && this.mode === MODE.MATCH) { ui.toggle('pause', true); this.overlayBack = null; return; }
    this.overlayBack = null;
    this.input.enabled = true;
  }

  onAction(a) {
    if (a === 'menu') {
      if (ui.isShown('settings') || ui.isShown('controls')) this.closeOverlay();
      else if (this.mode === MODE.MATCH) {
        if (ui.isShown('pause')) this.closeOverlay(); else this.openOverlay('pause');
      }
    } else if (a === 'ballcam' && this.mode === MODE.MATCH) {
      this.renderer.cam.ballCam = !this.renderer.cam.ballCam;
    } else if (a === 'scores' && this.mode === MODE.MATCH && !this.ended) {
      this.showScores(!ui.isShown('scores'));
    } else if (a === 'mute') {
      this.cfg = settings.set({ muted: !this.cfg.muted });
      audio.setMuted(this.cfg.muted);
      ui.toast(this.cfg.muted ? 'Sound off (M)' : 'Sound on (M)');
    }
  }

  // ================================================================= lobby
  startSolo() {
    audio.unlock();
    this.online = false;
    this.isHost = true;
    this.myPid = 1;
    this.lobby.players = new Map([[1, { pid: 1, name: this.playerName(), team: 0, type: this.cfg.car }]]);
    this.lobby.code = null;
    this.enterLobby();
  }

  async startHost() {
    audio.unlock();
    const code = makeRoomCode();
    $('menuMsg').textContent = 'Opening a room…';
    $('hostBtn').disabled = true;
    const host = new Host(code, {
      onJoin: (pid, name) => this.onJoin(pid, name),
      onRejoin: (pid, name) => this.onJoin(pid, name, true),
      onLeave: (pid) => this.onLeave(pid),
      onControl: (pid, msg) => this.onHostControl(pid, msg),
      onInput: (pid, bytes) => this.onRemoteInput(pid, bytes),
      onStatus: (text, kind) => ui.toast(text, kind),
    });
    try {
      await host.start();
    } catch (e) {
      $('menuMsg').textContent = e.message || 'Could not open a room.';
      $('hostBtn').disabled = false;
      host.close();
      return;
    }
    $('hostBtn').disabled = false;
    $('menuMsg').textContent = '';
    this.host = host;
    this.online = true;
    this.isHost = true;
    this.myPid = 1;
    this.lobby.players = new Map([[1, { pid: 1, name: this.playerName(), team: 0, type: this.cfg.car }]]);
    this.lobby.code = code;
    history.replaceState(null, '', roomUrl(code));
    this.enterLobby();
  }

  enterLobby() {
    this.mode = MODE.LOBBY;
    this.endMatchState();
    ui.show('lobby');
    this.syncLobbyOpts();
    this.renderLobby();
  }

  syncLobbyOpts() {
    const o = this.lobby.opts;
    $('optSize').value = String(o.size);
    $('optLevel').value = String(o.level);
    $('optLength').value = String(o.length);
  }

  readLobbyOpts() {
    if (!this.isHost) return;
    this.lobby.opts = { size: +$('optSize').value, level: +$('optLevel').value, length: +$('optLength').value };
    this.broadcastLobby();
  }

  /** Lobby rows including the bots that would fill each team at kickoff. */
  lobbyRows() {
    const { size, level } = this.lobby.opts;
    const rows = [];
    let b = 0;
    for (const team of [0, 1]) {
      const humans = [...this.lobby.players.values()].filter((p) => p.team === team);
      for (const p of humans) rows.push({ ...p, bot: false, me: p.pid === this.myPid });
      if (level >= 0) for (let i = humans.length; i < size; i++) rows.push({ name: BOT_NAMES[b++ % BOT_NAMES.length], team, bot: true });
    }
    return rows;
  }

  renderLobby() {
    ui.renderLobby(this.lobbyRows(), { isHost: this.isHost, online: this.online, code: this.lobby.code }, (pid) => this.host?.kick(pid));
  }

  broadcastLobby() {
    this.renderLobby();
    if (!this.host) return;
    this.host.sendControl(null, { t: 'lobby', players: [...this.lobby.players.values()], opts: this.lobby.opts, code: this.lobby.code });
  }

  lobbySwitch(pid) {
    const p = this.lobby.players.get(pid);
    if (!p) return;
    const other = 1 - p.team;
    if ([...this.lobby.players.values()].filter((q) => q.team === other).length >= MAX_TEAM) return;
    p.team = other;
    this.broadcastLobby();
  }

  sendCarType() {
    if (this.isHost) {
      const p = this.lobby.players.get(this.myPid);
      if (p) p.type = this.cfg.car;
      const c = this.world?.car(this.myCar);
      if (c) c.type = this.cfg.car;
      this.broadcastLobby();
    } else this.client?.sendControl({ t: 'car', type: this.cfg.car });
  }

  // ------------------------------------------------------------ host side
  onJoin(pid, name, rejoined = false) {
    const players = [...this.lobby.players.values()];
    let p = this.lobby.players.get(pid);
    if (!p) {
      const blue = players.filter((q) => q.team === 0).length;
      const orange = players.filter((q) => q.team === 1).length;
      p = { pid, name, team: blue <= orange ? 0 : 1, type: 0 };
      this.lobby.players.set(pid, p);
    }
    if (this.mode === MODE.MATCH) {
      this.seatMidMatch(p);
      ui.feed(`${ui.tname(p.name, p.team)} ${rejoined ? 'is back' : 'joined'}`);
    } else {
      this.broadcastLobby();
      ui.toast(`${name} joined`);
    }
  }

  onLeave(pid) {
    const p = this.lobby.players.get(pid);
    if (this.mode === MODE.MATCH) {
      // The car stays on the pitch under bot control, so a dropped player
      // doesn't leave their team a man down - and a refresh can reclaim it.
      const r = this.roster.find((x) => x.pid === pid && !x.bot);
      if (r) {
        r.bot = true;
        r.owner = pid;
        r.pid = 0;
        this.bots.set(r.id, new Bot(r.id, Math.max(0, this.lobby.opts.level), r.id));
        this.broadcastRoster();
      }
      if (p) ui.feed(`${ui.tname(p.name, p.team)} left`);
    } else if (p) {
      this.lobby.players.delete(pid);
      this.broadcastLobby();
      ui.toast(`${p.name} left`);
    }
    if (this.mode !== MODE.MATCH) this.lobby.players.delete(pid);
  }

  /** Give a player joining (or rejoining) a running match a car. */
  seatMidMatch(p) {
    let r = this.roster.find((x) => x.owner === p.pid && x.bot);
    if (!r) {
      const count = (team) => this.roster.filter((x) => x.team === team && !x.bot).length;
      const order = count(0) <= count(1) ? [0, 1] : [1, 0];
      for (const team of order) {
        r = this.roster.find((x) => x.team === team && x.bot);
        if (r) break;
        if (this.roster.filter((x) => x.team === team).length < MAX_TEAM) {
          const id = Math.max(0, ...this.roster.map((x) => x.id)) + 1;
          this.world.addCar(id, team, p.type);
          r = { id, pid: p.pid, name: p.name, team, type: p.type, bot: false };
          this.roster.push(r);
          break;
        }
      }
    }
    if (r) {
      this.bots.delete(r.id);
      Object.assign(r, { pid: p.pid, name: p.name, bot: false, owner: undefined });
      p.team = r.team;
      this.queues.set(r.id, []);
      this.lastSeq.set(r.id, 0);
    }
    this.host?.sendControl(p.pid, this.startMsg());
    this.broadcastRoster();
  }

  onHostControl(pid, msg) {
    if (!msg) return;
    if (msg.t === 'team' && this.mode === MODE.LOBBY) this.lobbySwitch(pid);
    else if (msg.t === 'car') {
      const p = this.lobby.players.get(pid);
      const type = Math.max(0, Math.min(CAR_TYPES.length - 1, msg.type | 0));
      if (p) p.type = type;
      const r = this.roster.find((x) => x.pid === pid && !x.bot);
      if (r && this.world) { r.type = type; const c = this.world.car(r.id); if (c) c.type = type; }
      if (this.mode === MODE.LOBBY) this.broadcastLobby();
    } else if (msg.t === 'leave') {
      this.host?.forget(pid);
    }
  }

  onRemoteInput(pid, bytes) {
    const r = this.roster.find((x) => x.pid === pid && !x.bot);
    if (!r || !this.world) return;
    const list = decodeInput(bytes);
    if (!list) return;
    const q = this.queues.get(r.id) || [];
    let last = this.lastSeq.get(r.id) || 0;
    for (const i of list) if (i.seq > last) { q.push(i); last = i.seq; }
    // A burst after a stall would otherwise play back in slow motion forever.
    while (q.length > 6) q.shift();
    this.queues.set(r.id, q);
    this.lastSeq.set(r.id, last);
  }

  hostStartMatch() {
    if (!this.isHost) return;
    const { size, level, length } = this.lobby.opts;
    const world = new World({ length, seed: (Math.random() * 1e9) | 0 });
    this.roster = [];
    this.bots = new Map();
    this.queues = new Map();
    this.lastSeq = new Map();
    let id = 1, bi = (Math.random() * BOT_NAMES.length) | 0;
    for (const team of [0, 1]) {
      const humans = [...this.lobby.players.values()].filter((p) => p.team === team);
      for (const p of humans) {
        world.addCar(id, team, p.type);
        this.roster.push({ id, pid: p.pid, name: p.name, team, type: p.type, bot: false });
        this.queues.set(id, []);
        id++;
      }
      if (level >= 0) {
        for (let i = humans.length; i < size; i++) {
          const type = (id * 7) % CAR_TYPES.length;
          world.addCar(id, team, type);
          this.roster.push({ id, pid: 0, name: BOT_NAMES[bi++ % BOT_NAMES.length], team, type, bot: true });
          this.bots.set(id, new Bot(id, level, id));
          id++;
        }
      }
    }
    world.kickoff();
    this.world = world;
    this.snapEvents = [];
    this.myCar = this.roster.find((r) => r.pid === this.myPid)?.id ?? -1;
    this.host?.sendControl(null, this.startMsg());
    this.beginMatch(length);
  }

  startMsg() {
    return { t: 'start', length: this.world.length, roster: this.roster.map(stripRoster) };
  }

  broadcastRoster() {
    this.host?.sendControl(null, { t: 'roster', roster: this.roster.map(stripRoster) });
  }

  hostToLobby() {
    if (!this.isHost) return;
    // Anyone who dropped during the match is gone for good now.
    for (const [pid] of this.lobby.players) {
      if (pid !== this.myPid && this.host && ![...this.host.peers.values()].some((r) => r.pid === pid && r.joined)) this.lobby.players.delete(pid);
    }
    this.enterLobby();
    this.broadcastLobby();
  }

  // ----------------------------------------------------------- client side
  async join(code, session = null) {
    code = String(code || '').toUpperCase().trim();
    if (code.length !== 5) { $('menuMsg').textContent = 'Room codes are 5 characters.'; return; }
    audio.unlock();
    const name = this.playerName();
    $('menuMsg').textContent = 'Looking for the room…';
    $('joinBtn').disabled = true;
    const client = new Client(code, name, {
      onControl: (m) => this.onClientControl(m),
      onState: (b) => this.onClientState(b),
      onStatus: (t, k) => ui.toast(t, k),
      onStage: (t) => { $('menuMsg').textContent = t; },
      onClose: () => this.onClientClosed(),
    }, session ? { pid: session.pid, token: session.token } : { token: this.token });
    try {
      const w = await client.start();
      this.client = client;
      this.online = true;
      this.isHost = false;
      this.myPid = w.pid;
      this.lobby.code = code;
      saveSession({ code, pid: w.pid, token: client.token });
      history.replaceState(null, '', roomUrl(code));
      $('menuMsg').textContent = '';
      client.sendControl({ t: 'car', type: this.cfg.car });
      if (this.mode === MODE.MENU) { this.mode = MODE.LOBBY; ui.show('lobby'); ui.renderLobby([], { isHost: false, online: true, code }, () => {}); }
    } catch (e) {
      $('menuMsg').textContent = e.message || 'Could not join.';
      client.close();
      if (session) clearSession();
    }
    $('joinBtn').disabled = false;
  }

  onClientControl(m) {
    if (!m) return;
    switch (m.t) {
      case 'lobby':
        this.lobby.players = new Map(m.players.map((p) => [p.pid, p]));
        this.lobby.opts = m.opts;
        if (this.mode !== MODE.LOBBY) { this.mode = MODE.LOBBY; this.endMatchState(); ui.show('lobby'); }
        this.syncLobbyOpts();
        this.renderLobby();
        break;
      case 'start':
        this.roster = m.roster;
        this.pred = new Predictor(m.length);
        this.myCar = this.roster.find((r) => r.pid === this.myPid && !r.bot)?.id ?? -1;
        this.pred.myId = this.myCar;
        this.stats = new Map();
        this.beginMatch(m.length);
        break;
      case 'roster':
        this.roster = m.roster;
        this.myCar = this.roster.find((r) => r.pid === this.myPid && !r.bot)?.id ?? -1;
        if (this.pred) this.pred.myId = this.myCar;
        break;
      case 'goal': this.onGoal(m); break;
      case 'stats': for (const [id, ...s] of m.s) this.stats.set(id, unpackStats(s)); break;
      case 'end':
        for (const [id, ...s] of m.stats) this.stats.set(id, unpackStats(s));
        this.onEnd(m.winner, m.score);
        break;
      case 'snap': this.onClientState(b64ToBytes(m.b)); break;
      case 'kicked':
        this.leave(true);
        $('menuMsg').textContent = 'The host removed you from the room.';
        break;
      default:
    }
  }

  onClientState(bytes) {
    if (!this.pred) return;
    const s = decodeSnapshot(bytes);
    if (!s) return;
    const w = this.pred.world;
    // Remember where things were so the interpolation base moves with the
    // correction instead of smearing it across the next frame.
    const before = new Map(w.cars.map((c) => [c.id, [c.x, c.y, c.z]]));
    before.set('ball', [w.ball.x, w.ball.y, w.ball.z]);
    const evs = this.pred.onSnapshot(s);
    for (const [id, old] of before) {
      const e = id === 'ball' ? w.ball : w.car(id);
      const p = this.prev.get(id);
      if (!e || !p) continue;
      const d = [e.x - old[0], e.y - old[1], e.z - old[2]];
      if (Math.hypot(...d) > SNAP_DIST) { p[0] = e.x; p[1] = e.y; p[2] = e.z; } else { p[0] += d[0]; p[1] += d[1]; p[2] += d[2]; }
    }
    for (const e of evs) this.onEvent(e);
  }

  onClientClosed() {
    if (!this.client) return;
    const s = loadSession();
    this.client = null;
    this.endMatchState();
    this.mode = MODE.MENU;
    ui.show('menu');
    if (s) {
      $('menuMsg').textContent = 'Lost the host - trying to get back in…';
      setTimeout(() => this.join(s.code, s), 1500);
    } else $('menuMsg').textContent = 'Disconnected from the host.';
  }

  leave(silent = false) {
    if (this.client) { this.client.sendControl({ t: 'leave' }); const c = this.client; this.client = null; setTimeout(() => c.close(), 150); }
    if (this.host) { const h = this.host; this.host = null; h.close(); }
    clearSession();
    history.replaceState(null, '', roomUrl(null));
    this.endMatchState();
    this.online = false;
    this.isHost = false;
    this.mode = MODE.MENU;
    ui.show('menu');
    for (const s of ['pause', 'settings', 'controls']) ui.toggle(s, false);
    this.input.enabled = true;
    if (!silent) $('menuMsg').textContent = '';
  }

  // ================================================================= match
  beginMatch() {
    this.mode = MODE.MATCH;
    this.ended = false;
    this.prev.clear();
    this.lastCount = null;
    this.renderer.cam.ballCam = this.cfg.ballCam;
    ui.resetHud();
    ui.hideBanner();
    ui.show('hud');
    ui.toggle('endButtons', false);
    ui.toggle('touch', settings.isTouch);
    this.input.enabled = true;
    audio.sfx.whistle();
  }

  endMatchState() {
    this.world = null;
    this.pred = null;
    this.roster = [];
    this.bots = new Map();
    this.myCar = -1;
    this.ended = false;
    ui.countdown(null);
    ui.nameplates([]);
  }

  /** Called from both the worker ticker and rAF; steps fixed ticks. */
  pump() {
    const now = performance.now();
    this.acc += Math.min(now - this.lastT, 250);
    this.lastT = now;
    while (this.acc >= TICK_MS) {
      this.acc -= TICK_MS;
      if (this.mode === MODE.MATCH) {
        if (this.world) this.hostTick();
        else if (this.pred) this.clientTick();
      }
    }
  }

  capturePrev(w) {
    for (const c of w.cars) {
      const p = this.prev.get(c.id);
      if (p) { p[0] = c.x; p[1] = c.y; p[2] = c.z; } else this.prev.set(c.id, [c.x, c.y, c.z]);
    }
    const b = this.prev.get('ball');
    if (b) { b[0] = w.ball.x; b[1] = w.ball.y; b[2] = w.ball.z; } else this.prev.set('ball', [w.ball.x, w.ball.y, w.ball.z]);
  }

  localInput(car) {
    this.input.airborne = car && !car.grounded;
    return quantize(this.input.read());
  }

  hostTick() {
    const w = this.world;
    this.capturePrev(w);
    const inputs = new Map();
    if (this.myCar >= 0) inputs.set(this.myCar, this.localInput(w.car(this.myCar)));
    for (const [id, bot] of this.bots) inputs.set(id, bot.think(w));
    for (const [id, q] of this.queues) if (q.length) inputs.set(id, q.shift());
    w.step(inputs);
    const evs = w.drainEvents();
    for (const e of evs) {
      this.onEvent(e);
      if (e.type === EV.GOAL) this.hostGoal();
      if (e.type === EV.END) this.hostEnd();
    }
    if (this.host) {
      this.snapEvents.push(...evs);
      if (w.tick % SNAP_EVERY === 0) {
        this.host.broadcastState(encodeSnapshot(w, this.snapEvents));
        this.snapEvents = [];
      }
      if (w.tick % 60 === 0) this.host.sendControl(null, { t: 'stats', s: this.packStats() });
    }
  }

  clientTick() {
    const w = this.pred.world;
    this.capturePrev(w);
    const inp = this.localInput(w.car(this.myCar));
    const evs = this.pred.localTick(inp);
    if (this.myCar >= 0) this.client?.sendState(encodeInput(this.pred.pending.slice(-INPUT_REDUNDANCY)));
    for (const e of evs) this.onEvent(e);
  }

  packStats() {
    return this.world.cars.map((c) => [c.id, c.stats.score, c.stats.goals, c.stats.assists, c.stats.saves, c.stats.shots, c.stats.demos]);
  }

  hostGoal() {
    const g = this.world.lastGoal;
    const name = (id) => this.roster.find((r) => r.id === id)?.name || null;
    const msg = { t: 'goal', team: g.team, scorer: name(g.scorer), assist: name(g.assist), speed: g.speed, score: this.world.score };
    this.host?.sendControl(null, msg);
    this.onGoal(msg);
  }

  hostEnd() {
    const w = this.world;
    this.host?.sendControl(null, { t: 'end', winner: w.winner, score: w.score, stats: this.packStats() });
    this.onEnd(w.winner, w.score);
  }

  onGoal(m) {
    const team = m.team;
    const mine = this.roster.find((r) => r.id === this.myCar);
    const ours = mine ? mine.team === team : true;
    const kph = Math.round(m.speed * 3.6);
    ui.banner('GOAL!', `${m.scorer ? m.scorer : TEAM_NAME[team]}${m.assist ? ` (assist ${m.assist})` : ''} · ${kph} km/h`, team);
    ui.feed(m.scorer ? `${ui.tname(m.scorer, team)} scored${m.assist ? ` · assist ${ui.tname(m.assist, team)}` : ''}` : `${ui.tname(TEAM_NAME[team], team)} scored`);
    audio.sfx.goal(ours);
  }

  onEnd(winner, score) {
    this.ended = true;
    audio.sfx.whistle();
    const mine = this.roster.find((r) => r.id === this.myCar);
    const title = mine ? (mine.team === winner ? 'Victory!' : 'Defeat') : `${TEAM_NAME[winner]} wins`;
    setTimeout(() => {
      if (this.mode !== MODE.MATCH) return;
      this.showScores(true, { title, winner, score });
      ui.toggle('endButtons', true);
      for (const id of ['rematchBtn', 'toLobbyBtn']) ui.toggle(id, this.isHost);
      $('endMsg').textContent = this.isHost ? '' : 'Waiting for the host…';
    }, 1800);
  }

  showScores(on, end = null) {
    ui.toggle('scores', on);
    if (!on) return;
    const w = this.world || this.pred?.world;
    const rows = this.roster.map((r) => ({
      ...r,
      me: r.id === this.myCar,
      stats: (this.world ? this.world.car(r.id)?.stats : this.stats.get(r.id)) || unpackStats([]),
    }));
    ui.scoreboard(rows, end?.score || w?.score || [0, 0], end ? { title: end.title, winner: end.winner } : {});
    if (!end) ui.toggle('endButtons', false);
  }

  // --------------------------------------------------------------- events
  onEvent(e) {
    const w = this.world || this.pred?.world;
    const me = w?.car(this.myCar);
    const dist = me ? Math.hypot(e.x - me.x, e.y - me.y, e.z - me.z) : 20;
    const near = Math.max(0.15, 1 - dist / 70);
    switch (e.type) {
      case EV.HIT:
        if (e.b === 1) { // a save
          const r = this.roster.find((x) => x.id === e.a);
          if (r) ui.feed(`${ui.tname(r.name, r.team)} made a save!`);
          audio.crowdSwell(0.5, 1.5);
          break;
        }
        audio.sfx.hit(e.v, e.a === this.myCar ? 1 : near);
        break;
      case EV.BOUNCE: audio.sfx.bounce(e.v, near); break;
      case EV.JUMP: if (e.a === this.myCar) audio.sfx.jump(); break;
      case EV.DODGE: if (e.a === this.myCar) audio.sfx.dodge(); else audio.sfx.dodge(near * 0.5); break;
      case EV.PAD: if (e.a === this.myCar) audio.sfx.pad(w?.pads[e.b]?.big); break;
      case EV.DEMO: {
        audio.sfx.demo();
        const a = this.roster.find((x) => x.id === e.a), v = this.roster.find((x) => x.id === e.b);
        if (a && v) ui.feed(`${ui.tname(a.name, a.team)} demolished ${ui.tname(v.name, v.team)}`);
        break;
      }
      default:
    }
    this.renderer.onEvent(e);
  }

  // ================================================================ render
  frame(t) {
    requestAnimationFrame((x) => this.frame(x));
    this.pump();
    const dt = Math.min(0.1, (t - (this.lastFrame || t)) / 1000);
    this.lastFrame = t;
    if (this.pred) this.pred.decay(dt);

    const w = this.world || this.pred?.world;
    if (this.mode !== MODE.MATCH || !w || (this.pred && !this.pred.ready)) {
      this.renderer.draw(this.showroomView(), dt);
      audio.engineUpdate(null);
      if (this.mode === MODE.MATCH) ui.hud({ score: [0, 0], clock: 0, boost: 0, ballCam: this.renderer.cam.ballCam, respawn: 0 });
      return;
    }
    const alpha = Math.min(1, this.acc / TICK_MS);
    const view = this.buildView(w, alpha);
    this.renderer.draw(view, dt);

    const me = w.car(this.myCar);
    audio.engineUpdate(me && !me.demo ? Math.hypot(me.vx, me.vy, me.vz) : null, me && (me.inp.b & BTN.BOOST) && me.boost > 0, me?.grounded);
    ui.hud({
      score: w.score, clock: w.clock, overtime: w.overtime, lastCall: w.lastCall,
      boost: me ? me.boost : 0, ballCam: this.renderer.cam.ballCam,
      respawn: me && me.demo ? me.respawnT : 0, spectating: !me,
    });
    this.updateCountdown(w);
    this.updatePlates(view);
    if (this.pred) this.updateNetBadge();
    if (ui.isShown('scores') && !this.ended && (t | 0) % 30 === 0) this.showScores(true);
  }

  updateCountdown(w) {
    const now = performance.now();
    if (this.lastPhase === PHASE.COUNTDOWN && w.phase === PHASE.PLAY) this.goUntil = now + 700;
    this.lastPhase = w.phase;
    let n = null;
    if (w.phase === PHASE.COUNTDOWN) n = String(Math.max(1, Math.ceil(w.phaseT)));
    else if (now < (this.goUntil || 0)) n = 'GO!';
    if (n === this.lastCount) return;
    if (n) audio.sfx.countdown(n === 'GO!');
    this.lastCount = n;
    ui.countdown(n);
  }

  updatePlates(view) {
    if (!this.cfg.plates) { ui.nameplates([]); return; }
    const out = [];
    const cam = this.renderer.camera.position;
    for (const c of view.cars) {
      if (c.id === this.myCar || c.demo) continue;
      const p = this.renderer.project(c.x, c.y + 2.1, c.z);
      if (!p) continue;
      const d = Math.hypot(c.x - cam.x, c.y - cam.y, c.z - cam.z);
      const r = this.roster.find((x) => x.id === c.id);
      out.push({ id: c.id, team: c.team, name: r ? r.name : `Car ${c.id}`, boost: c.boost, x: p.x, y: p.y, alpha: Math.max(0, Math.min(1, (90 - d) / 30)) });
    }
    ui.nameplates(out);
  }

  updateNetBadge() {
    const b = $('netBadge');
    const stale = this.pred.stale;
    b.classList.toggle('hidden', !stale);
    if (stale) b.textContent = 'Connection to host stalled…';
  }

  buildView(w, alpha) {
    const off = (id) => this.pred?.offset(id);
    const pos = (id, e) => {
      const p = this.prev.get(id);
      let x = e.x, y = e.y, z = e.z;
      if (p) { x = p[0] + (e.x - p[0]) * alpha; y = p[1] + (e.y - p[1]) * alpha; z = p[2] + (e.z - p[2]) * alpha; }
      const o = off(id);
      if (o) { x += o.x; y += o.y; z += o.z; }
      return { x, y, z };
    };
    const cars = w.cars.map((c) => {
      const p = pos(c.id, c);
      const sp = Math.hypot(c.vx, c.vy, c.vz);
      return {
        id: c.id, team: c.team, type: c.type, ...p,
        qx: c.qx, qy: c.qy, qz: c.qz, qw: c.qw, vx: c.vx, vy: c.vy, vz: c.vz,
        s: c.inp.s, boost: c.boost, grounded: c.grounded, demo: c.demo,
        boosting: !c.demo && !!(c.inp.b & BTN.BOOST) && c.boost > 0 && w.phase !== PHASE.COUNTDOWN,
        supersonic: sp >= K.SUPERSONIC,
      };
    });
    const bp = pos('ball', w.ball);
    return {
      cars, myId: this.myCar,
      ball: { ...bp, vx: w.ball.vx, vy: w.ball.vy, vz: w.ball.vz, live: w.ball.live },
      pads: w.pads.map((p) => p.t <= 0),
    };
  }

  showroomView() {
    return {
      showroom: true, myId: -1,
      cars: [{ id: 900, team: 0, type: this.cfg.car, x: 0, y: K.RIDE, z: 0, qx: 0, qy: 0, qz: 0, qw: 1, vx: 0, vy: 0, vz: 0, s: 0, boost: 100, grounded: true, demo: false, boosting: false, supersonic: false }],
      ball: { x: 0, y: 6, z: 0, vx: 0, vy: 0, vz: 0, live: false },
      pads: new Array(40).fill(true),
    };
  }
}

/** The current URL with ?room set (or removed), keeping dev flags like ?fakenet. */
function roomUrl(code) {
  const q = new URLSearchParams(location.search);
  if (code) q.set('room', code); else q.delete('room');
  const s = q.toString();
  return location.pathname + (s ? `?${s}` : '');
}

function stripRoster(r) { return { id: r.id, pid: r.pid, name: r.name, team: r.team, type: r.type, bot: r.bot }; }
function unpackStats(s) {
  return { score: s[0] || 0, goals: s[1] || 0, assists: s[2] || 0, saves: s[3] || 0, shots: s[4] || 0, demos: s[5] || 0 };
}

// Dev only: ?fakenet swaps PeerJS for a tab-to-tab fake (tools/fakepeer.js).
if (new URLSearchParams(location.search).has('fakenet')) await import('../tools/fakepeer.js');
window.game = new Game();

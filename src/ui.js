// ---------------------------------------------------------------------------
// DOM: screens, lobby lists, HUD, scoreboard, feed, banners.
// Pure presentation - it is handed data and callbacks, and owns no game state.
// ---------------------------------------------------------------------------

import { TEAM_NAME } from './consts.js';

export const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SCREENS = ['menu', 'lobby', 'hud', 'scores', 'pause', 'settings', 'controls'];
export function show(...ids) {
  for (const s of SCREENS) $(s).classList.toggle('hidden', !ids.includes(s));
}
export function toggle(id, on) { $(id).classList.toggle('hidden', !on); }
export const isShown = (id) => !$(id).classList.contains('hidden');

let toastTimer = 0;
export function toast(text, kind = '', ms = 3500) {
  const t = $('toast');
  t.textContent = text;
  t.className = 'toast ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

// ------------------------------------------------------------------ lobby
/**
 * @param rows   [{ pid, name, team, bot, me }] already including bot fillers
 * @param opts   { isHost, online, code, canKick }
 */
export function renderLobby(rows, opts, onKick) {
  $('lobbyTitle').textContent = opts.online ? 'Online lobby' : 'Exhibition vs bots';
  toggle('roomRow', !!opts.online);
  if (opts.code) $('roomCode').textContent = opts.code;
  for (const [team, id] of [[0, 'teamBlue'], [1, 'teamOrange']]) {
    const ul = $(id);
    ul.innerHTML = '';
    for (const r of rows.filter((x) => x.team === team)) {
      const li = document.createElement('li');
      if (r.bot) li.className = 'bot';
      if (r.me) li.classList.add('me');
      li.innerHTML = `<span>${esc(r.name)}</span><span class="tagc">${r.bot ? 'bot' : r.pid === 1 ? 'host' : r.me ? 'you' : ''}</span>`;
      if (opts.isHost && !r.bot && !r.me && opts.online) {
        const k = document.createElement('button');
        k.className = 'btn tiny kick';
        k.textContent = 'Kick';
        k.onclick = () => {
          if (k.dataset.armed) onKick(r.pid);
          else { k.dataset.armed = '1'; k.textContent = 'Sure?'; setTimeout(() => { delete k.dataset.armed; k.textContent = 'Kick'; }, 2500); }
        };
        li.appendChild(k);
      }
      ul.appendChild(li);
    }
  }
  $('lobbySettings').classList.toggle('readonly', !opts.isHost);
  for (const s of ['optSize', 'optLevel', 'optLength']) $(s).disabled = !opts.isHost;
  toggle('startBtn', opts.isHost);
  $('lobbyMsg').textContent = opts.isHost ? '' : 'Waiting for the host to kick off…';
}

// -------------------------------------------------------------------- HUD
export function fmtClock(sec, overtime) {
  const s = Math.max(0, overtime ? Math.floor(sec) : Math.ceil(sec));
  return `${overtime ? '+' : ''}${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

let last = {};
function setText(id, v) { if (last[id] !== v) { last[id] = v; $(id).textContent = v; } }
export function resetHud() { last = {}; }

export function hud(h) {
  setText('scoreB', String(h.score[0]));
  setText('scoreO', String(h.score[1]));
  setText('clock', fmtClock(h.clock, h.overtime));
  setText('clockTag', h.overtime ? 'OVERTIME' : h.lastCall ? 'LAST PLAY' : '');
  const boost = Math.round(h.boost ?? 0);
  setText('boostNum', String(boost));
  const arc = $('boostArc');
  const len = (boost / 100) * 235.6;
  if (last.arc !== len) { last.arc = len; arc.style.strokeDasharray = `${len} 314.2`; }
  toggle('respawn', h.respawn > 0);
  if (h.respawn > 0) setText('respawnT', String(Math.ceil(h.respawn)));
  $('camTag').classList.toggle('on', h.ballCam);
  setText('camTag', h.ballCam ? 'Ball cam: on (B)' : 'Ball cam: off (B)');
  toggle('spectTag', h.spectating);
}

let cdLast = null;
export function countdown(n) {
  const el = $('countdown');
  if (n === cdLast) return;
  cdLast = n;
  if (n === null) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  el.classList.toggle('go', n === 'GO!');
  el.textContent = n;
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
}

let bannerTimer = 0;
export function banner(top, sub, team, ms = 2800) {
  const b = $('banner');
  $('bannerTop').textContent = top;
  $('bannerSub').textContent = sub || '';
  $('bannerSub').classList.toggle('hidden', !sub);
  b.className = 'banner ' + (team === 0 ? 'b' : team === 1 ? 'o' : '');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => b.classList.add('hidden'), ms);
}
export function hideBanner() { $('banner').classList.add('hidden'); }

export function feed(html) {
  const f = $('feed');
  const d = document.createElement('div');
  d.innerHTML = html;
  f.prepend(d);
  while (f.children.length > 5) f.lastChild.remove();
  setTimeout(() => d.remove(), 6000);
}
export const tname = (name, team) => `<span class="${team ? 'o' : 'b'}">${esc(name)}</span>`;

// -------------------------------------------------------------- nameplates
const plates = new Map();
export function nameplates(list) {
  const root = $('plates');
  const seen = new Set();
  for (const p of list) {
    seen.add(p.id);
    let el = plates.get(p.id);
    if (!el) {
      el = document.createElement('div');
      el.innerHTML = '<span></span><i class="bb"></i>';
      root.appendChild(el);
      plates.set(p.id, el);
    }
    el.className = 'plate t' + p.team;
    if (el.firstChild.textContent !== p.name) el.firstChild.textContent = p.name;
    el.lastChild.style.width = `${Math.round(p.boost)}%`;
    el.style.left = `${p.x.toFixed(1)}px`;
    el.style.top = `${p.y.toFixed(1)}px`;
    el.style.opacity = p.alpha.toFixed(2);
  }
  for (const [id, el] of plates) if (!seen.has(id)) { el.remove(); plates.delete(id); }
}

// -------------------------------------------------------------- scoreboard
/**
 * @param rows [{ id, name, team, bot, me, stats }]
 */
export function scoreboard(rows, score, { title, winner = -1 } = {}) {
  $('scoresTitle').textContent = title || 'Scoreboard';
  // MVP is the top scorer on the winning side, as in the game this echoes.
  const best = rows.filter((r) => r.team === winner).reduce((m, r) => (r.stats.score > (m?.stats.score ?? -1) ? r : m), null);
  let html = winner >= 0 ? `<p class="winner t${winner}">${TEAM_NAME[winner]} wins ${score[winner]}-${score[1 - winner]}</p>` : '';
  for (const team of [0, 1]) {
    html += `<div class="thead t${team}"><span>${TEAM_NAME[team]}</span><span>${score[team]}</span></div>`;
    html += `<table class="stable t${team}"><tr><th>Player</th><th>Score</th><th>Goals</th><th>Assists</th><th>Saves</th><th>Shots</th><th>Demos</th></tr>`;
    for (const r of rows.filter((x) => x.team === team).sort((a, b) => b.stats.score - a.stats.score)) {
      const s = r.stats;
      const mvp = winner >= 0 && best && r.id === best.id ? '<span class="mvp">MVP</span>' : '';
      html += `<tr class="${r.me ? 'me' : ''}"><td>${esc(r.name)}${r.bot ? ' <small>(bot)</small>' : ''}${mvp}</td><td>${s.score}</td><td>${s.goals}</td><td>${s.assists}</td><td>${s.saves}</td><td>${s.shots}</td><td>${s.demos}</td></tr>`;
    }
    html += '</table>';
  }
  $('scoresBody').innerHTML = html;
}

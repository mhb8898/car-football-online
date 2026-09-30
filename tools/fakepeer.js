// ---------------------------------------------------------------------------
// A stand-in for PeerJS that connects tabs of one browser over
// BroadcastChannel. Development only: main.js loads it when the page URL
// carries ?fakenet (optionally ?fakenet=80 for 80 ms each way, &loss=0.05 to
// drop that share of packets on unreliable channels).
//
// Why it exists: WebRTC needs a working UDP path, and some machines don't
// have one - a VPN in TUN mode, for example, can swallow every candidate,
// even between two tabs on the same laptop. Everything above the transport
// (lobby, snapshots, inputs, prediction) is this game's own code, and this
// lets it be exercised anyway, with latency and loss dialled in on purpose.
// Only the API surface net.js uses is implemented.
// ---------------------------------------------------------------------------

const params = new URLSearchParams(location.search);
const DELAY = Number(params.get('fakenet')) || 0;
const LOSS = Number(params.get('loss')) || 0;
const bus = new BroadcastChannel('fakepeer-v1');
const peers = new Map();                     // id -> FakePeer living in this tab
const uid = () => Math.random().toString(36).slice(2, 10);

class Emitter {
  constructor() { this.h = {}; }
  on(ev, fn) { (this.h[ev] ||= []).push(fn); return this; }
  emit(ev, ...a) { for (const fn of this.h[ev] || []) fn(...a); }
}

class FakeConn extends Emitter {
  constructor(owner, remote, id, opts) {
    super();
    this.owner = owner; this.peer = remote; this.connId = id;
    this.label = opts.label; this.reliable = opts.reliable !== false;
    this.serialization = opts.serialization; this.open = false;
    this.peerConnection = { iceConnectionState: 'connected', addEventListener() {} };
  }
  send(data) {
    if (!this.open) return;
    if (!this.reliable && Math.random() < LOSS) return;
    const payload = data instanceof Uint8Array ? data.slice() : data;
    const post = () => bus.postMessage({ k: 'data', to: this.peer, from: this.owner.id, conn: this.connId, payload });
    if (DELAY) setTimeout(post, DELAY * (this.reliable ? 1 : 0.8 + Math.random() * 0.4)); else post();
  }
  close() {
    if (!this.open) return;
    this.open = false;
    bus.postMessage({ k: 'close', to: this.peer, from: this.owner.id, conn: this.connId });
    this.emit('close');
  }
}

class FakePeer extends Emitter {
  constructor(id) {
    super();
    this.id = id || uid();
    this.conns = new Map();
    this.destroyed = false;
    peers.set(this.id, this);
    // Claim the id; anyone already holding it answers 'taken'.
    bus.postMessage({ k: 'claim', id: this.id });
    this.claimT = setTimeout(() => this.emit('open', this.id), 300);
  }
  connect(remote, opts = {}) {
    const c = new FakeConn(this, remote, uid(), opts);
    this.conns.set(c.connId, c);
    bus.postMessage({ k: 'connect', to: remote, from: this.id, conn: c.connId, opts });
    c.timer = setTimeout(() => { if (!c.open) this.emit('error', { type: 'peer-unavailable' }); }, 3000);
    return c;
  }
  reconnect() {}
  destroy() {
    this.destroyed = true;
    for (const c of this.conns.values()) c.close();
    peers.delete(this.id);
  }
}

bus.onmessage = ({ data: m }) => {
  if (m.k === 'claim') {
    if (peers.has(m.id)) bus.postMessage({ k: 'taken', id: m.id });
    return;
  }
  if (m.k === 'taken') {
    const p = peers.get(m.id);
    if (p && p.claimT) { clearTimeout(p.claimT); p.emit('error', { type: 'unavailable-id' }); }
    return;
  }
  const p = peers.get(m.to);
  if (!p || p.destroyed) return;
  if (m.k === 'connect') {
    const c = new FakeConn(p, m.from, m.conn, m.opts);
    p.conns.set(m.conn, c);
    p.emit('connection', c);
    c.open = true;
    bus.postMessage({ k: 'accept', to: m.from, from: p.id, conn: m.conn });
    setTimeout(() => c.emit('open'), 0);
  } else if (m.k === 'accept') {
    const c = p.conns.get(m.conn);
    if (c && !c.open) { clearTimeout(c.timer); c.open = true; c.emit('open'); }
  } else if (m.k === 'data') {
    const c = p.conns.get(m.conn);
    if (c && c.open) c.emit('data', m.payload);
  } else if (m.k === 'close') {
    const c = p.conns.get(m.conn);
    if (c && c.open) { c.open = false; c.emit('close'); }
  }
};

window.Peer = FakePeer;
console.log(`[fakepeer] active: ${DELAY} ms, loss ${LOSS}`);

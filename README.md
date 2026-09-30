# Turbo Kickoff

Rocket-powered car football in the browser: drive, boost, jump, flip into a
ball twice your size and put it in the net. **1v1 up to 4v4 online over
WebRTC**, with bots filling any empty seat, hosted as a plain static site on
GitHub Pages.

**Play:** https://mhb8898.github.io/car-football-online/

No install, no accounts, no game server. One player hosts, everyone else joins
with a 5-character room code (or the invite link).

It shares its transport with [Potato Royale 3D](https://github.com/mhb8898/brotato-online-3d),
but the netcode above it is different, because a ball game needs something
an arena shooter doesn't.

---

## Why the netcode predicts the whole world

The usual browser-game recipe predicts **your own** character and shows
everything else ~100 ms in the past, interpolated between snapshots. That's
fine when enemies are far away. In car football it breaks the core action:
your car is drawn now and the ball a round trip ago, so you drive straight
through a ball that then flies off on its own.

So the simulation is written to run identically on host and clients
(`src/world.js`: pure JS, no DOM, no clock, no `Math.random()` in the
physics), and every client runs its own copy:

```
host  ── snapshot (tick T, full save-state) ──►  client
                                                  1. load the snapshot into its World
                                                  2. drop inputs the host has consumed (ack)
                                                  3. replay the rest, one tick each
                                                  4. keep stepping with live input
```

The ball and every car come out in the **present**. The only thing a client
can't know is what other players will press next; it assumes "same as last
tick" and the next snapshot corrects it. Corrections go into a per-object
visual offset that decays over a few frames, so the simulation snaps but the
picture glides.

For the replay to land where the host did, a snapshot has to carry **every**
field the physics reads: velocity, orientation, angular velocity, jump
timers, "was jump already held" (edge detection), the ball-punch cooldown.
That's why cars go as float32 rather than packed int16. It comes to ~82 bytes
a car, under 1 KB for a full 4v4, at 30 Hz.

`tools/netsim.mjs` runs a host and a client in one process with fake latency
and loss and measures the error:

```
$ node tools/netsim.mjs --ms 80 --loss 0.05
own car error: median 0.000  p95 0.000  max 0.00 m
ball error:    median 0.000  p95 0.009  max 3.59 m
```

Your own car is exact. The ball is exact until someone *else* touches it,
which no client can foresee. The next snapshot fixes that within a frame or
two.

### The rest of the transport

Same design as the sibling project:

- **PeerJS's public broker** does the WebRTC handshake only, then gets out of
  the way; gameplay is peer-to-peer.
- **Star topology**: the host is the authority, and each client holds one
  connection.
- **Two data channels per peer**: `s` is unreliable and unordered (snapshots
  and inputs; a late snapshot is worse than a lost one). `c` is reliable and
  ordered (lobby, roster, goals, stats, end of match).
- **Inputs are sent 4 at a time** (the last four ticks), so a lost packet costs
  nothing. The host queues them per car and consumes one per tick.
- The **simulation clock is a Web Worker timer**, because `requestAnimationFrame`
  stops in background tabs and a host who alt-tabs would freeze everyone.
- **Refreshing rejoins.** The tab remembers its seat and a secret token. While
  you're gone a bot drives your car, and you get it back when you return.

## Gameplay

- **Driving**: throttle, brake, reverse, powerslide, and boost to
  supersonic (28 m/s).
- **Jump, double jump and dodge.** Jump, then press jump again with a
  direction to flip; a flip into the ball hits 35% harder.
- **Air control**: pitch, yaw and air roll, with boost pushing along the
  nose, so aerials work.
- **Boost pads**: 6 big (100) and 22 small (12), mirrored so no side is
  favoured.
- **Demolitions**: hit an opponent at supersonic speed and they respawn 3 s
  later.
- **Match rules** follow the game this echoes: kickoffs from five mirrored
  spots, a 2/3/5 minute clock, and **"last play"**, where at 0:00 the match
  ends when the ball next touches the floor. A tie goes to golden-goal
  overtime.
- **Stats**: goals, assists, saves, shots and demos, a score, and an MVP.
  Shots and saves are detected by tracing the ball's path before and after
  each touch.
- **Bots** (Rookie / Pro / All-Star) run on the host only. To clients they
  are just more cars.

**Controls** — `W/S` drive (pitch in the air), `A/D` steer (yaw), `Space`
jump/dodge, `Shift` or left mouse boost, `Ctrl` powerslide/air roll, `Q/E` air
roll, `B` ball cam, `Tab` scoreboard, `Esc` menu, `M` mute. Keys match by
physical position, so WASD works on any keyboard layout. Gamepads use the
standard mapping, and touch devices get a stick and buttons.

## The art is made in Blender

Every model in `assets/` is generated by a script in `tools/blender/`,
built with bmesh and exported to glTF:

| Script | Output |
|---|---|
| `cars.py` | `cars.glb`: Comet, Stinger, Bulldog. Separate wheel objects (spun and steered in game) and an `exhaust` marker for the flame. |
| `ball.py` | `ball.glb`: truncated-icosahedron panels with glowing seams, radius exactly 1.9 m. |
| `pads.py` | `pads.glb`: big and small boost pads, with orbs that hide while respawning. |
| `arena.py` | `arena.glb` + `field.jpg`: pitch texture, walls, glass, goals with nets, 4000-seat crowd, floodlights. |

The scripts share one set of conventions with the game (`src/consts.js`):
1 unit = 1 m, forward is +X, and the playable faces of the stadium sit
exactly on the planes the physics collides with. Material names carry
meaning: `paint` is recoloured per team, `*_glow` is emissive, `glass` and
`net` are transparent. Cars have exactly the same hitbox whatever they look
like.

To rebuild, run a script inside Blender, e.g. from the Python console:

```python
import runpy; runpy.run_path("tools/blender/cars.py", run_name="__main__")
```

The renderer draws procedural stand-ins until the models load, and keeps
using them if the models never arrive, so missing art costs looks, not the
game.

## Running locally

Any static server over `http://` works (ES modules don't load from `file://`):

```bash
python3 tools/serve.py 8777      # like http.server, but never cached
# open http://localhost:8777
```

There is no build step; `git push` is the deploy.

Useful tools:

```bash
node tools/sim.mjs --size 3 --minutes 5 --runs 3   # bots vs bots, headless
node tools/netsim.mjs --ms 120 --loss 0.1          # prediction error under bad networks
```

To test multiplayer on one machine, open two tabs. If WebRTC can't connect
on your network (a VPN in TUN mode can block every candidate, even between
two local tabs), add `?fakenet` to both URLs. That swaps PeerJS for a tab-to-tab
fake over `BroadcastChannel`, so the lobby, snapshots, inputs and prediction
can still be exercised. `?fakenet=80&loss=0.05` adds latency and loss.

## Deploying your own copy

1. Push this repo to GitHub.
2. **Settings → Pages → Deploy from a branch → `main` / root.**
3. Your copy is live at `https://<user>.github.io/<repo>/`.

Signalling and TURN servers are configured in `src/config.js`. See the
comments there for self-hosting the PeerJS broker and for adding a TURN relay,
which the ~10–15% of connections behind symmetric NATs need.

## Project layout

```
index.html        shell: menu, lobby, HUD, overlays
style.css         all UI
src/
  consts.js       field, ball and car constants, pads, kickoff spots
  world.js        the deterministic simulation (runs on host AND clients)
  bot.js          bot AI (host only)
  protocol.js     binary snapshot and input formats
  predict.js      client-side whole-world prediction and smoothing
  net.js          PeerJS transport (from the sibling project)
  config.js       signalling, ICE/TURN, tick rates
  render.js       Three.js: stadium, cars, ball, particles, cameras, bloom
  input.js        keyboard, gamepad, touch
  audio.js        procedural WebAudio (engine, boost, hits, horn, crowd)
  ui.js           DOM for screens, lobby, HUD and scoreboard
  main.js         modes, lobby flow, sim clock, render loop
assets/           Blender output (.glb, field.jpg)
tools/
  blender/        one script per asset, plus shared helpers
  sim.mjs         headless bot matches
  netsim.mjs      headless prediction-accuracy test
  fakepeer.js     tab-to-tab PeerJS stand-in for testing (?fakenet)
  serve.py        no-cache dev server
```

## Licence

MIT — see [LICENSE](LICENSE).

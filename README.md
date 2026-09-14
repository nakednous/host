# `@nakednous/host`

DOM transport for `@nakednous/tree` — pointer input with per-pointer capture, the interactive
handle controller and pointer router, players and a frame loop, helm and track factories, 6-DOF
device streams (WebHID, Gamepad), image and video sources, a DOM label overlay and the orbit —
**zero renderer**, pure vanilla DOM.

> **Status: 0.0.x.** The whole surface below is shipped. What a bridge draws (a handle's locus,
> a track's path, a helm's rig) lives in `webgl.tree` / `p5.tree`; the host only computes, through
> `@nakednous/tree`, and listens.

---

## Installation

```bash
npm install @nakednous/host
```

```js
import { createHost } from '@nakednous/host'
import { createCamera, PLANE } from '@nakednous/tree'

const cam = createCamera({ eye: [0, 0, 10] })
const host = createHost(canvas, {
  onFrame(dt) {
    host.view.setCamera(cam)              // the matrices every pick and label reads
    if (!h.update()) orbit.update()       // the handle gate falls through to the orbit
    draw()
    host.labels.tick()
  },
})
const h = host.handle({ constraint: PLANE, normal: [0, 0, 1] })
const orbit = host.orbit(cam)
```

---

## Architecture

`@nakednous/host` is the transport layer of an engine-free stack. It knows nothing about
WebGL or WebGPU — it owns a canvas element's input and the frame clock, and hands numbers to
`@nakednous/tree`.

```
  application
      │
      ▼
  webgl.tree · webgpu.tree    ← bridge: the GPU, thinly
      │
      ├── @nakednous/host     ← this package: pointer, handles, tracks, helms, players, streams, media, labels, orbit
      │        │
      │        └── @nakednous/tree
      │
      ├── @nakednous/ui       ← optional: DOM panels
      │
      └── @nakednous/tree     ← math, spaces, animation, visibility
```

Dependency direction is strict: `tree ← host`; host never imports ui, ui never imports host,
and nothing flows back into tree.

---

## The surface

One context per canvas. Every construct is a method on it, takes its one positional
dependency first and an options object last, and registers with the context so
`host.dispose()` releases everything.

| member | what it is |
|---|---|
| `createHost(canvas, opts)` | the context: `ndcZMin` (WEBGL default, or WEBGPU), `onFrame(dt, host)` for the host's own loop, `onSize(w, h, dpr)` for the bridge's buffer, `raf` / `caf` overrides |
| `host.view` | the view bag — `mat4Proj` · `mat4View` · `mat4PV` · `mat4PVInv` · `mat4Eye`, `vp`, `ndcZMin`, `stale`; `set(P, V)`, `setCamera(cam)`, `resize(w, h)` |
| `host.pointer` | the pointer source — presses queued per frame, per-pointer entries with a move counter, claims that capture on the canvas, Esc cancel, `flush()` |
| `host.players` | the registry ticked each frame — `{ tick(dt) → boolean }`, removed on `false` |
| `host.width` · `host.height` · `host.dpr` | the canvas observer's logical size and pixel ratio |
| `host.dt` · `host.clock()` | last frame period and seconds since creation |
| `host.handle(opts)` | `Handle` — a draggable core constraint (`SPHERE` · `PLANE` · `AXIS` · `DIAL` · `VIEW`, or a contract object); `update()`, `value(out, opts)`, snap, hover, cancel, `from` |
| `host.router(handles, opts)` | `PointerRouter` — one shared pick over overlapping handles, nearest proxy wins; shared hover |
| `host.cameraHelm(cam, opts)` · `host.poseHelm(opts)` | a core `PoseHelm` on the players: body-fly a camera state, or integrate into a pose in `WORLD` · `EYE` · `SELF` · a mat4 and `bind()` a target |
| `host.poseTrack(opts)` · `host.cameraTrack(cam, opts)` | core tracks ticked while they play; `{ handles }` builds `TrackHandles`, one handle per keyframe |
| `host.hid(opts)` · `host.gamepad(opts)` | rate streams — `lin[3]` / `ang[3]` in raw device units, `bind(helm)` feeds it each tick; `available`, `connected` |
| `host.image(url)` · `host.video(opts)` · `host.raster(draw, w, h)` | texture sources — an `ImageBitmap`, a hidden `<video>` from a file or the camera with a `ready` promise, a Canvas2D drawing |
| `host.model(url)` | an OBJ model as arrays — `{ position, normal?, texcoord?, indices }`, what twgl's `createBufferInfoFromArrays` takes; parsed by `webgl-obj-loader`, materials ignored |
| `host.labels` · `host.hasLabels` | the label layer, created on first access — `set(id, text, x, y, z, opts)` at a world anchor, `setScreen(id, text, sx, sy, opts)` in canvas px, `{ frame: true }` for a label that lives one frame, `tick()`; `hasLabels` probes without creating |
| `host.orbit(cam, opts)` | the fall-through gesture — one pointer orbits, two pan and dolly, the wheel dollies; `update()` reports whether the camera moved; the vertical sense follows the bag's projection (y-up GL, y-flipped p5) |
| `host.tick(dt)` | external-loop mode: tick the players; the caller flushes the pointer once its consumers ran |
| `host.register(c)` · `host.unregister(c)` · `host.dispose()` | the lifecycle |

The module-level functions behind the methods are exported too (`createView`, `createPointer`,
`createPlayers`, `createLoop`, `observeCanvas`, `Handle`, `PointerRouter`, `cameraHelm`,
`poseHelm`, `helmBasis`, `poseTrack`, `cameraTrack`, `TrackHandles`, `createHid`,
`createGamepad`, `decodeSpaceNavigator`, `loadImage`, `createVideo`, `raster`, `loadModel`, `createLabels`,
`createOrbit`), so an adapter can compose them on its own context.

---

## The frame

Two loop modes. With `{ onFrame }` the host runs `requestAnimationFrame`; without it the
application — or the p5 adapter from its `predraw` — calls `host.tick(dt)` and flushes the
pointer itself. Inside a frame the order is fixed, because each step reads what the previous
one wrote:

1. **players tick** — a playing track writes its camera state or pose, a helm integrates the
   stream it was fed, a stream polls its device.
2. **install the camera** — `host.view.setCamera(cam)` (or `set(P, V)` from renderer state):
   the matrices every pick, solve, label and orbit reads this frame.
3. **handles and routers update** — presses are picked, drags solved, claims taken.
4. **the orbit falls through** — `if (!h.update()) orbit.update()`: only unclaimed pointers
   reach it.
5. **draw** — the bridge reads the camera state, the handles' values, the tracks' paths.
6. **labels tick** — world anchors projected through the current bag, transforms written.
7. **pointer flush** — the press queue empties, released pointers leave.

`dt` is seconds, clamped to 50 ms so a stalled tab never integrates a leap.

---

## Seams

| seam | direction | contract |
|---|---|---|
| view bag | bridge → host | the bridge's `setCamera(cam)` also calls `host.view.setCamera(cam)`; without a host the bridge keeps its own matrices |
| external tick | adapter → host | `host.tick(dt)` from the adapter's predraw; `host.labels.tick()` after the adapter set `host.view` from renderer state |
| proxies · locus | tree → host → bridge | constraint objects carry `proxy` and `locus`; the host tests, the bridge draws |
| label anchors | tree → bridge → host | a generator writes `out.labels`; the bridge forwards each to `labels.set` |
| rate stream | host → tree | `helm.feed(lin, ang)` per tick, raw device units; the helm's profile scales |
| camera state | host ↔ tree ↔ bridge | plain data: the orbit, a track, a helm write it; `setCamera(cam)` reads it |
| bridge camera | host → bridge | a camera helm or track exposes `_onApply(cam)`, fired after each write, for an adapter that mirrors the state into its own camera |
| construction | host → bridge | `TrackHandles` builds members through `_makeHandle(opts)` / `_makeRouter(opts)`, so a subclass makes members it can draw |
| device interfaces | test → host | `hid`, `gamepads`, `document`, `media`, `raf` / `caf` options replace the globals |

---

## Conventions

- Options object last; the context's factories take their one positional dependency first.
- Out-first, zero allocation in every per-frame path: `value(out, …)`, the streams' triples,
  the label positions, the view bag's matrices — caller- or host-owned buffers allocated once.
- Every DOM listener attached by the context is removed by `dispose()`.
- Errors are `console.error` with a `[host]` prefix and a fallback, never a throw.
- Library code: semicolons, JSDoc on every public member, `@module host/<file>`.

---

## Development

```bash
npm test          # node:test — DOM pieces against a minimal stub, math through tree
npm run build     # rollup → dist/index.js
```

---

## License

AGPL-3.0-only  
© JP Charalambos

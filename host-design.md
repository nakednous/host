# `host` — DOM transport (design)

> Target: `@nakednous/host` 0.0.1 on `@nakednous/tree` 0.0.28+ (the core additions:
> `camera.js`, `unproject`, the analytic proxies). Consumers: `twgl.tree`, `webgpu.tree`,
> and later the `p5.tree` adapter. The apex is `stack-design.md` in the tree repo; this doc
> owns the host's surface at implementation depth.
> Status: **design only** — no code. Names marked *(provisional)* are open to veto. The
> reference for every ported behaviour is `p5.tree/src/{handle,track,helm}.js` — this doc
> states what moves, what stays identical, and what changes, not the algorithms already
> settled there.

---

## 1 · Scope

Host is the **signal host** of the notebook's pseudo-host, as a package: the things a
program needs from the browser that are neither math nor GPU — a canvas element's pointer
input, the frame clock, device streams, decoded media, DOM text — and the three control
constructs (Handle · Track · Helm) driven from them. It is pure vanilla DOM and knows nothing
about WebGL or WebGPU. Everything it computes goes through `@nakednous/tree`; everything it
draws, it does not — a bridge does.

What it is not: a panel library (that is ui), a renderer, a scene, a loop the application
must adopt (the loop is optional; the players are tickable from outside).

---

## 2 · Layering

```
@nakednous/tree    math, constructs' cores, camera state, unproject, proxies
       ↑
@nakednous/host    this package — one context per canvas: pointer, view bag, players,
                   loop, handles + router, helm + track factories, streams, media,
                   labels, orbit, canvas observer
       ↑
twgl.tree · webgpu.tree · (p5.tree adapter)
```

`tree ← host`; host never imports ui; nothing flows back. A bridge takes the host as an
argument where it needs it (`setCamera(gl, cam, { host })`) — host never imports a bridge.

---

## 3 · The context — `createHost(canvas, opts)` *(provisional)*

One instance per canvas element, the way a p5 sketch has one instance. It owns the pointer
source, the view bag, the players, the label layer, and the canvas observer, and it is the
factory for every construct on that canvas, so the sketch surface stays one object:

```js
const host = createHost(canvas, { onFrame })

host.pointer      // the pointer source (§5)
host.view         // the view bag (§4)
host.players      // the registry (§8)
host.labels       // the DOM text layer (§11)
host.width · host.height · host.dpr   // from the canvas observer (§13)
host.clock()      // seconds since creation
host.dt           // last frame period, clamped

host.handle(opts)                 host.router(handles, opts)
host.orbit(cam, opts)
host.poseTrack(opts)              host.cameraTrack(cam, opts)
host.poseHelm(opts)               host.cameraHelm(cam, opts)
host.hid(opts)                    host.gamepad(opts)
host.image(url)                   host.video(opts)          host.raster(draw, w, h)
host.tick(dt)                     // external-loop mode
host.dispose()
```

Why a context rather than free factories: every construct needs the same three things —
the pointer source, the view bag, the players — and passing them to each factory is the
redundant-signature pattern the rules forbid. The modules underneath are still separable
(`pointer.js` exports its class; the p5 adapter uses it alone), but the public entry is the
context.

**Two loop modes.**

- `{ onFrame }` given: the host runs `requestAnimationFrame` (overridable: `{ raf }`, the
  seam a WebXR session fills later). Each frame: compute `dt` (clamped to 50 ms, the
  stalled-tab guard), `players.tick(dt)`, `onFrame(dt, host)`, then `labels.tick()`.
- `{ onFrame }` absent: **external-tick mode**. The application (or the p5 adapter from
  `predraw`) calls `host.tick(dt)` = `players.tick(dt)`, and `host.labels.tick()` after it
  has set the view. Nothing else in the host cares who owns the loop.

**Frame order inside `onFrame`** is the notation's, and the one the p5 controller already
imposes: the application installs the camera (which fills `host.view`), then updates its
handles or routers, then falls through to the orbit when nothing grabbed, then draws.

```js
function onFrame(dt) {
  setCamera(gl, cam, { host })          // a bridge call; fills host.view
  if (!router.update()) orbit.update()  // measure → condition → apply, gated
  scene()
}
```

---

## 4 · The view bag — `host.view`

The one object every pick, solve, label and orbit reads: the matrices bag `mapLocation`
takes, plus the viewport and the NDC convention.

```js
host.view = {
  mat4Proj, mat4View, mat4PV, mat4PVInv,   // Float32Array(16) each, host-owned
  vp,                                      // [0, h, w, −h] — y-down, logical canvas px
  ndcZMin,                                 // WEBGL | WEBGPU, set once by the bridge
  set(P, V)                                // copy P and V, recompute PV and PVInv
  setCamera(cam)                           // build V and P from camera state, then set
}
```

`set(P, V)` is the raw seam; `setCamera(cam)` is `cameraView` + `cameraProj(cam, aspect,
ndcZMin)` with `aspect` from the observer, then `set`. A bridge given `{ host }` calls one
of them from its own `setCamera`; the p5 adapter calls `set` from renderer state. `vp` is
written by the canvas observer; `ndcZMin` is written once by whoever creates the context
for a GPU API (`createHost(canvas, { ndcZMin: WEBGL })`) — never detected.

`mat4PVInv` is recomputed on `set`, once per frame, so `unproject` and every `SCREEN →
WORLD` mapping share it. Degenerate `V` or `P` leaves the previous inverse and marks the
bag stale; consumers treat a stale bag as "no pick this frame."

---

## 5 · The pointer source — `host.pointer`

One source per canvas, shared by every handle, router and orbit on it. It is the
notation's `pointer`.

- **Events**: `pointerdown` · `pointermove` · `pointerup` · `pointercancel` on the canvas,
  `keydown` (Esc) on the window. Listeners only record; nothing solves in a listener.
- **Coordinates**: logical canvas px through the element's bounding rectangle — `(clientX −
  rect.left) · (width / rect.width)` — so a CSS-scaled canvas maps correctly (the
  `mouseX` skew the p5 controller works around). The same numbers `mapLocation(SCREEN)`
  and `vp` expect.
- **Per-pointer**: every event carries its `pointerId`; the source keeps a map `id → { x,
  y, down, moved, up, cancel }` and a queue of presses in order. Multitouch is per-pointer
  by construction; the mouse is one more pointer.
- **Capture**: on a claimed press the source calls `setPointerCapture(id)` on the canvas, so
  a drag that leaves the canvas keeps flowing; released on up / cancel / dispose.
- **Consumption**: consumers read the queues inside the frame and mark what they claimed
  (`claim(id, owner)` / `release(id)`); an unclaimed pointer is what the orbit sees. The
  press queue drains once per frame, so several same-frame presses on different members
  all land — the router's lifted limit, now the source's.
- **Esc** sets a cancel flag on every currently claimed pointer.

The source has no notion of a handle; it is a typed event buffer with claims.

---

## 6 · Handle — `host.handle(opts)`

The p5 controller, ported. The semantics below are **identical** to `p5.tree` and are not
restated: the update ordering contract (host-driven, before the orbit); the grab / solve /
release state machine keyed to one `pointerId`; `snap` at the solve seam (angular for
`SPHERE` az/el and `DIAL` θ, a world grid for `PLANE` / `AXIS` / `VIEW`, `PLANE`
re-projecting); `hover` as a lone-handle opt-in; cancel (Esc · `pointercancel` ·
`cancel()`) reverting to the grab-time value with exact θ winding, restoring the binding,
firing `onCancel` not `onRelease`; the hooks `onGrab` / `onChange` / `onRelease` /
`onCancel` user-first with lib-space `_on*` seams; the deferred constraint frame `from`
resolved each idle frame through `mapDirection` and frozen at grab; `anchor(v)` moving the
reference with the stored point riding along per kind; `sync()`; `scalar()`; `azEl(out2)`;
`enabled`; `dispose()`; `VIEW` as a core `PLANE` re-aimed at the camera each solve.

What changes:

- **The pick is analytic.** `_pickAt(x, y)` becomes: `unproject(o, d, x, y, view)` → `radius
  = grabPx · pixelRatio(point)` → `t = constraint.proxy(o, d, radius)`; a hit is a finite
  `t`. Built-in kinds use the core defaults (a sphere at the handle point; the capsule-chain
  ring for `DIAL`); a custom kind supplies `proxy` on its constraint object — the seam that
  replaces `pickProxy(h, pos, rad)`. No framebuffer, no readback, no per-instance proxy prep.
  Hover costs one `unproject` and one proxy test per moved frame.
- **The camera is read from the view bag**, never from a camera object. `VIEW`'s re-aim
  takes the look direction as `mapDirection(_k, EYE → WORLD, view)`; the `from` resolution
  uses the same bag. A handle therefore works under any camera the application installs —
  a track, a helm, an orbit, an XR pose — because all of them end in `host.view`.
- **`value(out, opts)` is out-first, `out` required.** `opts.to` is `WORLD` (default),
  `EYE`, or a `mat4` frame; `opts.report` overrides the constraint's. The allocating
  convenience (`h.value()` → a fresh vector) is the p5 adapter's, not the host's.
- **`bind(target)` takes two shapes**: an `{ get, set }` accessor, or a `vec3` array
  mutated in place. Camera fields need no third shape — the camera state is plain data, so
  `bind(cam.eye)` / `bind(cam.center)` *is* the field binder. `set` receives the reused
  value array (no per-frame allocation), `onChange` the same array.
- **No draw.** `locusLines(out, handle, opts)` in the core writes the locus by kind (sphere
  wire · plane quad · axis segment · dial ring · view square) plus the aim line and the
  dot's position; the bridge's `handle.draw` uploads and draws it. A custom kind supplies a
  `locus(out, …)` generator on its constraint object, or draws nothing but dot and aim.
- **Options**: as `createHandle` minus `drawLocus` / `pickProxy` (now contract members),
  minus the p5 vector types. `from` is `WORLD` · `EYE` · a `mat4`, exactly `mapDirection`'s.

```js
const h = host.handle({
  constraint: SPHERE,        // SPHERE | PLANE | AXIS | DIAL | VIEW | a constraint object
  report: DIRECTION,         // POINT | DIRECTION
  anchor, radius, axis, normal, zero, extent,
  from,                      // WORLD | EYE | mat4 — deferred basis frame
  grabPx: 12, snap: null, hover: false, enabled: true,
  bind,                      // accessor | vec3
  onGrab, onChange, onRelease, onCancel,
})
h.update()                   // reads host.view and host.pointer; returns grabbed
h.value(out, { to, report })
h.bind(target) · h.sync() · h.anchor(v) · h.cancel() · h.scalar() · h.azEl(out2)
h.grabbed() · h.hovered() · h.enabled · h.dispose()
```

---

## 7 · Router — `host.router(handles, opts)`

The p5 router, ported, with its pick made analytic. Identical: members' own move / solve /
release machinery, the router replacing only the down step through an injected `_adopt`;
queued presses all resolving; the claimed-pointer map; shared hover (default on) setting at
most one hovered member; `add` / `remove` toggling `_routed` and owning the members'
`_onRelease` / `_onCancel` seams; `update()` delegating to every member and returning
whether any grabbed; `hovered()`; `dispose()`.

What changes: `_sharedPick(x, y)` is one `unproject` and one `proxy` test per enabled
member, **nearest `t` wins** — the same winner the depth buffer chose, without a pass. Ties
(coincident dots, the every-keyframe-targets-the-origin case) resolve to the first member,
as the pass resolved by draw order. Presses and hover moves come from `host.pointer`'s
queues, not from the router's own listeners; the router claims through the source.

---

## 8 · Players, tracks, helms

**`host.players`** — the registry the loop ticks. `add(player)` / `remove(player)` /
`tick(dt)`; a player is `{ tick(dt) → boolean }`, removed when it returns `false`. Tracks
register through their `_onActivate` / `_onDeactivate` hooks (wired by the factories),
helms permanently until disposed. Iteration snapshots the set, so a player may remove
itself or add another during a tick.

**`host.poseTrack(opts)`** — a core `PoseTrack` with the activation hooks wired to
`host.players`; `{ handles }` decorates it with `TrackHandles` (§8.1). **`host.cameraTrack(cam,
opts)`** — a core `CameraTrack` whose player ticks and evaluates straight into `cam`: the
camera state *is* the keyframe shape, so `track.eval(cam)` is the write; on deactivate it
evaluates once more so the camera rests on the path. `add()` with no argument captures
`cam`; `add({ camera })` accepts any camera-state object. No `{ camera }` duck-typing of
lookat scalars — that was p5's.

**`host.cameraHelm(cam, opts)`** — a core `PoseHelm` seeded from `cam` (`pos ← eye`, `rot ←
qFromLookDir(center − eye, up)`), integrating body-fly in `cameraEye(cam)` each tick and
writing back through `cameraFromPose(cam, pose)` — constant gaze distance, as the p5
`applyPose` TRS branch. **`host.poseHelm(opts)`** — a core `PoseHelm` with `from` (`WORLD` ·
`EYE` · `SELF` · a `mat4`) resolved against `host.view` for `EYE` (the eye matrix as
`mat4Invert(view.mat4View)`, cached per frame) and the helm's own pose for `SELF`; `bind`
takes a camera state, an `{ applyPose }` sink, a `{ get, set }` accessor, or a `{ pos, rot }`
object — the p5 factory's four shapes minus `p5.Camera`, plus the camera state. Both expose
the core surface plus `bind` (pose helm) and `dispose`.

### 8.1 TrackHandles

Ported verbatim from `p5.tree/src/track.js`: one `VIEW` member per draggable keyframe field
(`pos` / `eye` / `center`), the optional `rot` `DIAL` per keyframe about a declared axis,
the shared router, index-resolved binders so `set(i, spec)` never strands a member, rebuild
on `keyframes.length` change, idle sync, the position → rot-anchor forward on `onChange`,
the keyframe-coordinate hooks. Changes: binders write into the keyframe arrays directly
(`a[0] = v[0] …`), no `p5.Vector`; the draw is the bridge's (`trackPath` `HANDLES` bit →
`locusLines` per member); `update()` reads `host.view`.

---

## 9 · Streams — `host.hid(opts)` · `host.gamepad(opts)`

The measure-by-subscription transports. Each yields `lin[3]` / `ang[3]` and, when bound,
feeds a helm every frame; the helm's `profile` does all scaling, so the streams carry raw
device units and no configuration beyond identification and decoding.

- **`host.hid({ filters, decode, bind })`** — WebHID. `connect()` must run from a user
  gesture (`navigator.hid.requestDevice({ filters })`); `filters` default to the
  3Dconnexion vendor. `decode(report, reportId, lin, ang)` fills the triples from a report;
  the default decodes the SpaceNavigator's two-report int16 little-endian layout, the `e7`
  experiment's. Reports arrive out of band into the stream's buffers; the frame reads the
  latest — last-write-wins, the notation's subscribe-into-buffer. Permissions-Policy gates
  `requestDevice` to top-level documents: a stream in an iframe reports `available ===
  false` and never prompts.
- **`host.gamepad({ index, map, bind })`** — the Gamepad API, polled once per frame from
  `navigator.getGamepads()`; `map` names which axes feed which lanes (default: left stick →
  `lin[0]` / `lin[1]`, right stick → `ang[1]` / `ang[0]`, triggers → `lin[2]`); dead axes
  read exactly `0`.
- **`bind(helm)`** on either: each poll calls `helm.feed(lin, ang)`. `unbind()`,
  `dispose()`. Both expose `available` and `connected` for a UI to reflect.

---

## 10 · Media — `host.image(url)` · `host.video(opts)` · `host.raster(draw, w, h)`

- **`image(url) → Promise<ImageBitmap>`** — `fetch` + `createImageBitmap`. No orientation
  option here: whether rows are flipped is the bridge's `upload` (twgl's `flipY`), because
  it depends on the GPU API's texture space.
- **`video({ src } | { camera: { facingMode, width, height } })`** — a `<video>` element
  (`muted`, `playsInline`, hidden) from a file or `getUserMedia`; returns `{ el, ready,
  width, height, start(), stop(), dispose() }`. `ready` resolves at `loadedmetadata`; the
  bridge's `upload(tex, source.el)` refreshes the texture each frame. A camera source inside
  an iframe needs `allow="camera"` on the frame — the notebook's existing note; the host
  surfaces the denial as a rejected `ready`, never a silent black.
- **`raster(draw, w, h) → ImageBitmap`** — an `OffscreenCanvas` (or a detached canvas)
  2D context handed to `draw(ctx)`, transferred to a bitmap. The text path for textures:
  glyph strips, billboard tags, anything Canvas2D can typeset with real shaping.

---

## 11 · Labels — `host.labels`

DOM text over the canvas: the replacement for WEBGL `text()` in HUDs, gizmo labels and
formula readouts, with the browser's own shaping.

- **Layer**: one absolutely positioned `<div>` overlaying the canvas, sized by the observer,
  `pointer-events: none` so it never steals input. It is inserted as the canvas's next
  sibling; the host sets the parent to `position: relative` if it is `static`, and says so
  in the console once.
- **API**: `set(id, text, x, y, z, opts)` — a world anchor, projected each `tick()` through
  `mapLocation(WORLD → SCREEN, host.view)`; `opts` carries `dx` / `dy` pixel offsets, an
  anchor (`center` default; `left` · `right`), and a class name for CSS. `setScreen(id,
  text, sx, sy, opts)` places in canvas px directly — the HUD form. `remove(id)`,
  `clear()`, `visible`.
- **Behaviour**: a label whose screen depth falls outside `[0, 1]` or whose anchor leaves
  the canvas is hidden, not clamped. Elements are reused by id; `tick()` writes `transform`
  only, no layout thrash. Text content updates only when the string changed.
- **Gizmo anchors**: a generator that carries text — the helm rig's `identify` lane labels
  — writes anchors into `out.labels` (`{ x, y, z, text }` per label); the bridge's gizmo call
  forwards them to `labels.set` under a gizmo-scoped id, so `helmRig(gl, helm, { identify:
  true })` just works. `axes` `LABELS` are line glyphs and never come here.

---

## 12 · Orbit — `host.orbit(cam, opts)`

The fall-through gesture: what the notation cuts as overlay, and what the handle gate
yields to.

- **One pointer**: drag → `cameraOrbit(cam, dAz, dEl)` about `cam.center`, sensitivity in
  radians per pixel (`opts.rotate`, default `0.005`), elevation clamped short of the poles.
- **Two pointers**: Δ distance → `cameraDolly(cam, factor)` toward `center`; Δ midpoint →
  `cameraPan(cam, dx, dy)` in the eye's right / up, y sign correct. Computed from the two
  pointers' own coordinates, deterministically — the consumer-side fix the notebook's iOS
  notes describe.
- **Wheel**: dolly; `opts.wheel` scales it.
- **`update()`** consumes only *unclaimed* pointers and returns `true` when it moved the
  camera, so `if (!h.update()) orbit.update()` reads as the p5 gate. It writes `cam` only;
  the next frame's `setCamera(cam)` installs it.
- **Options**: `rotate`, `pan`, `zoom` scalars; `minDistance` / `maxDistance`; `enabled`.
  `home()` restores the pose captured at creation.

No damping, no inertia — direct manipulation wants exactness, and a sketch that wants
smoothing lerps the camera it owns.

---

## 13 · Canvas — the observer

Created with the context. A `ResizeObserver` on the canvas element plus `devicePixelRatio`
tracking: on change it updates `host.width` / `host.height` (logical CSS px), `host.dpr`,
`host.view.vp` (`[0, height, width, −height]`), the label layer's size, and calls
`opts.onSize(width, height, dpr)` so the bridge can resize the drawing buffer. The host
never touches `canvas.width` / `canvas.height` — that is the renderer's decision.

---

## 14 · Conventions

- Library code: semicolons, JSDoc on every public member, `@module host/<file>`; example
  code in docs: no semicolons.
- Options object last; the context's factories take their one positional dependency first
  (`orbit(cam, opts)`, `cameraTrack(cam, opts)`).
- Out-first, zero-alloc in every per-frame path: `value(out, …)`, the projected label
  positions, the streams' triples, the view bag's matrices — all caller- or host-owned
  buffers allocated once.
- Module-level scratch is per module, as in the p5 controller: `update()` runs to
  completion within one frame with no reentrancy across handles.
- Every DOM listener attached by the context is removed by `dispose()`; constructs
  register with the context so `host.dispose()` disposes them all — the p5 `remove`
  lifecycle, generalized.
- Errors are `console.error` with a `[host]` prefix and a fallback, never a throw, matching
  the p5 bridge's tone.

---

## 15 · Seams

| seam | direction | contract |
|---|---|---|
| view bag | bridge → host | `setCamera(gl, cam, { host })` calls `host.view.setCamera(cam)`; without a host the bridge keeps its own matrices |
| external tick | adapter → host | `host.tick(dt)` from `predraw`; `host.labels.tick()` after the adapter sets `host.view` from renderer state |
| proxies · locus | tree → host → bridge | constraint objects carry `proxy` and `locus`; host tests, bridge draws |
| label anchors | tree → bridge → host | `out.labels` from a generator; the bridge forwards to `labels.set` |
| rate stream | host → tree | `helm.feed(lin, ang)` per poll |
| camera state | host ↔ tree ↔ bridge | plain data; the orbit, a track, a helm write it; `setCamera(cam)` reads it |

---

## 16 · Gates

The host items of the apex's §6.2, owned here: the label overlay under CSS scaling / DPR /
a scrolled iframe; WebHID on Wayland / Chromium and the Gamepad polling cadence; the
two-finger orbit across Chromium, Firefox, iOS WebKit; external tick from a p5 sketch with
no host loop. Plus two of its own:

- **Claims versus capture.** When a router claims a pointer for a member and the member
  later cancels, the source must release capture on the same frame the claim clears;
  *experiment:* a two-member cluster, Esc mid-drag, then an immediate second press.
- **Label layer insertion.** Setting the canvas parent to `position: relative` is an
  intrusion; *experiment:* the notebook's Hextra content column and the docs runner's
  srcdoc iframe — if either breaks layout, the layer becomes a `position: fixed` element
  tracking the canvas rectangle instead.

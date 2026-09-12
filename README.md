# `@nakednous/host`

DOM transport for `@nakednous/tree` — pointer input with per-pointer capture, the interactive
handle controller and pointer router, players and a frame loop, 6-DOF device streams (WebHID,
Gamepad), image and video sources, a DOM label overlay — **zero renderer**, pure vanilla DOM.

> **Status: 0.0.x.** Shipped: the context (`createHost`), the view bag, the pointer source,
> players and the frame loop, the canvas observer, `Handle` and `PointerRouter`, the helm and
> track factories with `TrackHandles`. Still to land: device streams, media, the label overlay
> and the orbit.

---

## Installation

```bash
npm install @nakednous/host
```

```js
import { createHost } from '@nakednous/host'

const host = createHost(canvas)          // one per canvas
host.view.setCamera(cam)                 // a @nakednous/tree camera state
const h = host.handle({ constraint: PLANE, normal: [0, 0, 1] })
// each frame: if (!h.update()) orbit(); …; host.tick(dt)
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
  twgl.tree · webgpu.tree     ← bridge: the GPU, thinly
      │
      ├── @nakednous/host     ← this package: pointer, handles, tracks, helms, players, streams, media
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

## License

AGPL-3.0-only  
© JP Charalambos

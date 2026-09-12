# `@nakednous/host`

DOM transport for `@nakednous/tree` — pointer input with per-pointer capture, the interactive
handle controller and pointer router, players and a frame loop, 6-DOF device streams (WebHID,
Gamepad), image and video sources, a DOM label overlay — **zero renderer**, pure vanilla DOM.

> **Status: design.** The package surface is being settled in `host-design.md`; no source has
> been written. This README is a placeholder that states the package's place in the stack.

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

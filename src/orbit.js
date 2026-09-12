/**
 * @file The orbit — the fall-through camera gesture on unclaimed pointers.
 * @module host/orbit
 * @license AGPL-3.0-only
 *
 * What the handle gate yields to: one pointer orbits the camera state about
 * its center, two pointers dolly by their distance and pan by their
 * midpoint, the wheel dollies. update() consumes only unclaimed pointers and
 * returns true when it moved the camera, so
 *
 *   if (!h.update()) orbit.update()
 *
 * reads as the gate. It writes cam only; the next setCamera(cam) installs it.
 * Two-pointer motion is computed from the pointers' own coordinates, never
 * from a browser's pinch synthesis, so it reads the same on every platform;
 * the canvas gets touch-action: none while the orbit lives so the browser
 * does not scroll or zoom the page instead. No damping, no inertia: direct
 * manipulation wants exactness, and a sketch that wants smoothing lerps the
 * camera it owns.
 */

'use strict';

import { createCamera, cameraCopy, cameraOrbit, cameraDolly, cameraPan, pixelRatio } from '@nakednous/tree';

const _clamp = { min: 0, max: Infinity };

/**
 * Create an orbit on a camera state.
 *
 * @param {object} host
 * @param {object} cam  The camera state written.
 * @param {{ rotate?:number, pan?:number, zoom?:number, wheel?:number,
 *           minDistance?:number, maxDistance?:number, enabled?:boolean }} [opts]
 *        rotate: radians per pixel (default 0.005). pan / zoom / wheel:
 *        scalars on the two-pointer pan, the pinch and the wheel dolly
 *        (default 1). minDistance / maxDistance: gaze-distance clamps.
 * @returns {object} The orbit: { cam, enabled, rotate, pan, zoom, wheel,
 *          minDistance, maxDistance, update(), home(), dispose() }.
 */
export function createOrbit(host, cam, opts) {
  const o = opts || {};
  const canvas = host.canvas;
  const home = cameraCopy(createCamera(), cam);
  const tracked = new Map();   // pointer id → { x, y } as last consumed
  let wheelAcc = 0;

  const onWheel = (e) => {
    if (typeof e.preventDefault === 'function') e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? (host.height || 1) : 1;
    wheelAcc += (e.deltaY || 0) * unit;
  };
  canvas.addEventListener('wheel', onWheel, { passive: false });
  const touchAction = canvas.style ? canvas.style.touchAction : undefined;
  if (canvas.style) canvas.style.touchAction = 'none';

  const track = (p) => {
    let t = tracked.get(p.id);
    if (!t) { t = { x: p.x, y: p.y }; tracked.set(p.id, t); }
    else { t.x = p.x; t.y = p.y; }
  };
  const distance = () => {
    const e = cam.eye, c = cam.center;
    return Math.hypot(e[0] - c[0], e[1] - c[1], e[2] - c[2]);
  };
  const dolly = (factor) => {
    _clamp.min = orbit.minDistance; _clamp.max = orbit.maxDistance;
    cameraDolly(cam, factor, _clamp);
  };

  const orbit = {
    /** The camera state written. */
    cam,
    /** False makes update() a no-op that drops its pointer memory. */
    enabled: o.enabled !== false,
    /** Radians per pixel of one-pointer drag. */
    rotate: o.rotate ?? 0.005,
    /** Scalar on the two-pointer pan. */
    pan: o.pan ?? 1,
    /** Scalar on the pinch dolly's exponent. */
    zoom: o.zoom ?? 1,
    /** Scalar on the wheel dolly. */
    wheel: o.wheel ?? 1,
    /** Gaze-distance clamps for every dolly. */
    minDistance: o.minDistance ?? 0,
    maxDistance: o.maxDistance ?? Infinity,

    /**
     * Consume this frame's unclaimed pointer motion and wheel into cam.
     * @returns {boolean} Whether the camera moved.
     */
    update() {
      if (!orbit.enabled) { tracked.clear(); wheelAcc = 0; return false; }
      const src = host.pointer;
      let a = null, b = null;
      for (const p of src.pointers.values()) {
        if (p.owner !== null || p.up || p.cancel) { tracked.delete(p.id); continue; }
        if (a === null || p.id < a.id) { b = a; a = p; }
        else if (b === null || p.id < b.id) b = p;
      }
      for (const id of tracked.keys()) {
        if ((a === null || id !== a.id) && (b === null || id !== b.id)) tracked.delete(id);
      }
      let moved = false;
      if (a !== null && b === null) {
        const t = tracked.get(a.id);
        if (t) {
          const dx = a.x - t.x, dy = a.y - t.y;
          if (dx !== 0 || dy !== 0) { cameraOrbit(cam, -dx * orbit.rotate, dy * orbit.rotate); moved = true; }
        }
        track(a);
      } else if (a !== null && b !== null) {
        const ta = tracked.get(a.id), tb = tracked.get(b.id);
        if (ta && tb) {
          const dmx = (a.x + b.x - ta.x - tb.x) / 2, dmy = (a.y + b.y - ta.y - tb.y) / 2;
          if (dmx !== 0 || dmy !== 0) {
            const view = host.view;
            const ratio = pixelRatio(view.mat4Proj, -view.vp[3] || 1, -distance(), view.ndcZMin);
            cameraPan(cam, -dmx * ratio * orbit.pan, dmy * ratio * orbit.pan);
            moved = true;
          }
          const d0 = Math.hypot(ta.x - tb.x, ta.y - tb.y), d1 = Math.hypot(a.x - b.x, a.y - b.y);
          if (d0 > 0 && d1 > 0 && d0 !== d1) { dolly(Math.pow(d0 / d1, orbit.zoom)); moved = true; }
        }
        track(a); track(b);
      }
      if (wheelAcc !== 0) {
        dolly(Math.exp(wheelAcc * 0.001 * orbit.wheel));
        wheelAcc = 0;
        moved = true;
      }
      return moved;
    },

    /** Restore the pose captured at creation. */
    home() { cameraCopy(cam, home); return orbit; },

    /** Remove the wheel listener, restore touch-action, unregister from the host. */
    dispose() {
      canvas.removeEventListener('wheel', onWheel);
      if (canvas.style) canvas.style.touchAction = touchAction;
      tracked.clear();
      host.unregister(orbit);
      return orbit;
    },
  };
  return host.register(orbit);
}

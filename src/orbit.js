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
 * does not scroll or zoom the page instead. `damping`, seconds, makes the
 * camera trail the gesture through a first-order lag: each step of a drag —
 * orbit, pan and dolly lanes — and each wheel notch is an impulse the camera
 * drains with that time constant through tree's coast, so it follows the
 * finger about `damping` behind and, after a release, travels the rest of
 * what the finger did and no more, a flick easing out. A fresh touch drops
 * what is still draining, so do home() and enabled = false. The default is
 * 0.2 s; 0 makes the orbit exact.
 *
 * Canvas y runs down; which world direction that is depends on the
 * projection installed in the view bag: a y-up projection (GL's, tree's
 * default) maps a downward drag to the eye's −up, a y-flipped one (p5's,
 * mat4Proj[5] < 0) to +up. The orbit reads that sign off the bag each
 * update, so a drag down always brings the scene down.
 */

'use strict';

import { createCamera, cameraCopy, cameraOrbit, cameraDolly, cameraPan, pixelRatio, coastStep, coastAlive } from '@nakednous/tree';

const _clamp = { min: 0, max: Infinity };
const _now = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
const EPS = 1e-4;        // a rate below this in every lane ends the drain
const DT_MAX = 0.1;      // seconds, the measured frame's clamp

/**
 * Create an orbit on a camera state.
 *
 * @param {object} host
 * @param {object} cam  The camera state written.
 * @param {{ rotate?:number, pan?:number, zoom?:number, wheel?:number, damping?:number,
 *           minDistance?:number, maxDistance?:number, enabled?:boolean }} [opts]
 *        rotate: radians per pixel (default 0.005). pan / zoom / wheel:
 *        scalars on the two-pointer pan, the pinch and the wheel dolly
 *        (default 1). damping: the lag's time constant in seconds (default
 *        0.2; 0 exact). minDistance / maxDistance: gaze-distance clamps.
 * @returns {object} The orbit: { cam, enabled, rotate, pan, zoom, wheel, damping,
 *          minDistance, maxDistance, update(dt), home(), dispose() }.
 */
export function createOrbit(host, cam, opts) {
  const o = opts || {};
  const canvas = host.canvas;
  const home = cameraCopy(createCamera(), cam);
  const tracked = new Map();   // pointer id → { x, y } as last consumed
  let wheelAcc = 0;
  const rate = [0, 0, 0, 0, 0];           // what is still draining: dAz, dEl, panX, panY, log dolly — per second
  const step = [0, 0, 0, 0, 0];           // one frame of it
  let lastNow = 0, wasPressed = false;

  const cancel = () => { for (let i = 0; i < 5; i++) rate[i] = 0; };
  const apply = (s) => {
    if (s[0] !== 0 || s[1] !== 0) cameraOrbit(cam, s[0], s[1]);
    if (s[2] !== 0 || s[3] !== 0) cameraPan(cam, s[2], s[3]);
    if (s[4] !== 0) dolly(Math.exp(s[4]));
  };

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
    /** The lag's time constant, seconds; 0 makes the orbit exact. */
    damping: o.damping ?? 0.2,
    /** Gaze-distance clamps for every dolly. */
    minDistance: o.minDistance ?? 0,
    maxDistance: o.maxDistance ?? Infinity,

    /**
     * Consume this frame's unclaimed pointer motion and wheel into cam —
     * through the lag when damping is on.
     * @param {number} [dt]  The frame in seconds; measured since the last update when omitted.
     * @returns {boolean} Whether the camera moved.
     */
    update(dt) {
      const now = _now();
      if (typeof dt !== 'number') dt = lastNow ? Math.min((now - lastNow) / 1000, DT_MAX) : 0;
      lastNow = now;
      if (!orbit.enabled) { tracked.clear(); wheelAcc = 0; cancel(); wasPressed = false; return false; }
      const src = host.pointer;
      let a = null, b = null;
      for (const p of src.pointers.values()) {
        // a hovering mouse has an entry without a press; only pressed, unclaimed, live pointers drive
        if (!p.down || p.owner !== null || p.up || p.cancel) { tracked.delete(p.id); continue; }
        if (a === null || p.id < a.id) { b = a; a = p; }
        else if (b === null || p.id < b.id) b = p;
      }
      for (const id of tracked.keys()) {
        if ((a === null || id !== a.id) && (b === null || id !== b.id)) tracked.delete(id);
      }
      const tau = orbit.damping > 0 ? orbit.damping : 0;
      const pressed = a !== null;
      if (pressed && !wasPressed) cancel();         // a fresh touch catches the scene: what was still draining is dropped
      wasPressed = pressed;
      let moved = false;
      let az = 0, el = 0, px = 0, py = 0, ld = 0;   // this frame's step
      const view = host.view;
      const ys = view.mat4Proj[5] < 0 ? -1 : 1;   // canvas-down is the eye's −up under a y-up projection, +up under p5's flip
      if (a !== null && b === null) {
        const t = tracked.get(a.id);
        if (t) {
          const dx = a.x - t.x, dy = a.y - t.y;
          if (dx !== 0 || dy !== 0) { az = -dx * orbit.rotate; el = ys * dy * orbit.rotate; }
        }
        track(a);
      } else if (a !== null && b !== null) {
        const ta = tracked.get(a.id), tb = tracked.get(b.id);
        if (ta && tb) {
          const dmx = (a.x + b.x - ta.x - tb.x) / 2, dmy = (a.y + b.y - ta.y - tb.y) / 2;
          if (dmx !== 0 || dmy !== 0) {
            const ratio = pixelRatio(view.mat4Proj, -view.vp[3] || 1, -distance(), view.ndcZMin);
            px = -dmx * ratio * orbit.pan; py = ys * dmy * ratio * orbit.pan;
          }
          const d0 = Math.hypot(ta.x - tb.x, ta.y - tb.y), d1 = Math.hypot(a.x - b.x, a.y - b.y);
          if (d0 > 0 && d1 > 0 && d0 !== d1) ld = orbit.zoom * Math.log(d0 / d1);
        }
        track(a); track(b);
      }
      // the step: exact, or — with damping — an impulse the drain below spreads over time
      if (az !== 0 || el !== 0 || px !== 0 || py !== 0 || ld !== 0) {
        if (tau > 0) { rate[0] += az / tau; rate[1] += el / tau; rate[2] += px / tau; rate[3] += py / tau; rate[4] += ld / tau; }
        else { step[0] = az; step[1] = el; step[2] = px; step[3] = py; step[4] = ld; apply(step); moved = true; }
      }
      if (wheelAcc !== 0) {
        const w = wheelAcc * 0.001 * orbit.wheel;
        wheelAcc = 0;
        if (tau > 0) rate[4] += w / tau;
        else { dolly(Math.exp(w)); moved = true; }
      }
      if (tau > 0 && coastAlive(rate, EPS)) { apply(coastStep(step, rate, dt, tau)); moved = true; }
      return moved;
    },

    /** Restore the pose captured at creation; whatever was draining is dropped. */
    home() { cameraCopy(cam, home); cancel(); return orbit; },

    /** Remove the wheel listener, restore touch-action, unregister from the host. */
    dispose() {
      canvas.removeEventListener('wheel', onWheel);
      if (canvas.style) canvas.style.touchAction = touchAction;
      tracked.clear();
      cancel();
      host.unregister(orbit);
      return orbit;
    },
  };
  return host.register(orbit);
}

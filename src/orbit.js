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
 * does not scroll or zoom the page instead. During a drag the orbit is exact:
 * direct manipulation wants exactness. `inertia`, seconds, lets the gesture
 * coast after release: the rate of its last 100 ms — orbit, pan and dolly
 * lanes per second — decays with that time constant through tree's coast,
 * so the travel is the rate times `inertia` at any frame rate; the wheel
 * joins as impulses on the dolly lane; a press, home() and enabled = false
 * cancel. 0, the default, keeps the orbit exact.
 *
 * Screen y runs down; which world direction that is depends on the
 * projection installed in the view bag: a y-up projection (GL's, tree's
 * default) maps a downward drag to the eye's −up, a y-flipped one (p5's,
 * mat4Proj[5] < 0) to +up. The orbit reads that sign off the bag each
 * update, so a drag down always brings the scene down.
 */

'use strict';

import { createCamera, cameraCopy, cameraOrbit, cameraDolly, cameraPan, pixelRatio, coastStep, coastAlive } from '@nakednous/tree';

const _clamp = { min: 0, max: Infinity };
const _now = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
const WINDOW = 0.1;      // seconds of gesture the release rate averages
const RING = 32;         // steps remembered: enough for the window at 240 Hz
const LANES = 6;         // t, dAz, dEl, panX, panY, log dolly
const EPS = 1e-4;        // a rate below this in every lane ends the coast
const DT_MAX = 0.1;      // seconds, the measured frame's clamp

/**
 * Create an orbit on a camera state.
 *
 * @param {object} host
 * @param {object} cam  The camera state written.
 * @param {{ rotate?:number, pan?:number, zoom?:number, wheel?:number, inertia?:number,
 *           minDistance?:number, maxDistance?:number, enabled?:boolean }} [opts]
 *        rotate: radians per pixel (default 0.005). pan / zoom / wheel:
 *        scalars on the two-pointer pan, the pinch and the wheel dolly
 *        (default 1). inertia: the coast's time constant in seconds (default
 *        0, exact). minDistance / maxDistance: gaze-distance clamps.
 * @returns {object} The orbit: { cam, enabled, rotate, pan, zoom, wheel, inertia,
 *          minDistance, maxDistance, update(dt), home(), dispose() }.
 */
export function createOrbit(host, cam, opts) {
  const o = opts || {};
  const canvas = host.canvas;
  const home = cameraCopy(createCamera(), cam);
  const tracked = new Map();   // pointer id → { x, y } as last consumed
  let wheelAcc = 0;
  const rate = [0, 0, 0, 0, 0];           // the coast: dAz, dEl, panX, panY, log dolly — per second
  const step = [0, 0, 0, 0, 0];           // one frame of it
  const ring = new Float64Array(RING * LANES);   // the gesture's recent steps, stamped
  let ringHead = 0, ringCount = 0;
  let clock = 0, lastNow = 0, wasPressed = false;

  const remember = (t, az, el, px, py, ld) => {
    const i = ringHead * LANES;
    ring[i] = t; ring[i + 1] = az; ring[i + 2] = el; ring[i + 3] = px; ring[i + 4] = py; ring[i + 5] = ld;
    ringHead = (ringHead + 1) % RING;
    if (ringCount < RING) ringCount++;
  };
  const cancel = () => { rate[0] = rate[1] = rate[2] = rate[3] = rate[4] = 0; ringCount = 0; };
  // the release rate: the window's steps over the time they span
  const seed = (t, dt) => {
    let oldest = t, any = false;
    rate[0] = rate[1] = rate[2] = rate[3] = rate[4] = 0;
    for (let k = 0; k < ringCount; k++) {
      const i = ((ringHead - 1 - k + RING) % RING) * LANES;
      if (t - ring[i] > WINDOW) break;
      if (ring[i] < oldest) oldest = ring[i];
      rate[0] += ring[i + 1]; rate[1] += ring[i + 2]; rate[2] += ring[i + 3]; rate[3] += ring[i + 4]; rate[4] += ring[i + 5];
      any = true;
    }
    const span = Math.max(t - oldest, dt);
    if (!any || !(span > 0)) { cancel(); return; }
    for (let i = 0; i < 5; i++) rate[i] /= span;
    ringCount = 0;
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
    /** The coast's time constant, seconds; 0 keeps the orbit exact. */
    inertia: o.inertia ?? 0,
    /** Gaze-distance clamps for every dolly. */
    minDistance: o.minDistance ?? 0,
    maxDistance: o.maxDistance ?? Infinity,

    /**
     * Consume this frame's unclaimed pointer motion and wheel into cam, and
     * the coast when one is running.
     * @param {number} [dt]  The frame in seconds; measured since the last update when omitted.
     * @returns {boolean} Whether the camera moved.
     */
    update(dt) {
      const now = _now();
      if (typeof dt !== 'number') dt = lastNow ? Math.min((now - lastNow) / 1000, DT_MAX) : 0;
      lastNow = now;
      clock += dt;
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
      const tau = orbit.inertia > 0 ? orbit.inertia : 0;
      const pressed = a !== null;
      if (pressed && !wasPressed) cancel();         // a touch takes over from any coast; the ring restarts with the gesture
      let moved = false;
      let az = 0, el = 0, px = 0, py = 0, ld = 0;   // this frame's exact gesture, the coast's lanes
      const view = host.view;
      const ys = view.mat4Proj[5] < 0 ? -1 : 1;   // screen-down is the eye's −up under a y-up projection, +up under p5's flip
      if (a !== null && b === null) {
        const t = tracked.get(a.id);
        if (t) {
          const dx = a.x - t.x, dy = a.y - t.y;
          if (dx !== 0 || dy !== 0) { az = -dx * orbit.rotate; el = ys * dy * orbit.rotate; cameraOrbit(cam, az, el); moved = true; }
        }
        track(a);
      } else if (a !== null && b !== null) {
        const ta = tracked.get(a.id), tb = tracked.get(b.id);
        if (ta && tb) {
          const dmx = (a.x + b.x - ta.x - tb.x) / 2, dmy = (a.y + b.y - ta.y - tb.y) / 2;
          if (dmx !== 0 || dmy !== 0) {
            const ratio = pixelRatio(view.mat4Proj, -view.vp[3] || 1, -distance(), view.ndcZMin);
            px = -dmx * ratio * orbit.pan; py = ys * dmy * ratio * orbit.pan;
            cameraPan(cam, px, py);
            moved = true;
          }
          const d0 = Math.hypot(ta.x - tb.x, ta.y - tb.y), d1 = Math.hypot(a.x - b.x, a.y - b.y);
          if (d0 > 0 && d1 > 0 && d0 !== d1) { ld = orbit.zoom * Math.log(d0 / d1); dolly(Math.exp(ld)); moved = true; }
        }
        track(a); track(b);
      }
      if (pressed && tau > 0) remember(clock, az, el, px, py, ld);   // a still finger remembers zeros, so a stop before lifting does not coast
      else if (!pressed && wasPressed && tau > 0) seed(clock, dt);
      wasPressed = pressed;
      if (wheelAcc !== 0) {
        const w = wheelAcc * 0.001 * orbit.wheel;
        wheelAcc = 0;
        if (tau > 0 && !pressed) rate[4] += w / tau;   // an impulse: the same travel as the exact dolly, spread over the coast
        else { dolly(Math.exp(w)); moved = true; }
      }
      if (!pressed && tau > 0 && coastAlive(rate, EPS)) {
        coastStep(step, rate, dt, tau);
        if (step[0] !== 0 || step[1] !== 0) cameraOrbit(cam, step[0], step[1]);
        if (step[2] !== 0 || step[3] !== 0) cameraPan(cam, step[2], step[3]);
        if (step[4] !== 0) dolly(Math.exp(step[4]));
        moved = true;
      }
      return moved;
    },

    /** Restore the pose captured at creation; any coast ends. */
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

/**
 * @file orbit tests — one-pointer orbit, two-pointer dolly and pan, wheel,
 *       claims, enabled, home — against the pointer source and the DOM stub.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCamera } from '@nakednous/tree';
import { createHost } from '../src/index.js';
import { createCanvas, installWindow } from './dom.js';

installWindow();
const near = (a, b, tol = 1e-4) => assert.ok(Math.abs(a - b) <= tol, `${a} ≠ ${b}`);
const near3 = (v, e, tol) => { near(v[0], e[0], tol); near(v[1], e[1], tol); near(v[2], e[2], tol); };

function rig(opts) {
  const canvas = createCanvas({ rect: { left: 0, top: 0, width: 400, height: 300 } });
  canvas.style = {};
  const host = createHost(canvas);
  const cam = createCamera({ eye: [0, 0, 10], center: [0, 0, 0], up: [0, 1, 0], fov: Math.PI / 2, near: 1, far: 100 });
  host.view.setCamera(cam);
  const orbit = host.orbit(cam, Object.assign({ damping: 0 }, opts));   // exact unless a test asks
  const down = (id, x, y) => canvas.dispatch('pointerdown', { pointerId: id, clientX: x, clientY: y });
  const move = (id, x, y) => canvas.dispatch('pointermove', { pointerId: id, clientX: x, clientY: y });
  const up = (id) => canvas.dispatch('pointerup', { pointerId: id, clientX: 0, clientY: 0 });
  const frame = (dt) => { const m = orbit.update(dt); host.pointer.flush(); return m; };
  return { canvas, host, cam, orbit, down, move, up, frame };
}

test('orbit: one pointer drags the eye about the center; no motion means no move', () => {
  const { canvas, cam, orbit, down, move, up, frame, host } = rig({ rotate: 0.01 });
  assert.equal(canvas.style.touchAction, 'none');
  down(1, 100, 100);
  assert.equal(frame(), false);                       // the press seeds, nothing to consume yet
  move(1, 200, 100);                                  // +100 px → −1 rad about +Y
  assert.equal(frame(), true);
  near3(cam.eye, [10 * Math.sin(-1), 0, 10 * Math.cos(1)]);
  near3(cam.center, [0, 0, 0]);
  assert.equal(frame(), false);
  move(1, 200, 150);                                  // +50 px down: the scene follows, so the eye rises
  assert.equal(frame(), true);
  assert.ok(cam.eye[1] > 0);
  up(1);
  assert.equal(frame(), false);
  orbit.home();
  near3(cam.eye, [0, 0, 10]);
  host.dispose();
  assert.equal(canvas.style.touchAction, undefined);
  assert.equal(canvas.listenerCount('wheel'), 0);
});

test('orbit: a hovering mouse never orbits; the press that follows starts from its own position', () => {
  const { cam, canvas, move, down, frame, host } = rig({ rotate: 0.01 });
  move(1, 100, 100); frame();
  move(1, 300, 100);
  assert.equal(frame(), false);
  near3(cam.eye, [0, 0, 10]);
  down(1, 300, 100); frame();
  move(1, 310, 100);
  assert.equal(frame(), true);
  near3(cam.eye, [10 * Math.sin(-0.1), 0, 10 * Math.cos(0.1)]);
  host.dispose();
});

test('orbit: a claimed pointer is invisible; a release drops its memory so re-press never jumps', () => {
  const { cam, down, move, up, frame, host } = rig({ rotate: 0.01 });
  down(1, 100, 100);
  host.pointer.claim(1, {});
  frame();
  move(1, 300, 100);
  assert.equal(frame(), false);
  near3(cam.eye, [0, 0, 10]);
  host.pointer.release(1);
  frame();                                            // first sight of the free pointer: seeds at (300, 100)
  move(1, 310, 100);
  assert.equal(frame(), true);
  near3(cam.eye, [10 * Math.sin(-0.1), 0, 10 * Math.cos(0.1)]);
  up(1); frame();
  down(1, 0, 0); frame();
  near3(cam.eye, [10 * Math.sin(-0.1), 0, 10 * Math.cos(0.1)]);
  host.dispose();
});

test('orbit: two pointers pan by their midpoint at the center depth and dolly by their distance', () => {
  const { cam, down, move, frame, host } = rig();
  down(1, 100, 150); down(2, 200, 150);
  frame();
  move(1, 110, 150); move(2, 210, 150);               // midpoint +10 px, distance unchanged
  assert.equal(frame(), true);
  // 90° lens at depth 10 over 300 px: 20 / 300 world units per px → the camera pans −10 · 0.0667 along +X
  near3(cam.eye, [-2 / 3, 0, 10]);
  near3(cam.center, [-2 / 3, 0, 0]);
  move(1, 60, 150); move(2, 260, 150);                // distance 100 → 200: pinch out halves the gaze distance
  assert.equal(frame(), true);
  near(cam.eye[2], 5);
  near(cam.center[2], 0);
  move(1, 60, 200); move(2, 260, 200);                // both fingers down 50 px: the scene follows, so the eye rises
  frame();
  assert.ok(cam.eye[1] > 0);
  near(cam.eye[1], cam.center[1]);                    // a pan carries eye and center together
  host.dispose();
});

test('orbit: under a y-flipped projection (p5) the vertical drag and pan reverse; the horizontal ones do not', () => {
  const { host, cam, down, move, frame } = rig({ rotate: 0.01 });
  const P = new Float32Array(host.view.mat4Proj);
  P[5] = -P[5];                                       // p5's projection: NDC y-down
  host.view.set(P, host.view.mat4View);
  down(1, 100, 100); frame();
  move(1, 100, 150); frame();                         // +50 px down: the scene follows, the eye sinks
  assert.ok(cam.eye[1] < 0);
  move(1, 200, 150); frame();                         // +100 px right: unchanged
  assert.ok(cam.eye[0] < 0);
  host.dispose();

  const r2 = rig();
  const P2 = new Float32Array(r2.host.view.mat4Proj); P2[5] = -P2[5];
  r2.host.view.set(P2, r2.host.view.mat4View);
  r2.down(1, 100, 100); r2.down(2, 200, 100); r2.frame();
  r2.move(1, 100, 150); r2.move(2, 200, 150); r2.frame();
  assert.ok(r2.cam.eye[1] < 0);
  near(r2.cam.eye[1], r2.cam.center[1]);
  r2.host.dispose();
});

test('orbit: the wheel dollies with exp(deltaY / 1000), lines scale by 16, clamps hold, and it prevents the default', () => {
  const { canvas, cam, orbit, frame, host } = rig({ minDistance: 2, maxDistance: 12 });
  let prevented = 0;
  canvas.dispatch('wheel', { deltaY: 100, deltaMode: 0, preventDefault: () => prevented++ });
  assert.equal(prevented, 1);
  assert.equal(frame(), true);
  near(cam.eye[2], 10 * Math.exp(0.1));
  canvas.dispatch('wheel', { deltaY: 100, deltaMode: 0 });
  frame();
  near(cam.eye[2], 12);                               // maxDistance
  canvas.dispatch('wheel', { deltaY: -3, deltaMode: 1 });
  frame();
  near(cam.eye[2], 12 * Math.exp(-0.048));
  orbit.wheel = 100;
  canvas.dispatch('wheel', { deltaY: -100, deltaMode: 0 });
  frame();
  near(cam.eye[2], 2);                                // minDistance
  orbit.enabled = false;
  canvas.dispatch('wheel', { deltaY: 100, deltaMode: 0 });
  assert.equal(frame(), false);
  near(cam.eye[2], 2);
  host.dispose();
});

const DT = 1 / 60;
const azOf = (cam) => Math.atan2(cam.eye[0], cam.eye[2]);   // the eye's azimuth about +Y, from [0, 0, 10]

test('orbit: damping defaults to 0.2 s', () => {
  const { host } = rig();
  const cam = createCamera();
  assert.equal(host.orbit(cam).damping, 0.2);
  assert.equal(host.orbit(cam, { damping: 0 }).damping, 0);
  host.dispose();
});

test('orbit: damping trails the drag by its time constant and completes it after release, no more', () => {
  const { cam, down, move, up, frame, host } = rig({ rotate: 0.01, damping: 0.5 });
  const tau = 0.5;
  down(1, 100, 100); frame(DT);
  move(1, 200, 100);                                   // −1 rad asked for
  assert.equal(frame(DT), true);
  near(azOf(cam), -(1 - Math.exp(-DT / tau)), 1e-6);   // one frame of the lag
  assert.equal(frame(DT), true);                       // still pressed, still draining
  near(azOf(cam), -(1 - Math.exp(-2 * DT / tau)), 1e-6);
  up(1);
  let n = 0;
  while (frame(DT)) n++;                               // the drain ends on its own
  assert.ok(n > 100 && n < 2000, `${n} frames`);
  near(azOf(cam), -1, 1e-3);                           // the drag's own travel, nothing beyond
  host.dispose();
});

test('orbit: a fresh touch catches the scene where it is; home drops the drain', () => {
  const { cam, orbit, down, move, up, frame, host } = rig({ rotate: 0.01, damping: 0.5 });
  down(1, 100, 100); frame(DT);
  move(1, 200, 100); frame(DT);
  up(1); frame(DT);
  assert.equal(frame(DT), true);                       // draining after the release
  const mid = azOf(cam);
  down(1, 200, 100);
  assert.equal(frame(DT), false);                      // caught: nothing moves
  near(azOf(cam), mid);
  up(1); frame(DT);
  assert.equal(frame(DT), false);
  down(1, 200, 100); frame(DT);
  move(1, 250, 100); frame(DT);
  orbit.home();
  near3(cam.eye, [0, 0, 10]);
  assert.equal(frame(DT), false);                      // home dropped what the drag had left to drain
  host.dispose();
});

test('orbit: the wheel dollies through the lag with the exact dolly\'s travel; damping 0 stays exact', () => {
  const { canvas, cam, orbit, frame, host } = rig({ damping: 0.5 });
  canvas.dispatch('wheel', { deltaY: 100, deltaMode: 0 });
  assert.equal(frame(DT), true);
  assert.ok(cam.eye[2] > 10 && cam.eye[2] < 10 * Math.exp(0.1));   // under way, not there yet
  while (frame(DT));
  near(cam.eye[2], 10 * Math.exp(0.1), 1e-3);
  orbit.damping = 0;
  canvas.dispatch('wheel', { deltaY: -100, deltaMode: 0 });
  assert.equal(frame(DT), true);
  near(cam.eye[2], 10, 1e-3);                          // exact, in one frame
  assert.equal(frame(DT), false);
  host.dispose();
});

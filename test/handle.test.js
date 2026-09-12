/**
 * @file Handle and router tests — a camera 500 units out on +Z looking at
 *       the origin, presses and moves through the DOM stub; the expected
 *       world positions come from the core's own mappings.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCamera, mapLocation, SCREEN, WORLD, EYE, PLANE, AXIS, DIAL, SPHERE, POINT,
} from '@nakednous/tree';
import { createHost, VIEW } from '../src/index.js';
import { createCanvas, installWindow } from './dom.js';

const win = installWindow();
const near = (a, b, tol = 1e-3) => assert.ok(Math.abs(a - b) <= tol, `${a} ≠ ${b}`);

/** A host on a 400×300 canvas with the camera installed in its view bag. */
function setup() {
  const canvas = createCanvas({ rect: { left: 0, top: 0, width: 400, height: 300 } });
  const host = createHost(canvas);
  host.view.setCamera(createCamera({ eye: [0, 0, 500], center: [0, 0, 0], fov: Math.PI / 3, near: 1, far: 2000 }));
  return { canvas, host };
}
const press = (c, id, x, y) => c.dispatch('pointerdown', { pointerId: id, clientX: x, clientY: y });
const move  = (c, id, x, y) => c.dispatch('pointermove', { pointerId: id, clientX: x, clientY: y });
const up    = (c, id, x, y) => c.dispatch('pointerup',   { pointerId: id, clientX: x, clientY: y });
/** The world point under canvas pixel (x, y) at the depth of the origin. */
function worldAt(host, x, y) {
  const v = host.view, s = [0, 0, 0];
  mapLocation(s, 0, 0, 0, WORLD, SCREEN, v, v.vp, v.ndcZMin);
  return mapLocation([0, 0, 0], x, y, s[2], SCREEN, WORLD, v, v.vp, v.ndcZMin);
}

test('handle: a press on the dot grabs and claims, a drag solves on the plane, release fires', () => {
  const { canvas, host } = setup();
  const log = [];
  const h = host.handle({ constraint: PLANE, normal: [0, 0, 1],
    onGrab: () => log.push('grab'), onChange: (v) => log.push(['change', v[0]]), onRelease: () => log.push('release') });
  const out = [0, 0, 0];
  assert.deepEqual(h.value(out), [0, 0, 0]);
  press(canvas, 1, 200, 150);                      // the origin projects to the centre
  assert.equal(h.update(), true);
  assert.equal(host.pointer.ownerOf(1), h);
  assert.ok(canvas.captured.has(1));
  move(canvas, 1, 250, 150);
  h.update();
  const w = worldAt(host, 250, 150);
  h.value(out);
  near(out[0], w[0]); near(out[1], w[1]); near(out[2], 0);
  up(canvas, 1, 250, 150);
  assert.equal(h.update(), false);
  assert.equal(host.pointer.ownerOf(1), null);
  host.pointer.flush();
  assert.deepEqual(log[0], 'grab');
  assert.equal(log[1][0], 'change');
  assert.equal(log[log.length - 1], 'release');
});

test('handle: a press off the dot misses and leaves the pointer unclaimed', () => {
  const { canvas, host } = setup();
  const h = host.handle({ constraint: PLANE, normal: [0, 0, 1] });
  press(canvas, 1, 380, 20);
  assert.equal(h.update(), false);
  assert.equal(host.pointer.ownerOf(1), null);
  assert.ok(!canvas.captured.has(1));
});

test('handle: Esc mid-drag reverts to the grab value and fires onCancel, not onRelease', () => {
  const { canvas, host } = setup();
  const log = [];
  const h = host.handle({ constraint: PLANE, normal: [0, 0, 1], onCancel: () => log.push('cancel'), onRelease: () => log.push('release') });
  press(canvas, 1, 200, 150); h.update();
  move(canvas, 1, 300, 150); h.update();
  assert.ok(h.value([0, 0, 0])[0] > 10);
  win.dispatch('keydown', { key: 'Escape' });
  assert.equal(h.update(), false);
  assert.deepEqual(h.value([0, 0, 0]), [0, 0, 0]);
  assert.deepEqual(log, ['cancel']);
  assert.equal(host.pointer.ownerOf(1), null);
});

test('handle: bind to a vec3 mutates it in place; an accessor seeds and receives values; sync re-seeds', () => {
  const { canvas, host } = setup();
  const pos = [0, 0, 0];
  const h = host.handle({ constraint: PLANE, normal: [0, 0, 1], bind: pos });
  press(canvas, 1, 200, 150); h.update();
  move(canvas, 1, 240, 150); h.update();
  near(pos[0], worldAt(host, 240, 150)[0]);
  const store = { v: [0, 0, 0], sets: 0 };
  const g = host.handle({ constraint: PLANE, normal: [0, 0, 1], bind: { get: () => store.v, set: (v) => { store.v = [...v]; store.sets++; } } });
  store.v = [30, 0, 0];
  g.sync();
  assert.deepEqual(g.value([0, 0, 0]), [30, 0, 0]);
  assert.equal(store.sets, 0);
});

test('handle: value converts to SCREEN and EYE through the view bag', () => {
  const { host } = setup();
  const h = host.handle({ constraint: PLANE, normal: [0, 0, 1] });
  const s = h.value([0, 0, 0], { to: SCREEN });
  near(s[0], 200); near(s[1], 150);
  const e = h.value([0, 0, 0], { to: EYE });
  near(e[2], -500);
});

test('handle: VIEW drags in the screen-parallel plane through the point', () => {
  const { canvas, host } = setup();
  const h = host.handle({ constraint: VIEW });
  assert.equal(h._constraint.view, true);
  press(canvas, 1, 200, 150); h.update();
  move(canvas, 1, 200, 100); h.update();
  const w = worldAt(host, 200, 100);
  const out = h.value([0, 0, 0]);
  near(out[0], w[0]); near(out[1], w[1]); near(out[2], 0);
});

test('handle: a DIAL grabs anywhere on its ring and its scalar follows the drag', () => {
  const { canvas, host } = setup();
  const h = host.handle({ constraint: DIAL, axis: [0, 0, 1], radius: 100, zero: [1, 0, 0] });
  const s0 = h.value([0, 0, 0], { to: SCREEN });          // the θ = 0 point, (100, 0, 0)
  press(canvas, 1, s0[0], s0[1]);
  assert.equal(h.update(), true);
  const s1 = [0, 0, 0];
  mapLocation(s1, 0, 100, 0, WORLD, SCREEN, host.view, host.view.vp, host.view.ndcZMin);   // the θ = π/2 point
  move(canvas, 1, s1[0], s1[1]); h.update();
  near(h.scalar(), Math.PI / 2, 1e-2);
  const miss = host.handle({ constraint: DIAL, axis: [0, 0, 1], radius: 100 });
  up(canvas, 1, s1[0], s1[1]); h.update(); host.pointer.flush();
  press(canvas, 2, 200, 150);                              // the centre: not on the ring
  assert.equal(miss.update(), false);
});

test('handle: snap quantises the solved point on a grid; hover tests unclaimed motion', () => {
  const { canvas, host } = setup();
  const h = host.handle({ constraint: PLANE, normal: [0, 0, 1], snap: 25, hover: true });
  move(canvas, 3, 200, 150); h.update();
  assert.equal(h.hovered(), true);
  move(canvas, 3, 10, 10); h.update();
  assert.equal(h.hovered(), false);
  press(canvas, 1, 200, 150); h.update();
  move(canvas, 1, 230, 150); h.update();
  const x = h.value([0, 0, 0])[0];
  near(x % 25, 0, 1e-6);
});

test('handle: from EYE resolves the axis against the view each idle frame; SPHERE reports a direction', () => {
  const { canvas, host } = setup();
  const h = host.handle({ constraint: AXIS, axis: [1, 0, 0], extent: [-200, 200], from: EYE });
  h.update();
  assert.deepEqual([...h._constraint.u].map((v) => +v.toFixed(6)), [1, 0, 0]);   // eye X is world X for this camera
  const s = host.handle({ constraint: SPHERE, radius: 80 });
  const d = s.value([0, 0, 0]);
  near(Math.hypot(d[0], d[1], d[2]), 1);
  const p = s.value([0, 0, 0], { report: POINT });
  near(Math.hypot(p[0], p[1], p[2]), 80);
  press(canvas, 1, 200, 150); assert.equal(h.update(), true);
});

test('router: one press grabs exactly the nearest of two overlapping members; hover names it', () => {
  const { canvas, host } = setup();
  const far  = host.handle({ constraint: PLANE, normal: [0, 0, 1], anchor: [0, 0, 0] });
  const nearH = host.handle({ constraint: PLANE, normal: [0, 0, 1], anchor: [0, 0, 100] });
  const r = host.router([far, nearH]);
  move(canvas, 5, 200, 150); r.update();
  assert.equal(r.hovered(), nearH);
  assert.equal(nearH.hovered(), true);
  assert.equal(far.hovered(), false);
  press(canvas, 1, 200, 150);
  assert.equal(r.update(), true);
  assert.equal(nearH.grabbed(), true);
  assert.equal(far.grabbed(), false);
  assert.equal(host.pointer.ownerOf(1), nearH);
  up(canvas, 1, 200, 150); r.update();
  assert.equal(nearH.grabbed(), false);
  assert.equal(host.pointer.ownerOf(1), null);
  r.remove(nearH);
  assert.equal(nearH._routed, false);
  r.dispose();
  assert.equal(far._routed, false);
});

test('host: dispose releases handles and their claims; an invalid constraint yields null', () => {
  const { canvas, host } = setup();
  assert.equal(host.handle({ constraint: 42 }), null);
  const h = host.handle({ constraint: PLANE, normal: [0, 0, 1] });
  press(canvas, 1, 200, 150); h.update();
  assert.ok(canvas.captured.has(1));
  host.dispose();
  assert.ok(!canvas.captured.has(1));
  assert.equal(h._pointer, null);
});

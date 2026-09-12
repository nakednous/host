/**
 * @file host tests — view bag, canvas observer, pointer source, players,
 *       loop, and the context — against the DOM stub; math through tree.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WEBGL, WEBGPU, createCamera, mat4Persp, mat4MulPoint } from '@nakednous/tree';
import { createHost, createView, createPointer, createPlayers, createLoop, observeCanvas } from '../src/index.js';
import { createCanvas, installWindow } from './dom.js';

const win = installWindow();
const near = (a, b, tol = 1e-5) => assert.ok(Math.abs(a - b) <= tol, `${a} ≠ ${b}`);

test('view: identity and stale until set; set computes PV and its inverse', () => {
  const v = createView();
  assert.equal(v.stale, true);
  assert.equal(v.ndcZMin, WEBGL);
  assert.deepEqual([...v.mat4PV], [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
  const P = mat4Persp(new Float32Array(16), -1, 1, -1, 1, 1, 10, WEBGL);
  const V = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,-5,1]);
  v.set(P, V);
  assert.equal(v.stale, false);
  const p = mat4MulPoint([0, 0, 0], v.mat4PV, 0, 0, 0);
  const q = mat4MulPoint([0, 0, 0], v.mat4PVInv, p[0], p[1], p[2]);
  near(q[0], 0); near(q[1], 0); near(q[2], 0, 1e-4);
});

test('view: a singular product keeps the previous inverse and marks stale', () => {
  const v = createView({ ndcZMin: WEBGPU });
  assert.equal(v.ndcZMin, WEBGPU);
  const P = mat4Persp(new Float32Array(16), -1, 1, -1, 1, 1, 10, WEBGPU);
  const I = new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
  v.set(P, I);
  const inv = [...v.mat4PVInv];
  v.set(P, new Float32Array(16));
  assert.equal(v.stale, true);
  assert.deepEqual([...v.mat4PVInv], inv);
});

test('view: setCamera uses the viewport aspect and keeps P for an unset lens', () => {
  const v = createView({ width: 400, height: 200 });
  assert.deepEqual(v.vp, [0, 200, 400, -200]);
  v.setCamera(createCamera({ eye: [0, 0, 10], fov: Math.PI / 2, near: 1, far: 100 }));
  near(v.mat4Proj[5], 1);            // 90° lens: f = 1
  near(v.mat4Proj[0], 0.5);          // aspect 2
  assert.equal(v.stale, false);
  const P = [...v.mat4Proj];
  v.setCamera(createCamera({ eye: [0, 0, 5], fov: null, halfHeight: null }));
  assert.deepEqual([...v.mat4Proj], P);
  near(v.mat4View[14], -5);
  v.resize(100, 50);
  assert.deepEqual(v.vp, [0, 50, 100, -50]);
});

test('canvas: the observer reports the rectangle once, then only changes', () => {
  const canvas = createCanvas({ width: 640, height: 480, rect: { left: 10, top: 20, width: 320, height: 240 } });
  const seen = [];
  const obs = observeCanvas(canvas, (w, h, dpr) => seen.push([w, h, dpr]));
  assert.deepEqual(seen, [[320, 240, 1]]);
  obs.measure();
  assert.equal(seen.length, 1);
  win.devicePixelRatio = 2;
  win.dispatch('resize', {});
  assert.deepEqual(seen[1], [320, 240, 2]);
  obs.dispose();
  win.devicePixelRatio = 1;
  win.dispatch('resize', {});
  assert.equal(seen.length, 2);
  assert.equal(win.listenerCount('resize'), 0);
});

test('canvas: without a laid-out rectangle the attributes are the size', () => {
  const canvas = createCanvas({ width: 50, height: 40, rect: { left: 0, top: 0, width: 0, height: 0 } });
  const seen = [];
  observeCanvas(canvas, (w, h) => seen.push([w, h])).dispose();
  assert.deepEqual(seen, [[50, 40]]);
});

test('pointer: presses queue in canvas px, moves count, claims capture, flush ends the frame', () => {
  const canvas = createCanvas({ rect: { left: 100, top: 50, width: 800, height: 600 } });
  const view = createView({ width: 400, height: 300 });
  const src = createPointer(canvas, view);
  canvas.dispatch('pointerdown', { pointerId: 7, clientX: 300, clientY: 350 });
  assert.deepEqual(src.presses, [{ id: 7, x: 100, y: 150 }]);   // CSS px halved to logical
  const p = src.get(7);
  assert.equal(p.down, true);
  assert.equal(p.seq, 1);
  canvas.dispatch('pointermove', { pointerId: 7, clientX: 320, clientY: 350 });
  assert.equal(p.seq, 2);
  near(p.x, 110);
  const owner = {};
  assert.equal(src.claim(7, owner), true);
  assert.equal(src.claim(7, {}), false);           // held by another
  assert.equal(src.claim(7, owner), true);         // re-claim by the holder is fine
  assert.equal(src.ownerOf(7), owner);
  assert.ok(canvas.captured.has(7));
  src.flush();
  assert.equal(src.presses.length, 0);
  assert.equal(src.get(7), p);                     // still down: kept
  canvas.dispatch('pointerup', { pointerId: 7, clientX: 320, clientY: 350 });
  assert.equal(p.up, true);
  assert.ok(!canvas.captured.has(7));
  assert.equal(src.ownerOf(7), owner);             // the owner still sees the release this frame
  src.flush();
  assert.equal(src.get(7), null);
  src.dispose();
  assert.equal(canvas.listenerCount('pointerdown'), 0);
  assert.equal(win.listenerCount('keydown'), 0);
});

test('pointer: multitouch is per pointer; Esc cancels only claimed pointers; cancel releases capture', () => {
  const canvas = createCanvas();
  const src = createPointer(canvas, createView({ width: 400, height: 300 }));
  canvas.dispatch('pointerdown', { pointerId: 1, clientX: 10, clientY: 10 });
  canvas.dispatch('pointerdown', { pointerId: 2, clientX: 20, clientY: 20 });
  assert.equal(src.presses.length, 2);
  src.claim(1, {});
  win.dispatch('keydown', { key: 'Escape' });
  assert.equal(src.get(1).cancel, true);
  assert.equal(src.get(2).cancel, false);
  canvas.dispatch('pointercancel', { pointerId: 2 });
  assert.equal(src.get(2).cancel, true);
  src.flush();
  assert.equal(src.pointers.size, 0);
  src.release(9);                                  // unknown: no-op
  src.dispose();
});

test('pointer: an unknown pointer cannot be claimed; release drops the capture', () => {
  const canvas = createCanvas();
  const src = createPointer(canvas, createView({ width: 400, height: 300 }));
  assert.equal(src.claim(5, {}), false);
  canvas.dispatch('pointerdown', { pointerId: 5, clientX: 1, clientY: 1 });
  src.claim(5, {});
  src.release(5);
  assert.equal(src.ownerOf(5), null);
  assert.ok(!canvas.captured.has(5));
  src.dispose();
});

test('players: snapshot iteration, self-removal, removal by return value', () => {
  const players = createPlayers();
  const log = [];
  const b = { tick(dt) { log.push('b' + dt); return true; } };
  const a = { tick(dt) { log.push('a' + dt); players.remove(b); players.add(c); return false; } };
  const c = { tick() { log.push('c'); return true; } };
  players.add(a).add(b).add(b);
  assert.equal(players.size, 2);
  players.tick(1);
  assert.deepEqual(log, ['a1']);                   // b removed before its turn; c added after the snapshot
  assert.equal(players.has(a), false);
  assert.equal(players.has(c), true);
  players.tick(2);
  assert.deepEqual(log, ['a1', 'c']);
  players.clear();
  assert.equal(players.size, 0);
});

test('loop: a fake raf drives onFrame with a clamped dt; stop cancels', () => {
  const queue = [];
  let t = 0;
  const raf = (cb) => { queue.push(cb); return queue.length; };
  const caf = () => { queue.length = 0; };
  const frames = [];
  const loop = createLoop({ raf, caf, now: () => t, onFrame: (dt) => frames.push(dt) });
  loop.start().start();
  assert.equal(queue.length, 1);
  t = 16; queue.shift()();
  t = 116; queue.shift()();                        // 100 ms → clamped to 50 ms
  near(frames[0], 0.016);
  near(frames[1], 0.05);
  loop.stop();
  assert.equal(loop.running, false);
  assert.equal(queue.length, 0);
});

test('host: external-tick mode wires view, pointer, players and the observer; dispose releases all', () => {
  const canvas = createCanvas({ rect: { left: 0, top: 0, width: 400, height: 300 } });
  const sizes = [];
  const host = createHost(canvas, { ndcZMin: WEBGPU, onSize: (w, h, d) => sizes.push([w, h, d]) });
  assert.equal(host.width, 400);
  assert.equal(host.height, 300);
  assert.deepEqual(host.view.vp, [0, 300, 400, -300]);
  assert.equal(host.view.ndcZMin, WEBGPU);
  assert.deepEqual(sizes, [[400, 300, 1]]);
  let ticks = 0;
  host.players.add({ tick(dt) { ticks += dt; return true; } });
  host.tick(0.5);
  assert.equal(ticks, 0.5);
  assert.equal(host.dt, 0.5);
  assert.ok(host.clock() >= 0);
  let disposed = 0;
  host.register({ dispose() { disposed++; } });
  canvas.dispatch('pointerdown', { pointerId: 3, clientX: 1, clientY: 1 });
  host.pointer.claim(3, {});
  host.dispose();
  assert.equal(disposed, 1);
  assert.equal(host.players.size, 0);
  assert.equal(canvas.listenerCount('pointermove'), 0);
  assert.ok(!canvas.captured.has(3));
});

test('host: loop mode ticks players, calls onFrame, then flushes the pointer', () => {
  const canvas = createCanvas();
  const queue = [];
  const order = [];
  const host = createHost(canvas, {
    raf: (cb) => { queue.push(cb); return 1; }, caf: () => { queue.length = 0; },
    onFrame: (dt, h) => { order.push('frame'); assert.equal(h, host); assert.equal(h.pointer.presses.length, 1); },
  });
  host.players.add({ tick() { order.push('tick'); return true; } });
  canvas.dispatch('pointerdown', { pointerId: 1, clientX: 5, clientY: 5 });
  queue.shift()();
  assert.deepEqual(order, ['tick', 'frame']);
  assert.equal(host.pointer.presses.length, 0);
  host.dispose();
  assert.equal(queue.length, 0);
});

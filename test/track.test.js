/**
 * @file Track factory tests — a pose track played through the host's players,
 *       a camera track evaluating into its camera state, the add() shapes,
 *       and TrackHandles dragging keyframes through the DOM stub.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCamera, mapLocation, SCREEN, WORLD } from '@nakednous/tree';
import { createHost, TrackHandles } from '../src/index.js';
import { createCanvas, installWindow } from './dom.js';

installWindow();
const near = (a, b, tol = 1e-2) => assert.ok(Math.abs(a - b) <= tol, `${a} ≠ ${b}`);

function setup() {
  const canvas = createCanvas({ rect: { left: 0, top: 0, width: 400, height: 300 } });
  const host = createHost(canvas);
  host.view.setCamera(createCamera({ eye: [0, 0, 500], center: [0, 0, 0], fov: Math.PI / 3, near: 1, far: 2000 }));
  return { canvas, host };
}
const press = (c, id, x, y) => c.dispatch('pointerdown', { pointerId: id, clientX: x, clientY: y });
const move  = (c, id, x, y) => c.dispatch('pointermove', { pointerId: id, clientX: x, clientY: y });
const up    = (c, id, x, y) => c.dispatch('pointerup',   { pointerId: id, clientX: x, clientY: y });
const screenOf = (host, p) => mapLocation([0, 0, 0], p[0], p[1], p[2], WORLD, SCREEN, host.view, host.view.vp, host.view.ndcZMin);

test('poseTrack: play registers a player, the pose advances per tick, the end unregisters it', () => {
  const { host } = setup();
  const track = host.poseTrack();
  track.add({ pos: [0, 0, 0] });
  track.add({ pos: [100, 0, 0] });
  assert.equal(host.players.size, 0);
  track.play({ duration: 10 });
  assert.equal(host.players.size, 1);
  const out = { pos: [0, 0, 0], rot: [0, 0, 0, 1], scl: [1, 1, 1] };
  for (let i = 0; i < 5; i++) host.tick(1 / 60);
  assert.ok(track.eval(out).pos[0] > 0 && out.pos[0] < 100);
  for (let i = 0; i < 20; i++) host.tick(1 / 60);
  assert.equal(track.playing, false);
  assert.equal(host.players.size, 0);
});

test('cameraTrack: evaluates into the camera state each tick and rests on the path when stopped', () => {
  const { host } = setup();
  const cam = createCamera({ eye: [0, 0, 500] });
  const track = host.cameraTrack(cam);
  track.add({ eye: [0, 0, 400], center: [0, 0, 0] });
  track.add({ eye: [400, 0, 0], center: [0, 0, 0] });
  track.eyeInterp = 'linear';
  track.play({ duration: 10 });
  host.tick(1 / 60);
  assert.ok(cam.eye[0] > 0 && cam.eye[2] < 400);
  track.stop();
  assert.equal(host.players.size, 0);
  const at = [...cam.eye];
  track.seek(0.5);                                       // no player: nothing moves
  host.tick(1 / 60);
  assert.deepEqual([...cam.eye], at);
});

test('cameraTrack: add() captures the camera state, add({ camera }) any camera state, arrays recurse', () => {
  const { host } = setup();
  const cam = createCamera({ eye: [1, 2, 3], center: [0, 0, 0], fov: 1 });
  const track = host.cameraTrack(cam);
  track.add();
  assert.deepEqual(track.keyframes[0].eye, [1, 2, 3]);
  near(track.keyframes[0].fov, 1, 0);
  const other = createCamera({ eye: [9, 9, 9] });
  track.add({ camera: other });
  assert.deepEqual(track.keyframes[1].eye, [9, 9, 9]);
  track.add([{ eye: [5, 5, 5] }, { camera: createCamera({ eye: [6, 6, 6] }) }]);
  assert.equal(track.keyframes.length, 4);
  assert.deepEqual(track.keyframes[3].eye, [6, 6, 6]);
  assert.equal(host.cameraTrack(null).add(), undefined);
});

test('TrackHandles: a drag on a keyframe dot moves the keyframe; hooks carry the index and field', () => {
  const { canvas, host } = setup();
  const track = host.poseTrack({ handles: true });
  track.add({ pos: [-100, 0, 0] });
  track.add({ pos: [100, 0, 0] });
  const th = track.handles;
  assert.ok(th instanceof TrackHandles);
  const log = [];
  th.onGrab = (i, f) => log.push(['grab', i, f]);
  th.onChange = (v, i, f) => log.push(['change', i, f]);
  th.update();
  assert.equal(th.members.length, 2);
  const s = screenOf(host, [100, 0, 0]);
  press(canvas, 1, s[0], s[1]);
  assert.equal(th.update(), true);
  assert.equal(th.selected, 1);
  const s2 = screenOf(host, [100, -50, 0]);
  move(canvas, 1, s2[0], s2[1]); th.update();
  near(track.keyframes[1].pos[1], -50);
  near(track.keyframes[1].pos[0], 100);
  assert.deepEqual(log[0], ['grab', 1, 'pos']);
  assert.deepEqual(log[1], ['change', 1, 'pos']);
  up(canvas, 1, s2[0], s2[1]); th.update();
  assert.equal(th.grabbed(), false);
  track.add({ pos: [0, 100, 0] });
  th.update();
  assert.equal(th.members.length, 3);                    // rebuilt on the count change
  th.dispose();
  assert.equal(track.handles, null);
});

test('TrackHandles: a camera track gets eye and center members; center: false drops the centers', () => {
  const { host } = setup();
  const cam = createCamera();
  const t1 = host.cameraTrack(cam, { handles: true });
  t1.add({ eye: [0, 0, 400], center: [0, 0, 0] });
  t1.handles.update();
  assert.deepEqual(t1.handles.members.map((m) => m.field), ['eye', 'center']);
  const t2 = host.cameraTrack(cam, { handles: { center: false } });
  t2.add({ eye: [0, 0, 400], center: [0, 0, 0] });
  t2.handles.update();
  assert.deepEqual(t2.handles.members.map((m) => m.field), ['eye']);
});

test('TrackHandles: a rot DIAL seeds from the keyframe twist and writes it back; a moved keyframe re-anchors it', () => {
  const { host } = setup();
  const track = host.poseTrack({ handles: { rot: [0, 1, 0] } });
  track.add({ pos: [0, 0, 0], rot: { axis: [0, 1, 0], angle: 1 } });
  const th = track.handles;
  th.update();
  const rot = th.members.find((m) => m.field === 'rot');
  near(rot.h.scalar(), 1, 1e-6);
  track.keyframes[0].pos[0] = 50;
  th.update();
  near(rot.h._constraint.anchor[0], 50, 1e-9);
});

/**
 * @file Helm factory tests — a camera state flown body-relative, a pose helm
 *       in WORLD / EYE / SELF, the bind shapes; ticked through host.players.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCamera, cameraEye, WORLD, EYE, SELF } from '@nakednous/tree';
import { createHost } from '../src/index.js';
import { createCanvas, installWindow } from './dom.js';

installWindow();
const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} ≠ ${b}`);

function setup() {
  const canvas = createCanvas({ rect: { left: 0, top: 0, width: 400, height: 300 } });
  return createHost(canvas);
}
// A rate that, after the default profile (Tz lane 1, sign −1, sens 0.30),
// pushes the pose forward by 30 units per second.
const FORWARD = [0, -100, 0];

test('cameraHelm: seeded from the state, a forward push flies along the gaze, gaze distance kept', () => {
  const host = setup();
  const cam = createCamera({ eye: [0, 0, 500], center: [0, 0, 0] });
  const helm = host.cameraHelm(cam);
  helm.deadzone = 0;
  helm.feed(FORWARD, null);
  host.tick(1);
  near(cam.eye[2], 470, 1e-3);                 // 30 units toward the origin
  near(cam.center[2], -30, 1e-3);              // 500 away, as before
  assert.ok(host.players.size === 1);
  helm.dispose();
  assert.equal(host.players.size, 0);
});

test('cameraHelm: body-fly — after a yaw the same push follows the new heading', () => {
  const host = setup();
  const cam = createCamera({ eye: [0, 0, 500], center: [0, 0, 0] });
  const helm = host.cameraHelm(cam);
  helm.deadzone = 0;
  helm.feed(null, [0, 0, 100]);               // Ry (lane 2), sign −1: yaw
  host.tick(1);
  const E = cameraEye(new Float32Array(16), cam);
  const fwd = [-E[8], -E[9], -E[10]];
  assert.ok(Math.abs(fwd[0]) > 1e-3, 'the heading turned');
  const e0 = [...cam.eye];
  helm.feed(FORWARD, [0, 0, 0]);
  host.tick(1);
  const d = [cam.eye[0] - e0[0], cam.eye[1] - e0[1], cam.eye[2] - e0[2]];
  const l = Math.hypot(d[0], d[1], d[2]);
  near(d[0] / l, fwd[0], 1e-3); near(d[2] / l, fwd[2], 1e-3);
});

test('poseHelm: WORLD integrates in world axes into a { pos, rot } object; SELF follows its own heading', () => {
  const host = setup();
  const obj = { pos: [1, 2, 3], rot: [0, 0, 0, 1] };
  const helm = host.poseHelm({ from: WORLD, bind: obj });
  helm.deadzone = 0;
  helm.feed([100, 0, 0], null);              // Tx lane 0, +30/s
  host.tick(1);
  near(obj.pos[0], 31); near(obj.pos[1], 2); near(obj.pos[2], 3);
  const self = host.poseHelm({ from: SELF }).bind({ pos: [0, 0, 0], rot: [0, 0, 0, 1] });
  self.deadzone = 0;
  self.feed(null, [0, 0, 100]); host.tick(1);
  const rot = [...self.eval({ pos: [0, 0, 0], rot: [0, 0, 0, 1] }).rot];
  assert.ok(Math.abs(rot[1]) > 1e-3, 'yawed');
  self.feed(FORWARD, [0, 0, 0]); host.tick(1);
  const p = self.eval({ pos: [0, 0, 0], rot: [0, 0, 0, 1] }).pos;
  assert.ok(Math.abs(p[0]) > 1e-3, 'the push followed the yawed heading, not −Z');
});

test('poseHelm: EYE resolves against the view bag — a screen push moves along the viewing camera\'s axes', () => {
  const host = setup();
  host.view.setCamera(createCamera({ eye: [500, 0, 0], center: [0, 0, 0] }));   // looking down −X
  const obj = { pos: [0, 0, 0], rot: [0, 0, 0, 1] };
  const helm = host.poseHelm({ from: EYE }).bind(obj);
  helm.deadzone = 0;
  helm.feed(FORWARD, null);                  // "forward" on screen = away from the viewer = −X
  host.tick(1);
  near(obj.pos[0], -30, 1e-3); near(obj.pos[2], 0, 1e-3);
});

test('poseHelm: the camera-state, accessor and applyPose bind shapes; an unknown target stays unbound', () => {
  const host = setup();
  const cam = createCamera({ eye: [0, 0, 500] });
  const h1 = host.poseHelm({ from: WORLD }).bind(cam);
  h1.deadzone = 0; h1.feed([100, 0, 0], null); host.tick(1);
  near(cam.eye[0], 30); near(cam.center[2], 0);
  const log = [];
  host.poseHelm({ from: WORLD, bind: { get: () => ({ pos: [5, 0, 0], rot: [0, 0, 0, 1] }), set: (p) => log.push(p.pos[0]) } });
  host.tick(1);
  near(log[0], 5);
  const sink = { n: 0, applyPose() { this.n++; } };
  host.poseHelm({ bind: sink }); host.tick(1);
  assert.equal(sink.n, 1);
  const before = host.players.size;
  const u = host.poseHelm().bind(42); host.tick(1);
  assert.equal(host.players.size, before + 1);
  assert.equal(u.eval({ pos: [0, 0, 0], rot: [0, 0, 0, 1] }).pos[0], 0);
});

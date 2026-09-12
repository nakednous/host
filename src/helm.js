/**
 * @file Helm factories — a core PoseHelm driven from the host's players.
 * @module host/helm
 * @license AGPL-3.0-only
 *
 * cameraHelm(host, cam, opts) flies a camera state body-relative: the helm is
 * seeded from the state through cameraToPose, integrates each tick in the
 * state's own eye matrix (which equals the pose written last tick, so a
 * forward push flies forward) and writes back through cameraFromPose at the
 * state's gaze distance. poseHelm(host, opts) produces a pose in a declared
 * frame — WORLD, EYE (the host's view bag), SELF (its own pose) or a mat4 —
 * and drives whatever bind() names: a camera state, an { applyPose } sink, a
 * { get, set } accessor or a { pos, rot } object. Both register a player
 * with the host until disposed.
 */

'use strict';

import {
  PoseHelm, cameraEye, cameraFromPose, cameraToPose, qToMat4, WORLD, EYE, SELF,
} from '@nakednous/tree';

const _pose = { pos: [0, 0, 0], rot: [0, 0, 0, 1] };   // step() output
const _self = { pos: [0, 0, 0], rot: [0, 0, 0, 1] };   // eval() readout for SELF
const _em   = new Float32Array(16);                    // the resolved basis

const _rawMat4 = (m) => (m != null && m.mat4 != null) ? m.mat4 : m;
const _isCameraState = (c) => !!(c && c.eye && c.center && c.up);

function _applyOpts(helm, opts) {
  if (!opts) return;
  if (opts.profile)          helm.profile  = opts.profile;
  if (opts.deadzone != null) helm.deadzone = opts.deadzone;
  if (opts.filter != null)   helm.filter   = opts.filter;
  if (opts.fullScale != null) helm.fullScale = opts.fullScale;
}

/**
 * The basis a pose helm's `from` resolves to: null for WORLD, the view bag's
 * eye matrix for EYE, the helm's own rotation for SELF, a mat4 as given.
 * Exported for a bridge's rig gizmo.
 * @param {PoseHelm} helm
 * @param {object} view  The host's view bag.
 * @param {Float32Array} em  16-element scratch.
 * @returns {ArrayLike<number>|null}
 */
export function helmBasis(helm, view, em) {
  const from = helm.from;
  if (from != null && typeof from !== 'string') return _rawMat4(from);
  if (from === EYE)  return view ? view.mat4Eye : null;
  if (from === SELF) return qToMat4(em, helm.eval(_self).rot);
  if (from === WORLD || from == null) return null;
  console.error('[host] poseHelm: `from` must be EYE, WORLD, SELF, or a mat4 frame. Falling back to WORLD.');
  return null;
}

/**
 * Fly a camera state from a live 6-DOF rate stream, body-relative.
 * @param {object} host
 * @param {object} cam   A camera state ({ eye, center, up, … }).
 * @param {{ profile?:object, deadzone?:number, filter?:object, fullScale?:number }} [opts]
 * @returns {PoseHelm} The helm, with dispose().
 */
export function cameraHelm(host, cam, opts) {
  const helm = new PoseHelm();
  _applyOpts(helm, opts);
  if (opts && opts.from != null) {
    console.error('[host] cameraHelm: a camera helm is always body-fly and has no `from`. Ignoring it; bind the camera to a poseHelm for screen- or world-relative motion.');
  }
  if (_isCameraState(cam)) helm.home(cameraToPose(_pose, cam));
  const player = {
    tick(dt) {
      helm.step(_pose, dt, _isCameraState(cam) ? cameraEye(_em, cam) : null);
      if (_isCameraState(cam)) {
        cameraFromPose(cam, _pose);
        if (helm._onApply) helm._onApply(cam);
      }
      return true;
    },
  };
  helm._onApply = null;   // lib-space seam: a bridge pushes the written state to its camera
  host.players.add(player);
  helm.dispose = () => { host.players.remove(player); host.unregister(helm); return helm; };
  return host.register(helm);
}

/**
 * Integrate a live 6-DOF rate stream into a pose in a declared frame and
 * drive a bound target with it.
 * @param {object} host
 * @param {{ profile?:object, deadzone?:number, filter?:object, fullScale?:number,
 *           from?:string|ArrayLike<number>, bind?:object }} [opts]
 * @returns {PoseHelm} The helm, with bind() and dispose().
 */
export function poseHelm(host, opts) {
  const o = opts || {};
  const helm = new PoseHelm();
  _applyOpts(helm, o);
  if (o.from != null) helm.from = o.from;
  let sink = null;

  const player = {
    tick(dt) {
      if (sink) {
        helm.step(_pose, dt, helmBasis(helm, host.view, _em));
        sink(_pose);
      }
      return true;
    },
  };
  host.players.add(player);

  /**
   * Bind the target the helm drives: a camera state (seeded from it, written
   * through cameraFromPose), an { applyPose } sink, a { get, set } accessor
   * (get() seeds, set(pose) writes) or a { pos, rot } object mutated in
   * place. Chainable.
   * @param {object} target
   * @returns {PoseHelm} this
   */
  helm.bind = (target) => {
    if (_isCameraState(target)) {
      helm.home(cameraToPose(_pose, target));
      sink = (pose) => cameraFromPose(target, pose);
    } else if (target && typeof target.get === 'function' && typeof target.set === 'function') {
      helm.home(target.get());
      sink = (pose) => target.set(pose);
    } else if (target && typeof target.applyPose === 'function') {
      sink = (pose) => target.applyPose(pose);
    } else if (target && target.pos && target.rot) {
      helm.home(target);
      sink = (pose) => {
        target.pos[0] = pose.pos[0]; target.pos[1] = pose.pos[1]; target.pos[2] = pose.pos[2];
        target.rot[0] = pose.rot[0]; target.rot[1] = pose.rot[1];
        target.rot[2] = pose.rot[2]; target.rot[3] = pose.rot[3];
      };
    } else {
      console.error('[host] poseHelm: bind() target must be a camera state, an { applyPose } sink, a { get, set } accessor, or a { pos, rot } object. Leaving unbound.');
    }
    return helm;
  };
  helm.dispose = () => { host.players.remove(player); host.unregister(helm); return helm; };
  if (o.bind != null) helm.bind(o.bind);
  return host.register(helm);
}

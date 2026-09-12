/**
 * @file The view bag — the matrices every pick, solve, label and orbit reads.
 * @module host/view
 * @license AGPL-3.0-only
 *
 * The matrices bag mapLocation takes, plus the signed viewport and the NDC
 * convention:
 *
 *   view = {
 *     mat4Proj, mat4View, mat4PV, mat4PVInv,   // Float32Array(16) each, host-owned
 *     vp,                                      // [0, h, w, −h] — y-down, logical canvas px
 *     ndcZMin,                                 // WEBGL | WEBGPU, set once at creation
 *     stale,                                   // true until a set() with an invertible P · V
 *     set(P, V)                                // copy P and V, recompute PV and PVInv
 *     setCamera(cam)                           // build V and P from a camera state, then set
 *     resize(width, height)                    // the canvas observer's write into vp
 *   }
 *
 * mat4PVInv is recomputed on set, once per frame, so unproject and every
 * SCREEN → WORLD mapping share it. A degenerate P · V leaves the previous
 * inverse and marks the bag stale; consumers treat a stale bag as "no pick
 * this frame".
 */

'use strict';

import { WEBGL, mat4Mul, mat4Invert, cameraView, cameraProj } from '@nakednous/tree';

const _inv = new Float32Array(16);   // inverse scratch: the bag keeps its previous inverse on failure
const _P   = new Float32Array(16);   // setCamera's projection
const _V   = new Float32Array(16);   // setCamera's view

function _identity(m) {
  m.fill(0);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

/**
 * Create a view bag. The matrices start at identity and the bag stale, so a
 * consumer reading it before the first set() picks nothing.
 *
 * @param {{ ndcZMin?:number, width?:number, height?:number }} [opts]
 *        ndcZMin: WEBGL (−1, default) or WEBGPU (0) — written once here, never
 *        detected. width / height: the initial logical canvas size.
 * @returns {object} The view bag.
 */
export function createView(opts) {
  const o = opts || {};
  const w = o.width || 0, h = o.height || 0;
  const view = {
    mat4Proj:  _identity(new Float32Array(16)),
    mat4View:  _identity(new Float32Array(16)),
    mat4PV:    _identity(new Float32Array(16)),
    mat4PVInv: _identity(new Float32Array(16)),
    vp: [0, h, w, -h],
    ndcZMin: o.ndcZMin === 0 ? 0 : WEBGL,
    stale: true,

    /**
     * Install a projection and a view: both copied, P · V and its inverse
     * recomputed. A singular product keeps the previous inverse and marks
     * the bag stale.
     * @param {ArrayLike<number>} P  Projection mat4.
     * @param {ArrayLike<number>} V  View mat4 (world → eye).
     * @returns {object} this
     */
    set(P, V) {
      for (let i = 0; i < 16; i++) { view.mat4Proj[i] = P[i]; view.mat4View[i] = V[i]; }
      mat4Mul(view.mat4PV, view.mat4Proj, view.mat4View);
      if (mat4Invert(_inv, view.mat4PV) === null) { view.stale = true; return view; }
      view.mat4PVInv.set(_inv);
      view.stale = false;
      return view;
    },

    /**
     * Install a camera state: cameraView and cameraProj at the viewport's
     * aspect under the bag's ndcZMin, then set(). A state with both fov and
     * halfHeight null keeps the projection already installed.
     * @param {object} cam  Camera state.
     * @returns {object} this
     */
    setCamera(cam) {
      const aspect = view.vp[3] !== 0 ? view.vp[2] / -view.vp[3] : 1;
      cameraView(_V, cam);
      const P = cameraProj(_P, cam, aspect, view.ndcZMin) || view.mat4Proj;
      return view.set(P, _V);
    },

    /**
     * Write a new logical canvas size into vp: [0, height, width, −height].
     * @param {number} width
     * @param {number} height
     * @returns {object} this
     */
    resize(width, height) {
      view.vp[1] = height; view.vp[2] = width; view.vp[3] = -height;
      return view;
    },
  };
  return view;
}

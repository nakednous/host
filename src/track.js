/**
 * @file Track factories and TrackHandles — core tracks wired to the host's players.
 * @module host/track
 * @license AGPL-3.0-only
 *
 * poseTrack(host, opts) is a core PoseTrack whose activation hooks add and
 * remove its player. cameraTrack(host, cam, opts) is a core CameraTrack whose
 * player evaluates straight into the camera state `cam` — the state is the
 * keyframe shape, so track.eval(cam) is the write — and once more on
 * deactivate so the camera rests on the path; add() with no argument
 * captures `cam`, add({ camera }) any camera-state object. { handles } on
 * either decorates the track with TrackHandles: one VIEW handle per
 * draggable keyframe field (pos / eye / center), an optional rot DIAL per
 * keyframe about a declared axis, all on one router.
 */

'use strict';

import { PoseTrack, CameraTrack, qFromAxisAngle, DIAL } from '@nakednous/tree';
import { VIEW } from './handle.js';

// ── Players ────────────────────────────────────────────────────────────────

function _wirePoseTrack(host, track) {
  let player = null;
  track._onActivate = () => {
    player = player || { tick() { track.tick(); return track.playing; } };
    host.players.add(player);
  };
  track._onDeactivate = () => { if (player) host.players.remove(player); };
}

/**
 * A core PoseTrack ticked by the host while it plays.
 * @param {object} host
 * @param {{ handles?:boolean|object }} [opts]
 * @returns {PoseTrack}
 */
export function poseTrack(host, opts) {
  const o = opts || {};
  const track = new PoseTrack();
  _wirePoseTrack(host, track);
  if (o.handles) track.handles = new TrackHandles(host, track, o.handles, false);
  return track;
}

/**
 * A core CameraTrack evaluating into the camera state `cam` while it plays.
 * @param {object} host
 * @param {object} cam   A camera state ({ eye, center, up, fov, halfHeight, near, far }).
 * @param {{ handles?:boolean|object }} [opts]
 * @returns {CameraTrack}
 */
export function cameraTrack(host, cam, opts) {
  const o = opts || {};
  const track = new CameraTrack();
  const state = cam || null;   // the evaluation target; track.camera is informational
  track.camera = state;
  track._onApply = null;       // lib-space seam: a bridge pushes the evaluated state to its camera

  const coreAdd = track.add.bind(track);
  track.add = function (spec, addOpts) {
    if (spec == null) {
      if (!state) return;
      spec = state;
    } else if (Array.isArray(spec)) {
      for (const s of spec) track.add(s, addOpts);
      return;
    } else if (spec.camera != null) {
      spec = spec.camera;
    }
    coreAdd(spec, addOpts);
  };

  const apply = () => {
    if (!state || track.keyframes.length === 0) return;
    track.eval(state);
    if (track._onApply) track._onApply(state);
  };
  const player = {
    tick() {
      if (!track.playing) return false;
      track.tick();
      apply();
      return track.playing;
    },
  };
  track._onActivate   = () => host.players.add(player);
  track._onDeactivate = () => { host.players.remove(player); apply(); };

  if (o.handles) track.handles = new TrackHandles(host, track, o.handles, true);
  return track;
}

// ── TrackHandles ───────────────────────────────────────────────────────────

const _vx = (v, i) => (v[i] !== undefined ? v[i] : (i === 0 ? v.x : i === 1 ? v.y : v.z));

/**
 * Per-keyframe manipulators of a track — the factories' `handles` opt,
 * stored at track.handles. Members are internal handles on one router;
 * their hooks are re-exposed with keyframe coordinates: onGrab(index, field,
 * h) / onChange(value, index, field, h) / onRelease / onCancel, field one of
 * 'pos' | 'eye' | 'center' | 'rot'. update() rebuilds the members when the
 * keyframe count changes and re-seeds every idle member from its keyframe.
 * A bridge draws the members itself (`members`).
 */
export class TrackHandles {
  /**
   * @param {object} host
   * @param {object} track       PoseTrack | CameraTrack.
   * @param {true|object} opts   `true` for the defaults, or
   *        { center?, rot?, rotRadius?, rotSnap?, grabPx?, snap?, hover? }.
   * @param {boolean} isCamera   CameraTrack (eye / center) vs PoseTrack (pos / rot).
   */
  constructor(host, track, opts, isCamera) {
    const o = opts === true ? {} : (opts || {});
    this._host     = host;
    this._track    = track;
    this._isCamera = !!isCamera;
    this._members    = [];
    this._rotByIndex = new Map();
    this._n          = -1;
    this._enabled    = true;
    /** Last-grabbed keyframe index, null until a grab. @type {number|null} */
    this.selected = null;

    this._grabPx  = Number.isFinite(o.grabPx) ? o.grabPx : 12;
    this._snap    = o.snap    ?? null;
    this._rotSnap = o.rotSnap ?? null;
    this._center  = this._isCamera ? (o.center !== false) : false;
    if (!this._isCamera && o.center !== undefined) console.error('[host] track handles: `center` is CameraTrack-only — ignoring.');
    this._rotAxis   = null;
    this._rotRadius = Number.isFinite(o.rotRadius) ? o.rotRadius : 40;
    if (o.rot != null) {
      if (this._isCamera) {
        console.error('[host] track handles: `rot` is PoseTrack-only — a camera keyframe\'s orientation is its center; drag that instead. Ignoring.');
      } else {
        const ax = _vx(o.rot, 0) ?? 0, ay = _vx(o.rot, 1) ?? 1, az = _vx(o.rot, 2) ?? 0;
        const l = Math.hypot(ax, ay, az) || 1;
        this._rotAxis = [ax / l, ay / l, az / l];
      }
    }

    this.onGrab = null; this.onChange = null; this.onRelease = null; this.onCancel = null;
    this._hover  = o.hover !== false;
    this._router = null;   // made on the first rebuild, once a subclass is constructed
  }

  // The construction seams a bridge subclass overrides so the members are
  // handles it can draw.
  _makeHandle(opts) { return this._host.handle(opts); }
  _makeRouter(opts) { return this._host.router([], opts); }

  /** The members, { h, index, field } each, for a bridge's draw. */
  get members() { return this._members; }
  /** Dot radius in pixels, the members' grabPx. */
  get grabPx() { return this._grabPx; }

  /**
   * Rebuild if the keyframe count changed, re-seed idle members, then route.
   * Call first in the frame, before the orbit.
   * @returns {boolean} true while any member is grabbed.
   */
  update() {
    if (this._track.keyframes.length !== this._n) this._rebuild();
    if (this._enabled) this._syncIdle();
    return this._router.update();
  }

  /** The members' router, made on the first update(). */
  get router() { return this._router; }

  /** Runtime gate — false suspends grab / solve and empties the pick. */
  get enabled() { return this._enabled; }
  set enabled(v) {
    this._enabled = !!v;
    for (const m of this._members) m.h.enabled = this._enabled;
  }

  /** True while any member is grabbed. */
  grabbed() {
    for (const m of this._members) if (m.h.grabbed()) return true;
    return false;
  }

  /** The keyframe index under the pointer (or grabbed), else null. */
  hovered() {
    for (const m of this._members) if (m.h.hovered()) return m.index;
    return null;
  }

  /** Re-seed every idle member from its keyframe. Chainable. */
  sync() { this._syncIdle(); return this; }

  /** Dispose the members and the router, detach from the track. */
  dispose() {
    this._teardown();
    if (this._router) this._router.dispose();
    if (this._track.handles === this) this._track.handles = null;
  }

  _rebuild() {
    if (!this._router) this._router = this._makeRouter({ hover: this._hover });
    this._teardown();
    const n = this._track.keyframes.length;
    this._n = n;
    for (let i = 0; i < n; i++) {
      this._addViewMember(i, this._isCamera ? 'eye' : 'pos');
      if (this._center)  this._addViewMember(i, 'center');
      if (this._rotAxis) this._addRotMember(i);
    }
    if (this.selected != null && this.selected >= n) this.selected = null;
  }

  _teardown() {
    for (const m of this._members) { this._router.remove(m.h); m.h.dispose(); }
    this._members.length = 0;
    this._rotByIndex.clear();
  }

  // A VIEW member bound to kf[field] by index, so set(i, spec) replacing the
  // keyframe never strands it.
  _addViewMember(index, field) {
    const track = this._track;
    const h = this._makeHandle({
      constraint: VIEW, grabPx: this._grabPx, snap: this._snap,
      bind: {
        get: () => track.keyframes[index] ? track.keyframes[index][field] : null,
        set: (v) => {
          const k = track.keyframes[index];
          if (!k) return;
          const a = k[field];
          a[0] = _vx(v, 0); a[1] = _vx(v, 1); a[2] = _vx(v, 2);
        },
      },
    });
    if (!h) return;
    this._wire(h, index, field);
    this._members.push({ h, index, field });
    this._router.add(h);
  }

  // A rot member: one DIAL about the declared axis at the keyframe's
  // position, unbound — θ lands in kf.rot through the hooks.
  _addRotMember(index) {
    const kf = this._track.keyframes[index];
    const h = this._makeHandle({
      constraint: DIAL, anchor: [kf.pos[0], kf.pos[1], kf.pos[2]],
      axis: this._rotAxis, radius: this._rotRadius, grabPx: this._grabPx, snap: this._rotSnap,
    });
    if (!h) return;
    this._wire(h, index, 'rot');
    const m = { h, index, field: 'rot' };
    this._members.push(m);
    this._rotByIndex.set(index, m);
    this._router.add(h);
    this._syncRot(m);
  }

  _wire(h, index, field) {
    const rotWrite = () => {
      const k = this._track.keyframes[index];
      if (k) { const u = this._rotAxis; qFromAxisAngle(k.rot, u[0], u[1], u[2], h.scalar()); }
    };
    h.onGrab = () => {
      this.selected = index;
      if (this.onGrab) this.onGrab(index, field, h);
    };
    h.onChange = (v) => {
      if (field === 'rot') rotWrite();
      else if (field === 'pos') {
        // Forward the dragged position into the keyframe's rot ring now, so
        // the ring never trails the dot by a frame.
        const rm = this._rotByIndex.get(index);
        const k = this._track.keyframes[index];
        if (rm && k) rm.h.anchor(k.pos);
      }
      if (this.onChange) this.onChange(v, index, field, h);
    };
    h.onRelease = () => { if (this.onRelease) this.onRelease(index, field, h); };
    h.onCancel = () => {
      if (field === 'rot') rotWrite();   // a DIAL is unbound: re-derive from the reverted θ
      if (this.onCancel) this.onCancel(index, field, h);
    };
  }

  _syncIdle() {
    for (const m of this._members) {
      if (m.h.grabbed()) continue;
      if (m.field === 'rot') this._syncRot(m);
      else m.h.sync();
    }
  }

  // Anchor the ring at the live keyframe position and set θ to the twist of
  // kf.rot about the axis: θ = 2·atan2(q.xyz · u, q.w).
  _syncRot(m) {
    const k = this._track.keyframes[m.index];
    if (!k) return;
    m.h.anchor(k.pos);
    const u = this._rotAxis;
    const th = 2 * Math.atan2(k.rot[0] * u[0] + k.rot[1] * u[1] + k.rot[2] * u[2], k.rot[3]);
    const c = m.h._constraint;
    if (c.s !== th) { c.s = th; c._dialPoint(); }
  }
}

/**
 * @file Track factories and TrackHandles — core tracks wired to the host's players.
 * @module host/track
 * @license AGPL-3.0-only
 *
 * poseTrack(host, opts) is a core PoseTrack whose activation hooks add and
 * remove its player. cameraTrack(host, cam, opts) is a core CameraTrack whose
 * player evaluates straight into the camera state `cam` — the state is the
 * keyframe shape, so track.eval(cam) is the write — while the track plays, and
 * once more on deactivate so the camera rests on the path. That bound is the
 * point: a stopped track's camera belongs to whoever else drives it — the
 * reader's orbit, the figure's own camera code — so a consumer that renders
 * from the state derives it instead, one evaluation per frame after the tick
 * that advances the transport, which carries a seek, a dragged keyframe and a
 * capture into the state as well and repeats the player's write harmlessly
 * while the track plays. add() with no argument
 * captures `cam`, add({ camera }) any camera-state object. { handles } on
 * either decorates the track with TrackHandles: one VIEW handle per
 * draggable keyframe field (pos / eye / center), an optional rot DIAL per
 * keyframe about a declared axis, all on one router.
 *
 * add(depth) — the transport panel's + button, which passes its depth slider
 * (ui's contract) — authors a keyframe where the camera is looking: on a pose
 * track the pose lands at the centre of the installed camera's frustum at
 * that depth, aimed along the camera's own eye frame; on a camera track the
 * camera state is captured, the depth having nothing to place. A panel whose
 * depth row is hidden passes no depth, which reads the panel's default, 0.5.
 * The frame is the host's view bag — the matrices the last setCamera
 * installed — so the placement is the same on every bridge and needs no
 * renderer here. remove() is the panel's −: no argument retracts the last
 * keyframe, one per call, an index staying the core track's own remove.
 */

'use strict';

import { PoseTrack, CameraTrack, qFromAxisAngle, DIAL, mapLocation, NDC, WORLD } from '@nakednous/tree';
import { VIEW } from './handle.js';

// ── Placement — the + button's depth ───────────────────────────────────────
//
// The transport panel hands add() a depth in [0, 1] and expects a keyframe in
// front of the camera. Writer-free placement: unproject the frustum's centre
// through the view bag's P · V inverse and aim the pose along the bag's eye
// frame (E = V⁻¹, its columns right / up / back). The depth is NDC-linear, as
// the p5 transport's was — 0 the near plane's centre, 1 the far plane's — so
// every bridge's own ndcZMin maps it without the caller knowing the API.

const _at  = [0, 0, 0];   // the unprojected frustum centre
const _dir = [0, 0, 0];   // the camera's forward
const _up  = [0, 0, 0];   // the camera's up

/**
 * Append a pose at the centre of the installed camera's frustum, `depth` of
 * the way from the near plane to the far one.
 *
 * @param {object} host
 * @param {function} add    The track's core add, already bound.
 * @param {number} [depth]  NDC-linear depth in [0, 1]; clamped, absent or NaN
 *                          reads the panel's own default, 0.5.
 * @returns {boolean} false when no camera is installed (a stale view bag).
 */
function _addInFront(host, add, depth) {
  const view = host.view;
  if (!view || view.stale) return false;
  const d    = Number.isFinite(depth) ? (depth < 0 ? 0 : depth > 1 ? 1 : depth) : 0.5;
  const ndcZ = view.ndcZMin + d * (1 - view.ndcZMin);
  mapLocation(_at, 0, 0, ndcZ, NDC, WORLD, view, view.vp, view.ndcZMin);
  const e = view.mat4Eye;                        // columns: right · up · back · eye
  _dir[0] = -e[8];  _dir[1] = -e[9];  _dir[2] = -e[10];
  _up[0]  =  e[4];  _up[1]  =  e[5];  _up[2]  =  e[6];
  add({ pos: [_at[0], _at[1], _at[2]], rot: { dir: _dir, up: _up } }, { deduplicate: false });
  return true;
}

// ── Players ────────────────────────────────────────────────────────────────

// remove(): the panel's −, retracting the last authored keyframe — one per
// click, either kind of track. An index stays the core track's own remove, so
// a caller editing by index is unaffected; an empty track removes nothing.
function _wireRemove(track) {
  const coreRemove = track.remove.bind(track);
  track.remove = function (index) {
    return coreRemove(index == null ? track.keyframes.length - 1 : index);
  };
  return track;
}

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

  // add(depth): the transport's + (see the module header). A spec, or an array
  // of specs, is the core track's own; no argument — the panel with its depth
  // row hidden — places at the panel's default depth, 0.5.
  const coreAdd = track.add.bind(track);
  let warned = false;
  track.add = function (spec, addOpts) {
    if (spec != null && typeof spec !== 'number') return coreAdd(spec, addOpts);
    if (!_addInFront(host, coreAdd, spec) && !warned) {
      warned = true;
      console.warn('[host] poseTrack: add(depth) places a pose against the installed camera, and the view bag is stale — no keyframe added. Call the bridge\'s setCamera first.');
    }
  };

  if (o.handles) track.handles = new TrackHandles(host, track, o.handles, false);
  return _wireRemove(track);
}

/**
 * A core CameraTrack evaluating into the camera state `cam` while it plays, and
 * once when it stops, so the camera rests on the path.
 *
 * The write is bounded by playback on purpose: while a track is stopped the
 * camera it names belongs to whoever else drives it — the reader's orbit, the
 * figure's own camera code — and a factory writing every frame would fight
 * them. A consumer that renders *from* the state therefore derives it: evaluate
 * the track once per frame, after the tick that advances the transport. A seek,
 * a dragged keyframe and a capture reach the state that way too, and the
 * evaluation repeats the player's own write harmlessly while the track plays.
 *
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
    // No spec, or the transport panel's depth: a camera keyframe *is* the
    // camera, so there is nothing a placement depth could move — capture.
    if (spec == null || typeof spec === 'number') {
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
  return _wireRemove(track);
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

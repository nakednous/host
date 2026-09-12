/**
 * @file The handle controller — a draggable constraint driven from the pointer source.
 * @module host/handle
 * @license AGPL-3.0-only
 *
 * Wraps a core Constraint (@nakednous/tree) with the transport a draggable
 * 3D control needs: presses, moves and releases from the host's pointer
 * source, a pixel → ray unprojection through the host's view bag, an
 * analytic pick against the constraint's proxy, and a host-driven update()
 * lifecycle. No drawing: a bridge draws the locus (locusLines) and the dot.
 *
 * ── update() ordering contract ─────────────────────────────────────────────
 * update() is host-driven, before the orbit, because the orbit gate depends
 * on the grab resolving first:
 *
 *   onFrame() { setCamera(cam); if (!h.update()) orbit.update(); scene() }
 *
 * ── Pick ───────────────────────────────────────────────────────────────────
 * The pointer's ray is unproject(x, y, view) in WORLD; the grab size is
 * grabPx converted to world units through pixelRatio at the proxy's depth;
 * the constraint's proxy(ray, radius) answers t or Infinity. Built-in kinds
 * carry their proxy (a sphere at the point, the DIAL's ring); a custom kind
 * supplies one or gets the sphere. solve() runs in WORLD; value() converts.
 *
 * ── Pointer source ─────────────────────────────────────────────────────────
 * update() reads the frame's press queue and the tracked pointer's entry
 * (seq counts moves; up / cancel end the gesture; Esc cancels every claimed
 * pointer). A grab claims the pointer, which captures it on the canvas; a
 * miss leaves it unclaimed for the orbit. The whole gesture keys to one
 * pointerId, so on a shared surface each handle tracks its own finger.
 *
 * ── Constraint kinds ───────────────────────────────────────────────────────
 * Core SPHERE / PLANE / AXIS / DIAL pass straight through. VIEW is a core
 * PLANE re-aimed at the camera each solve — a screen-parallel drag plane
 * through the current point — reported as a world position; its constraint
 * carries `view: true`, the flag locusLines reads. A custom kind is a
 * contract-conforming object (kind / solve / value / seed, optional scalar /
 * azEl / aim / proxy / locus) passed as `constraint`.
 *
 * ── Snap / hover / cancel / from ───────────────────────────────────────────
 * snap quantises at the solve seam: an angular step for SPHERE (az/el) and
 * DIAL (θ), a world grid for PLANE / AXIS / VIEW (PLANE re-projecting).
 * hover is a lone-handle opt-in (a router provides it shared). Cancel — Esc,
 * pointercancel, cancel() — reverts to the value captured at grab, restores
 * the binding and fires onCancel instead of onRelease. `from` names the space
 * the symbolic basis (axis / normal / zero) resolves FROM into WORLD each idle
 * frame through mapDirection on the view bag — WORLD, EYE, or a mat4 —
 * frozen at grab.
 */

'use strict';

import {
  createConstraint, dirFromAzEl, unproject, rayHitSphere,
  mapLocation, mapDirection, pixelRatio, mat4Invert,
  SPHERE, PLANE, AXIS, DIAL, POINT, DIRECTION, WORLD, MATRIX,
} from '@nakednous/tree';

/** The screen-parallel free-translate constraint (a core PLANE re-aimed each solve). */
export const VIEW = 4;

// Module-level scratch — update() and value() run to completion within one
// frame with no reentrancy across handles.
const _rayO = [0, 0, 0];             // pick ray origin, WORLD
const _rayD = [0, 0, 0];             // pick ray unit direction, WORLD
/** The ray scratch a handle's _ray(x, y) fills — the router's shared pick reads it. */
export const rayScratch = { o: _rayO, d: _rayD };
const _v3   = [0, 0, 0];             // value() extraction scratch
const _q2   = [0, 0];                // az/el snap scratch
const _b0   = [0, 0, 0];             // resolved θ = 0 reference
const _b2   = [0, 0, 0];             // resolved axis / normal
const _frameInv = new Float32Array(16);

// The mapping bag mapLocation / mapDirection take: the view's matrices plus
// the frames a call names (a mat4 `from` or `to` is the MATRIX space).
const _bag = { mat4Proj: null, mat4View: null, mat4PV: null, mat4PVInv: null, mat4Eye: null,
               fromFrame: null, toFrame: null, toFrameInv: null };
const _isMat = (s) => s != null && typeof s !== 'string';
const _space = (s) => (_isMat(s) ? MATRIX : s);

function _bagOf(view, from, to) {
  _bag.mat4Proj = view.mat4Proj; _bag.mat4View = view.mat4View;
  _bag.mat4PV = view.mat4PV; _bag.mat4PVInv = view.mat4PVInv; _bag.mat4Eye = view.mat4Eye;
  _bag.fromFrame = _isMat(from) ? from : null;
  if (_isMat(to)) { _bag.toFrame = to; _bag.toFrameInv = mat4Invert(_frameInv, to) ? _frameInv : null; }
  else { _bag.toFrame = null; _bag.toFrameInv = null; }
  return _bag;
}

const _norm3 = (o) => {
  const l = Math.hypot(o[0], o[1], o[2]) || 1;
  o[0] /= l; o[1] /= l; o[2] /= l;
  return o;
};

// Orthonormal in-plane basis for a unit normal n, seeded from the world axis
// least aligned with it (a DIAL's θ = 0 reference when `from` gives none).
const _basisFromNormal = (n, ub, vb) => {
  const ax = Math.abs(n[0]), ay = Math.abs(n[1]), az = Math.abs(n[2]);
  let rx = 0, ry = 0, rz = 0;
  if (ax <= ay && ax <= az) rx = 1; else if (ay <= az) ry = 1; else rz = 1;
  ub[0] = ry*n[2] - rz*n[1]; ub[1] = rz*n[0] - rx*n[2]; ub[2] = rx*n[1] - ry*n[0];
  _norm3(ub);
  vb[0] = n[1]*ub[2] - n[2]*ub[1]; vb[1] = n[2]*ub[0] - n[0]*ub[2]; vb[2] = n[0]*ub[1] - n[1]*ub[0];
};

// Read component i of an array or {x, y, z}, falling back to d.
const _vx = (v, i, d) => {
  if (v == null) return d;
  const c = i === 0 ? v.x : i === 1 ? v.y : v.z;
  return c ?? v[i] ?? d;
};

/** Contract check for a custom constraint object. */
export const isConstraint = (c) =>
  c && typeof c === 'object' &&
  typeof c.solve === 'function' &&
  typeof c.value === 'function' &&
  typeof c.seed  === 'function';

/**
 * The handle controller. Stateful and long-lived, like a track; driven from
 * the frame through update(), read with value(out, opts).
 */
export class Handle {
  /**
   * @param {object} host  The host context (its pointer source and view bag).
   * @param {object} opts  See host.handle().
   */
  constructor(host, opts) {
    this._host = host;
    this._pointer = host.pointer;
    this._view = host.view;

    const kind = opts.constraint;
    this._isView = (kind === VIEW);
    if (isConstraint(kind)) {
      this._constraint = kind;
    } else {
      const coreKind = this._isView ? PLANE : kind;
      // Vector opts pass straight through — the core duck-types arrays and {x, y, z}.
      this._constraint = createConstraint(coreKind, {
        radius: opts.radius, report: opts.report, anchor: opts.anchor,
        normal: opts.normal, axis: opts.axis, zero: opts.zero, extent: opts.extent,
      });
      if (this._isView) this._constraint.view = true;   // the flag locusLines reads
    }

    // Deferred constraint frame: the symbolic basis and the space it resolves from.
    this._from = null; this._fromDir = null; this._fromZero = null;
    if (opts.from != null && opts.from !== WORLD) {
      const custom = isConstraint(kind);
      const dirOpt = (kind === PLANE) ? opts.normal : (opts.axis ?? opts.normal);
      const ok = !this._isView &&
                 (kind === PLANE || kind === AXIS || kind === DIAL ||
                  (custom && typeof this._constraint.aim === 'function'));
      if (!ok) {
        console.error('[host] handle: `from` needs an aimable constraint — PLANE, AXIS, DIAL, or a custom kind exposing aim(); ignoring.');
      } else if (custom && dirOpt == null) {
        console.error('[host] handle: `from` on a custom kind needs a symbolic `axis` (or `normal`) to resolve; ignoring.');
      } else {
        this._from = opts.from;
        this._fromDir = [_vx(dirOpt, 0, kind === AXIS ? 1 : 0), _vx(dirOpt, 1, kind === AXIS ? 0 : 1), _vx(dirOpt, 2, 0)];
        if (opts.zero != null) {
          this._fromZero = [_vx(opts.zero, 0, 1), _vx(opts.zero, 1, 0), _vx(opts.zero, 2, 0)];
        } else if (kind === DIAL) {
          // Derive the θ = 0 reference once, in the FROM space, so axis and zero co-rotate.
          _b2[0] = this._fromDir[0]; _b2[1] = this._fromDir[1]; _b2[2] = this._fromDir[2];
          _norm3(_b2);
          const r0 = [0, 0, 0], r1 = [0, 0, 0];
          _basisFromNormal(_b2, r0, r1);
          this._fromZero = r0;
        }
      }
    }

    this._enabled = opts.enabled !== false;
    this._grabPx  = Number.isFinite(opts.grabPx) ? opts.grabPx : 12;
    this._snap    = opts.snap ?? null;
    this._hover   = opts.hover === true;
    this._hovered = false;
    this._hid = null; this._hseq = -1;       // the pointer last hover-tested, and its seq then

    // Transport state: one pointerId per gesture, its last consumed move seq
    // and its position in logical canvas px; _routed hands the down step to a router.
    this._grabbed = false;
    this._pid = null;
    this._seq = -1;
    this._ptr = [0, 0];
    this._routed = false;

    // The proxy: its world position and the grab radius in world units.
    this._proxyPos = [0, 0, 0];
    this._proxyRad = 0;

    // Cancel state — the value (and scalar, for winding) captured at grab.
    this._saved = [0, 0, 0];
    this._savedS = 0;

    // Hooks — user-facing, then the lib-space seams a router or a track owns.
    this.onGrab    = typeof opts.onGrab    === 'function' ? opts.onGrab    : null;
    this.onRelease = typeof opts.onRelease === 'function' ? opts.onRelease : null;
    this.onChange  = typeof opts.onChange  === 'function' ? opts.onChange  : null;
    this.onCancel  = typeof opts.onCancel  === 'function' ? opts.onCancel  : null;
    this._onGrab = null; this._onRelease = null; this._onChange = null; this._onCancel = null;

    // Binding — a normalised { get, set } accessor; _bindVal the reused value array.
    this._binder = null;
    this._bindVal = [0, 0, 0];

    if (opts.bind != null) this.bind(opts.bind);
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────

  /**
   * Resolve the grab and re-solve from the pointer. Call first in the frame,
   * before the orbit; a routed handle is updated by its router. Returns the
   * grabbed state so the orbit gate can short-circuit; a disabled handle
   * returns false.
   * @returns {boolean} grabbed
   */
  update() {
    if (!this._enabled) {
      if (this._pid !== null && this._pointer) this._pointer.release(this._pid);
      this._grabbed = false; this._hovered = false; this._pid = null;
      return false;
    }
    const src = this._pointer;
    if (!src) return false;
    if (this._from && !this._grabbed) this._resolveFrame();

    // Fresh press (unrouted): the first unclaimed press this frame is
    // hit-tested at its pixel; a hit claims the pointer, a miss leaves it.
    if (!this._routed && this._pid === null) {
      for (const pr of src.presses) {
        if (src.ownerOf(pr.id) !== null) continue;
        this._ptr[0] = pr.x; this._ptr[1] = pr.y;
        if (this._pickAt(pr.x, pr.y)) { this._adopt(pr.id, pr.x, pr.y); break; }
      }
    }

    if (this._pid !== null) {
      const e = src.get(this._pid);
      if (!e) {
        this._cancelNow();                       // the entry left before this handle saw its end
      } else {
        if (this._grabbed && e.seq !== this._seq && !e.cancel) {
          this._seq = e.seq;
          this._ptr[0] = e.x; this._ptr[1] = e.y;
          this._solveFromPointer(e.x, e.y);
          this._applySnap();
          this._afterSolve();
        }
        if (e.cancel) {
          this._cancelNow();
        } else if (e.up) {
          src.release(this._pid);
          this._grabbed = false;
          this._pid = null;
          this.onRelease  && this.onRelease(this);
          this._onRelease && this._onRelease(this);
        }
      }
    }

    // Hover: a lone handle tests the latest unclaimed pointer motion.
    if (this._grabbed) {
      this._hovered = true;
    } else if (this._hover && !this._routed) {
      for (const e of src.pointers.values()) {
        if (e.owner !== null) continue;
        if (e.id === this._hid && e.seq === this._hseq) continue;
        this._hid = e.id; this._hseq = e.seq;
        this._hovered = this._pickAt(e.x, e.y);
        break;
      }
    }
    return this._grabbed;
  }

  _beginGrab() {
    const c = this._constraint;
    c.value(this._saved, POINT);
    this._savedS = typeof c.scalar === 'function' ? c.scalar() : 0;
    this._grabbed = true;
    this.onGrab  && this.onGrab(this);
    this._onGrab && this._onGrab(this);
  }

  /** Router seam: adopt a pointer a shared pick decided; claims it through the source. */
  _adopt(pointerId, x, y) {
    const e = this._pointer.get(pointerId);
    this._pid = pointerId;
    this._seq = e ? e.seq : -1;
    this._ptr[0] = x; this._ptr[1] = y;
    this._pointer.claim(pointerId, this);
    this._beginGrab();
  }

  /**
   * Revert the drag in flight to the value captured at grab (exact θ winding
   * included), restore the binding, fire onCancel. No-op when not grabbed.
   * Chainable.
   * @returns {Handle} this
   */
  cancel() {
    if (this._grabbed) this._cancelNow();
    return this;
  }

  _cancelNow() {
    const c = this._constraint;
    if (this._isView) {
      c.pt[0] = this._saved[0]; c.pt[1] = this._saved[1]; c.pt[2] = this._saved[2];
    } else if (c.kind === DIAL) {
      c.s = this._savedS;
      c._dialPoint();
    } else {
      c.seed(this._saved[0], this._saved[1], this._saved[2]);
    }
    if (this._binder) this._binder.set(this.value(this._bindVal));
    this._grabbed = false;
    if (this._pid !== null && this._pointer) this._pointer.release(this._pid);
    this._pid = null;
    this.onCancel  && this.onCancel(this);
    this._onCancel && this._onCancel(this);
  }

  // ── Frame, pick, solve ──────────────────────────────────────────────────

  // Resolve the symbolic basis from its space into WORLD through the view
  // bag and re-aim the constraint; idle frames only.
  _resolveFrame() {
    const v = this._view, bag = _bagOf(v, this._from, null), from = _space(this._from);
    const d = this._fromDir;
    mapDirection(_b2, d[0], d[1], d[2], from, WORLD, bag, v.vp, v.ndcZMin);
    if (this._fromZero) {
      const z = this._fromZero;
      mapDirection(_b0, z[0], z[1], z[2], from, WORLD, bag, v.vp, v.ndcZMin);
      this._constraint.aim(_b2[0], _b2[1], _b2[2], _b0[0], _b0[1], _b0[2]);
    } else {
      this._constraint.aim(_b2[0], _b2[1], _b2[2]);
    }
  }

  // The proxy's world position and its grab radius in world units — a
  // constant grabPx screen size at the proxy's depth.
  _proxyPrep() {
    const c = this._constraint, v = this._view, p = this._proxyPos;
    if (this._from && !this._grabbed) this._resolveFrame();
    if (c.kind === DIAL && !this._isView) {
      p[0] = c.anchor[0]; p[1] = c.anchor[1]; p[2] = c.anchor[2];
    } else {
      c.value(p, POINT);
    }
    const V = v.mat4View;
    const eyeZ = V[2]*p[0] + V[6]*p[1] + V[10]*p[2] + V[14];
    this._proxyRad = this._grabPx * pixelRatio(v.mat4Proj, -v.vp[3], eyeZ, v.ndcZMin);
  }

  // The analytic pick: t along the ray, or Infinity.
  _proxyT(o, d) {
    this._proxyPrep();
    const c = this._constraint;
    if (typeof c.proxy === 'function') return c.proxy(o[0], o[1], o[2], d[0], d[1], d[2], this._proxyRad);
    const p = this._proxyPos;
    return rayHitSphere(o[0], o[1], o[2], d[0], d[1], d[2], p[0], p[1], p[2], this._proxyRad);
  }

  /** Unproject a canvas pixel into the ray scratch; false on a stale view. */
  _ray(x, y) {
    const v = this._view;
    if (v.stale) return false;
    return unproject(_rayO, _rayD, x, y, v, v.vp, v.ndcZMin) !== null;
  }

  /** Hit-test the proxy at a canvas pixel. */
  _pickAt(x, y) {
    return this._ray(x, y) && this._proxyT(_rayO, _rayD) < Infinity;
  }

  _solveFromPointer(x, y) {
    if (!this._ray(x, y)) return;
    if (this._isView) this._viewUpdatePlane();
    this._constraint.solve(_rayO[0], _rayO[1], _rayO[2], _rayD[0], _rayD[1], _rayD[2]);
  }

  // VIEW: re-aim the plane at the camera through the current point — its
  // normal the look direction (−Z of the eye matrix), its anchor the point.
  _viewUpdatePlane() {
    const c = this._constraint, E = this._view.mat4Eye;
    c.n[0] = -E[8]; c.n[1] = -E[9]; c.n[2] = -E[10];
    _norm3(c.n);
    c.anchor[0] = c.pt[0]; c.anchor[1] = c.pt[1]; c.anchor[2] = c.pt[2];
  }

  // ── Snap ────────────────────────────────────────────────────────────────

  /** Snap step — angular (rad) for SPHERE / DIAL, a world grid for PLANE / AXIS / VIEW; null off. */
  get snap()  { return this._snap; }
  set snap(v) { this._snap = v ?? null; }

  _applySnap() {
    const sn = this._snap;
    if (sn == null) return;
    const c = this._constraint;
    if (this._isView || c.kind === PLANE) {
      const gx = Array.isArray(sn) ? sn[0] : sn, gy = Array.isArray(sn) ? sn[1] : sn, gz = Array.isArray(sn) ? sn[2] : sn;
      _v3[0] = gx > 0 ? Math.round(c.pt[0] / gx) * gx : c.pt[0];
      _v3[1] = gy > 0 ? Math.round(c.pt[1] / gy) * gy : c.pt[1];
      _v3[2] = gz > 0 ? Math.round(c.pt[2] / gz) * gz : c.pt[2];
      if (this._isView) { c.pt[0] = _v3[0]; c.pt[1] = _v3[1]; c.pt[2] = _v3[2]; }
      else c.seed(_v3[0], _v3[1], _v3[2]);
    } else if (c.kind === AXIS || c.kind === DIAL) {
      const step = Array.isArray(sn) ? sn[0] : sn;
      if (!(step > 0)) return;
      const q = Math.round(c.s / step) * step;
      c.s = q < c.min ? c.min : (q > c.max ? c.max : q);
      if (c.kind === DIAL) c._dialPoint();
      else {
        c.pt[0] = c.anchor[0] + c.s * c.u[0];
        c.pt[1] = c.anchor[1] + c.s * c.u[1];
        c.pt[2] = c.anchor[2] + c.s * c.u[2];
      }
    } else if (c.kind === SPHERE) {
      const step = Array.isArray(sn) ? sn[0] : sn;
      if (!(step > 0)) return;
      c.azEl(_q2);
      dirFromAzEl(c.dir, Math.round(_q2[0] / step) * step, Math.round(_q2[1] / step) * step);
    }
  }

  // ── Value and binding ───────────────────────────────────────────────────

  /**
   * Write the current value into `out`. `report` overrides the constraint's
   * (POINT | DIRECTION); `to` converts from WORLD to EYE, SCREEN, NDC, or a
   * mat4 frame through the view bag. Out-first, out required.
   * @param {number[]} out  3-element destination.
   * @param {{ to?:string|ArrayLike<number>, report?:number }} [opts]
   * @returns {number[]} out
   */
  value(out, opts) {
    const o = opts || {}, c = this._constraint;
    const report = (o.report === POINT || o.report === DIRECTION) ? o.report : c.report;
    const to = o.to ?? WORLD;
    c.value(_v3, report);
    if (to === WORLD) { out[0] = _v3[0]; out[1] = _v3[1]; out[2] = _v3[2]; return out; }
    const v = this._view, bag = _bagOf(v, null, to), space = _space(to);
    return report === DIRECTION
      ? mapDirection(out, _v3[0], _v3[1], _v3[2], WORLD, space, bag, v.vp, v.ndcZMin)
      : mapLocation(out, _v3[0], _v3[1], _v3[2], WORLD, space, bag, v.vp, v.ndcZMin);
  }

  /**
   * Bind the handle to a target it drives while dragging: a `{ get, set }`
   * accessor, or a vec3 array mutated in place (a camera state's eye or
   * center is one). get() seeds the constraint now; each solve calls
   * set(value) with the reused value array, then fires onChange. Chainable.
   * @param {number[]|{ get:Function, set:Function }} target
   * @returns {Handle} this
   */
  bind(target) {
    let binder = null;
    if (target && typeof target.get === 'function' && typeof target.set === 'function') {
      binder = target;
    } else if (target && typeof target === 'object' && typeof target.length === 'number' && target.length >= 3) {
      binder = { get: () => target, set: (v) => { target[0] = v[0]; target[1] = v[1]; target[2] = v[2]; } };
    } else {
      console.error('[host] handle.bind: unrecognised target — pass a vec3 array or an { get, set } accessor. Leaving unbound.');
      return this;
    }
    this._binder = binder;
    if (this._from && !this._grabbed) this._resolveFrame();
    this._seedFromBinding();
    return this;
  }

  /** Re-seed the constraint from the bound target after it changed externally. Chainable. */
  sync() {
    if (this._binder) this._seedFromBinding();
    return this;
  }

  _seedFromBinding() {
    const g = this._binder.get();
    if (g == null) return;
    const x = _vx(g, 0, 0), y = _vx(g, 1, 0), z = _vx(g, 2, 0);
    if (this._isView) { const pt = this._constraint.pt; pt[0] = x; pt[1] = y; pt[2] = z; }
    else this._constraint.seed(x, y, z);
  }

  // Push the freshly solved value to the binding and fire onChange, once per solve.
  _afterSolve() {
    const bound = this._binder !== null;
    const notify = !!(this.onChange || this._onChange);
    if (!bound && !notify) return;
    const v = this.value(this._bindVal);
    if (bound) this._binder.set(v);
    if (notify) {
      this.onChange  && this.onChange(v, this);
      this._onChange && this._onChange(v, this);
    }
  }

  // ── Readouts and edits ──────────────────────────────────────────────────

  /** AXIS: the signed distance along the rail; DIAL: the accumulated angle; NaN otherwise. */
  scalar() { return typeof this._constraint.scalar === 'function' ? this._constraint.scalar() : NaN; }

  /** SPHERE: [az, el] of the current direction, into out2. */
  azEl(out2) {
    const o = out2 || [0, 0];
    return typeof this._constraint.azEl === 'function' ? this._constraint.azEl(o) : o;
  }

  /** True between grab and release. */
  grabbed() { return this._grabbed; }

  /** True while the pointer rests on the proxy, and while grabbed. */
  hovered() { return this._hovered; }

  /**
   * Move the reference point — sphere centre, plane point, axis anchor,
   * dial centre, or a VIEW handle's point; the stored point rides along.
   * Chainable.
   * @param {number[]|{x:number,y:number,z:number}} v
   * @returns {Handle} this
   */
  anchor(v) {
    const c = this._constraint;
    const t = this._isView ? c.pt : c.anchor;
    if (!t) return this;
    t[0] = _vx(v, 0, t[0]); t[1] = _vx(v, 1, t[1]); t[2] = _vx(v, 2, t[2]);
    if (!this._isView) {
      if (c.kind === DIAL) c._dialPoint();
      else if (c.kind === AXIS) {
        c.pt[0] = c.anchor[0] + c.s * c.u[0];
        c.pt[1] = c.anchor[1] + c.s * c.u[1];
        c.pt[2] = c.anchor[2] + c.s * c.u[2];
      } else if (c.kind === PLANE) c.seed(c.pt[0], c.pt[1], c.pt[2]);
    }
    return this;
  }

  /** Runtime gate — false suspends grab / solve without disposing. */
  get enabled() { return this._enabled; }
  set enabled(v) {
    this._enabled = !!v;
    if (!this._enabled) {
      if (this._pid !== null && this._pointer) this._pointer.release(this._pid);
      this._grabbed = false; this._hovered = false; this._pid = null;
    }
  }

  /** Release the pointer claim and leave the host. */
  dispose() {
    if (this._pid !== null && this._pointer) this._pointer.release(this._pid);
    this._pid = null;
    this._grabbed = false;
    this._pointer = null;
    this._host.unregister(this);
  }
}

/**
 * Validate the constraint option: a built-in kind, VIEW, or a contract object.
 * @param {*} kind
 * @returns {boolean}
 */
export function validConstraint(kind) {
  return kind === SPHERE || kind === PLANE || kind === AXIS || kind === DIAL || kind === VIEW || !!isConstraint(kind);
}

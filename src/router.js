/**
 * @file The pointer router — shared arbitration for overlapping handles.
 * @module host/router
 * @license AGPL-3.0-only
 *
 * Per-handle self-picking double-grabs on overlap: two proxies under one
 * finger each test only themselves and both hit. The router replaces the
 * members' down step with one shared pick: the pointer's ray once, every
 * enabled member's proxy tested, the nearest t wins (a tie keeps the
 * earlier member, as draw order would). Members keep their own move /
 * solve / release machinery, grabbed through their injected _adopt; every
 * unclaimed press of the frame resolves, so several same-frame presses on
 * different members all land. Hover is the same test on unclaimed pointer
 * motion, shared, setting at most one hovered member.
 */

'use strict';

import { rayScratch } from './handle.js';

/** Shared pick over a set of handles on one host. */
export class PointerRouter {
  /**
   * @param {object}   host     The host context.
   * @param {object[]} handles  Members.
   * @param {{ hover?:boolean }} [opts]  hover defaults to true.
   */
  constructor(host, handles, opts) {
    const o = opts || {};
    this._host = host;
    this._pointer = host.pointer;
    this._handles = [];
    this._hover = o.hover !== false;
    this._hoveredH = null;
    this._hid = null; this._hseq = -1;
    for (const h of handles || []) this.add(h);
  }

  /**
   * Route a handle: its own pointerdown adoption is disabled and the shared
   * pick grabs it through _adopt. Chainable.
   * @param {object} h
   * @returns {PointerRouter} this
   */
  add(h) {
    if (!h || typeof h._proxyT !== 'function') {
      console.error('[host] router.add: not a handle — ignoring.');
      return this;
    }
    if (this._handles.includes(h)) return this;
    h._routed = true;
    h._onRelease = h._onCancel = () => this._unclaim(h);
    this._handles.push(h);
    return this;
  }

  /**
   * Un-route a handle; it self-picks again. Chainable.
   * @param {object} h
   * @returns {PointerRouter} this
   */
  remove(h) {
    const i = this._handles.indexOf(h);
    if (i < 0) return this;
    this._handles.splice(i, 1);
    this._unclaim(h);
    h._routed = false;
    h._onRelease = h._onCancel = null;
    if (this._hoveredH === h) { this._hoveredH = null; h._hovered = false; }
    return this;
  }

  /**
   * Resolve the frame's presses with one shared pick each, refresh hover on
   * pointer motion, then update every member. Call first in the frame, in
   * place of the members' own updates.
   * @returns {boolean} true if any member is grabbed.
   */
  update() {
    const hs = this._handles, src = this._pointer;
    if (!src) return false;
    for (const pr of src.presses) {
      if (src.ownerOf(pr.id) !== null) continue;
      const win = this._sharedPick(pr.x, pr.y);
      if (win && win._pid === null && win.enabled) win._adopt(pr.id, pr.x, pr.y);
    }
    if (this._hover) {
      for (const e of src.pointers.values()) {
        if (e.owner !== null) continue;
        if (e.id === this._hid && e.seq === this._hseq) continue;
        this._hid = e.id; this._hseq = e.seq;
        const win = this._sharedPick(e.x, e.y);
        this._hoveredH = win;
        for (const h of hs) h._hovered = (h === win) || h._grabbed;
        break;
      }
    }
    let g = false;
    for (const h of hs) g = h.update() || g;
    return g;
  }

  // One ray, every enabled member's proxy, the nearest t.
  _sharedPick(x, y) {
    const hs = this._handles;
    const first = hs.find((h) => h.enabled);
    if (!first || !first._ray(x, y)) return null;
    let win = null, best = Infinity;
    for (const h of hs) {
      if (!h.enabled) continue;
      const t = h._proxyT(rayScratch.o, rayScratch.d);
      if (t < best) { best = t; win = h; }
    }
    return win;
  }

  _unclaim(h) {
    const src = this._pointer;
    if (!src) return;
    for (const e of src.pointers.values()) if (e.owner === h) src.release(e.id);
  }

  /** The member under the pointer, or null. */
  hovered() { return this._hoveredH; }

  /** Un-route every member and leave the host. */
  dispose() {
    for (const h of [...this._handles]) this.remove(h);
    this._pointer = null;
    this._host.unregister(this);
  }
}

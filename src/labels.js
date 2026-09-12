/**
 * @file The label layer — DOM text over the canvas, anchored in world or screen space.
 * @module host/labels
 * @license AGPL-3.0-only
 *
 * The replacement for WEBGL text() in HUDs, gizmo labels and formula
 * readouts, with the browser's own shaping. One absolutely positioned <div>
 * overlays the canvas as its next sibling, pointer-events: none, sized by
 * the canvas observer; the host sets the canvas parent to position:
 * relative when it is static, and says so in the console once.
 *
 *   labels.set(id, text, x, y, z, opts)     // a world anchor, projected each tick()
 *   labels.setScreen(id, text, sx, sy, opts) // canvas px, the HUD form
 *   labels.remove(id) · labels.clear() · labels.visible
 *   labels.tick()                            // after the view bag is current
 *
 * opts: dx / dy pixel offsets, anchor ('center' default, 'left', 'right'),
 * class — a CSS class beside the layer's own 'host-label', frame — a
 * transient label that lives for the frame it was set in: a gizmo re-sets
 * it every draw and tick() removes it once a frame passes without. A label
 * whose screen depth leaves [0, 1] or whose anchor leaves the canvas is
 * hidden, not clamped. Elements are reused by id; tick() writes transforms
 * only, text when the string changed.
 */

'use strict';

import { WORLD, SCREEN, mapLocation } from '@nakednous/tree';

const _p = [0, 0, 0];
const _ANCHOR = { center: -50, left: 0, right: -100 };
const _NO_OPTS = {};

/**
 * Create the label layer of a canvas. The layer is inserted at once; it
 * needs a parent, so create it after the canvas is in the document.
 *
 * @param {object} host  Its canvas, view bag and size are read.
 * @param {{ document?:object }} [opts]  The Document (default: the global).
 * @returns {object|null} The layer, or null without a document or a parent.
 */
export function createLabels(host, opts) {
  const o = opts || {};
  const doc = o.document || (typeof document !== 'undefined' ? document : null);
  const canvas = host.canvas;
  const parent = canvas && canvas.parentNode;
  if (!doc || !parent) { console.error('[host] labels: the canvas needs a parent element.'); return null; }

  const el = doc.createElement('div');
  el.className = 'host-labels';
  Object.assign(el.style, {
    position: 'absolute', left: '0px', top: '0px', width: '0px', height: '0px',
    pointerEvents: 'none', overflow: 'hidden',
  });
  const cs = typeof getComputedStyle === 'function' ? getComputedStyle(parent) : null;
  if (cs && cs.position === 'static') {
    parent.style.position = 'relative';
    console.info('[host] labels: set the canvas parent to position: relative for the label layer.');
  }
  parent.insertBefore(el, canvas.nextSibling);

  const entries = new Map();   // id → { el, text, x, y, z, dx, dy, ax, screen, cls, sx, sy, shown }
  let width = 0, height = 0, left = -1, top = -1, visible = true;

  const entry = (id, text, o) => {
    let e = entries.get(id);
    if (!e) {
      const span = doc.createElement('span');
      Object.assign(span.style, { position: 'absolute', left: '0px', top: '0px', whiteSpace: 'nowrap', willChange: 'transform' });
      span.style.visibility = 'hidden';
      el.appendChild(span);
      e = { el: span, text: null, x: 0, y: 0, z: 0, dx: 0, dy: 0, ax: -50, screen: false, cls: null, sx: NaN, sy: NaN, shown: false, frame: false, fresh: false };
      entries.set(id, e);
    }
    if (e.text !== text) { e.text = text; e.el.textContent = text; }
    const c = o.class || null;
    if (e.cls !== c) { e.cls = c; e.el.className = c ? 'host-label ' + c : 'host-label'; }
    e.ax = _ANCHOR[o.anchor] ?? -50;
    e.dx = o.dx || 0; e.dy = o.dy || 0;
    e.frame = !!o.frame; e.fresh = true;
    return e;
  };
  const place = (e, sx, sy) => {
    if (sx === e.sx && sy === e.sy) return;
    e.sx = sx; e.sy = sy;
    e.el.style.transform = 'translate(' + sx + 'px, ' + sy + 'px) translate(' + e.ax + '%, -50%)';
  };
  const show = (e, on) => {
    if (e.shown === on) return;
    e.shown = on;
    e.el.style.visibility = on ? '' : 'hidden';
  };

  const labels = {
    /** The layer element. */
    el,
    /** Whether the layer shows; false hides every label at once. */
    get visible() { return visible; },
    set visible(v) { visible = !!v; el.style.display = visible ? '' : 'none'; },
    /** Live label count. */
    get size() { return entries.size; },

    /**
     * Place a label at a world anchor, projected each tick().
     * @param {string} id
     * @param {string} text
     * @param {number} x, y, z  World anchor.
     * @param {{ dx?:number, dy?:number, anchor?:string, class?:string, frame?:boolean }} [opts]
     * @returns {object} this
     */
    set(id, text, x, y, z, opts) {
      const e = entry(id, text, opts || _NO_OPTS);
      e.screen = false; e.x = x; e.y = y; e.z = z;
      return labels;
    },

    /**
     * Place a label in canvas px — the HUD form.
     * @param {string} id
     * @param {string} text
     * @param {number} sx, sy  Canvas px, y down.
     * @param {{ dx?:number, dy?:number, anchor?:string, class?:string, frame?:boolean }} [opts]
     * @returns {object} this
     */
    setScreen(id, text, sx, sy, opts) {
      const e = entry(id, text, opts || _NO_OPTS);
      e.screen = true; e.x = sx; e.y = sy; e.z = 0;
      return labels;
    },

    /** Remove a label. */
    remove(id) {
      const e = entries.get(id);
      if (e) { el.removeChild(e.el); entries.delete(id); }
      return labels;
    },

    /** Remove every label. */
    clear() { for (const id of [...entries.keys()]) labels.remove(id); return labels; },

    /**
     * Project every world label through the view bag and write the
     * transforms; hide what falls outside the canvas or the depth range.
     * Call after the view bag is current for the frame.
     * @returns {object} this
     */
    tick() {
      const ol = canvas.offsetLeft || 0, ot = canvas.offsetTop || 0;
      if (ol !== left || ot !== top) { left = ol; top = ot; el.style.left = ol + 'px'; el.style.top = ot + 'px'; }
      const view = host.view;
      for (const [id, e] of entries) {
        if (e.frame && !e.fresh) { labels.remove(id); continue; }
        e.fresh = false;
        let sx, sy, on;
        if (e.screen) { sx = e.x; sy = e.y; on = true; }
        else if (!view || view.stale) { on = false; }
        else {
          mapLocation(_p, e.x, e.y, e.z, WORLD, SCREEN, view, view.vp, view.ndcZMin);
          sx = _p[0]; sy = _p[1];
          on = _p[2] >= 0 && _p[2] <= 1 && sx >= 0 && sx <= width && sy >= 0 && sy <= height;
        }
        if (on) place(e, sx + e.dx, sy + e.dy);
        show(e, on);
      }
      return labels;
    },

    /**
     * The observer's write: the layer's size in CSS px.
     * @param {number} w
     * @param {number} h
     * @returns {object} this
     */
    resize(w, h) {
      width = w; height = h;
      el.style.width = w + 'px'; el.style.height = h + 'px';
      return labels;
    },

    /** Remove the layer and its labels. */
    dispose() {
      entries.clear();
      if (el.parentNode) el.parentNode.removeChild(el);
      host.unregister(labels);
      return labels;
    },
  };
  labels.resize(host.width || 0, host.height || 0);
  return host.register(labels);
}

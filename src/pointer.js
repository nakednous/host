/**
 * @file The pointer source — a typed event buffer with claims, one per canvas.
 * @module host/pointer
 * @license AGPL-3.0-only
 *
 * Shared by every handle, router and orbit on a canvas. Listeners only
 * record; nothing solves in a listener:
 *
 * - pointerdown · pointermove · pointerup · pointercancel on the canvas,
 *   keydown (Esc) on the window.
 * - Coordinates in logical canvas px through the element's bounding
 *   rectangle — (clientX − rect.left) · (width / rect.width), the logical
 *   size read off the view bag's vp — the numbers mapLocation(SCREEN) and vp
 *   expect, so a CSS-scaled canvas maps correctly.
 * - Per pointer: an entry { id, x, y, seq, down, up, cancel, owner }, kept
 *   from its press until the frame after its release; `seq` counts moves,
 *   so a consumer remembers the last seq it consumed and reads only new
 *   motion. Multitouch is per-pointer by construction; the mouse is one
 *   more pointer.
 * - Presses queue in order for the frame (`presses`); consumers read the
 *   queue inside the frame and claim what they take. Several same-frame
 *   presses on different members all land.
 * - Claims: claim(id, owner) captures the pointer on the canvas so a drag
 *   that leaves it keeps flowing; release(id), up and cancel release the
 *   capture. An unclaimed pointer is what the orbit sees.
 * - Esc sets the cancel flag on every claimed pointer.
 * - flush() ends the frame: the press queue empties and released pointers
 *   leave the map. The loop calls it after onFrame; an external loop calls
 *   it after its consumers ran (the p5 adapter from postdraw).
 */

'use strict';

/**
 * Create the pointer source of a canvas.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {object} view  The view bag; vp[2] and −vp[3] are the logical size.
 * @returns {object} The source: { presses, pointers, get, claim, release,
 *          ownerOf, flush, dispose }.
 */
export function createPointer(canvas, view) {
  const pointers = new Map();          // id → entry
  const presses  = [];                 // this frame's presses, in order: { id, x, y }
  const xy = [0, 0];

  const toCanvas = (e, out) => {
    const r = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : null;
    const w = view.vp[2], h = -view.vp[3];
    if (r && r.width > 0 && r.height > 0 && w > 0 && h > 0) {
      out[0] = (e.clientX - r.left) * (w / r.width);
      out[1] = (e.clientY - r.top)  * (h / r.height);
    } else {
      out[0] = e.clientX; out[1] = e.clientY;
    }
    return out;
  };

  const entry = (id) => {
    let p = pointers.get(id);
    if (!p) { p = { id, x: 0, y: 0, seq: 0, down: false, up: false, cancel: false, owner: null }; pointers.set(id, p); }
    return p;
  };

  const capture = (id, on) => {
    const f = on ? canvas.setPointerCapture : canvas.releasePointerCapture;
    if (typeof f !== 'function') return;
    try { f.call(canvas, id); } catch (_) { /* best effort: a synthetic or already-released id */ }
  };

  const onDown = (e) => {
    const p = entry(e.pointerId);
    toCanvas(e, xy);
    p.x = xy[0]; p.y = xy[1]; p.seq++;
    p.down = true; p.up = false; p.cancel = false;
    presses.push({ id: p.id, x: p.x, y: p.y });
  };
  const onMove = (e) => {
    const p = entry(e.pointerId);
    toCanvas(e, xy);
    p.x = xy[0]; p.y = xy[1]; p.seq++;
  };
  const onUp = (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    toCanvas(e, xy);
    p.x = xy[0]; p.y = xy[1]; p.seq++;
    p.up = true;
    capture(p.id, false);
  };
  const onCancel = (e) => {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    p.cancel = true;
    capture(p.id, false);
  };
  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    for (const p of pointers.values()) if (p.owner !== null) p.cancel = true;
  };

  canvas.addEventListener('pointerdown',   onDown);
  canvas.addEventListener('pointermove',   onMove);
  canvas.addEventListener('pointerup',     onUp);
  canvas.addEventListener('pointercancel', onCancel);
  if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('keydown', onKey);

  const source = {
    /** This frame's presses in order, each { id, x, y }; emptied by flush(). */
    presses,
    /** The live pointer entries by id. */
    pointers,

    /**
     * The entry of a pointer, or null when it is not on the canvas.
     * @param {number} id
     * @returns {object|null}
     */
    get(id) { return pointers.get(id) || null; },

    /**
     * Claim a pointer for an owner and capture it on the canvas. Fails when
     * another owner holds it or the pointer is unknown.
     * @param {number} id
     * @param {object} owner
     * @returns {boolean} claimed
     */
    claim(id, owner) {
      const p = pointers.get(id);
      if (!p || (p.owner !== null && p.owner !== owner)) return false;
      p.owner = owner;
      capture(id, true);
      return true;
    },

    /**
     * Release a claim and the capture with it. No-op for an unclaimed id.
     * @param {number} id
     */
    release(id) {
      const p = pointers.get(id);
      if (!p || p.owner === null) return;
      p.owner = null;
      capture(id, false);
    },

    /**
     * The owner holding a pointer, or null.
     * @param {number} id
     * @returns {object|null}
     */
    ownerOf(id) { const p = pointers.get(id); return p ? p.owner : null; },

    /**
     * End the frame: the press queue empties; pointers that released or
     * cancelled leave the map (their claims dropped), the rest keep their
     * position and seq.
     */
    flush() {
      presses.length = 0;
      for (const [id, p] of pointers) {
        if (p.up || p.cancel) { p.owner = null; pointers.delete(id); }
      }
    },

    /** Remove every listener and release every capture. */
    dispose() {
      canvas.removeEventListener('pointerdown',   onDown);
      canvas.removeEventListener('pointermove',   onMove);
      canvas.removeEventListener('pointerup',     onUp);
      canvas.removeEventListener('pointercancel', onCancel);
      if (typeof window !== 'undefined' && window.removeEventListener) window.removeEventListener('keydown', onKey);
      for (const p of pointers.values()) if (p.owner !== null) capture(p.id, false);
      pointers.clear();
      presses.length = 0;
    },
  };
  return source;
}

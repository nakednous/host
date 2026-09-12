/**
 * @file The canvas observer — logical size and device pixel ratio.
 * @module host/canvas
 * @license AGPL-3.0-only
 *
 * A ResizeObserver on the canvas element plus devicePixelRatio tracking:
 * on change the observer reports the logical size in CSS px and the dpr to
 * its callback, which the context uses to update host.width / host.height /
 * host.dpr, the view bag's vp, the label layer and the bridge's onSize. The
 * observer never touches canvas.width / canvas.height — that is the
 * renderer's decision.
 *
 * Without a ResizeObserver (a headless run) the size is measured once from
 * the element's bounding rectangle, falling back to its width / height
 * attributes.
 */

'use strict';

/**
 * Measure a canvas: logical CSS size from its bounding rectangle when laid
 * out, else its width / height attributes; dpr from the window.
 * @param {HTMLCanvasElement} canvas
 * @param {number[]} out3  [width, height, dpr] destination.
 * @returns {number[]} out3
 */
export function measureCanvas(canvas, out3) {
  const r = typeof canvas.getBoundingClientRect === 'function' ? canvas.getBoundingClientRect() : null;
  const laidOut = r && r.width > 0 && r.height > 0;
  out3[0] = laidOut ? r.width  : (canvas.width  || 0);
  out3[1] = laidOut ? r.height : (canvas.height || 0);
  out3[2] = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  return out3;
}

/**
 * Observe a canvas's logical size and dpr. `onChange(width, height, dpr)`
 * fires once immediately with the current measure and again on every
 * change; a change is reported only when a value differs.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {function(number, number, number):void} onChange
 * @returns {{ width:number, height:number, dpr:number, measure():void, dispose():void }}
 */
export function observeCanvas(canvas, onChange) {
  const m = [0, 0, 1];
  const obs = { width: -1, height: 0, dpr: 1, measure, dispose };
  let ro = null;
  const onWindow = () => measure();

  function measure() {
    measureCanvas(canvas, m);
    if (m[0] === obs.width && m[1] === obs.height && m[2] === obs.dpr) return;
    obs.width = m[0]; obs.height = m[1]; obs.dpr = m[2];
    onChange(obs.width, obs.height, obs.dpr);
  }

  function dispose() {
    if (ro) { ro.disconnect(); ro = null; }
    if (typeof window !== 'undefined' && window.removeEventListener) window.removeEventListener('resize', onWindow);
  }

  measure();                                   // width −1 makes the first measure report
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => measure());
    ro.observe(canvas);
  }
  // A zoom changes devicePixelRatio and fires resize; the observer alone would miss it.
  if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('resize', onWindow);
  return obs;
}

/**
 * @file A minimal DOM stub for the host tests: a canvas element with
 *       listeners, a bounding rectangle and pointer capture, plus a window.
 * @module host/test/dom
 */

export function createCanvas({ width = 400, height = 300, rect } = {}) {
  const listeners = new Map();
  const captured = new Set();
  const r = rect || { left: 0, top: 0, width, height };
  return {
    width, height, captured,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    dispatch(type, e) { for (const fn of listeners.get(type) || []) fn(e); },
    listenerCount(type) { return listeners.get(type)?.size || 0; },
    getBoundingClientRect() { return r; },
    setPointerCapture(id) { captured.add(id); },
    releasePointerCapture(id) { captured.delete(id); },
  };
}

/** Install a window stub with keydown / resize listeners; returns a dispatcher. */
export function installWindow() {
  const listeners = new Map();
  globalThis.window = {
    devicePixelRatio: 1,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    dispatch(type, e) { for (const fn of listeners.get(type) || []) fn(e); },
    listenerCount(type) { return listeners.get(type)?.size || 0; },
  };
  return globalThis.window;
}

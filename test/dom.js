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

/** A minimal element: listeners, a style bag, a child list, attributes, media playback. */
export function createElement(tag) {
  const listeners = new Map();
  const el = {
    tagName: tag.toUpperCase(),
    style: {}, attrs: {}, children: [], parentNode: null, hidden: false,
    className: '', textContent: '', playing: false,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    dispatch(type, e) { for (const fn of listeners.get(type) || []) fn(e); },
    listenerCount(type) { return listeners.get(type)?.size || 0; },
    setAttribute(k, v) { el.attrs[k] = v; },
    removeAttribute(k) { delete el.attrs[k]; if (k === 'src') delete el.src; },
    appendChild(c) { c.parentNode = el; el.children.push(c); return c; },
    insertBefore(c, ref) {
      c.parentNode = el;
      const i = ref ? el.children.indexOf(ref) : -1;
      if (i < 0) el.children.push(c); else el.children.splice(i, 0, c);
      return c;
    },
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); c.parentNode = null; },
    remove() { if (el.parentNode) el.parentNode.removeChild(el); },
    get nextSibling() {
      const p = el.parentNode; if (!p) return null;
      const i = p.children.indexOf(el); return p.children[i + 1] || null;
    },
    play() { el.playing = true; return Promise.resolve(); },
    pause() { el.playing = false; },
    getContext() { return el._ctx || (el._ctx = { log: [] }); },
    getBoundingClientRect() { return el.rect || { left: 0, top: 0, width: 0, height: 0 }; },
    offsetLeft: 0, offsetTop: 0,
  };
  return el;
}

/** Install a document stub with createElement and a computed-style reader; returns it. */
export function installDocument() {
  const doc = { createElement, body: createElement('body') };
  globalThis.document = doc;
  globalThis.getComputedStyle = (el) => ({ position: el.style.position || 'static' });
  return doc;
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

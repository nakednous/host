/**
 * @file labels tests — the label layer against the DOM stub; projection
 *       through the view bag.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCamera } from '@nakednous/tree';
import { createHost } from '../src/index.js';
import { createCanvas, createElement, installDocument, installWindow } from './dom.js';

installWindow();

function hostInParent({ parentPosition = '' } = {}) {
  const doc = installDocument();
  const parent = createElement('main');
  parent.style.position = parentPosition;
  // an element stub (tree, offsets) carrying the canvas stub's listeners, capture and rectangle
  const canvas = Object.assign(createElement('canvas'), createCanvas({ rect: { left: 0, top: 0, width: 400, height: 300 } }));
  parent.appendChild(canvas);
  const host = createHost(canvas);
  return { doc, parent, canvas, host };
}

test('labels: created on first access as the canvas sibling; a static parent becomes relative once', () => {
  const { parent, canvas, host } = hostInParent();
  const infos = [];
  const orig = console.info; console.info = (m) => infos.push(m);
  let labels;
  assert.equal(host.hasLabels, false);
  try { labels = host.labels; assert.equal(host.labels, labels); } finally { console.info = orig; }
  assert.equal(host.hasLabels, true);
  assert.equal(parent.style.position, 'relative');
  assert.equal(infos.length, 1);
  assert.equal(parent.children[0], canvas);
  assert.equal(parent.children[1], labels.el);
  assert.equal(labels.el.style.pointerEvents, 'none');
  assert.equal(labels.el.style.width, '400px');
  assert.equal(labels.el.style.height, '300px');
  labels.dispose();
  assert.equal(parent.children.length, 1);
  host.dispose();
});

test('labels: a positioned parent is left alone; the layer resizes with the observer', () => {
  const { parent, canvas, host } = hostInParent({ parentPosition: 'absolute' });
  const labels = host.labels;
  assert.equal(parent.style.position, 'absolute');
  Object.assign(canvas.getBoundingClientRect(), { width: 200, height: 100 });
  window.dispatch('resize', {});
  assert.equal(labels.el.style.width, '200px');
  assert.equal(host.width, 200);
  host.dispose();
  assert.equal(parent.children.length, 1);          // the layer went with the host
});

test('labels: world anchors project through the view bag; out-of-view and behind are hidden; transforms only on change', () => {
  const { host } = hostInParent();
  const labels = host.labels;
  host.view.setCamera(createCamera({ eye: [0, 0, 10], center: [0, 0, 0], fov: Math.PI / 2, near: 1, far: 100 }));
  labels.set('o', 'origin', 0, 0, 0);
  labels.set('r', 'right', 5, 0, 0, { dx: 4, dy: -6, anchor: 'left', class: 'tag' });
  labels.set('b', 'behind', 0, 0, 20);
  labels.set('f', 'far', 0, 0, -200);
  labels.set('x', 'off', 100, 0, 0);
  const o = labels.el.children[0], r = labels.el.children[1];
  assert.equal(o.textContent, 'origin');
  assert.equal(r.className, 'host-label tag');
  assert.equal(o.style.visibility, 'hidden');       // nothing placed before a tick
  labels.tick();
  assert.equal(o.style.transform, 'translate(200px, 150px) translate(-50%, -50%)');
  assert.equal(o.style.visibility, '');
  // x = 5 at depth 10 under a 90° lens and aspect 4/3: ndc x = 5 / (10 · 4/3) = 0.375 → 200 + 0.375 · 200 = 275
  assert.equal(r.style.transform, 'translate(279px, 144px) translate(0%, -50%)');
  assert.equal(labels.el.children[2].style.visibility, 'hidden');
  assert.equal(labels.el.children[3].style.visibility, 'hidden');
  assert.equal(labels.el.children[4].style.visibility, 'hidden');
  o.style.transform = 'untouched';
  labels.tick();
  assert.equal(o.style.transform, 'untouched');      // unchanged position: no write
  labels.set('o', 'origin', 0, 1, 0);
  labels.tick();
  assert.notEqual(o.style.transform, 'untouched');
  assert.equal(labels.size, 5);
  labels.remove('x').remove('nope');
  assert.equal(labels.size, 4);
  labels.clear();
  assert.equal(labels.size, 0);
  assert.equal(labels.el.children.length, 0);
  host.dispose();
});

test('labels: a stale bag hides world labels but not screen labels; visible toggles the layer; text updates only on change', () => {
  const { host } = hostInParent();
  const labels = host.labels;
  labels.set('w', 'world', 0, 0, 0).setScreen('h', 'hud', 10, 20, { anchor: 'right' });
  labels.tick();
  const w = labels.el.children[0], h = labels.el.children[1];
  assert.equal(w.style.visibility, 'hidden');
  assert.equal(h.style.visibility, '');
  assert.equal(h.style.transform, 'translate(10px, 20px) translate(-100%, -50%)');
  h.textContent = 'stale text';
  labels.setScreen('h', 'hud', 10, 20);
  assert.equal(h.textContent, 'stale text');         // same string: not rewritten
  labels.setScreen('h', 'hud2', 10, 20);
  assert.equal(h.textContent, 'hud2');
  labels.visible = false;
  assert.equal(labels.el.style.display, 'none');
  labels.visible = true;
  assert.equal(labels.el.style.display, '');
  host.canvas.offsetLeft = 8; host.canvas.offsetTop = 16;
  labels.tick();
  assert.equal(labels.el.style.left, '8px');
  assert.equal(labels.el.style.top, '16px');
  host.dispose();
});

test('labels: a frame label lives while it is re-set each frame and goes once a tick passes without', () => {
  const { host } = hostInParent();
  const labels = host.labels;
  labels.setScreen('t', 'transient', 1, 1, { frame: true }).setScreen('k', 'kept', 2, 2);
  labels.tick();
  assert.equal(labels.size, 2);
  labels.setScreen('t', 'transient', 1, 1, { frame: true });
  labels.tick();
  assert.equal(labels.size, 2);
  labels.tick();
  assert.equal(labels.size, 1);
  assert.equal(labels.el.children[0].textContent, 'kept');
  host.dispose();
});

test('labels: a canvas without a parent yields null and an error', () => {
  installDocument();
  const host = createHost(createCanvas());
  const errors = [];
  const orig = console.error; console.error = (m) => errors.push(m);
  try { assert.equal(host.labels, null); } finally { console.error = orig; }
  assert.equal(errors.length, 1);
  host.dispose();
});

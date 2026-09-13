/**
 * @file media tests — image, video, raster and model against stubbed fetch,
 *       document and media devices.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadImage, createVideo, raster, loadModel, createHost } from '../src/index.js';
import { createCanvas, createElement, installDocument } from './dom.js';

test('loadImage: fetches the blob and decodes it into a bitmap; a bad status throws', async () => {
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push([url, init]); return { ok: url !== 'nope', status: url === 'nope' ? 404 : 200, blob: async () => 'blob:' + url }; };
  globalThis.createImageBitmap = async (blob, opts) => ({ bitmap: blob, opts });
  try {
    const b = await loadImage('a.png', { fetch: { mode: 'cors' }, bitmap: { premultiplyAlpha: 'none' } });
    assert.deepEqual(b, { bitmap: 'blob:a.png', opts: { premultiplyAlpha: 'none' } });
    assert.deepEqual(calls[0], ['a.png', { mode: 'cors' }]);
    assert.equal((await loadImage('b.png')).opts, undefined);
    await assert.rejects(loadImage('nope'), /404/);
  } finally { delete globalThis.fetch; delete globalThis.createImageBitmap; }
});

test('loadModel: fetches OBJ text into the arrays shape; normal and texcoord only when present; a bad status throws', async () => {
  const quad = 'v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\nvn 0 0 1\nf 1/1/1 2/2/1 3/3/1 4/4/1\n';
  const bare = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n';
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push([url, init]); return { ok: url !== 'nope', status: url === 'nope' ? 404 : 200, text: async () => (url === 'quad.obj' ? quad : bare) }; };
  try {
    const m = await loadModel('quad.obj', { fetch: { mode: 'cors' } });
    assert.deepEqual(calls[0], ['quad.obj', { mode: 'cors' }]);
    assert.deepEqual(Object.keys(m).sort(), ['indices', 'normal', 'position', 'texcoord']);
    assert.ok(m.position.data instanceof Float32Array);
    assert.deepEqual([...m.position.data], [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
    assert.ok(m.indices.data instanceof Uint32Array);
    assert.deepEqual([...m.indices.data], [0, 1, 2, 2, 3, 0]);
    assert.deepEqual([...m.normal.data], [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
    assert.equal(m.texcoord.numComponents, 2);
    assert.deepEqual([...m.texcoord.data], [0, 0, 1, 0, 1, 1, 0, 1]);
    const b = await loadModel('bare.obj');
    assert.deepEqual(Object.keys(b).sort(), ['indices', 'position']);
    assert.equal(b.position.data.length / 3, 3);
    await assert.rejects(loadModel('nope'), /404/);
  } finally { delete globalThis.fetch; }
});

test('video: a src source is hidden, muted, looping; ready resolves at loadedmetadata and autoplays', async () => {
  const doc = installDocument();
  const v = createVideo({ src: 'clip.mp4', document: doc });
  assert.equal(v.el.tagName, 'VIDEO');
  assert.equal(v.el.muted, true);
  assert.equal(v.el.loop, true);
  assert.equal(v.el.style.display, 'none');
  assert.equal(v.el.src, 'clip.mp4');
  v.el.videoWidth = 640; v.el.videoHeight = 360;
  v.el.dispatch('loadedmetadata', {});
  assert.equal(await v.ready, v);
  assert.deepEqual([v.width, v.height], [640, 360]);
  assert.equal(v.el.playing, true);
  v.stop();
  assert.equal(v.el.playing, false);
  v.dispose();
  assert.equal(v.el.src, undefined);
  assert.equal(v.el.listenerCount('loadedmetadata'), 0);
});

test('video: a load error rejects ready; a missing source rejects at once', async () => {
  const doc = installDocument();
  const v = createVideo({ src: 'missing.mp4', document: doc, autoplay: false });
  v.el.dispatch('error', {});
  await assert.rejects(v.ready, /failed to load missing.mp4/);
  await assert.rejects(createVideo({ document: doc }).ready, /needs/);
});

test('video: a camera source attaches the stream; a denial rejects ready; dispose stops the tracks', async () => {
  const doc = installDocument();
  const stopped = [];
  const stream = { getTracks: () => [{ stop: () => stopped.push(1) }] };
  const media = { getUserMedia: async (c) => { media.constraints = c; return stream; } };
  const v = createVideo({ camera: { facingMode: 'environment' }, document: doc, media });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(media.constraints, { video: { facingMode: 'environment' }, audio: false });
  assert.equal(v.el.srcObject, stream);
  v.el.dispatch('loadedmetadata', {});
  await v.ready;
  v.dispose();
  assert.equal(stopped.length, 1);
  assert.equal(v.el.srcObject, null);

  const denied = { getUserMedia: async () => { throw new Error('NotAllowed'); } };
  await assert.rejects(createVideo({ camera: true, document: doc, media: denied }).ready, /camera denied: NotAllowed/);
  await assert.rejects(createVideo({ camera: true, document: doc, media: {} }).ready, /unavailable/);
});

test('raster: draws through OffscreenCanvas into a bitmap, else a document canvas', () => {
  const log = [];
  globalThis.OffscreenCanvas = class { constructor(w, h) { this.w = w; this.h = h; } getContext() { return { log }; } transferToImageBitmap() { return { bitmap: [this.w, this.h] }; } };
  try {
    const b = raster((ctx, w, h) => ctx.log.push([w, h]), 64, 32);
    assert.deepEqual(b, { bitmap: [64, 32] });
    assert.deepEqual(log, [[64, 32]]);
  } finally { delete globalThis.OffscreenCanvas; }
  const doc = installDocument();
  const c = raster((ctx) => ctx.log.push('drawn'), 8, 4, { document: doc });
  assert.equal(c.tagName, 'CANVAS');
  assert.deepEqual([c.width, c.height], [8, 4]);
  assert.deepEqual(c.getContext('2d').log, ['drawn']);
});

test('host: image, video and raster hang off the context; a video disposes with the host', async () => {
  const doc = installDocument();
  const host = createHost(createCanvas());
  assert.equal(typeof host.image, 'function');
  assert.equal(typeof host.raster, 'function');
  const v = host.video({ src: 'x.mp4', document: doc });
  v.el.dispatch('loadedmetadata', {});
  await v.ready;
  host.dispose();
  assert.equal(v.el.playing, false);
  assert.equal(v.el.src, undefined);
  assert.equal(createElement('div').tagName, 'DIV');
});

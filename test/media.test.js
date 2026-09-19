/**
 * @file media tests — image, video, raster and model against stubbed fetch,
 *       document and media devices.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadImage, createVideo, raster, loadMesh, loadModel, createHost } from '../src/index.js';
import { createCanvas, createElement, installDocument } from './dom.js';
import { document as gltfDocument, glb } from './gltf.fixture.js';

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

const QUAD = 'v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\nvn 0 0 1\nf 1/1/1 2/2/1 3/3/1 4/4/1\n';
const BARE = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n';
// A roof: two triangles meeting along the ridge x = 1, the ridge's two vertices written twice, each slope with its own normal (a faceted file).
const ROOF = 'v 0 0 0\nv 1 0 1\nv 1 1 1\nv 1 1 1\nv 1 0 1\nv 2 0 0\nvn -0.70710678 0 0.70710678\nvn 0.70710678 0 0.70710678\nf 1//1 2//1 3//1\nf 4//2 5//2 6//2\n';
const objFetch = (calls) => async (url, init) => {
  calls.push([url, init]);
  const text = /quad/.test(url) ? QUAD : /roof/.test(url) ? ROOF : BARE;
  return { ok: !/nope/.test(url), status: /nope/.test(url) ? 404 : 200, text: async () => text,
           arrayBuffer: async () => new TextEncoder().encode(text).buffer };
};

test('loadMesh: an OBJ file as one mesh — the arrays shape with its bounds; a bad status, an unknown format throw', async () => {
  const calls = [];
  globalThis.fetch = objFetch(calls);
  try {
    const m = await loadMesh('quad.obj', { fetch: { mode: 'cors' } });
    assert.deepEqual(calls[0], ['quad.obj', { mode: 'cors' }]);
    assert.deepEqual(Object.keys(m).sort(), ['bounds', 'indices', 'normal', 'position', 'texcoord']);
    assert.ok(m.position.data instanceof Float32Array);
    assert.deepEqual([...m.position.data], [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
    assert.ok(m.indices.data instanceof Uint32Array);
    assert.deepEqual([...m.indices.data], [0, 1, 2, 2, 3, 0]);
    assert.deepEqual([...m.normal.data], [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
    assert.deepEqual([...m.texcoord.data], [0, 0, 1, 0, 1, 1, 0, 1]);
    assert.deepEqual(m.bounds, { min: [0, 0, 0], max: [1, 1, 0], center: [0.5, 0.5, 0], diag: Math.SQRT2 });
    await assert.rejects(loadMesh('nope.obj'), /404/);
    await assert.rejects(loadMesh('model.stl'), /unknown format/);
    assert.equal((await loadMesh('blob:1234', { format: 'obj' })).position.data.length, 9);
  } finally { delete globalThis.fetch; }
});

test('loadMesh: normals — the file\'s kept, smooth where missing; smooth and flat always recompute; false computes nothing', async () => {
  globalThis.fetch = objFetch([]);
  const near = (a, b) => a.every((v, i) => Math.abs(v - b[i]) < 1e-6);
  const S = Math.SQRT1_2;
  try {
    const filled = await loadMesh('bare.obj?v=2');
    assert.deepEqual([...filled.normal.data], [0, 0, 1, 0, 0, 1, 0, 0, 1]);        // none in the file: computed
    assert.equal((await loadMesh('bare.obj', { normals: false })).normal, undefined);
    assert.deepEqual([...(await loadMesh('quad.obj', { normals: false })).normal.data].slice(0, 3), [0, 0, 1]);   // the file's, kept

    // the faceted roof: left to itself the file's flat normals are kept; 'smooth' blends them along the ridge
    const roof = await loadMesh('roof.obj');
    assert.ok(near([...roof.normal.data].slice(3, 6), [-S, 0, S]) && near([...roof.normal.data].slice(12, 15), [S, 0, S]));
    const smooth = await loadMesh('roof.obj', { normals: 'smooth' });
    assert.ok(near([...smooth.normal.data].slice(3, 6), [0, 0, 1]) && near([...smooth.normal.data].slice(12, 15), [0, 0, 1]));
    assert.ok(near([...smooth.normal.data].slice(0, 3), [-S, 0, S]));               // off the ridge: its own slope
    assert.equal(smooth.position.data.length, 18);                                   // the mesh itself untouched

    // 'flat' replaces the quad's own normals and gives every triangle its vertices
    const flat = await loadMesh('quad.obj', { normals: 'flat' });
    assert.equal(flat.position.data.length / 3, 6);
    assert.deepEqual([...flat.indices.data], [0, 1, 2, 3, 4, 5]);
    assert.equal(flat.texcoord.data.length, 12);
    assert.deepEqual([...flat.normal.data].slice(0, 3), [0, 0, 1]);
    assert.equal(flat.bounds.diag, Math.SQRT2);
    await assert.rejects(loadMesh('quad.obj', { normals: 'phong' }), /normals is one of/);
  } finally { delete globalThis.fetch; }
});

test('loadMesh: opts.parse reads another format; a file of several parts rejects, naming loadModel', async () => {
  const { json, bin } = gltfDocument();
  json.nodes.push({ name: 'twin', mesh: 0 }); json.scenes[0].nodes.push(3);        // the same primitive under a second node
  globalThis.fetch = async (url) => ({ ok: true, status: 200, arrayBuffer: async () => (/glb$/.test(url) ? glb(json, bin) : Float32Array.of(0, 0, 0, 2, 0, 0, 0, 2, 0).buffer) });
  try {
    const m = await loadMesh('cloud.xyz', { parse: (buffer) => ({
      position: { numComponents: 3, data: new Float32Array(buffer) }, indices: { numComponents: 3, data: Uint32Array.of(0, 1, 2) } }) });
    assert.deepEqual([...m.normal.data], [0, 0, 1, 0, 0, 1, 0, 0, 1]);
    assert.deepEqual(m.bounds.max, [2, 2, 0]);
    await assert.rejects(loadMesh('two.glb'), /2 parts; loadModel/);
  } finally { delete globalThis.fetch; }
});

test('loadModel: an OBJ file is one white part under one identity node', async () => {
  globalThis.fetch = objFetch([]);
  try {
    const model = await loadModel('quad.obj');
    assert.deepEqual(Object.keys(model), ['parts', 'nodes', 'skins', 'clips']);
    const { mesh, ...rest } = model.parts[0];
    assert.deepEqual(rest, { name: '', node: 0, skin: -1, targets: [], color: [1, 1, 1, 1] });
    assert.equal(mesh.bounds.diag, Math.SQRT2);
    assert.deepEqual(model.nodes, { names: [''], parents: Int32Array.of(-1), rest: Float32Array.of(0, 0, 0, 0, 0, 0, 1, 1, 1, 1) });
    assert.deepEqual(model.skins, []); assert.deepEqual(model.clips, []);
  } finally { delete globalThis.fetch; }
});

test('loadModel: a .glb and a .gltf with its buffer arrive in the same shape; flat flattens the morph targets with the mesh', async () => {
  const { json, bin } = gltfDocument();
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    return { ok: true, status: 200, json: async () => json, arrayBuffer: async () => (/\.glb$/.test(url) ? glb(json, bin) : bin) };
  };
  try {
    const a = await loadModel('https://x.test/models/tri.glb');
    json.buffers[0].uri = 'tri.bin';
    const b = await loadModel('https://x.test/models/tri.gltf');
    assert.deepEqual(calls, ['https://x.test/models/tri.glb', 'https://x.test/models/tri.gltf', 'https://x.test/models/tri.bin']);
    assert.deepEqual(a, b);
    assert.deepEqual(Object.keys(a), ['parts', 'nodes', 'skins', 'clips']);
    assert.equal(a.parts[0].skin, 0); assert.equal(a.clips[0].name, 'Slide');
    assert.deepEqual([...a.parts[0].mesh.normal.data], [0, 0, 1, 0, 0, 1, 0, 0, 1]);
    assert.deepEqual(a.parts[0].mesh.bounds.max, [1, 1, 0]);
    const flat = await loadModel('https://x.test/models/tri.glb', { normals: 'flat' });
    assert.deepEqual(Object.keys(flat.parts[0].targets[0]).sort(), ['name', 'position']);
    assert.equal(flat.parts[0].targets[0].position.data.length, flat.parts[0].mesh.position.data.length);
    assert.equal(flat.parts[0].mesh.joints.data.length, 12);
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

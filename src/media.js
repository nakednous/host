/**
 * @file Media sources — images, video and Canvas2D rasters for a bridge's textures, models for its buffers.
 * @module host/media
 * @license AGPL-3.0-only
 *
 * A mesh arrives as arrays for a bridge's buffer upload, its bounds beside
 * them: loadMesh. A model keeps a file's structure — parts, hierarchy, skins,
 * clips: loadModel. Both read OBJ (host/obj) and glTF 2.0 (host/gltf), or
 * another format through a parser the caller passes.
 *
 * What a texture upload reads from: an ImageBitmap fetched from a URL, a
 * hidden <video> element from a file or the user's camera, a bitmap drawn
 * through a 2D context (the text path — glyph strips, billboard tags,
 * anything Canvas2D can typeset). No orientation option anywhere: whether
 * rows flip is the bridge's upload, since it depends on the GPU API's
 * texture space.
 */

'use strict';

import { parseObj } from './obj.js';
import { parseGlb, parseGltf } from './gltf.js';
import { meshNormals, meshBounds, meshGroups, meshFlatten } from '@nakednous/tree';

/**
 * Fetch an image into an ImageBitmap.
 * @param {string} url
 * @param {{ fetch?:object, bitmap?:object }} [opts]
 *        fetch: the fetch init (credentials, mode, …). bitmap: the
 *        createImageBitmap options (premultiplyAlpha, colorSpaceConversion, …).
 * @returns {Promise<ImageBitmap>}
 */
export async function loadImage(url, opts) {
  const o = opts || {};
  const res = await fetch(url, o.fetch);
  if (!res.ok) throw new Error('[host] image: ' + url + ' → ' + res.status);
  const blob = await res.blob();
  return o.bitmap ? createImageBitmap(blob, o.bitmap) : createImageBitmap(blob);
}

const _ONE_NODE = () => ({ names: [''], parents: Int32Array.of(-1), rest: Float32Array.of(0, 0, 0, 0, 0, 0, 1, 1, 1, 1) });
const _part = (mesh) => ({ name: '', node: 0, skin: -1, mesh, targets: [], color: [1, 1, 1, 1] });

// A morph target's deltas expanded through its mesh's indices; a target carries no indices of its own.
function _flatTarget(target, indices) {
  const flat = meshFlatten(target, indices);
  delete flat.indices;
  return flat;
}

// The normals option applied to every part, then each mesh's bounds; parts sharing a mesh share the result.
//   undefined / true  the file's normals; smooth ones where a mesh has none
//   'smooth'          always recomputed, summed per position (tree's meshGroups), so a faceted file smooths
//   'flat'            always recomputed on the flattened mesh (tree's meshFlatten), morph targets flattened with it
//   false             nothing computed
function _finish(model, o) {
  const mode = o.normals === undefined || o.normals === true ? 'fill' : o.normals;
  if (mode !== 'fill' && mode !== 'smooth' && mode !== 'flat' && mode !== false) {
    throw new Error("[host] model: normals is one of 'smooth', 'flat', false, or left out.");
  }
  const done = new Map();
  for (const part of model.parts) {
    const source = part.mesh;
    if (done.has(source)) {
      part.mesh = done.get(source);
      if (mode === 'flat') part.targets = part.targets.map(t => _flatTarget(t, source.indices.data));
      continue;
    }
    let mesh = source;
    const bounds = meshBounds({ min: [0, 0, 0], max: [0, 0, 0], center: [0, 0, 0], diag: 0 }, mesh.position.data);
    if (mode === 'flat') {
      mesh = meshFlatten(source);
      const p = mesh.position.data;
      mesh.normal = { numComponents: 3, data: meshNormals(new Float32Array(p.length), p, mesh.indices.data) };
      part.targets = part.targets.map(t => _flatTarget(t, source.indices.data));
    } else if (mode === 'smooth' || (mode === 'fill' && !mesh.normal)) {
      const p = mesh.position.data;
      const groups = meshGroups(new Int32Array(p.length / 3), p, 1e-6 * bounds.diag);
      mesh.normal = { numComponents: 3, data: meshNormals(new Float32Array(p.length), p, mesh.indices.data, { groups }) };
    }
    mesh.bounds = bounds;
    done.set(source, mesh);
    part.mesh = mesh;
  }
  return model;
}

// Fetch and parse into the model shape, before the normals and bounds.
async function _load(url, o, what) {
  const get = async (at, init) => {
    const res = await fetch(at, init);
    if (!res.ok) throw new Error('[host] ' + what + ': ' + at + ' → ' + res.status);
    return res;
  };
  if (typeof o.parse === 'function') {
    const mesh = await o.parse(await (await get(url, o.fetch)).arrayBuffer());
    return { parts: [_part(mesh)], nodes: _ONE_NODE(), skins: [], clips: [] };
  }
  const format = (o.format || (/\.(\w+)(?:[?#].*)?$/.exec(url) || [])[1] || '').toLowerCase();
  if (format !== 'obj' && format !== 'glb' && format !== 'gltf') {
    throw new Error('[host] ' + what + ': ' + url + ' → unknown format; opts.format is one of obj, glb, gltf, or pass opts.parse.');
  }
  const res = await get(url, o.fetch);
  if (format === 'obj') return { parts: [_part(parseObj(await res.text()))], nodes: _ONE_NODE(), skins: [], clips: [] };
  if (format === 'glb') {
    const { json, bin } = parseGlb(await res.arrayBuffer());
    return parseGltf(json, [bin]);
  }
  const json = await res.json();
  const base = typeof location !== 'undefined' ? new URL(url, location.href) : url;
  const resolve = (uri) => {
    if (/^data:/.test(uri)) return uri;
    try { return String(new URL(uri, base)); } catch (e) { return url.replace(/[^/]*$/, '') + uri; }
  };
  const buffers = await Promise.all((json.buffers || []).map(async b => (await get(resolve(b.uri), o.fetch)).arrayBuffer()));
  return parseGltf(json, buffers);
}

/**
 * Fetch a mesh: one object in the arrays shape — position, indices, and
 * normal, tangent, texcoord, color, joints, weights when the file carries them
 * — with `bounds`, its extent `{ min, max, center, diag }`, beside them. A
 * bridge's buffer upload takes it as it is; `size / mesh.bounds.diag` is the
 * scale that fits any file to `size`.
 *
 * Formats: OBJ (host/obj), and glTF 2.0 as `.glb` or `.gltf` (host/gltf) when
 * the file holds one part. A file of several parts rejects, naming loadModel:
 * a mesh is never silently the first of many. `opts.parse` reads any other
 * format: it receives the fetched ArrayBuffer and returns the arrays shape.
 *
 * Normals. Left out, the option keeps the file's normals and gives smooth
 * ones to a mesh that has none. 'smooth' always recomputes them, summed per
 * position, so a file that arrives faceted or cut along a texture seam
 * smooths too. 'flat' always recomputes them on the flattened mesh — every
 * triangle owning its vertices, so the vertex count grows and the indices
 * count up. false computes nothing. The procedure, its limits (no crease
 * angle; grouping by grid cell, at 1e-6 of the bounds' diagonal) and its
 * sources are tree/mesh's. glTF viewers compute flat normals for a file
 * without any; here that is `normals: 'flat'`.
 *
 * @param {string} url
 * @param {{ fetch?:object, format?:string, parse?:function(ArrayBuffer):object,
 *           normals?:'smooth'|'flat'|false }} [opts]  fetch: the fetch init. format: 'obj' |
 *        'glb' | 'gltf' when the URL's extension does not say. parse: a parser for another
 *        format. normals: as above.
 * @returns {Promise<object>} The mesh.
 */
export async function loadMesh(url, opts) {
  const o = opts || {};
  const model = await _load(url, o, 'mesh');
  if (model.parts.length !== 1) {
    throw new Error('[host] mesh: ' + url + ' → ' + model.parts.length + ' parts; loadModel keeps them apart.');
  }
  return _finish(model, o).parts[0].mesh;
}

/**
 * Fetch a model with its structure — what a rig, morph targets or animation
 * need; a single mesh is loadMesh's:
 *
 *   { parts: [{ name, node, skin, mesh, targets, color }], nodes, skins, clips }
 *
 * A part is one triangle primitive under one node: `mesh` as loadMesh returns
 * it (the arrays shape with `bounds`, in the part's own space), `targets` its
 * morph targets as delta arrays, `color` its base colour [r, g, b, a], `node`
 * the node it hangs from and `skin` its skin's index or −1. `nodes` is the
 * hierarchy `{ names, parents, rest }`, parents first, `rest` a pose of ten
 * numbers per node; `skins` are `{ name, joints, inverseBind }` and `clips`
 * `{ name, duration, channels }` — what tree's clipSample, poseWorld and
 * jointPalette take. A rigid part draws under its node's world matrix, a
 * skinned one under its skin's joint palette. An OBJ file is one white part
 * under one identity node.
 *
 * The options are loadMesh's; `normals` applies to every part, 'flat'
 * flattening each part's morph targets with its mesh.
 *
 * @param {string} url
 * @param {{ fetch?:object, format?:string, parse?:function(ArrayBuffer):object,
 *           normals?:'smooth'|'flat'|false }} [opts]
 * @returns {Promise<{ parts:object[], nodes:{ names:string[], parents:Int32Array, rest:Float32Array },
 *                     skins:object[], clips:object[] }>}
 */
export async function loadModel(url, opts) {
  const o = opts || {};
  return _finish(await _load(url, o, 'model'), o);
}

/**
 * A hidden, muted, inline <video> element from a file or the user's camera.
 * `ready` resolves once metadata arrived (width / height known); a camera
 * denial rejects it. Inside an iframe a camera source needs allow="camera"
 * on the frame.
 *
 * @param {{ src?:string, camera?:boolean|object, loop?:boolean, autoplay?:boolean,
 *           document?:object, media?:object }} opts
 *        src: a media URL. camera: true or getUserMedia video constraints
 *        ({ facingMode, width, height }). loop (default true for src).
 *        autoplay (default true): start() once ready. document / media: the
 *        Document and MediaDevices to use (defaults: the globals) — the seam
 *        a test fills.
 * @returns {{ el:HTMLVideoElement, ready:Promise<object>, width:number, height:number,
 *             start():Promise<void>, stop():object, dispose():object }}
 */
export function createVideo(opts) {
  const o = opts || {};
  const doc = o.document || (typeof document !== 'undefined' ? document : null);
  if (!doc) { console.error('[host] video: no document.'); return null; }
  const el = doc.createElement('video');
  el.muted = true;
  el.playsInline = true;
  el.setAttribute('playsinline', '');
  el.setAttribute('muted', '');
  el.style.display = 'none';
  let stream = null;

  const v = {
    /** The <video> element — the bridge's upload source, refreshed each frame. */
    el,
    /** Intrinsic size, known once `ready` resolved. */
    width: 0, height: 0,
    /** Resolves with this source once metadata arrived; rejects on a camera denial or a load error. */
    ready: null,
    /** Play; resolves when playback began. */
    start() { const p = el.play(); return p && typeof p.catch === 'function' ? p.catch((e) => console.error('[host] video: play() failed: ' + e.message + '.')) : Promise.resolve(); },
    /** Pause. Chainable. */
    stop() { el.pause(); return v; },
    /** Stop, release the camera tracks, detach the element. */
    dispose() {
      el.pause();
      if (stream) { for (const t of stream.getTracks()) t.stop(); stream = null; }
      el.removeAttribute('src');
      el.srcObject = null;
      if (typeof el.remove === 'function') el.remove();
      return v;
    },
  };

  v.ready = new Promise((resolve, reject) => {
    const unlisten = () => { el.removeEventListener('loadedmetadata', onMeta); el.removeEventListener('error', onErr); };
    const fail = (msg) => { unlisten(); reject(new Error('[host] video: ' + msg)); };
    const onMeta = () => {
      v.width = el.videoWidth || 0; v.height = el.videoHeight || 0;
      unlisten();
      if (o.autoplay !== false) v.start();
      resolve(v);
    };
    const onErr = () => fail('failed to load ' + (o.src || 'the source') + '.');
    el.addEventListener('loadedmetadata', onMeta);
    el.addEventListener('error', onErr);
    if (o.camera) {
      const media = o.media || (typeof navigator !== 'undefined' && navigator.mediaDevices) || null;
      if (!media || typeof media.getUserMedia !== 'function') { fail('getUserMedia is unavailable here.'); return; }
      media.getUserMedia({ video: o.camera === true ? true : o.camera, audio: false })
        .then((s) => { stream = s; el.srcObject = s; })
        .catch((e) => fail('camera denied: ' + e.message + '.'));
    } else if (o.src) {
      el.loop = o.loop !== false;
      el.src = o.src;
    } else {
      fail('needs { src } or { camera }.');
    }
  });
  v.ready.catch(() => {});   // an unobserved rejection is the caller's to observe, not a crash
  return v;
}

/**
 * Draw through a 2D context and hand the result back as a texture source: an
 * ImageBitmap where OffscreenCanvas exists, else the canvas element itself.
 *
 * @param {function(CanvasRenderingContext2D, number, number):void} draw
 * @param {number} w  Pixel width.
 * @param {number} h  Pixel height.
 * @param {{ document?:object }} [opts]  The Document for the fallback canvas.
 * @returns {ImageBitmap|HTMLCanvasElement|null}
 */
export function raster(draw, w, h, opts) {
  const o = opts || {};
  if (typeof OffscreenCanvas !== 'undefined') {
    const c = new OffscreenCanvas(w, h);
    draw(c.getContext('2d'), w, h);
    return c.transferToImageBitmap();
  }
  const doc = o.document || (typeof document !== 'undefined' ? document : null);
  if (!doc) { console.error('[host] raster: no OffscreenCanvas and no document.'); return null; }
  const c = doc.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  return c;
}

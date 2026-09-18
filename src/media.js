/**
 * @file Media sources — images, video and Canvas2D rasters for a bridge's textures, models for its buffers.
 * @module host/media
 * @license AGPL-3.0-only
 *
 * A model arrives as arrays for a bridge's buffer upload, with its hierarchy,
 * skins and clips beside them: loadModel fetches an OBJ file (host/obj) or a
 * glTF 2.0 one (host/gltf) into one shape.
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
import { meshNormals, meshBounds } from '@nakednous/tree';

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

// Normals where a mesh lacks them, and every mesh's bounds; meshes sharing arrays share both.
function _finish(model, o) {
  const bounds = new Map();
  for (const mesh of model.meshes) {
    const a = mesh.arrays, p = a.position.data;
    if (o.normals !== false && !a.normal) {
      a.normal = { numComponents: 3, data: meshNormals(new Float32Array(p.length), p, a.indices.data) };
    }
    if (!bounds.has(a)) bounds.set(a, meshBounds({ min: [0, 0, 0], max: [0, 0, 0], center: [0, 0, 0], diag: 0 }, p));
    mesh.bounds = bounds.get(a);
  }
  return model;
}

/**
 * Fetch a model — OBJ, or glTF 2.0 as `.glb` or `.gltf` with its buffers —
 * into one shape whatever the format:
 *
 *   { meshes: [{ name, node, skin, arrays, targets, color, bounds }], nodes, skins, clips }
 *
 * `arrays` is the arrays shape — position, indices, and normal, tangent,
 * texcoord, joints, weights when the file carries them — which twgl's
 * createBufferInfoFromArrays takes as it is. A mesh whose file carries no
 * normals gets smooth ones (tree's meshNormals), and `bounds` is its extent in
 * its own space, `{ min, max, center, diag }` (tree's meshBounds). `targets` are a mesh's morph
 * targets as delta arrays, `color` its base colour [r,g,b,a], `node` the node
 * it hangs from and `skin` its skin's index or −1. `nodes` is the hierarchy
 * `{ names, parents, rest }`, parents first, `rest` a pose of ten numbers per
 * node; `skins` are `{ name, joints, inverseBind }` and `clips` are `{ name,
 * duration, channels }` — what tree's clipSample, poseWorld and jointPalette
 * take. An OBJ file is one white mesh under one identity node, with no
 * targets, skins or clips (host/obj); glTF is read by host/gltf.
 *
 * @param {string} url
 * @param {{ fetch?:object, format?:string, normals?:boolean }} [opts]  fetch: the
 *        fetch init (credentials, mode, …). format: 'obj' | 'glb' | 'gltf' when the
 *        URL's extension does not say. normals (default true): compute the normals
 *        a mesh lacks.
 * @returns {Promise<{ meshes:object[], nodes:{ names:string[], parents:Int32Array, rest:Float32Array },
 *                     skins:object[], clips:object[] }>}
 */
export async function loadModel(url, opts) {
  const o = opts || {};
  const format = (o.format || (/\.(\w+)(?:[?#].*)?$/.exec(url) || [])[1] || '').toLowerCase();
  if (format !== 'obj' && format !== 'glb' && format !== 'gltf') {
    throw new Error('[host] model: ' + url + ' → unknown format; opts.format is one of obj, glb, gltf.');
  }
  const get = async (at) => {
    const res = await fetch(at, o.fetch);
    if (!res.ok) throw new Error('[host] model: ' + at + ' → ' + res.status);
    return res;
  };
  const res = await get(url);
  if (format === 'obj') {
    return _finish({
      meshes: [{ name: '', node: 0, skin: -1, arrays: parseObj(await res.text()), targets: [], color: [1, 1, 1, 1] }],
      nodes: { names: [''], parents: Int32Array.of(-1), rest: Float32Array.of(0, 0, 0, 0, 0, 0, 1, 1, 1, 1) },
      skins: [],
      clips: [],
    }, o);
  }
  if (format === 'glb') {
    const { json, bin } = parseGlb(await res.arrayBuffer());
    return _finish(parseGltf(json, [bin]), o);
  }
  const json = await res.json();
  const base = typeof location !== 'undefined' ? new URL(url, location.href) : url;
  const resolve = (uri) => {
    if (/^data:/.test(uri)) return uri;
    try { return String(new URL(uri, base)); } catch (e) { return url.replace(/[^/]*$/, '') + uri; }
  };
  const buffers = await Promise.all((json.buffers || []).map(async b => (await get(resolve(b.uri))).arrayBuffer()));
  return _finish(parseGltf(json, buffers), o);
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

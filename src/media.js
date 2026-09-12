/**
 * @file Media sources — images, video and Canvas2D rasters for a bridge's textures.
 * @module host/media
 * @license AGPL-3.0-only
 *
 * What a texture upload reads from: an ImageBitmap fetched from a URL, a
 * hidden <video> element from a file or the user's camera, a bitmap drawn
 * through a 2D context (the text path — glyph strips, billboard tags,
 * anything Canvas2D can typeset). No orientation option anywhere: whether
 * rows flip is the bridge's upload, since it depends on the GPU API's
 * texture space.
 */

'use strict';

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

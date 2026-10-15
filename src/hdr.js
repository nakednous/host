/**
 * @file HDR — Radiance (.hdr) RGBE bytes decoded to the pixels a bridge uploads.
 * @module host/hdr
 * @license AGPL-3.0-only
 *
 * A floating-point texture needs radiance, and no image decoder in the browser
 * gives it any: `loadImage` hands back an `ImageBitmap` of 8-bit codes, clamped
 * at 1.0, so a tone-mapping pass would have nothing left to compress. Radiance's
 * RGBE is the one high-range format a few dozen lines decode.
 *
 * ```
 * const hdr = decodeRGBE(bytes)          // { data, width, height } — radiance
 * const tex = texture(gl, hdr)          // the bridge's upload, RGBA32F
 * ```

 *
 * A pixel is three 8-bit mantissas and a shared exponent — `v · 2^(e − 136)` —
 * the format of Greg Ward's RADIANCE (Ward, *Real Pixels*, Graphics Gems II,
 * 1991). The reader follows `rgbe.c`'s structure and three.js's `HDRLoader`
 * (itself adapted from Bruce Walter's code), with the exact scale above rather
 * than that implementation's `v · 2^(e − 128) / 255`, and no `+ 0.5` — the
 * offset `rgbe.c`'s floating read carries, which lifts every pixel by half a
 * mantissa step (0.04 % of the mean on a Poly Haven HDRI) and which no file
 * declares. Rows keep the order the file states and are never flipped here: GL's
 * bottom-up space is the upload's concern (see texture.js).
 *
 * `loadHDR` — the fetch and the GL row order — is `webgl.tree`'s, and it
 * re-exports these two; a reader with no bridge to feed uses them directly. Rows
 * come back in the file's own order unless `rowOrder: 'BOTTOM_UP'` asks for GL's.
 * The decoder is trusted by round-tripping through the encoder and by agreeing
 * with three.js's `HDRLoader` and ImageMagick on real Radiance files.
 */

'use strict';

// Radiance's own threshold: at or below it a float holds no light, so a pixel
// that low is written as four zero bytes and read back as black.
const _MIN_RADIANCE = 1e-32;
// 16 Mpixel of RGBA32F is 256 MB of output: past this the tab is gone before
// anything on screen says why, so the refusal comes from here.
const _DEFAULT_MAX_PIXELS = 16 * 1024 * 1024;

const _fv = new DataView(new ArrayBuffer(4));

// The shared exponent as a float32: the bit pattern of 2^(e − 136) — mantissa
// zero, biased exponent — read straight out of the view, no Math.pow per pixel.
// 256 entries, made once at load, indexed by the exponent byte a pixel carries.
const _SCALES = new Float32Array(256);
for (let e = 0; e < 256; e++) {
  _fv.setUint32(0, e < 10 ? 0 : (e - 9) << 23, true);   // e < 10 underflows to zero
  _SCALES[e] = _fv.getFloat32(0, true);
}

/**
 * Encode three linear radiance samples and a shared exponent to RGBE bytes.
 * The inverse of a pixel in `decodeRGBE`: the largest component becomes a byte
 * level between 128 and 255 — `level = round(v / 2^(e − 136))` with e the
 * exponent that carries it — so all eight bits are spent and the components
 * keep their ratio. The level is an integer: 0.0 comes back exactly, and
 * everything else to within half a level, the 1/512 an 8-bit mantissa costs at
 * worst.
 * @param {number} r  Red, ≥ 0.
 * @param {number} g  Green.
 * @param {number} b  Blue.
 * @param {Uint8Array} [out]  Four bytes to write; a new one when absent.
 * @returns {Uint8Array} out
 */
export function encodeRGBE(r, g, b, out) {
  const o = out || new Uint8Array(4);
  const max = Math.max(r, g, b);
  if (!(max >= _MIN_RADIANCE)) { o[0] = o[1] = o[2] = o[3] = 0; return o; }
  // The exponent whose scale carries max as a byte level of 128 to 255 — the
  // finest step the format has for this magnitude. The float32's own exponent
  // sets the base, one scale step below the level 255 needs, and the search
  // steps up until max fits a byte. `_SCALES` is the decoder's own table, so
  // the two cannot drift apart.
  _fv.setFloat32(0, max, true);
  let e = Math.min(255, Math.max(1, ((_fv.getUint32(0, true) >>> 23) & 0xff) - 127 + 128));
  while (e < 255 && max / _SCALES[e] > 255) e++;
  o[0] = Math.min(255, Math.round(r / _SCALES[e]));
  o[1] = Math.min(255, Math.round(g / _SCALES[e]));
  o[2] = Math.min(255, Math.round(b / _SCALES[e]));
  o[3] = e;
  return o;
}

const _digits = (s) => {
  const m = /(\d+)/.exec(s);
  return m ? +m[1] : 0;
};

// The header: a magic line, keyed lines and comments, a blank line, then the
// resolution string (`-Y 512 +X 1024`). Anything before the resolution is
// skipped — XMP and other writers put blocks there — so the walk stops at the
// first line that states a dimension.
function _headerAt(data) {
  let pos = 0, height = 0, width = 0, flipRows = false;
  const n = data.length;
  while (pos < n) {
    let end = pos;
    while (end < n && data[end] !== 10) end++;
    const line = String.fromCharCode.apply(null, data.subarray(pos, Math.min(end, pos + 400)));
    pos = end + 1;
    if (/^#\?/.test(line)) continue;
    const res = /^\s*([-+])([XY])\s+(\d+)\s+([-+])([XY])\s+(\d+)\s*$/.exec(line);
    if (res) {
      const first = res[2].toUpperCase(), second = res[5].toUpperCase();
      if (first === 'Y' && second === 'X') {
        height = +res[3]; width = +res[6];
        flipRows = res[1] === '+';           // +Y: row 0 at the bottom
      } else if (first === 'X' && second === 'Y') {
        width = +res[3]; height = +res[6];
        flipRows = res[1] === '+';           // +X: column 0 on the right
      } else {
        throw new Error('[host] hdr: the resolution names ' + first + ' then ' + second + '; -Y h +X w expected.');
      }
      return { width, height, flipRows, pos };
    }
    if (line === '') continue;                    // a writer may separate the keys from the resolution
  }
  throw new Error('[host] hdr: no resolution line — the file is not a Radiance image.');
}

// One scanline of RGBE bytes into `row`: either the new-style RLE (4 planes,
// runs of 128 bytes or fewer) or the flat tuples an old writer leaves.
function _scanline(data, pos, row, w, off, rowBytes) {
  const end = data.length;
  if (w >= 8 && w < 32768 && pos + 3 < end && data[pos] === 2 && data[pos + 1] === 2 && (data[pos + 2] & 0x80) === 0) {
    const scanline = (data[pos + 2] << 8) | data[pos + 3];
    if (scanline !== w) throw new Error('[host] hdr: scanline width ' + scanline + ', image width ' + w + '.');
    pos += 4;
    for (let c = 0; c < 4; c++) {
      let x = 0;
      while (x < w) {
        if (pos >= end) throw new Error('[host] hdr: the file ends inside scanline ' + (off / rowBytes) + '.');
        const count = data[pos++];
        if (count > 128) {                       // a run of one byte
          if (pos >= end) throw new Error('[host] hdr: the file ends inside a run.');
          const v = data[pos++];
          for (let i = 0; i < count - 128; i++) row[(x + i) * 4 + c] = v;
          x += count - 128;
        } else {                                 // a literal run
          if (count === 0 || pos + count > end) throw new Error('[host] hdr: bad run length in scanline ' + (off / rowBytes) + '.');
          for (let i = 0; i < count; i++) row[(x + i) * 4 + c] = data[pos + i];
          pos += count;
          x += count;
        }
        if (x > w) throw new Error('[host] hdr: a run overruns scanline ' + (off / rowBytes) + '.');
      }
    }
    return pos;
  }
  // flat: 4 bytes per pixel, in file order (the scanline is one plane-less array)
  if (pos + w * 4 > end) throw new Error('[host] hdr: the file ends inside scanline ' + (off / rowBytes) + '.');
  for (let i = 0; i < w * 4; i++) row[i] = data[pos + i];
  return pos + w * 4;
}

/**
 * Decode Radiance RGBE bytes into the pixel source `texture` takes.
 * @details Every pixel becomes four float channels — R, G, B and 1 — and the
 * rows come back in the order the file states, top-down for the `-Y` every
 * writer emits. `loadHDR` is the one that turns them over for GL; a caller
 * here that wants the same passes `rowOrder: 'BOTTOM_UP'`. The decoder holds no
 * state, allocates its output once, and needs no DOM, so it runs under
 * node:test as well as in the browser.
 * @param {ArrayBuffer|Uint8Array} bytes  The whole file.
 * @param {{ rowOrder?:string, maxPixels?:number }} [opts]
 *        rowOrder: `FILE` (default) or `BOTTOM_UP` — the latter for GL's
 *        texture space, row 0 at v = 0.
 *        maxPixels: refuse past this many pixels (default 16 MPixel).
 * @returns {{ data:Float32Array, width:number, height:number }} Radiance in
 *          linear light: what `texture` uploads as RGBA32F, and the range a
 *          tone operator compresses.
 */
export function decodeRGBE(bytes, opts) {
  const o = opts || {};
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const head = _headerAt(data);
  const { width: w, height: h } = head;
  if (!(w > 0) || !(h > 0)) throw new Error('[host] hdr: the resolution states ' + w + ' × ' + h + '.');
  const max = o.maxPixels || _DEFAULT_MAX_PIXELS;
  if (w * h > max) {
    throw new Error('[host] hdr: ' + w + ' × ' + h + ' is past maxPixels (' + max +
      '); pass a bigger one, or decode at a lower resolution.');
  }
  const flip = o.rowOrder === 'BOTTOM_UP';
  const out = new Float32Array(w * h * 4);
  const row = new Uint8Array(w * 4);
  let pos = head.pos;
  for (let y = 0; y < h; y++) {
    pos = _scanline(data, pos, row, w, y * w * 4, w * 4);
    const at = (flip ? h - 1 - y : y) * w * 4;
    for (let x = 0; x < w; x++) {
      const p = x * 4, s = _SCALES[row[p + 3]], d = at + p;
      out[d] = row[p] * s;
      out[d + 1] = row[p + 1] * s;
      out[d + 2] = row[p + 2] * s;
      out[d + 3] = 1;
    }
  }
  return { data: out, width: w, height: h };
}

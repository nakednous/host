/**
 * @file hdr.test.js — the Radiance decoder: fixtures, the two scanline forms,
 * the row order a file states, refusal, and a round trip through an encoder
 * that shares no code with it, over a file this decoder did not write.

 * The bridge's `loadHDR` — the fetch, and GL's row order — is tested in
 * webgl.tree, where it lives.
 * @license AGPL-3.0-only
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { decodeRGBE, encodeRGBE } from '../src/hdr.js';

// ── the fixtures: a Radiance file is a header, a resolution line, and rows ──

// A Radiance header: the magic line, the format key, a blank line, the
// resolution string — and no blank line after it, since the first scanline
// starts at the next byte.
const HEAD = (res) => ['#?RADIANCE', 'FORMAT=32-bit_rle_rgbe', '', res].map((l) => l + '\n').join('');
const text = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));

// A whole file: header + resolution + the scanline bytes, as given.
function file(res, bytes) {
  const head = text(HEAD(res));
  const out = new Uint8Array(head.length + bytes.length);
  out.set(head); out.set(bytes, head.length);
  return out;
}

// One flat scanline: four bytes per pixel, no runs.
function flat(pixels) {
  const out = new Uint8Array(pixels.length * 4);
  pixels.forEach((p, i) => out.set(p, i * 4));
  return out;
}

// One new-style RLE scanline: the 4-byte marker, then four planes. `planes` is
// one token array per channel — a number is a literal byte, [-n, v] a run.
function rle(width, planes) {
  const out = [2, 2, width >> 8, width & 0xff];
  for (const plane of planes) {
    let run = [];
    const flush = () => {
      for (let i = 0; i < run.length; i += 128) {
        const chunk = run.slice(i, i + 128);
        out.push(chunk.length, ...chunk);
      }
      run = [];
    };
    for (const token of plane) {
      if (Array.isArray(token)) {
        flush();
        let [n, v] = token;
        while (n > 0) { const take = Math.min(n, 127); out.push(128 + take, v); n -= take; }
      } else run.push(token);
    }
    flush();
  }
  return Uint8Array.from(out);
}

const planeOf = (pixels, c) => pixels.map((p) => p[c]);

// One mantissa level at an exponent byte: the quantization step the format has.
const _STEP = (e) => (e < 10 ? 0 : 2 ** (e - 136));

// ── header and resolution ──────────────────────────────────────────────────

test('hdr: a flat file decodes a byte level at its exponent, and zero is zero', () => {
  // the byte is an integer level: (128, 128, 128, 136) is 128 · 2^0 = 128
  const bytes = file('-Y 1 +X 2', flat([[0, 0, 0, 0], [128, 128, 128, 136]]));
  const hdr = decodeRGBE(bytes);
  assert.equal(hdr.width, 2);
  assert.equal(hdr.height, 1);
  assert.equal(hdr.data.length, 8);
  assert.deepEqual([...hdr.data.slice(0, 3)], [0, 0, 0]);
  assert.deepEqual([...hdr.data.slice(4, 7)], [128, 128, 128]);
  assert.equal(hdr.data[7], 1, 'alpha is 1 — radiance is not premultiplied');
});

test('hdr: the scale is 2^(e − 136), one per exponent byte', () => {
  // e = 137 → 2^1: levels 64 · 2 = 128, 32 · 2 = 64, 0 · 2 = 0
  const hdr = decodeRGBE(file('-Y 1 +X 1', flat([[64, 32, 0, 137]])));
  assert.deepEqual([...hdr.data], [128, 64, 0, 1]);
  // the same levels a stop down are half the radiance
  const dark = decodeRGBE(file('-Y 1 +X 1', flat([[64, 32, 0, 136]])));
  assert.deepEqual([...dark.data], [64, 32, 0, 1]);
});

test('hdr: e = 0 is below the format\'s range and reads black; a zero level is zero', () => {
  // 2^(0 − 136) underflows to zero in float32, so the levels are lost, not invented
  const hdr = decodeRGBE(file('-Y 1 +X 2', flat([[255, 255, 255, 0], [0, 0, 0, 200]])));
  assert.deepEqual([...hdr.data.slice(0, 3)], [0, 0, 0]);
  assert.deepEqual([...hdr.data.slice(4, 7)], [0, 0, 0], 'levels of zero stay zero at any exponent');
});

test('hdr: keyed lines, comments and a block before the resolution are skipped', () => {
  const head = text('#?RADIANCE\n# a comment\nEXPOSURE=1.000\nGAMMA=1.0\n<x:xmpmeta>junk</x:xmpmeta>\n\n-Y 1 +X 1\n');
  const bytes = new Uint8Array(head.length + 4);
  bytes.set(head); bytes.set([200, 200, 200, 136], head.length);
  const hdr = decodeRGBE(bytes);
  assert.equal(hdr.width, 1);
  assert.equal(hdr.data[0], 200);
});

test('hdr: a file without a resolution line is refused', () => {
  assert.throws(() => decodeRGBE(text('#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n')), /resolution/);
  assert.throws(() => decodeRGBE(text('not a radiance file at all\n')), /resolution/);
});

// ── scanlines ──────────────────────────────────────────────────────────────

test('hdr: the RLE form decodes a literal run, a repeat, and a repeat past 127', () => {
  const w = 8;
  // three pixels literal, three of one value (a single encoded run), two more
  const pixels = [[1, 10, 20, 136], [2, 11, 21, 136], [3, 12, 22, 136],
                  [4, 13, 23, 136], [4, 13, 23, 136], [4, 13, 23, 136], [7, 14, 23, 136], [8, 15, 23, 136]];
  const planes = [0, 1, 2, 3].map((c) => {
    const v = planeOf(pixels, c);
    // bytes 0..2 literal, 3..5 one run of three, 6..7 literal
    return [v[0], v[1], v[2], [3, v[3]], v[6], v[7]];
  });
  const hdr = decodeRGBE(file(`-Y 1 +X ${w}`, rle(w, planes)));
  assert.equal(hdr.width, w);
  for (let x = 0; x < w; x++) {
    const s = 2 ** (pixels[x][3] - 136);
    for (let c = 0; c < 3; c++) {
      const want = pixels[x][c] * s;
      assert.equal(hdr.data[x * 4 + c], want, `pixel ${x} channel ${c}`);
    }
  }
});

test('hdr: a repeat longer than 127 splits into runs, and the planes stay in step', () => {
  const w = 200;
  const v = [90, 40, 200, 130];
  // one run of 200 in every plane: the decoder must accept the split
  const planes = [0, 1, 2, 3].map((c) => [[w, v[c]]]);
  const hdr = decodeRGBE(file(`-Y 1 +X ${w}`, rle(w, planes)));
  assert.equal(hdr.width, w);
  const s = 2 ** (v[3] - 136);
  for (let x = 0; x < w; x++) {
    for (let c = 0; c < 3; c++) {
      assert.equal(hdr.data[x * 4 + c], v[c] * s, `pixel ${x} channel ${c}`);
    }
  }
});

test('hdr: a scanline whose header states another width is refused', () => {
  const bad = rle(8, [0, 1, 2, 3].map((c) => planeOf([[1, 1, 1, 128], [2, 2, 2, 128], [3, 3, 3, 128], [4, 4, 4, 128],
    [5, 5, 5, 128], [6, 6, 6, 128], [7, 7, 7, 128], [8, 8, 8, 128]], c)));
  bad[2] = 0; bad[3] = 7;                          // the marker says 7, the image says 8
  assert.throws(() => decodeRGBE(file('-Y 1 +X 8', bad)), /scanline width/);
});

test('hdr: a width below 8 is read flat, as the format states', () => {
  // a leading 2 2 0 4 would be a marker at w ≥ 8; at w = 4 it is data, and the
  // four pixels are their own bytes
  const bytes = file('-Y 1 +X 4', flat([[2, 2, 0, 131], [1, 2, 3, 131], [4, 3, 2, 131], [0, 0, 0, 0]]));
  const hdr = decodeRGBE(bytes);
  assert.equal(hdr.width, 4);
  const s041 = 2 ** (131 - 136);
  assert.deepEqual([...hdr.data.slice(0, 4)], [2 * s041, 2 * s041, 0, 1]);
  assert.deepEqual([...hdr.data.slice(4, 8)], [1 * s041, 2 * s041, 3 * s041, 1]);
  assert.deepEqual([...hdr.data.slice(12)], [0, 0, 0, 1]);
});

test('hdr: a truncated file is refused, naming the row', () => {
  const bytes = file('-Y 2 +X 8', flat(Array.from({ length: 8 }, () => [1, 2, 3, 128])));
  assert.throws(() => decodeRGBE(bytes.subarray(0, bytes.length - 10)), /ends inside/);
});

// ── rows, size, refusal ────────────────────────────────────────────────────

test('hdr: rows are file order by default, and BOTTOM_UP reverses them on request', () => {
  const bytes = file('-Y 2 +X 1', flat([[10, 10, 10, 136], [20, 20, 20, 136]]));
  const plain = decodeRGBE(bytes);
  assert.ok(plain.data[0] < plain.data[4], 'row 0 is the file\'s first row');
  const flipped = decodeRGBE(bytes, { rowOrder: 'BOTTOM_UP' });
  assert.ok(Math.abs(flipped.data[0] - plain.data[4]) < 1e-9, 'row 0 is the file\'s last row');
  assert.ok(Math.abs(flipped.data[4] - plain.data[0]) < 1e-9);
});

test('hdr: +Y states the file\'s rows bottom-up, and is honoured', () => {
  const a = decodeRGBE(file('-Y 2 +X 1', flat([[20, 20, 20, 136], [30, 30, 30, 136]])));
  const b = decodeRGBE(file('+Y 2 +X 1', flat([[20, 20, 20, 136], [30, 30, 30, 136]])));
  assert.deepEqual([...a.data], [...b.data], 'the same rows, stated from opposite ends');
});

test('hdr: maxPixels refuses before allocating, and accepts where raised', () => {
  const bytes = file('-Y 4 +X 8', flat(Array.from({ length: 32 }, () => [1, 2, 3, 128])));
  assert.throws(() => decodeRGBE(bytes, { maxPixels: 16 }), /maxPixels/);
  assert.equal(decodeRGBE(bytes, { maxPixels: 32 }).data.length, 128);
});

// ── the encoder, and the round trip that trusts the decoder ────────────────

test('hdr: encodeRGBE writes a byte level and the exponent that carries it', () => {
  // The level is the byte: 1.0 sits at level 128 of e = 129, one scale step
  // below the level 255 that 255.0 needs.
  assert.deepEqual([...encodeRGBE(1, 1, 1)], [128, 128, 128, 129]);
  assert.deepEqual([...encodeRGBE(2, 2, 2)], [128, 128, 128, 130]);
  assert.deepEqual([...encodeRGBE(255, 255, 255)], [255, 255, 255, 136]);
  assert.deepEqual([...encodeRGBE(0, 0, 0)], [0, 0, 0, 0]);
  // the largest component takes the byte range, and the others keep their ratio
  const rgb = encodeRGBE(4, 1, 0);
  assert.equal(rgb[0], 128);
  assert.equal(rgb[1], 32);
});

test('hdr: what the encoder writes, the decoder reads back — to one mantissa step', () => {
  const values = [];
  let v = 1e-4;
  while (v < 1e6) { values.push(v, v * 1.7, v * 3.3); v *= 3.7; }
  for (const value of values) {
    const rgba = encodeRGBE(value, value, value);
    const hdr = decodeRGBE(file('-Y 1 +X 1', Uint8Array.from(rgba)));
    assert.equal(hdr.data[3], 1);
    const got = hdr.data[0];
    const step = _STEP(rgba[3]);                            // one mantissa level
    assert.ok(Math.abs(got - value) <= step + 1e-30, `${value} → ${got}, past a step of ${step}`);
  }
});

test('hdr: a file this decoder did not write decodes to its own radiance', () => {
  const bytes = new Uint8Array(readFileSync(hdrFile()));
  const hdr = decodeRGBE(bytes, { maxPixels: 64 * 1024 * 1024 });
  // the fixture: 128 × 48 of a sun-lit ridge, written by an encoder that shares
  // no code with this decoder — a mantissa of levels and a shared exponent, as
  // the format states (see fixtures/README.md)
  assert.equal(hdr.width, 128);
  assert.equal(hdr.height, 48);
  let max = 0, above = 0;
  for (let i = 0; i < hdr.data.length; i += 4) {
    if (hdr.data[i] > max) max = hdr.data[i];
    if (hdr.data[i] > 1) above++;
  }
  assert.ok(Math.abs(max - 2464) < 1, `the sun reads ${max}, 2464 written`);
  assert.ok(above > 1000, `${above} pixels past the display ceiling, which is the point of it`);
  assert.equal(hdr.data[3], 1, 'alpha is 1');
});

/**
 * The Radiance file the tests read when they need one this decoder did not
 * write: the committed fixture, or `WEBGL_TREE_HDR` for a captured HDRI. The
 * hand-authored fixtures prove the decoder agrees with itself on the format's
 * corners; a file from another encoder proves it agrees with the format.
 * @returns {string}
 */
function hdrFile() {
  return process.env.WEBGL_TREE_HDR ||
    join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tone_sunrise_128x48.hdr');
}

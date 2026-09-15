/**
 * @file OBJ text → the arrays shape a bridge's buffer upload takes.
 * @module host/obj
 * @license AGPL-3.0-only
 *
 * Positions, texture coordinates and normals. Faces are fan-triangulated — a
 * quad as 0 1 2 · 2 3 0 — and each distinct position / uv / normal triple
 * becomes one vertex, in order of first use. Indices are 1-based, or negative
 * counting back from the last declared element. Groups, objects, smoothing and
 * materials are ignored.
 */

'use strict';

const _index = (s, count) => {
  const i = parseInt(s, 10);
  return i < 0 ? count + i : i - 1;
};

/**
 * Parse OBJ text into `{ position, normal?, texcoord?, indices }`; normal and
 * texcoord only when some face vertex names one.
 * @param {string} text
 * @returns {{ position:{numComponents:number,data:Float32Array},
 *             normal?:{numComponents:number,data:Float32Array},
 *             texcoord?:{numComponents:number,data:Float32Array},
 *             indices:{numComponents:number,data:Uint32Array} }}
 */
export function parseObj(text) {
  const v = [], vt = [], vn = [];
  const position = [], texcoord = [], normal = [], indices = [];
  const seen = new Map();
  let uvs = false, normals = false;

  const vertex = (token) => {
    const [ps, ts, ns] = token.split('/');
    const p = _index(ps, v.length / 3);
    const t = ts ? _index(ts, vt.length / 2) : -1;
    const n = ns ? _index(ns, vn.length / 3) : -1;
    const key = p + '/' + t + '/' + n;
    let id = seen.get(key);
    if (id !== undefined) return id;
    position.push(v[3 * p], v[3 * p + 1], v[3 * p + 2]);
    if (t >= 0) { texcoord.push(vt[2 * t], vt[2 * t + 1]); uvs = true; } else texcoord.push(0, 0);
    if (n >= 0) { normal.push(vn[3 * n], vn[3 * n + 1], vn[3 * n + 2]); normals = true; } else normal.push(0, 0, 0);
    id = position.length / 3 - 1;
    seen.set(key, id);
    return id;
  };

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const parts = line.split(/\s+/);
    switch (parts[0]) {
      case 'v':  v.push(+parts[1], +parts[2], +parts[3]); break;
      case 'vt': vt.push(+parts[1], +(parts[2] ?? 0)); break;
      case 'vn': vn.push(+parts[1], +parts[2], +parts[3]); break;
      case 'f': {
        const ids = parts.slice(1).map(vertex);
        if (ids.length === 4) indices.push(ids[0], ids[1], ids[2], ids[2], ids[3], ids[0]);
        else for (let i = 1; i + 1 < ids.length; i++) indices.push(ids[0], ids[i], ids[i + 1]);
        break;
      }
    }
  }

  const out = {
    position: { numComponents: 3, data: new Float32Array(position) },
    indices: { numComponents: 3, data: new Uint32Array(indices) },
  };
  if (normals) out.normal = { numComponents: 3, data: new Float32Array(normal) };
  if (uvs) out.texcoord = { numComponents: 2, data: new Float32Array(texcoord) };
  return out;
}

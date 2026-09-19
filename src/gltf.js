/**
 * @file glTF 2.0 → meshes in the arrays shape, the node hierarchy, skins and animation clips.
 * @module host/gltf
 * @license AGPL-3.0-only
 *
 * The format is glTF 2.0 (Khronos Group): a JSON document plus binary buffers,
 * or both in one GLB container. parseGlb splits a container; parseGltf reads
 * the document over its buffers into what a bridge uploads and what tree's
 * skin functions (clipSample, poseWorld, jointPalette) take as they are.
 *
 * Read: triangle primitives (POSITION, NORMAL, TANGENT, TEXCOORD_0, JOINTS_0,
 * WEIGHTS_0, indices), morph targets (POSITION and NORMAL deltas), the
 * material's base colour factor, nodes, skins, animations. Normalised integer
 * accessors arrive as floats; interleaved views are unpacked. Not read:
 * textures, cameras, other primitive modes, sparse accessors and compressed
 * geometry (Draco, meshopt) — the last two throw.
 *
 * Nodes are re-indexed parents first, and every node index in the result
 * (a mesh's, a skin's joints, a channel's) is the new one.
 */

'use strict';

import { mat4ToTransform } from '@nakednous/tree';

const GLB_MAGIC = 0x46546C67, CHUNK_JSON = 0x4E4F534A, CHUNK_BIN = 0x004E4942;

const COMPONENTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
const TYPES = {
  5120: Int8Array, 5121: Uint8Array, 5122: Int16Array, 5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array,
};
const NORMALISED = { 5120: 127, 5121: 255, 5122: 32767, 5123: 65535 };
const ATTRIBUTES = {
  POSITION: 'position', NORMAL: 'normal', TANGENT: 'tangent', TEXCOORD_0: 'texcoord',
  JOINTS_0: 'joints', WEIGHTS_0: 'weights',
};
const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

/**
 * Split a GLB container into its JSON document and binary chunk.
 * @param {ArrayBuffer} buffer
 * @returns {{ json:object, bin:ArrayBuffer|null }}
 */
export function parseGlb(buffer) {
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error('[host] gltf: not a GLB container.');
  if (view.getUint32(4, true) !== 2) throw new Error('[host] gltf: GLB version ' + view.getUint32(4, true) + ', 2 expected.');
  const end = Math.min(view.getUint32(8, true), buffer.byteLength);
  let json = null, bin = null;
  for (let at = 12; at + 8 <= end;) {
    const length = view.getUint32(at, true), type = view.getUint32(at + 4, true);
    const start = at + 8;
    if (type === CHUNK_JSON) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, start, length)));
    else if (type === CHUNK_BIN && !bin) bin = buffer.slice(start, start + length);
    at = start + length + (-length & 3);
  }
  if (!json) throw new Error('[host] gltf: GLB without a JSON chunk.');
  return { json, bin };
}

/**
 * Read a glTF document over its buffers.
 *
 * A part is one triangle primitive under one node: `mesh` in the
 * arrays shape (position, normal?, tangent?, texcoord?, joints?, weights?,
 * indices), `targets` its morph targets as delta arrays, `color` the
 * material's base colour factor, `node` the node it hangs from and `skin` its
 * skin's index or −1. A rigid mesh draws under its node's world matrix; a
 * skinned one under its skin's joint palette.
 *
 * @param {object} json  The glTF document.
 * @param {ArrayBuffer[]} buffers  One per `json.buffers` entry.
 * @returns {{ parts:{ name:string, node:number, skin:number, mesh:object,
 *                      targets:{ name:string, position?:object, normal?:object }[], color:number[] }[],
 *             nodes:{ names:string[], parents:Int32Array, rest:Float32Array },
 *             skins:{ name:string, joints:Uint16Array, inverseBind:Float32Array }[],
 *             clips:{ name:string, duration:number, channels:object[] }[] }}
 *          nodes.rest: the rest pose, ten numbers per node (translation, rotation
 *          [x,y,z,w], scale). A clip channel: { node, path, interp, times, values }.
 */
export function parseGltf(json, buffers) {
  for (const ext of json.extensionsRequired || []) {
    if (/draco|meshopt/i.test(ext)) throw new Error('[host] gltf: ' + ext + ' is not supported.');
  }
  const cache = new Map();

  const accessor = (index) => {
    if (cache.has(index)) return cache.get(index);
    const a = json.accessors[index];
    if (a.sparse) throw new Error('[host] gltf: sparse accessors are not supported.');
    const n = COMPONENTS[a.type], Type = TYPES[a.componentType], scale = a.normalized && NORMALISED[a.componentType];
    const data = new (scale ? Float32Array : Type)(a.count * n);
    if (a.bufferView !== undefined) {
      const bv = json.bufferViews[a.bufferView];
      const base = (bv.byteOffset || 0) + (a.byteOffset || 0), size = Type.BYTES_PER_ELEMENT;
      const stride = bv.byteStride || n * size;
      const view = new DataView(buffers[bv.buffer]);
      const get = {
        5120: 'getInt8', 5121: 'getUint8', 5122: 'getInt16', 5123: 'getUint16', 5125: 'getUint32', 5126: 'getFloat32',
      }[a.componentType];
      for (let i = 0; i < a.count; i++) {
        for (let c = 0; c < n; c++) {
          const v = view[get](base + i * stride + c * size, true);
          data[i * n + c] = scale ? Math.max(v / scale, -1) : v;
        }
      }
    }
    const out = { numComponents: n, data };
    cache.set(index, out);
    return out;
  };

  // nodes, parents first
  const src = json.nodes || [], parentOf = new Array(src.length).fill(-1);
  src.forEach((node, i) => { for (const c of node.children || []) parentOf[c] = i; });
  const order = [], remap = new Array(src.length).fill(-1);
  const visit = (i) => { remap[i] = order.length; order.push(i); for (const c of src[i].children || []) visit(c); };
  src.forEach((_, i) => { if (parentOf[i] < 0) visit(i); });

  const names = [], parents = new Int32Array(order.length), rest = new Float32Array(order.length * 10);
  const xf = { pos: [0, 0, 0], rot: [0, 0, 0, 1], scl: [1, 1, 1] };
  order.forEach((old, i) => {
    const node = src[old];
    names.push(node.name || '');
    parents[i] = parentOf[old] < 0 ? -1 : remap[parentOf[old]];
    let t = node.translation || [0, 0, 0], r = node.rotation || [0, 0, 0, 1], s = node.scale || [1, 1, 1];
    if (node.matrix) { mat4ToTransform(xf, node.matrix); t = xf.pos; r = xf.rot; s = xf.scl; }
    rest.set(t, i * 10); rest.set(r, i * 10 + 3); rest.set(s, i * 10 + 7);
  });

  // parts: one per triangle primitive per node
  const primitives = (json.meshes || []).map((mesh) => {
    const out = [];
    for (const prim of mesh.primitives) {
      if ((prim.mode ?? 4) !== 4 || prim.attributes.POSITION === undefined) continue;
      const arrays = {};
      for (const [semantic, key] of Object.entries(ATTRIBUTES)) {
        if (prim.attributes[semantic] !== undefined) arrays[key] = accessor(prim.attributes[semantic]);
      }
      const count = arrays.position.data.length / 3;
      const data = prim.indices !== undefined
        ? Uint32Array.from(accessor(prim.indices).data)
        : Uint32Array.from({ length: count }, (_, i) => i);
      arrays.indices = { numComponents: 3, data };
      const targetNames = (mesh.extras && mesh.extras.targetNames) || [];
      const targets = (prim.targets || []).map((target, i) => {
        const t = { name: targetNames[i] || '' };
        if (target.POSITION !== undefined) t.position = accessor(target.POSITION);
        if (target.NORMAL !== undefined) t.normal = accessor(target.NORMAL);
        return t;
      });
      const material = prim.material !== undefined ? json.materials[prim.material] : null;
      const pbr = material && material.pbrMetallicRoughness;
      out.push({ arrays, targets, color: (pbr && pbr.baseColorFactor ? pbr.baseColorFactor : [1, 1, 1, 1]).slice() });
    }
    return { name: mesh.name || '', primitives: out };
  });

  const parts = [];
  order.forEach((old, i) => {
    const node = src[old];
    if (node.mesh === undefined) return;
    const mesh = primitives[node.mesh];
    for (const p of mesh.primitives) {
      parts.push({ name: mesh.name || names[i], node: i, skin: node.skin ?? -1, mesh: p.arrays, targets: p.targets, color: p.color });
    }
  });

  const skins = (json.skins || []).map((skin) => {
    const joints = Uint16Array.from(skin.joints, j => remap[j]);
    const inverseBind = skin.inverseBindMatrices !== undefined
      ? Float32Array.from(accessor(skin.inverseBindMatrices).data)
      : Float32Array.from({ length: joints.length * 16 }, (_, k) => IDENTITY[k % 16]);
    return { name: skin.name || '', joints, inverseBind };
  });

  const clips = (json.animations || []).map((anim) => {
    let duration = 0;
    const channels = [];
    for (const ch of anim.channels) {
      if (ch.target.node === undefined) continue;
      const sampler = anim.samplers[ch.sampler];
      const times = accessor(sampler.input).data, values = accessor(sampler.output).data;
      if (times.length) duration = Math.max(duration, times[times.length - 1]);
      channels.push({ node: remap[ch.target.node], path: ch.target.path, interp: sampler.interpolation || 'LINEAR', times, values });
    }
    return { name: anim.name || '', duration, channels };
  });

  return { parts, nodes: { names, parents, rest }, skins, clips };
}

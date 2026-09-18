/**
 * @file A synthetic glTF document for the tests: a skinned triangle with a
 * morph target, nodes listed child first, one clip; and a GLB container writer.
 */

// Pack typed arrays into one buffer, 4-byte aligned; returns the bufferViews and accessors.
function pack(parts) {
  let size = 0;
  const offsets = parts.map(([, data]) => { const at = size; size += data.byteLength + (-data.byteLength & 3); return at; });
  const bin = new Uint8Array(size);
  const bufferViews = [], accessors = [];
  const CT = new Map([[Float32Array, 5126], [Uint16Array, 5123], [Uint8Array, 5121], [Int16Array, 5122]]);
  parts.forEach(([type, data, extra], i) => {
    bin.set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), offsets[i]);
    bufferViews.push({ buffer: 0, byteOffset: offsets[i], byteLength: data.byteLength });
    const n = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[type];
    accessors.push({ bufferView: i, componentType: CT.get(data.constructor), count: data.length / n, type, ...extra });
  });
  return { bin: bin.buffer, bufferViews, accessors };
}

export function document() {
  const { bin, bufferViews, accessors } = pack([
    ['VEC3', Float32Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0)],                       // 0 position
    ['SCALAR', Uint16Array.of(0, 1, 2)],                                        // 1 indices
    ['VEC4', Uint8Array.of(0, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0, 0)],                // 2 joints
    ['VEC4', Uint8Array.of(255, 0, 0, 0, 51, 204, 0, 0, 0, 255, 0, 0), { normalized: true }],   // 3 weights
    ['VEC3', Float32Array.of(0, 0, 1, 0, 0, 1, 0, 0, 1)],                       // 4 target deltas
    ['MAT4', Float32Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,   1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, -1, 0, 1)],   // 5
    ['SCALAR', Float32Array.of(0, 1)],                                          // 6 times
    ['VEC3', Float32Array.of(0, 1, 0, 2, 1, 0)],                                // 7 translations
  ]);
  const json = {
    asset: { version: '2.0' },
    scenes: [{ nodes: [2] }],
    // listed child first: tip (0) under root (1); the mesh node (2) carries a matrix
    nodes: [
      { name: 'tip', translation: [0, 1, 0] },
      { name: 'root', children: [0] },
      { name: 'body', mesh: 0, skin: 0, children: [1], matrix: [2, 0, 0, 0, 0, 2, 0, 0, 0, 0, 2, 0, 5, 0, 0, 1] },
    ],
    meshes: [{
      name: 'tri', extras: { targetNames: ['Puff'] },
      primitives: [
        { attributes: { POSITION: 0, JOINTS_0: 2, WEIGHTS_0: 3 }, indices: 1, targets: [{ POSITION: 4 }], material: 0 },
        { attributes: { POSITION: 0 }, mode: 1 },                               // lines: skipped
      ],
    }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [1, 0.5, 0, 1] } }],
    skins: [{ joints: [1, 0], inverseBindMatrices: 5 }],
    animations: [{ name: 'Slide', channels: [{ sampler: 0, target: { node: 0, path: 'translation' } }], samplers: [{ input: 6, output: 7 }] }],
    buffers: [{ byteLength: bin.byteLength }],
    bufferViews, accessors,
  };
  return { json, bin };
}

export function glb(json, bin) {
  const text = new TextEncoder().encode(JSON.stringify(json));
  const jl = text.length + (-text.length & 3), bl = bin.byteLength + (-bin.byteLength & 3);
  const out = new Uint8Array(12 + 8 + jl + 8 + bl).fill(0x20, 20, 20 + jl);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546C67, true); view.setUint32(4, 2, true); view.setUint32(8, out.length, true);
  view.setUint32(12, jl, true); view.setUint32(16, 0x4E4F534A, true); out.set(text, 20);
  view.setUint32(20 + jl, bl, true); view.setUint32(24 + jl, 0x004E4942, true); out.set(new Uint8Array(bin), 28 + jl);
  return out.buffer;
}

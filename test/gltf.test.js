/**
 * @file glTF tests — the synthetic document of gltf.fixture, as JSON plus
 * buffer and as a GLB container.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGlb, parseGltf } from '../src/gltf.js';
import { clipSample, poseWorld, jointPalette } from '@nakednous/tree';
import { document, glb } from './gltf.fixture.js';

test('parseGltf: nodes re-indexed parents first; TRS from a matrix; the rest pose', () => {
  const { json, bin } = document();
  const m = parseGltf(json, [bin]);
  assert.deepEqual(m.nodes.names, ['body', 'root', 'tip']);
  assert.deepEqual([...m.nodes.parents], [-1, 0, 1]);
  assert.deepEqual([...m.nodes.rest.slice(0, 10)], [5, 0, 0, 0, 0, 0, 1, 2, 2, 2]);
  assert.deepEqual([...m.nodes.rest.slice(20, 30)], [0, 1, 0, 0, 0, 0, 1, 1, 1, 1]);
});

test('parseGltf: a triangle primitive in the arrays shape, its target, colour, node and skin; other modes skipped', () => {
  const { json, bin } = document();
  const m = parseGltf(json, [bin]);
  assert.equal(m.meshes.length, 1);
  const mesh = m.meshes[0];
  assert.equal(mesh.name, 'tri'); assert.equal(mesh.node, 0); assert.equal(mesh.skin, 0);
  assert.deepEqual(mesh.color, [1, 0.5, 0, 1]);
  assert.deepEqual(Object.keys(mesh.arrays).sort(), ['indices', 'joints', 'position', 'weights']);
  assert.ok(mesh.arrays.indices.data instanceof Uint32Array);
  assert.deepEqual([...mesh.arrays.indices.data], [0, 1, 2]);
  assert.ok(mesh.arrays.joints.data instanceof Uint8Array);
  assert.equal(mesh.arrays.joints.numComponents, 4);
  assert.ok(mesh.arrays.weights.data instanceof Float32Array);
  assert.ok(Math.abs(mesh.arrays.weights.data[4] - 0.2) < 1e-6 && Math.abs(mesh.arrays.weights.data[5] - 0.8) < 1e-6);
  assert.equal(mesh.targets.length, 1);
  assert.equal(mesh.targets[0].name, 'Puff');
  assert.deepEqual([...mesh.targets[0].position.data], [0, 0, 1, 0, 0, 1, 0, 0, 1]);
});

test('parseGltf: skins and clips carry the new node indices and feed tree as they are', () => {
  const { json, bin } = document();
  const m = parseGltf(json, [bin]);
  assert.deepEqual([...m.skins[0].joints], [1, 2]);
  assert.equal(m.skins[0].inverseBind.length, 32);
  const clip = m.clips[0];
  assert.equal(clip.name, 'Slide'); assert.equal(clip.duration, 1);
  assert.equal(clip.channels[0].node, 2); assert.equal(clip.channels[0].interp, 'LINEAR');
  const pose = clipSample(new Float32Array(30), clip, 0.5, { rest: m.nodes.rest });
  assert.deepEqual([...pose.slice(20, 23)], [1, 1, 0]);
  const world = poseWorld(new Float32Array(48), pose, m.nodes.parents);
  assert.deepEqual([...world.slice(44, 47)], [7, 2, 0]);           // 5 + 2 · (1, 1, 0)
  const palette = jointPalette(new Float32Array(32), world, m.skins[0].joints, m.skins[0].inverseBind);
  assert.deepEqual([...palette.slice(28, 31)], [7, 0, 0]);         // the tip's bind offset (0, 1, 0), scaled by 2, removed
});

test('parseGltf: an absent inverse bind accessor is identities; no indices counts up; defaults', () => {
  const { json, bin } = document();
  delete json.skins[0].inverseBindMatrices;
  delete json.meshes[0].primitives[0].indices;
  delete json.meshes[0].primitives[0].material;
  const m = parseGltf(json, [bin]);
  assert.deepEqual([...m.skins[0].inverseBind.slice(16)], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
  assert.deepEqual([...m.meshes[0].arrays.indices.data], [0, 1, 2]);
  assert.deepEqual(m.meshes[0].color, [1, 1, 1, 1]);
  const bare = parseGltf({ asset: { version: '2.0' } }, []);
  assert.deepEqual(bare, { meshes: [], nodes: { names: [], parents: new Int32Array(0), rest: new Float32Array(0) }, skins: [], clips: [] });
});

test('parseGltf: an interleaved view is unpacked by its stride', () => {
  const data = Float32Array.of(0, 0, 0, 9, 9, 1, 0, 0, 9, 9, 0, 1, 0, 9, 9);
  const json = {
    nodes: [{ mesh: 0 }], meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }],
    bufferViews: [{ buffer: 0, byteLength: 60, byteStride: 20 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }],
  };
  const m = parseGltf(json, [data.buffer]);
  assert.deepEqual([...m.meshes[0].arrays.position.data], [0, 0, 0, 1, 0, 0, 0, 1, 0]);
  assert.equal(m.meshes[0].skin, -1);
});

test('parseGltf: sparse accessors and compressed geometry throw', () => {
  const { json, bin } = document();
  json.accessors[0].sparse = { count: 1 };
  assert.throws(() => parseGltf(json, [bin]), /sparse/);
  assert.throws(() => parseGltf({ extensionsRequired: ['KHR_draco_mesh_compression'] }, []), /draco/);
});

test('parseGlb: splits the container; a bad magic or version throws', () => {
  const { json, bin } = document();
  const out = parseGlb(glb(json, bin));
  assert.deepEqual(out.json.nodes, json.nodes);
  assert.equal(parseGltf(out.json, [out.bin]).meshes[0].name, 'tri');
  assert.throws(() => parseGlb(new ArrayBuffer(12)), /not a GLB/);
  const v1 = glb(json, bin); new DataView(v1).setUint32(4, 1, true);
  assert.throws(() => parseGlb(v1), /version 1/);
});

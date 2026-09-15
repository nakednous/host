/**
 * The OBJ parser: triangulation, vertex sharing, relative indices, optional attributes.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseObj } from '../src/obj.js';

test('parseObj: a quad splits as 0 1 2 · 2 3 0, with uvs and a shared normal', () => {
  const m = parseObj('v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 1 1\nvt 0 1\nvn 0 0 1\nf 1/1/1 2/2/1 3/3/1 4/4/1\n');
  assert.deepEqual([...m.position.data], [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
  assert.deepEqual([...m.indices.data], [0, 1, 2, 2, 3, 0]);
  assert.deepEqual([...m.normal.data], [0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]);
  assert.deepEqual([...m.texcoord.data], [0, 0, 1, 0, 1, 1, 0, 1]);
});

test('parseObj: a pentagon fans from its first vertex', () => {
  const m = parseObj('v 0 0 0\nv 1 0 0\nv 2 1 0\nv 1 2 0\nv 0 1 0\nf 1 2 3 4 5\n');
  assert.deepEqual([...m.indices.data], [0, 1, 2, 0, 2, 3, 0, 3, 4]);
  assert.deepEqual(Object.keys(m).sort(), ['indices', 'position']);
});

test('parseObj: a triple repeated across faces is one vertex; the same position with another normal is two', () => {
  const m = parseObj('v 0 0 0\nv 1 0 0\nv 0 1 0\nv 1 1 0\nvn 0 0 1\nvn 0 0 -1\nf 1//1 2//1 3//1\nf 2//1 4//1 3//1\nf 1//2 3//2 2//2\n');
  assert.equal(m.position.data.length / 3, 7);
  assert.deepEqual([...m.indices.data], [0, 1, 2, 1, 3, 2, 4, 5, 6]);
  assert.equal(m.texcoord, undefined);
});

test('parseObj: negative indices count back from the last declared element; comments, blank lines and unknown statements pass', () => {
  const m = parseObj('# a triangle\n\no tri\nv 0 0 0\nv 1 0 0\nv 0 1 0\nusemtl red\ns off\nf -3 -2 -1\n');
  assert.deepEqual([...m.position.data], [0, 0, 0, 1, 0, 0, 0, 1, 0]);
  assert.deepEqual([...m.indices.data], [0, 1, 2]);
});

test('parseObj: CRLF lines and a vt with a third component read as 2D uvs', () => {
  const m = parseObj('v 0 0 0\r\nv 1 0 0\r\nv 0 1 0\r\nvt 0.25 0.5 0\r\nf 1/1 2/1 3/1\r\n');
  assert.deepEqual([...m.texcoord.data], [0.25, 0.5, 0.25, 0.5, 0.25, 0.5]);
  assert.equal(m.normal, undefined);
});

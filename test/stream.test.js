/**
 * @file stream tests — the WebHID and Gamepad streams against fake device
 *       interfaces, feeding a core PoseHelm through the host's players.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PoseHelm } from '@nakednous/tree';
import { createHost, createHid, createGamepad, decodeSpaceNavigator, HID_FILTERS } from '../src/index.js';
import { createCanvas, installWindow } from './dom.js';

installWindow();

const i16 = (...v) => {
  const d = new DataView(new ArrayBuffer(2 * v.length));
  v.forEach((x, i) => d.setInt16(2 * i, x, true));
  return d;
};

function fakeDevice(vendorId = 0x046d) {
  const listeners = new Map();
  return {
    vendorId, productId: 0xc626, opened: false,
    async open() { this.opened = true; },
    async close() { this.opened = false; },
    addEventListener(t, fn) { (listeners.get(t) || listeners.set(t, new Set()).get(t)).add(fn); },
    removeEventListener(t, fn) { listeners.get(t)?.delete(fn); },
    report(reportId, data) { for (const fn of listeners.get('inputreport') || []) fn({ reportId, data }); },
    listenerCount(t) { return listeners.get(t)?.size || 0; },
  };
}

function fakeHid({ granted = [], chosen = [] } = {}) {
  const listeners = new Map();
  return {
    prompts: 0,
    async requestDevice() { this.prompts++; return chosen; },
    async getDevices() { return granted; },
    addEventListener(t, fn) { (listeners.get(t) || listeners.set(t, new Set()).get(t)).add(fn); },
    removeEventListener(t, fn) { listeners.get(t)?.delete(fn); },
    disconnect(device) { for (const fn of listeners.get('disconnect') || []) fn({ device }); },
    listenerCount(t) { return listeners.get(t)?.size || 0; },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test('decodeSpaceNavigator: two 6-byte reports, or one 12-byte report', () => {
  const lin = [0, 0, 0], ang = [0, 0, 0];
  decodeSpaceNavigator(i16(10, -20, 30), 1, lin, ang);
  decodeSpaceNavigator(i16(-1, 2, -3), 2, lin, ang);
  assert.deepEqual(lin, [10, -20, 30]);
  assert.deepEqual(ang, [-1, 2, -3]);
  decodeSpaceNavigator(i16(1, 2, 3, 4, 5, 6), 1, lin, ang);
  assert.deepEqual(lin, [1, 2, 3]);
  assert.deepEqual(ang, [4, 5, 6]);
  decodeSpaceNavigator(i16(9, 9, 9), 3, lin, ang);        // an unknown id changes nothing
  decodeSpaceNavigator(i16(9), 1, lin, ang);              // a short report changes nothing
  assert.deepEqual(lin, [1, 2, 3]);
});

test('hid: resume attaches a granted device without a prompt; reports feed the helm each tick', async () => {
  const host = createHost(createCanvas());
  const device = fakeDevice();
  const hid = fakeHid({ granted: [fakeDevice(0x1234), device] });
  const helm = new PoseHelm();
  const s = createHid(host, { hid, bind: helm });
  assert.equal(s.available, true);
  assert.equal(s.connected, false);
  await tick();
  assert.equal(s.connected, true);
  assert.equal(s.device, device);
  assert.equal(hid.prompts, 0);
  assert.equal(device.opened, true);
  device.report(1, i16(100, 0, 0));
  device.report(2, i16(0, 0, 50));
  assert.deepEqual(s.lin, [100, 0, 0]);
  assert.deepEqual(s.ang, [0, 0, 50]);
  host.tick(0.016);
  assert.deepEqual([...helm._lin], [100, 0, 0]);
  assert.deepEqual([...helm._ang], [0, 0, 50]);
  s.unbind();
  device.report(1, i16(7, 0, 0));
  host.tick(0.016);
  assert.deepEqual([...helm._lin], [100, 0, 0]);          // unbound: the helm keeps its last rate
  hid.disconnect(device);
  assert.equal(s.connected, false);
  assert.deepEqual(s.lin, [0, 0, 0]);
  assert.equal(device.listenerCount('inputreport'), 0);
  s.dispose();
  assert.equal(hid.listenerCount('disconnect'), 0);
  assert.equal(host.players.size, 0);
  host.dispose();
});

test('hid: connect prompts and attaches the choice; no interface means unavailable', async () => {
  const host = createHost(createCanvas());
  const device = fakeDevice();
  const hid = fakeHid({ chosen: [device] });
  const s = createHid(host, { hid, resume: false, filters: HID_FILTERS });
  await tick();
  assert.equal(s.connected, false);
  assert.equal(await s.connect(), true);
  assert.equal(hid.prompts, 1);
  assert.equal(s.device, device);
  assert.equal(await s.connect(), true);                  // re-connect swaps cleanly
  assert.equal(device.listenerCount('inputreport'), 1);
  host.dispose();
  assert.equal(s.connected, false);

  const errors = [];
  const orig = console.error; console.error = (m) => errors.push(m);
  try {
    const none = createHid(createHost(createCanvas()), { hid: null });
    assert.equal(none.available, false);
    assert.equal(await none.connect(), false);
    none.bind({});                                        // no feed(): refused
    assert.equal(none.helm, null);
  } finally { console.error = orig; }
  assert.equal(errors.length, 2);
});

test('gamepad: polls the standard map each tick; absent axes read 0; index selects', () => {
  const host = createHost(createCanvas());
  const helm = new PoseHelm();
  let pads = [];
  const s = createGamepad(host, { gamepads: () => pads, bind: helm });
  assert.equal(s.available, true);
  host.tick(0.016);
  assert.equal(s.connected, false);
  assert.deepEqual(s.lin, [0, 0, 0]);
  const gp = { axes: [0.5, -0.25, 0.1, 0.9], buttons: Array.from({ length: 8 }, (_, i) => ({ value: i === 7 ? 0.75 : 0 })) };
  pads = [null, gp];
  host.tick(0.016);
  assert.equal(s.connected, true);
  assert.deepEqual(s.lin, [0.5, -0.25, 0.75]);
  assert.deepEqual(s.ang, [0.9, 0.1, 0]);
  assert.deepEqual([...helm._lin], [0.5, -0.25, 0.75]);
  s.index = 0;
  host.tick(0.016);
  assert.equal(s.connected, false);
  assert.deepEqual(s.ang, [0, 0, 0]);
  const short = createGamepad(host, { gamepads: () => [{ axes: [0.2], buttons: [] }], map: { lin: [0, 1, { button: 3 }], ang: [null, null, null] } });
  host.tick(0.016);
  assert.deepEqual(short.lin, [0.2, 0, 0]);
  s.dispose(); short.dispose();
  assert.equal(host.players.size, 0);
  host.dispose();
});

/**
 * @file The players registry and the frame loop.
 * @module host/loop
 * @license AGPL-3.0-only
 *
 * A player is { tick(dt) → boolean }, removed from the registry when it
 * returns false. Iteration snapshots the set, so a player may remove itself
 * or add another during a tick. Tracks register through their activation
 * hooks, helms until disposed.
 *
 * The loop is optional: with it, requestAnimationFrame (overridable — the
 * seam a WebXR session fills) drives onFrame(dt) with dt in seconds clamped
 * to 50 ms, the stalled-tab guard; without it the application ticks the
 * players from its own loop.
 */

'use strict';

/**
 * Create a players registry.
 * @returns {{ add(player):object, remove(player):object, has(player):boolean,
 *             tick(dt:number):void, size:number, clear():void }}
 */
export function createPlayers() {
  const set = new Set();
  const players = {
    /** Register a player; adding one already present is a no-op. */
    add(player) { if (player) set.add(player); return players; },
    /** Unregister a player. */
    remove(player) { set.delete(player); return players; },
    /** Whether a player is registered. */
    has(player) { return set.has(player); },
    /** Tick every player with dt (seconds); one returning false is removed. */
    tick(dt) {
      for (const p of [...set]) {
        if (!set.has(p)) continue;                 // removed by an earlier player this tick
        if (p.tick(dt) === false) set.delete(p);
      }
    },
    /** Registered count. */
    get size() { return set.size; },
    /** Unregister every player. */
    clear() { set.clear(); },
  };
  return players;
}

const _now = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

/**
 * Create a frame loop. `onFrame(dt)` runs once per animation frame with the
 * clamped period in seconds; start() schedules, stop() cancels.
 *
 * @param {{ onFrame:function(number):void, raf?:function, caf?:function,
 *           clampMs?:number, now?:function():number }} opts
 *        raf / caf default to the window's requestAnimationFrame /
 *        cancelAnimationFrame; clampMs defaults to 50.
 * @returns {{ start():object, stop():object, running:boolean, dt:number }}
 */
export function createLoop(opts) {
  const o = opts || {};
  const raf = o.raf || ((cb) => requestAnimationFrame(cb));
  const caf = o.caf || ((id) => cancelAnimationFrame(id));
  const now = o.now || _now;
  const clamp = (o.clampMs ?? 50) / 1000;
  let handle = null, last = 0;
  const loop = {
    running: false,
    dt: 0,
    start() {
      if (loop.running) return loop;
      loop.running = true;
      last = now();
      const frame = () => {
        if (!loop.running) return;
        const t = now();
        loop.dt = Math.min((t - last) / 1000, clamp);
        last = t;
        o.onFrame(loop.dt);
        if (loop.running) handle = raf(frame);
      };
      handle = raf(frame);
      return loop;
    },
    stop() {
      loop.running = false;
      if (handle !== null) { caf(handle); handle = null; }
      return loop;
    },
  };
  return loop;
}

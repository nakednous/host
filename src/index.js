/**
 * @file The host context — one per canvas: pointer, view bag, players, loop, observer.
 * @module host
 * @license AGPL-3.0-only
 *
 * The signal host of a program: what it needs from the browser that is
 * neither math nor GPU — a canvas element's pointer input, the frame clock,
 * its size — and the registry its constructs tick from. Pure vanilla DOM;
 * everything it computes goes through @nakednous/tree, nothing it draws.
 *
 *   const host = createHost(canvas, { onFrame })
 *   host.pointer · host.view · host.players
 *   host.width · host.height · host.dpr · host.dt · host.clock()
 *   host.handle(opts) · host.router(handles, opts)
 *   host.cameraHelm(cam, opts) · host.poseHelm(opts)
 *   host.poseTrack(opts) · host.cameraTrack(cam, opts)
 *   host.hid(opts) · host.gamepad(opts)
 *   host.image(url) · host.video(opts) · host.raster(draw, w, h)
 *   host.labels        // the DOM label layer, created on first access
 *   host.orbit(cam, opts)
 *   host.tick(dt)      // external-loop mode
 *   host.dispose()
 *
 * Two loop modes. With { onFrame } the host runs requestAnimationFrame
 * (overridable through { raf, caf }): each frame computes dt (clamped to
 * 50 ms), ticks the players, calls onFrame(dt, host), then flushes the
 * pointer source. Without it the application, or the p5 adapter from
 * predraw, calls host.tick(dt) = players.tick(dt) and host.pointer.flush()
 * once its consumers ran. Nothing else in the host cares who owns the loop.
 *
 * The frame order inside onFrame: install the camera (which fills
 * host.view), update handles or routers, fall through to the orbit when
 * nothing grabbed, draw.
 */

'use strict';

import { createView } from './view.js';
import { observeCanvas } from './canvas.js';
import { createPointer } from './pointer.js';
import { createPlayers, createLoop } from './loop.js';
import { Handle, validConstraint } from './handle.js';
import { PointerRouter } from './router.js';
import { cameraHelm, poseHelm } from './helm.js';
import { poseTrack, cameraTrack } from './track.js';
import { createHid, createGamepad } from './stream.js';
import { loadImage, createVideo, raster } from './media.js';
import { createLabels } from './labels.js';
import { createOrbit } from './orbit.js';

export { createView } from './view.js';
export { observeCanvas, measureCanvas } from './canvas.js';
export { createPointer } from './pointer.js';
export { createPlayers, createLoop } from './loop.js';
export { Handle, VIEW, isConstraint, validConstraint } from './handle.js';
export { PointerRouter } from './router.js';
export { cameraHelm, poseHelm, helmBasis } from './helm.js';
export { poseTrack, cameraTrack, TrackHandles } from './track.js';
export { createHid, createGamepad, decodeSpaceNavigator, HID_FILTERS, GAMEPAD_MAP } from './stream.js';
export { loadImage, createVideo, raster } from './media.js';
export { createLabels } from './labels.js';
export { createOrbit } from './orbit.js';

const _now = () => (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();

/**
 * Create the host context of a canvas.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {{ ndcZMin?:number, onFrame?:function(number, object):void, raf?:function,
 *           caf?:function, onSize?:function(number, number, number):void }} [opts]
 *        ndcZMin: the GPU API's NDC-z convention, WEBGL (default) or WEBGPU —
 *        written once, never detected. onFrame: the host's own loop; absent,
 *        external-tick mode. onSize(width, height, dpr): the bridge's chance
 *        to resize its drawing buffer.
 * @returns {object} The host.
 */
export function createHost(canvas, opts) {
  const o = opts || {};
  const t0 = _now();
  const constructs = new Set();
  let loop = null, observer = null, labels = null;
  const host = {
    canvas,
    width: 0, height: 0, dpr: 1,
    dt: 0,
    view: null, pointer: null, players: null,

    /** Seconds since the host was created. */
    clock() { return (_now() - t0) / 1000; },

    /**
     * External-loop mode: tick the players with dt (seconds). The caller
     * flushes the pointer source once its consumers ran.
     * @param {number} dt
     */
    tick(dt) { host.dt = dt; host.players.tick(dt); },

    /**
     * A draggable handle on this canvas — see host/handle. Returns null on
     * an invalid `constraint`.
     * @param {object} opts
     * @returns {Handle|null}
     */
    handle(opts) {
      const o = opts || {};
      if (!validConstraint(o.constraint)) {
        console.error('[host] handle: `constraint` must be SPHERE, PLANE, AXIS, DIAL, VIEW, or a contract-conforming constraint object; got ' + String(o.constraint) + '.');
        return null;
      }
      return host.register(new Handle(host, o));
    },

    /**
     * A shared pick over overlapping handles — see host/router.
     * @param {Handle[]} handles
     * @param {{ hover?:boolean }} [opts]
     * @returns {PointerRouter}
     */
    router(handles, opts) { return host.register(new PointerRouter(host, handles, opts)); },

    /** Fly a camera state body-relative from a 6-DOF rate stream — see host/helm. */
    cameraHelm(cam, opts) { return cameraHelm(host, cam, opts); },
    /** Integrate a 6-DOF rate stream into a pose in a declared frame — see host/helm. */
    poseHelm(opts) { return poseHelm(host, opts); },
    /** A core PoseTrack ticked while it plays — see host/track. */
    poseTrack(opts) { return poseTrack(host, opts); },
    /** A core CameraTrack evaluating into a camera state while it plays — see host/track. */
    cameraTrack(cam, opts) { return cameraTrack(host, cam, opts); },
    /** A WebHID 6-DOF rate stream — see host/stream. */
    hid(opts) { return createHid(host, opts); },
    /** A Gamepad rate stream, polled each tick — see host/stream. */
    gamepad(opts) { return createGamepad(host, opts); },
    /** Fetch an image into an ImageBitmap — see host/media. */
    image(url, opts) { return loadImage(url, opts); },
    /** A hidden <video> from a file or the camera, disposed with the host — see host/media. */
    video(opts) { return host.register(createVideo(opts)); },
    /** Draw through a 2D context into a texture source — see host/media. */
    raster(draw, w, h, opts) { return raster(draw, w, h, opts); },
    /**
     * The label layer — see host/labels. Created on first access, so a
     * canvas that never labels never gets a layer nor a repositioned parent.
     */
    get labels() {
      if (labels === null) labels = createLabels(host);
      return labels;
    },
    /** The fall-through camera gesture on unclaimed pointers — see host/orbit. */
    orbit(cam, opts) { return createOrbit(host, cam, opts); },

    /** Register a construct with dispose() so host.dispose() releases it. */
    register(c) { if (c) constructs.add(c); return c; },
    /** Unregister a construct. */
    unregister(c) { constructs.delete(c); },

    /** Stop the loop, disconnect the observer, remove every listener, dispose every construct. */
    dispose() {
      if (loop) loop.stop();
      for (const c of [...constructs]) { if (typeof c.dispose === 'function') c.dispose(); }
      constructs.clear();
      labels = null;
      observer.dispose();
      host.pointer.dispose();
      host.players.clear();
    },
  };

  host.view = createView({ ndcZMin: o.ndcZMin });
  host.players = createPlayers();
  host.pointer = createPointer(canvas, host.view);
  observer = observeCanvas(canvas, (w, h, dpr) => {
    host.width = w; host.height = h; host.dpr = dpr;
    host.view.resize(w, h);
    if (labels) labels.resize(w, h);
    if (typeof o.onSize === 'function') o.onSize(w, h, dpr);
  });

  if (typeof o.onFrame === 'function') {
    loop = createLoop({
      raf: o.raf, caf: o.caf,
      onFrame: (dt) => {
        host.dt = dt;
        host.players.tick(dt);
        o.onFrame(dt, host);
        host.pointer.flush();
      },
    });
    loop.start();
  }
  return host;
}

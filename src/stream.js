/**
 * @file Device streams — WebHID and Gamepad rate sources that feed a helm.
 * @module host/stream
 * @license AGPL-3.0-only
 *
 * The measure-by-subscription transports. Each yields lin[3] / ang[3] in raw
 * device units and, once bind(helm) ran, calls helm.feed(lin, ang) every
 * tick of the host's players — the helm's profile does all scaling, so a
 * stream carries no configuration beyond identification and decoding.
 *
 *   hid     — WebHID. connect() must run from a user gesture; reports land
 *             out of band into the stream's buffers and the frame reads the
 *             latest (last-write-wins). Permissions-Policy gates
 *             requestDevice to top-level documents: a stream in an iframe
 *             without allow="hid" reports available === false and never
 *             prompts.
 *   gamepad — the Gamepad API, polled once per tick from
 *             navigator.getGamepads(); an absent axis reads exactly 0.
 *
 * Both expose available and connected for a UI to reflect, and bind(helm),
 * unbind(), dispose().
 */

'use strict';

const _nav = () => (typeof navigator !== 'undefined' ? navigator : null);

/** The 3Dconnexion vendor ids: the SpaceNavigator and its successors. */
export const HID_FILTERS = [{ vendorId: 0x046d }, { vendorId: 0x256f }];

/**
 * The SpaceNavigator decode: report 1 carries translation, report 2
 * rotation, each three int16 little-endian lanes; a firmware that packs all
 * six lanes into one report fills both halves from it.
 * @param {DataView} report   The report's data (the id byte excluded).
 * @param {number} reportId
 * @param {number[]} lin  Translation lanes, written.
 * @param {number[]} ang  Rotation lanes, written.
 */
export function decodeSpaceNavigator(report, reportId, lin, ang) {
  if (report.byteLength >= 12) {
    for (let i = 0; i < 3; i++) { lin[i] = report.getInt16(2 * i, true); ang[i] = report.getInt16(6 + 2 * i, true); }
    return;
  }
  if (report.byteLength < 6) return;
  const t = reportId === 1 ? lin : reportId === 2 ? ang : null;
  if (!t) return;
  for (let i = 0; i < 3; i++) t[i] = report.getInt16(2 * i, true);
}

/** Whether WebHID's requestDevice is allowed in this document. */
function _hidAllowed() {
  if (typeof document !== 'undefined' && document.featurePolicy && typeof document.featurePolicy.allowsFeature === 'function') {
    return document.featurePolicy.allowsFeature('hid');
  }
  if (typeof window !== 'undefined' && 'top' in window) return window.top === window.self;
  return true;
}

function _stream(host, lin, ang) {
  let helm = null;
  const s = {
    /** The latest translation lanes, raw device units. */
    lin,
    /** The latest rotation lanes, raw device units. */
    ang,
    /** The bound helm, or null. */
    get helm() { return helm; },
    /**
     * Feed a helm every tick. Chainable.
     * @param {object} target  A PoseHelm (anything with feed(lin, ang)).
     * @returns {object} this
     */
    bind(target) {
      if (!target || typeof target.feed !== 'function') {
        console.error('[host] stream: bind() target must have feed(lin, ang). Leaving unbound.');
        return s;
      }
      helm = target;
      return s;
    },
    /** Stop feeding; the helm sees its last rate until it is fed again. */
    unbind() { helm = null; return s; },
  };
  const feed = () => { if (helm) helm.feed(lin, ang); };
  return { s, feed };
}

/**
 * A WebHID rate stream.
 *
 * @param {object} host
 * @param {{ filters?:object[], decode?:function, bind?:object, resume?:boolean,
 *           hid?:object }} [opts]
 *        filters: the requestDevice filters (default HID_FILTERS). decode:
 *        decode(report, reportId, lin, ang) (default decodeSpaceNavigator).
 *        bind: a helm to bind at once. resume (default true): attach a device
 *        this origin was already granted, without a prompt. hid: the WebHID
 *        interface (default navigator.hid) — the seam a test fills.
 * @returns {object} The stream: { available, connected, device, lin, ang,
 *          connect(), bind(helm), unbind(), dispose() }.
 */
export function createHid(host, opts) {
  const o = opts || {};
  const hid = o.hid || (_nav() && _nav().hid) || null;
  const filters = o.filters || HID_FILTERS;
  const decode = typeof o.decode === 'function' ? o.decode : decodeSpaceNavigator;
  const lin = [0, 0, 0], ang = [0, 0, 0];
  const { s, feed } = _stream(host, lin, ang);
  let device = null;

  const onReport = (e) => decode(e.data, e.reportId, lin, ang);
  const onDisconnect = (e) => { if (device && e.device === device) detach(); };
  const matches = (d) => filters.length === 0 || filters.some((f) =>
    (f.vendorId == null || f.vendorId === d.vendorId) && (f.productId == null || f.productId === d.productId));

  function detach() {
    if (!device) return;
    device.removeEventListener('inputreport', onReport);
    if (device.opened && typeof device.close === 'function') device.close().catch(() => {});
    device = null;
    s.connected = false;
    lin[0] = lin[1] = lin[2] = ang[0] = ang[1] = ang[2] = 0;
  }

  async function attach(d) {
    detach();
    try { if (!d.opened) await d.open(); }
    catch (e) { console.error('[host] hid: open() failed: ' + e.message + '.'); return false; }
    device = d;
    d.addEventListener('inputreport', onReport);
    s.connected = true;
    return true;
  }

  Object.assign(s, {
    /** Whether WebHID exists and requestDevice is allowed here. */
    available: !!(hid && typeof hid.requestDevice === 'function') && _hidAllowed(),
    /** Whether a device is open and reporting. */
    connected: false,

    /**
     * Prompt for a device (a user gesture is required) and attach the choice.
     * @returns {Promise<boolean>} attached
     */
    async connect() {
      if (!s.available) { console.error('[host] hid: WebHID is unavailable here (a top-level Chromium document over https or localhost).'); return false; }
      let devices;
      try { devices = await hid.requestDevice({ filters }); }
      catch (e) { console.error('[host] hid: requestDevice rejected: ' + e.message + '.'); return false; }
      if (!devices || !devices.length) return false;
      return attach(devices[0]);
    },

    /**
     * Attach a device this origin was already granted, without a prompt.
     * @returns {Promise<boolean>} attached
     */
    async resume() {
      if (!hid || typeof hid.getDevices !== 'function') return false;
      let devices;
      try { devices = await hid.getDevices(); } catch (_) { return false; }
      const d = (devices || []).find(matches);
      return d ? attach(d) : false;
    },

    /** Close the device, remove every listener, unregister from the host. */
    dispose() {
      detach();
      if (hid && typeof hid.removeEventListener === 'function') hid.removeEventListener('disconnect', onDisconnect);
      host.players.remove(player);
      host.unregister(s);
      return s;
    },
  });

  /** The open HIDDevice, or null. */
  Object.defineProperty(s, 'device', { get: () => device, enumerable: true });

  const player = { tick() { feed(); return true; } };
  host.players.add(player);
  if (hid && typeof hid.addEventListener === 'function') hid.addEventListener('disconnect', onDisconnect);
  if (o.bind) s.bind(o.bind);
  if (s.available && o.resume !== false) s.resume();
  return host.register(s);
}

/**
 * The default gamepad map, the standard layout: left stick → lin[0] / lin[1],
 * right stick → ang[1] / ang[0], the triggers → lin[2] (right minus left).
 */
export const GAMEPAD_MAP = { lin: [0, 1, { buttons: [6, 7] }], ang: [3, 2, null] };

function _lane(gp, spec) {
  if (spec == null) return 0;
  if (typeof spec === 'number') { const v = gp.axes[spec]; return typeof v === 'number' ? v : 0; }
  if (spec.buttons) {
    const n = gp.buttons[spec.buttons[0]], p = gp.buttons[spec.buttons[1]];
    return (p ? p.value : 0) - (n ? n.value : 0);
  }
  if (spec.button) { const b = gp.buttons[spec.button]; return b ? b.value : 0; }
  return 0;
}

/**
 * A Gamepad rate stream, polled once per tick.
 *
 * @param {object} host
 * @param {{ index?:number, map?:object, bind?:object, gamepads?:function }} [opts]
 *        index: which gamepad (default: the first connected). map: { lin,
 *        ang }, each three lane specs — an axis index, { buttons: [neg,
 *        pos] }, { button } or null (default GAMEPAD_MAP). bind: a helm to
 *        bind at once. gamepads: the poll (default navigator.getGamepads) —
 *        the seam a test fills.
 * @returns {object} The stream: { available, connected, index, lin, ang,
 *          bind(helm), unbind(), dispose() }.
 */
export function createGamepad(host, opts) {
  const o = opts || {};
  const nav = _nav();
  const poll = o.gamepads || (nav && typeof nav.getGamepads === 'function' ? () => nav.getGamepads() : null);
  const map = o.map || GAMEPAD_MAP;
  const lin = [0, 0, 0], ang = [0, 0, 0];
  const { s, feed } = _stream(host, lin, ang);

  Object.assign(s, {
    /** Whether the Gamepad API exists. */
    available: !!poll,
    /** Whether the last poll found a gamepad. */
    connected: false,
    /** The gamepad index polled, or null for the first connected. */
    index: o.index ?? null,
    /** Stop polling, unregister from the host. */
    dispose() { host.players.remove(player); host.unregister(s); return s; },
  });

  const player = {
    tick() {
      let gp = null;
      if (poll) {
        const list = poll() || [];
        if (s.index != null) gp = list[s.index] || null;
        else for (let i = 0; i < list.length; i++) if (list[i]) { gp = list[i]; break; }
      }
      s.connected = !!gp;
      for (let i = 0; i < 3; i++) {
        lin[i] = gp ? _lane(gp, map.lin[i]) : 0;
        ang[i] = gp ? _lane(gp, map.ang[i]) : 0;
      }
      feed();
      return true;
    },
  };
  host.players.add(player);
  if (o.bind) s.bind(o.bind);
  return host.register(s);
}

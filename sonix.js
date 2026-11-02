'use strict';
/*
 * Клавиатуры платформы Sonix SN32F2xx / DriveAll: MSI Forge GK600 TKL Wireless, Womier SK80 PRO,
 * Xinmeng M87 Pro, Aula F98 Pro и др.
 * Канал настроек — vendor-коллекция usagePage 0xFF13 (интерфейс MI_03), feature report ID 0, 64 байта.
 * Протокол подсветки — по драйверу Womier SK80 (MIT): https://github.com/BaylieBuffel/womier-sk80
 * ID GK600 — по https://github.com/Iroamstaff/gk600-tft-gif-usb
 *   кадр: команда в начале, байты 62/63 = AA 55
 *   начать 04 18 -> подготовка 04 13 [8]=01 -> данные -> применить 04 02 -> завершить 04 F0
 *   данные: [0] режим 0..21 (0 = выкл), [1..3] RGB, [8] радуга, [9] яркость 0..5,
 *           [10] скорость 0..5, [11] направление, [14..15] 55 AA
 * На GK600 не проверялось — команды уходят только по кнопке в интерфейсе.
 */
const HID = require('node-hid');
const EventEmitter = require('events');

const USAGE_PAGE = 0xff13;
// 05AC:024F — Mac-режим SK80; без коллекции FF13 (настоящая клавиатура Apple) не подходит
const MODELS = [
  { vid: 0x0db0, pid: 0xea47, name: 'MSI Forge GK600 TKL Wireless' },
  { vid: 0x05ac, pid: 0x024f, name: 'Womier SK80 (Sonix)' },
];
const DELAY = 35;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (a) => Array.from(a).map((x) => x.toString(16).padStart(2, '0')).join(' ');
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v | 0));

function frame(bytes, trailer = true) {
  const b = Buffer.alloc(64);
  bytes.forEach((v, i) => { if (v !== undefined) b[i] = v & 0xff; });
  if (trailer) { b[62] = 0xaa; b[63] = 0x55; }
  return b;
}

function encodeLight(s) {
  const mode = clamp(s.mode, 0, 21);
  const b = new Array(16).fill(0);
  b[0] = mode;
  if (mode !== 0) {
    const [r, g, bl] = Array.isArray(s.rgb) ? s.rgb : [255, 255, 255];
    b[1] = r; b[2] = g; b[3] = bl;
    b[8] = s.rainbow ? 1 : 0;
    b[9] = clamp(s.brightness, 0, 5);
    b[10] = clamp(s.speed, 0, 5);
    b[11] = s.direction ? 1 : 0;
  }
  b[14] = 0x55; b[15] = 0xaa;
  return frame(b);
}

class Sonix extends EventEmitter {
  constructor() {
    super();
    this.dev = null;
    this.path = null;
    this.state = { connected: false };
    this.timer = null;
    this.queue = Promise.resolve();
  }

  start() {
    this.poll();
    this.timer = setInterval(() => this.poll(), 2000);
  }
  stop() {
    clearInterval(this.timer);
    this._drop();
  }

  log(kind, msg) { this.emit('log', { t: Date.now(), kind, msg: 'Sonix ' + msg }); }
  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  poll() {
    const all = HID.devices();
    const d = all.find((x) => x.usagePage === USAGE_PAGE && MODELS.some((m) => m.vid === x.vendorId && m.pid === x.productId));
    if (this.dev) {
      if (!d || d.path !== this.path) this._drop();
      return;
    }
    if (!d) return;
    try {
      this.dev = new HID.HID(d.path);
      this.path = d.path;
      const m = MODELS.find((x) => x.vid === d.vendorId && x.pid === d.productId);
      const name = (d.product && !/^gaming keyboard$/i.test(d.product)) ? d.product : m.name;
      this.log('OK', `подключено: ${name}`);
      this.setState({ connected: true, name, vid: d.vendorId, pid: d.productId });
    } catch (e) {
      this.log('ERR', 'open: ' + e.message);
    }
  }

  _drop() {
    if (this.dev) { try { this.dev.close(); } catch (_) { /* ignore */ } }
    const was = !!this.dev;
    this.dev = null; this.path = null;
    if (was || this.state.connected) this.setState({ connected: false });
  }

  async _send(buf, readback) {
    this.log('TX', hex(buf.subarray(0, 16)));
    this.dev.sendFeatureReport([0, ...buf]);
    await sleep(DELAY);
    if (readback) {
      try {
        const r = this.dev.getFeatureReport(0, 65);
        this.log('RX', hex(r.slice(0, 16)));
      } catch (_) { /* ответ не обязателен */ }
      await sleep(DELAY);
    }
  }

  /** Только по кнопке в интерфейсе */
  setLight(s) {
    const run = async () => {
      if (!this.dev) throw new Error('Клавиатура Sonix не подключена');
      try {
        await this._send(frame([0x04, 0x18]), true);
        await this._send(frame([0x04, 0x13, 0, 0, 0, 0, 0, 0, 0x01]), true);
        await this._send(encodeLight(s), false);
        await this._send(frame([0x04, 0x02]), true);
        await this._send(frame([0x04, 0xf0]), false);
      } catch (e) {
        this._drop();
        throw e;
      }
      return true;
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }
}

module.exports = { Sonix, SONIX_MODELS: MODELS, encodeSonixLight: encodeLight };

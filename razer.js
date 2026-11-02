'use strict';
/*
 * Мыши Razer (VID 0x1532). Протокол — по драйверу openrazer:
 * https://github.com/openrazer/openrazer (driver/razercommon.*, razerchromacommon.c)
 *   feature report ID 0, 90 байт:
 *   [0] статус (0x02 = успех) [1] transaction id [2..3] осталось пакетов [4] тип протокола
 *   [5] размер данных [6] класс команды [7] id команды [8..87] аргументы [88] CRC = XOR байтов 2..87
 *   DPI: чтение 04/85, запись 04/05 [varstore, X(BE16), Y(BE16)]
 *   частота: 00/85 и 00/05 (1000=01, 500=02, 125=08); HyperPolling: 00/C0 и 00/40 (8000=01 … 125=40)
 *   батарея: 07/80 (аргумент [1] 0..255), зарядка 07/84
 * Transaction id у моделей разный (0x1F, 0xFF, 0x3F) — подбираем безопасным чтением версии прошивки.
 * На реальной мыши Razer не проверялось — запись только по кнопкам интерфейса.
 */
const HID = require('node-hid');
const EventEmitter = require('events');

const VID = 0x1532;
const TIDS = [0x1f, 0xff, 0x3f];
const LEGACY = { 1000: 0x01, 500: 0x02, 125: 0x08 };
const HYPER = { 8000: 0x01, 4000: 0x02, 2000: 0x04, 1000: 0x08, 500: 0x10, 250: 0x20, 125: 0x40 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function report(tid, cls, id, size, args = []) {
  const b = Buffer.alloc(90);
  b[1] = tid; b[5] = size; b[6] = cls; b[7] = id;
  args.forEach((v, i) => { b[8 + i] = v & 0xff; });
  let crc = 0;
  for (let i = 2; i < 88; i++) crc ^= b[i];
  b[88] = crc;
  return b;
}

class Razer extends EventEmitter {
  constructor() {
    super();
    this.devs = new Map(); // ключ VID:PID -> { dev, path, tid, info }
    this.bad = new Set();   // пути, которые не ответили
    this.state = { devices: [] };
    this.queue = Promise.resolve();
    this.timer = null;
  }

  start() {
    this.poll();
    this.timer = setInterval(() => this.poll(), 4000);
  }
  stop() {
    clearInterval(this.timer);
    for (const k of [...this.devs.keys()]) this._drop(k);
  }

  log(kind, msg) { this.emit('log', { t: Date.now(), kind, msg: 'Razer ' + msg }); }
  _emit() {
    this.state = { devices: [...this.devs.values()].map((c) => c.info) };
    this.emit('state', this.state);
  }

  _run(fn) {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
  }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const all = HID.devices().filter((d) => d.vendorId === VID);
      const keys = new Set(all.map((d) => d.productId.toString(16)));
      for (const k of [...this.devs.keys()]) if (!keys.has(k)) this._drop(k);
      // мышь Razer: есть мышиная коллекция (1/2); команды принимает обычно интерфейс 0
      const byPid = new Map();
      for (const d of all) {
        const k = d.productId.toString(16);
        if (!byPid.has(k)) byPid.set(k, []);
        byPid.get(k).push(d);
      }
      for (const [k, list] of byPid) {
        if (this.devs.has(k) || !list.some((d) => d.usagePage === 1 && d.usage === 2)) continue;
        await this._run(() => this._probe(k, list));
      }
      const now = Date.now();
      for (const c of this.devs.values()) {
        if (now - c.lastRead > 60000) await this._run(() => this._read(c)).catch(() => {});
      }
    } catch (e) {
      this.log('ERR', e.message);
    } finally {
      this.polling = false;
    }
  }

  async _xfer(c, cls, id, size, args, tid = c.tid) {
    const req = report(tid, cls, id, size, args);
    for (let attempt = 0; attempt < 4; attempt++) {
      c.dev.sendFeatureReport([0, ...req]);
      await sleep(attempt ? 60 : 25);
      const r = Buffer.from(c.dev.getFeatureReport(0, 91)).subarray(1);
      if (r[6] !== cls || r[7] !== id) continue;
      if (r[0] === 0x01 || r[0] === 0x00) continue; // занят / ещё нет ответа
      if (r[0] !== 0x02) throw Object.assign(new Error('статус ' + r[0]), { status: r[0] });
      return r;
    }
    throw new Error('нет ответа');
  }

  async _probe(key, list) {
    // интерфейс 0 первым, остальные по очереди
    const paths = list.slice().sort((a, b) => (a.interface || 0) - (b.interface || 0)).filter((d) => !this.bad.has(d.path));
    for (const d of paths) {
      let dev;
      try { dev = new HID.HID(d.path); } catch (_) { this.bad.add(d.path); continue; }
      const c = { dev, path: d.path, tid: 0, lastRead: 0 };
      for (const tid of TIDS) {
        try {
          const fw = await this._xfer(c, 0x00, 0x81, 0x02, [], tid);
          c.tid = tid;
          c.info = {
            id: key, src: 'razer', name: d.product || 'Razer', vid: VID, pid: d.productId,
            firmware: `${fw[8]}.${fw[9]}`, online: true,
          };
          this.devs.set(key, c);
          this.log('OK', `${c.info.name}: интерфейс ${d.interface}, transaction id 0x${tid.toString(16)}, прошивка ${c.info.firmware}`);
          await this._read(c);
          return;
        } catch (_) { /* следующий transaction id */ }
      }
      try { dev.close(); } catch (_) { /* ignore */ }
      this.bad.add(d.path);
    }
  }

  async _read(c) {
    c.lastRead = Date.now();
    const i = c.info;
    try {
      const dpi = await this._xfer(c, 0x04, 0x85, 0x07, [0x00]);
      const x = dpi.readUInt16BE(9);
      i.dpi = { value: x, def: null, min: 100, max: 30000, step: 50, list: null };
    } catch (_) { i.dpi = null; }
    i.rate = null;
    try {
      const r = await this._xfer(c, 0x00, 0xc0, 0x01, []);
      const code = r[9] || r[8];
      const hz = Number(Object.keys(HYPER).find((h) => HYPER[h] === code)) || null;
      i.rate = { hz, supported: Object.keys(HYPER).map(Number).sort((a, b) => a - b), hyper: true };
    } catch (_) {
      try {
        const r = await this._xfer(c, 0x00, 0x85, 0x01, []);
        const hz = Number(Object.keys(LEGACY).find((h) => LEGACY[h] === r[8])) || null;
        i.rate = { hz, supported: [125, 500, 1000], hyper: false };
      } catch (_) { /* частоту не отдаёт */ }
    }
    try {
      const b = await this._xfer(c, 0x07, 0x80, 0x02, []);
      const ch = await this._xfer(c, 0x07, 0x84, 0x02, []).catch(() => null);
      i.battery = { percent: Math.max(1, Math.round((b[9] / 255) * 100)), level: null, charging: ch && ch[9] ? 'charging' : 'discharging' };
    } catch (_) { i.battery = null; } // проводная мышь
    i.online = true;
    this._emit();
  }

  _drop(key) {
    const c = this.devs.get(key);
    if (!c) return;
    try { c.dev.close(); } catch (_) { /* ignore */ }
    this.devs.delete(key);
    this.bad.clear();
    this._emit();
  }

  _get(key) {
    const c = this.devs.get(key);
    if (!c) throw new Error('Мышь Razer не подключена');
    return c;
  }

  setDpi(key, dpi) {
    return this._run(async () => {
      const c = this._get(key);
      dpi = Math.round(Number(dpi));
      if (!(dpi >= 100 && dpi <= 30000)) throw new Error('DPI вне допустимого диапазона');
      this.log('TX', `DPI -> ${dpi}`);
      await this._xfer(c, 0x04, 0x05, 0x07, [0x01, dpi >> 8, dpi & 255, dpi >> 8, dpi & 255, 0, 0]);
      await this._read(c);
      if (c.info.dpi && c.info.dpi.value !== dpi) throw new Error('Мышь не приняла DPI (прочитано ' + c.info.dpi.value + ')');
      return this.state.devices;
    });
  }

  setRate(key, hz) {
    return this._run(async () => {
      const c = this._get(key);
      const r = c.info.rate;
      if (!r || !r.supported.includes(hz)) throw new Error('Недопустимая частота');
      this.log('TX', `частота -> ${hz} Гц`);
      if (r.hyper) {
        await this._xfer(c, 0x00, 0x40, 0x02, [0x00, HYPER[hz]]);
        await this._xfer(c, 0x00, 0x40, 0x02, [0x01, HYPER[hz]]).catch(() => {}); // мышь за донглом
      } else {
        await this._xfer(c, 0x00, 0x05, 0x01, [LEGACY[hz]]);
      }
      await this._read(c);
      if (c.info.rate && c.info.rate.hz !== hz) throw new Error('Мышь не приняла частоту (прочитано ' + c.info.rate.hz + ' Гц)');
      return this.state.devices;
    });
  }
}

module.exports = { Razer, razerReport: report };

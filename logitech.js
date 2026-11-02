'use strict';
/*
 * Мыши Logitech по HID++ 2.0 (через приёмник LIGHTSPEED/Unifying или по кабелю).
 * Long report 0x11, 20 байт, vendor-коллекция usagePage 0xFF00 / usage 2:
 *   [0x11, индекс устройства, индекс фичи, (функция << 4) | swId, параметры…]
 * Ошибка HID++ 2.0: [0x11, idx, 0xFF, фича, функция|swId, код].
 * Используемые фичи: 0x0005 имя, 0x1004 батарея, 0x2201 DPI, 0x8060 частота опроса.
 * Проверено на PRO X Wireless (приёмник C547): чтение и смена DPI. Запись — только по кнопкам интерфейса.
 */
const HID = require('node-hid');
const EventEmitter = require('events');

const VID = 0x046d;
const SW = 0x0b; // свой swId, чтобы не путать ответы с запросами G HUB
const FEAT = { NAME: 0x0005, UBATT: 0x1004, DPI: 0x2201, RATE: 0x8060 };
const LEVELS = { 1: 'critical', 2: 'low', 4: 'good', 8: 'full' };
const CHARGE = { 0: 'discharging', 1: 'charging', 2: 'charging', 3: 'full', 4: 'error' };

const hex = (a) => Array.from(a).map((x) => x.toString(16).padStart(2, '0')).join(' ');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Logitech extends EventEmitter {
  constructor() {
    super();
    this.dev = null;
    this.path = null;
    this.pending = null;
    this.queue = Promise.resolve();
    this.state = { connected: false, devices: [] };
    this.timer = null;
    this.lastScan = 0;
    this.lastRefresh = 0;
  }

  start() {
    this.poll();
    this.timer = setInterval(() => this.poll(), 3000);
  }
  stop() {
    clearInterval(this.timer);
    this._drop();
  }

  log(kind, msg) { this.emit('log', { t: Date.now(), kind, msg: 'Logitech ' + msg }); }
  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  async poll() {
    if (this.busyPoll) return;
    this.busyPoll = true;
    try {
      const info = HID.devices().find((d) => d.vendorId === VID && d.usagePage === 0xff00 && d.usage === 2);
      if (this.dev && (!info || info.path !== this.path)) this._drop();
      if (!this.dev && info) await this._open(info);
      if (!this.dev) return;
      const now = Date.now();
      // пустой приёмник (мышь спит/выключена) — пересканируем раз в 15 с, заряд обновляем раз в минуту
      if (!this.state.devices.length && now - this.lastScan > 15000) await this.scan();
      else if (this.state.devices.length && now - this.lastRefresh > 60000) await this.refresh();
    } catch (e) {
      this.log('ERR', e.message);
    } finally {
      this.busyPoll = false;
    }
  }

  // HIDAsync: чтение в отдельном нативном потоке. У синхронного HID запись ждёт
  // висящее чтение, и ответы приходят с задержкой больше секунды.
  async _open(info) {
    try {
      this.dev = await HID.HIDAsync.open(info.path);
    } catch (e) {
      this.log('ERR', 'open: ' + e.message);
      return;
    }
    this.path = info.path;
    this.receiver = /receiver/i.test(info.product || '') || info.productId === 0xc547 || info.productId === 0xc539 || info.productId === 0xc52b;
    this.dev.on('data', (d) => this._onData(d));
    this.dev.on('error', () => this._drop());
    this.log('OK', 'подключено: ' + (info.product || info.productId.toString(16)));
    this.setState({ connected: true, devices: [] });
    this.lastScan = 0;
  }

  _drop() {
    if (this.dev) this.dev.close().catch(() => {});
    const was = !!this.dev;
    this.dev = null; this.path = null;
    if (this.pending) { this.pending.reject(new Error('Устройство отключено')); this.pending = null; }
    if (was || this.state.connected) this.setState({ connected: false, devices: [] });
  }

  _onData(d) {
    const p = this.pending;
    if (!p || d[0] !== 0x11 || d[1] !== p.idx) return;
    if (d[2] === 0xff && d[3] === p.feat && d[4] === ((p.fn << 4) | SW)) { this.pending = null; p.reject(Object.assign(new Error('HID++ ошибка ' + d[5]), { code: d[5] })); return; }
    if (d[2] === p.feat && d[3] === ((p.fn << 4) | SW)) { this.pending = null; p.resolve(Buffer.from(d.slice(4))); }
  }

  /** один запрос HID++ 2.0; запросы идут строго по очереди */
  req(idx, feat, fn, params = [], timeout = 400) {
    const run = () => new Promise((resolve, reject) => {
      if (!this.dev) { reject(new Error('Приёмник Logitech не подключён')); return; }
      const b = new Array(20).fill(0);
      b[0] = 0x11; b[1] = idx; b[2] = feat; b[3] = (fn << 4) | SW;
      params.forEach((v, i) => { b[4 + i] = v; });
      const t = setTimeout(() => { if (this.pending && this.pending.t === t) { this.pending = null; reject(Object.assign(new Error('нет ответа'), { timeout: true })); } }, timeout);
      this.pending = { idx, feat, fn, t, resolve: (v) => { clearTimeout(t); resolve(v); }, reject: (e) => { clearTimeout(t); reject(e); } };
      this.dev.write(b).catch((e) => { this.pending = null; clearTimeout(t); this._drop(); reject(e); });
    });
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  async featureIndex(idx, id) {
    const r = await this.req(idx, 0x00, 0, [id >> 8, id & 255]);
    return r[0] || 0;
  }

  async scan() {
    this.lastScan = Date.now();
    const slots = this.receiver ? [1, 2, 3, 4, 5, 6] : [0xff];
    const found = [];
    for (const idx of slots) {
      try {
        const ping = await this.req(idx, 0x00, 1, [0, 0, 0xaa], 300);
        const d = { idx, protocol: `${ping[0]}.${ping[1]}`, f: {} };
        for (const [k, id] of Object.entries(FEAT)) d.f[k] = await this.featureIndex(idx, id);
        d.name = await this.readName(d);
        found.push(d);
        this.log('OK', `устройство ${idx}: ${d.name} (HID++ ${d.protocol})`);
      } catch (_) { /* слот пуст или устройство спит */ }
    }
    this.devs = found;
    await this.refresh();
  }

  async readName(d) {
    if (!d.f.NAME) return 'Устройство Logitech';
    const len = (await this.req(d.idx, d.f.NAME, 0))[0];
    let s = '';
    while (s.length < len) {
      const chunk = (await this.req(d.idx, d.f.NAME, 1, [s.length])).toString('latin1').replace(/\0.*$/s, '');
      if (!chunk) break;
      s += chunk;
    }
    return s.slice(0, len);
  }

  async readDevice(d) {
    const out = { idx: d.idx, name: d.name, protocol: d.protocol };
    try {
      if (d.f.UBATT) {
        const r = await this.req(d.idx, d.f.UBATT, 1);
        out.battery = { percent: r[0] || null, level: LEVELS[r[1]] || null, charging: CHARGE[r[2]] || 'unknown' };
      }
      if (d.f.DPI) {
        const list = await this.req(d.idx, d.f.DPI, 1, [0]);
        const now = await this.req(d.idx, d.f.DPI, 2, [0]);
        out.dpi = { value: now.readUInt16BE(1), def: now.readUInt16BE(3), ...decodeDpiList(list) };
      }
      if (d.f.RATE) {
        const mask = (await this.req(d.idx, d.f.RATE, 0))[0];
        const ms = (await this.req(d.idx, d.f.RATE, 1))[0];
        const supported = [];
        for (let i = 0; i < 8; i++) if (mask & (1 << i)) supported.push(i + 1);
        out.rate = { ms, supported };
      }
      out.online = true;
    } catch (e) {
      out.online = false;
      out.error = e.message;
    }
    return out;
  }

  async refresh() {
    this.lastRefresh = Date.now();
    const devices = [];
    for (const d of this.devs || []) devices.push(await this.readDevice(d));
    this.setState({ devices });
    return devices;
  }

  _find(idx) {
    const d = (this.devs || []).find((x) => x.idx === idx);
    if (!d) throw new Error('Мышь не найдена — пошевелите её, чтобы разбудить');
    return d;
  }

  async setDpi(idx, dpi) {
    const d = this._find(idx);
    if (!d.f.DPI) throw new Error('Мышь не поддерживает смену DPI');
    const cur = this.state.devices.find((x) => x.idx === idx);
    const lim = cur && cur.dpi;
    dpi = Math.round(Number(dpi));
    if (!lim || dpi < lim.min || dpi > lim.max) throw new Error('DPI вне допустимого диапазона');
    this.log('TX', `DPI ${idx} -> ${dpi}`);
    await this.req(idx, d.f.DPI, 3, [0, dpi >> 8, dpi & 255]);
    await sleep(50);
    const now = await this.req(idx, d.f.DPI, 2, [0]);
    if (now.readUInt16BE(1) !== dpi) throw new Error('Мышь не приняла DPI (прочитано ' + now.readUInt16BE(1) + ')');
    return this.refresh();
  }

  async setRate(idx, ms) {
    const d = this._find(idx);
    if (!d.f.RATE) throw new Error('Мышь не поддерживает смену частоты');
    const cur = this.state.devices.find((x) => x.idx === idx);
    if (!cur || !cur.rate || !cur.rate.supported.includes(ms)) throw new Error('Недопустимая частота');
    this.log('TX', `частота ${idx} -> ${ms} мс`);
    await this.req(idx, d.f.RATE, 2, [ms]);
    await sleep(50);
    const now = (await this.req(idx, d.f.RATE, 1))[0];
    if (now !== ms) throw new Error('Мышь не приняла частоту (прочитано ' + now + ' мс)');
    return this.refresh();
  }
}

/** список DPI: BE16-значения до нуля; 0xE000|шаг означает «от предыдущего до следующего с шагом» */
function decodeDpiList(r) {
  const vals = [];
  for (let i = 1; i + 1 < r.length; i += 2) {
    const v = r.readUInt16BE(i);
    if (!v) break;
    vals.push(v);
  }
  let step = 0;
  const plain = [];
  vals.forEach((v) => { if ((v >> 13) === 7) step = v & 0x1fff; else plain.push(v); });
  return { min: Math.min(...plain), max: Math.max(...plain), step: step || null, list: step ? null : plain };
}

module.exports = { Logitech, decodeDpiList, hex };

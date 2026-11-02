'use strict';
/*
 * Мыши Logitech по HID++ 2.0 (приёмники Unifying / Lightspeed / Bolt или кабель).
 * Long report 0x11, 20 байт, vendor-коллекция usagePage 0xFF00 / usage 2:
 *   [0x11, индекс устройства, индекс фичи, (функция << 4) | swId, параметры…]
 * Ошибка HID++ 2.0: [0x11, idx, 0xFF, фича, функция|swId, код].
 * Фичи (номера функций — как в Solaar):
 *   0x0005 имя
 *   0x1004 батарея (unified), 0x1000 батарея (уровень), 0x1001 батарея (напряжение)
 *   0x2201 DPI;            0x2202 расширенный DPI (Superlight 2, G502 X…): список 0x2, чтение 0x5, запись 0x6
 *   0x8060 частота 1–8 мс; 0x8061 расширенная частота до 8000 Гц: маска 0x1, чтение 0x2, запись 0x3
 *   0x8100 встроенные профили: чтение режима 0x2 (1 = профили включены), запись 0x1 (2 = управление с ПК)
 * Проверено на PRO X Wireless (0x2201/0x8060). Запись — только по кнопкам интерфейса.
 */
const HID = require('node-hid');
const EventEmitter = require('events');

const VID = 0x046d;
const SW = 0x0b; // свой swId, чтобы не путать ответы с запросами G HUB
const FEAT = {
  NAME: 0x0005, UBATT: 0x1004, BATT: 0x1000, VOLT: 0x1001,
  DPI: 0x2201, DPI2: 0x2202, RATE: 0x8060, RATE2: 0x8061, ONBOARD: 0x8100,
};
// приёмники: Unifying, Nano, Lightspeed, Bolt
const RECEIVERS = new Set([0xc52b, 0xc52f, 0xc531, 0xc532, 0xc534, 0xc539, 0xc53a, 0xc53d, 0xc53f, 0xc541, 0xc545, 0xc547, 0xc548, 0xc54d]);
const LEVELS = { 1: 'critical', 2: 'low', 4: 'good', 8: 'full' };
const CHARGE = { 0: 'discharging', 1: 'charging', 2: 'charging', 3: 'full', 4: 'error' };
const RATE2_HZ = [125, 250, 500, 1000, 2000, 4000, 8000]; // биты маски 0x8061: 8 мс … 125 мкс

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
    this.tried = new Set(); // пути, где устройств не нашлось — пробуем следующий
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
      const cands = HID.devices().filter((d) => d.vendorId === VID && d.usagePage === 0xff00 && d.usage === 2);
      if (this.dev && !cands.some((d) => d.path === this.path)) this._drop();
      if (!this.dev) {
        // приёмник и мышь по кабелю — разные пути; берём ещё не опробованный
        const info = cands.find((d) => !this.tried.has(d.path)) || cands[0];
        if (!cands.some((d) => !this.tried.has(d.path))) this.tried.clear();
        if (info) await this._open(info);
      }
      if (!this.dev) return;
      const now = Date.now();
      if (!this.state.devices.length && now - this.lastScan > 15000) {
        await this.scan();
        // на этом пути ничего — при следующем опросе попробуем другой (если он есть)
        if (!this.state.devices.length && cands.length > 1) { this.tried.add(this.path); this._drop(); }
      } else if (this.state.devices.length) {
        // спящую мышь проверяем часто — пошевелили, и данные появились; бодрую — раз в минуту (заряд)
        const sleeping = this.state.devices.some((d) => !d.online);
        if (now - this.lastRefresh > (sleeping ? 5000 : 60000)) await this.refresh();
      }
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
      this.tried.add(info.path);
      return;
    }
    this.path = info.path;
    this.receiver = RECEIVERS.has(info.productId) || /receiver/i.test(info.product || '');
    this.dev.on('data', (d) => this._onData(d));
    this.dev.on('error', () => this._drop());
    this.log('OK', `подключено: ${info.product || info.productId.toString(16)} (${this.receiver ? 'приёмник' : 'напрямую'})`);
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
        const has = Object.entries(d.f).filter(([, v]) => v).map(([k]) => k).join(', ');
        this.log('OK', `устройство ${idx}: ${d.name} (HID++ ${d.protocol}; ${has})`);
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

  async readBattery(d) {
    if (d.f.UBATT) {
      const r = await this.req(d.idx, d.f.UBATT, 1);
      return { percent: r[0] || null, level: LEVELS[r[1]] || null, charging: CHARGE[r[2]] || 'unknown' };
    }
    if (d.f.BATT) {
      const r = await this.req(d.idx, d.f.BATT, 0);
      const st = { 0: 'discharging', 1: 'charging', 2: 'charging', 3: 'full', 4: 'charging' }[r[2]] || 'unknown';
      return { percent: r[0] || null, level: null, charging: st };
    }
    if (d.f.VOLT) {
      const r = await this.req(d.idx, d.f.VOLT, 0);
      const mv = r.readUInt16BE(0);
      // грубая оценка по напряжению Li-ion: 3.5 В ≈ 0 %, 4.1 В ≈ 100 %
      const percent = Math.max(1, Math.min(100, Math.round(((mv - 3500) / 600) * 100)));
      return { percent, approx: true, mv, level: null, charging: r[2] & 0x80 ? 'charging' : 'discharging' };
    }
    return null;
  }

  async readDpi(d) {
    if (d.f.DPI) {
      const list = await this.req(d.idx, d.f.DPI, 1, [0]);
      const now = await this.req(d.idx, d.f.DPI, 2, [0]);
      return { value: now.readUInt16BE(1), def: now.readUInt16BE(3), ...decodeDpiList(list, 1) };
    }
    if (d.f.DPI2) {
      // список по страницам: [датчик, направление X, страница], первые 3 байта ответа — эхо
      let bytes = Buffer.alloc(0);
      for (let page = 0; page < 16; page++) {
        const r = await this.req(d.idx, d.f.DPI2, 2, [0, 0, page]);
        bytes = Buffer.concat([bytes, r.subarray(3)]);
        if (bytes.length >= 2 && hasListEnd(bytes)) break;
      }
      const cap = await this.req(d.idx, d.f.DPI2, 1, [0]);
      const now = await this.req(d.idx, d.f.DPI2, 5, [0]);
      d.dpi2 = { hasY: !!(cap[2] & 1), lod: now[9] };
      const x = now.readUInt16BE(1);
      return { value: x || now.readUInt16BE(3), def: now.readUInt16BE(3), ...decodeDpiList(bytes, 0) };
    }
    return null;
  }

  async readRate(d) {
    if (d.f.RATE) {
      const mask = (await this.req(d.idx, d.f.RATE, 0))[0];
      const ms = (await this.req(d.idx, d.f.RATE, 1))[0];
      const supported = [];
      for (let i = 0; i < 8; i++) if (mask & (1 << i)) supported.push(Math.round(1000 / (i + 1)));
      return { hz: Math.round(1000 / ms), supported: supported.filter((h) => [125, 250, 500, 1000].includes(h)) };
    }
    if (d.f.RATE2) {
      const mask = (await this.req(d.idx, d.f.RATE2, 1)).readUInt16BE(0);
      const cur = (await this.req(d.idx, d.f.RATE2, 2))[0];
      const supported = RATE2_HZ.filter((_, i) => mask & (1 << i));
      return { hz: RATE2_HZ[cur] || null, supported };
    }
    return null;
  }

  async readDevice(d) {
    const out = { idx: d.idx, name: d.name, protocol: d.protocol };
    try {
      out.battery = await this.readBattery(d);
      out.dpi = await this.readDpi(d);
      out.rate = await this.readRate(d);
      if (d.f.ONBOARD) out.onboard = (await this.req(d.idx, d.f.ONBOARD, 2))[0] === 1;
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

  /** при включённых встроенных профилях мышь игнорирует DPI/частоту с ПК — переводим в управление с ПК */
  async _hostMode(d) {
    if (!d.f.ONBOARD) return;
    const mode = (await this.req(d.idx, d.f.ONBOARD, 2))[0];
    if (mode !== 1) return;
    this.log('TX', `устройство ${d.idx}: встроенные профили -> управление с ПК`);
    await this.req(d.idx, d.f.ONBOARD, 1, [0x02]);
    await sleep(50);
  }

  async setDpi(idx, dpi) {
    const d = this._find(idx);
    if (!d.f.DPI && !d.f.DPI2) throw new Error('Мышь не поддерживает смену DPI');
    const cur = this.state.devices.find((x) => x.idx === idx);
    const lim = cur && cur.dpi;
    dpi = Math.round(Number(dpi));
    if (!lim || dpi < lim.min || dpi > lim.max) throw new Error('DPI вне допустимого диапазона');
    await this._hostMode(d);
    this.log('TX', `DPI ${idx} -> ${dpi}`);
    let got;
    if (d.f.DPI) {
      await this.req(idx, d.f.DPI, 3, [0, dpi >> 8, dpi & 255]);
      await sleep(50);
      got = (await this.req(idx, d.f.DPI, 2, [0])).readUInt16BE(1);
    } else {
      const y = d.dpi2 && d.dpi2.hasY ? dpi : 0;
      await this.req(idx, d.f.DPI2, 6, [0, dpi >> 8, dpi & 255, y >> 8, y & 255, (d.dpi2 && d.dpi2.lod) || 0]);
      await sleep(50);
      got = (await this.req(idx, d.f.DPI2, 5, [0])).readUInt16BE(1);
    }
    if (got !== dpi) throw new Error('Мышь не приняла DPI (прочитано ' + got + ')');
    return this.refresh();
  }

  async setRate(idx, hz) {
    const d = this._find(idx);
    if (!d.f.RATE && !d.f.RATE2) throw new Error('Мышь не поддерживает смену частоты');
    const cur = this.state.devices.find((x) => x.idx === idx);
    if (!cur || !cur.rate || !cur.rate.supported.includes(hz)) throw new Error('Недопустимая частота');
    await this._hostMode(d);
    this.log('TX', `частота ${idx} -> ${hz} Гц`);
    let got;
    if (d.f.RATE) {
      const ms = Math.round(1000 / hz);
      await this.req(idx, d.f.RATE, 2, [ms]);
      await sleep(50);
      got = Math.round(1000 / (await this.req(idx, d.f.RATE, 1))[0]);
    } else {
      await this.req(idx, d.f.RATE2, 3, [RATE2_HZ.indexOf(hz)]);
      await sleep(50);
      got = RATE2_HZ[(await this.req(idx, d.f.RATE2, 2))[0]];
    }
    if (got !== hz) throw new Error('Мышь не приняла частоту (прочитано ' + got + ' Гц)');
    return this.refresh();
  }
}

function hasListEnd(b) {
  for (let i = 0; i + 1 < b.length; i += 2) if (!b.readUInt16BE(i)) return true;
  return false;
}

/** список DPI: BE16-значения до нуля; 0xE000|шаг означает «от предыдущего до следующего с шагом» */
function decodeDpiList(r, offset = 1) {
  const vals = [];
  for (let i = offset; i + 1 < r.length; i += 2) {
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

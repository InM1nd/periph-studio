'use strict';
/*
 * Клавиатуры Keydous / Royuan. Проверено на NJ80-AP (VID 0x3151, PID 0x4003, плата 415);
 * модели определяются по ID платы из profiles/royuan.json, запись — только семейству yc200.
 * Протокол взят из официального драйвера Keydous (семейство YC200):
 *   - feature report, report ID 0, 64 байта данных (65 с ID)
 *   - byte[0] = команда; контрольная сумма:
 *       "se": byte[7] = 255 - (sum(byte[0..6]) & 255)   (чтение и большинство записей)
 *       "ei": byte[8] = 255 - (sum(byte[0..7]) & 255)   (запись подсветки)
 *   - ответ читается get_feature_report через ~10-20 мс, byte[0] эхо команды
 */
const HID = require('node-hid');
const EventEmitter = require('events');

// Модели Royuan: таблица из драйвера Keydous (tools/gen-royuan-profiles.js) + NJ80-AP новой ревизии
const PROFILES = require('./profiles/royuan.json');
const SUPPORTED = PROFILES.usbIds;
const MODELS = [...PROFILES.extra, ...PROFILES.models];

/** Модель по ID платы (ответ 0x8F). Запись разрешена только семейству yc200 — его протокол проверен на NJ80. */
function modelFor(board, vid, pid) {
  const m = MODELS.find((x) => x.board === board && x.vid === vid && x.pid === pid) || MODELS.find((x) => x.board === board);
  if (!m) return { board, name: `Royuan, плата ${board}`, family: 'unknown', writable: false, keymap: false, modes: null };
  return {
    board, name: m.name, family: m.family, cls: m.cls, modes: m.modes,
    writable: m.family === 'yc200',
    keymap: board === 415, // схема клавиш и заводская матрица есть только для NJ80-AP
    verified: !!m.verified,
  };
}

// Команды семейства RY108 -> YZWCommon -> YC200Common (запись N, чтение N | 0x80).
// Проверено на NJ80: 0x87 отдаёт подсветку, 0x84 — частоту опроса.
const CMD = {
  GET_REV: 0x80, GET_INFO: 0x8f, RESET: 0x02, GET_BATTERY: 0x83,
  SET_REPORT: 0x04, GET_REPORT: 0x84,
  GET_PROFILE: 0x85,
  SET_KBOPTION: 0x06, GET_KBOPTION: 0x86,
  SET_LED: 0x07, GET_LED: 0x87,
  SET_KEYMATRIX: 0x09, GET_KEYMATRIX: 0x89,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (a) => Array.from(a).map((x) => x.toString(16).padStart(2, '0')).join(' ');

function se(buf) {
  let s = 0;
  for (let i = 0; i < 7; i++) s += buf[i];
  buf[7] = (255 - (s & 255)) & 255;
  return buf;
}
function ei(buf) {
  let s = 0;
  for (let i = 0; i < 8; i++) s += buf[i];
  buf[8] = (255 - (s & 255)) & 255;
  return buf;
}
function cmd(op, b1 = 0, b2 = 0, b3 = 0, b4 = 0) {
  const b = Buffer.alloc(64);
  b[0] = op; b[1] = b1; b[2] = b2; b[3] = b3; b[4] = b4;
  return b;
}

/* ---------- Подсветка ---------- */
const MAXSPEED = 4;
const DAZZLE = 8; // радужный
const NORMAL = 7; // один цвет
const COMMONCOLOR = {
  0: 0xff0000, 1: 0xff8000, 2: 0xffff00, 3: 0x00ff00, 4: 0x00ffff, 5: 0x0000ff, 6: 0xff00ff,
};
const WAVEOP = { right: 0, left: 1, down: 2, up: 3 };

// id -> описание режима (из yc200CommonLayout драйвера)
const MODES = [
  { key: 'off',            idx: 0,  rgb: false, speed: false, dazzle: false },
  { key: 'alwaysOn',       idx: 1,  rgb: true,  speed: false, dazzle: true },
  { key: 'breath',         idx: 2,  rgb: true,  speed: true,  dazzle: true },
  { key: 'neon',           idx: 3,  rgb: false, speed: true,  dazzle: false },
  { key: 'wave',           idx: 4,  rgb: true,  speed: true,  dazzle: true,  options: ['right', 'left', 'down', 'up'] },
  { key: 'ripple',         idx: 5,  rgb: true,  speed: true,  dazzle: true },
  { key: 'raindrop',       idx: 6,  rgb: true,  speed: true,  dazzle: true },
  { key: 'snake',          idx: 7,  rgb: true,  speed: true,  dazzle: true,  options: ['z', 'return'] },
  { key: 'pressAction',    idx: 8,  rgb: true,  speed: true,  dazzle: true },
  { key: 'converge',       idx: 9,  rgb: true,  speed: true,  dazzle: true },
  { key: 'sineWave',       idx: 10, rgb: true,  speed: true,  dazzle: true },
  { key: 'kaleidoscope',   idx: 11, rgb: true,  speed: true,  dazzle: true,  options: ['out', 'in'] },
  { key: 'lineWave',       idx: 12, rgb: true,  speed: true,  dazzle: true,  options: ['right', 'left'] },
  { key: 'laser',          idx: 14, rgb: true,  speed: true,  dazzle: true },
  { key: 'circleWave',     idx: 15, rgb: true,  speed: true,  dazzle: true,  options: ['anti-clockwise', 'clockwise'] },
  { key: 'dazzling',       idx: 16, rgb: true,  speed: true,  dazzle: true },
  { key: 'rainDown',       idx: 17, rgb: true,  speed: true,  dazzle: true },
  { key: 'meteor',         idx: 18, rgb: true,  speed: true,  dazzle: true },
  { key: 'pressActionOff', idx: 19, rgb: true,  speed: true,  dazzle: true },
];
const MODE_BY_KEY = Object.fromEntries(MODES.map((m) => [m.key, m]));
const MODE_BY_IDX = Object.fromEntries(MODES.map((m) => [m.idx, m]));

function encodeLight(s) {
  const m = MODE_BY_KEY[s.mode];
  if (!m) throw new Error('Неизвестный режим подсветки: ' + s.mode);
  const dazzle = !!s.dazzle && m.dazzle;
  const u = dazzle ? DAZZLE : NORMAL;
  const speed = Math.max(0, Math.min(4, s.speed | 0));
  const value = Math.max(0, Math.min(4, s.brightness | 0));
  let l = 7;
  switch (m.key) {
    case 'off': l = 7; break;
    case 'neon': l = 7; break;
    case 'wave': l = ((WAVEOP[s.option] ?? WAVEOP.right) << 4) | u; break;
    case 'snake': l = ((s.option === 'return') ? 16 : 0) | u; break;
    case 'kaleidoscope': l = ((s.option === 'in') ? 16 : 0) | u; break;
    case 'lineWave': l = ((s.option === 'left') ? 16 : 0) | u; break;
    case 'circleWave': l = ((s.option === 'clockwise') ? 16 : 0) | u; break;
    default: l = u;
  }
  const b = Buffer.alloc(64);
  b[0] = CMD.SET_LED;
  b[1] = m.idx;
  b[2] = MAXSPEED - speed;
  b[3] = value;
  b[4] = l;
  if (m.rgb && Array.isArray(s.rgb)) {
    let [r, g, bl] = s.rgb;
    if (r === 255 && g === 255 && bl === 255) { r = 0xfa; g = 0xfa; bl = 0xfa; } // белый в протоколе = FAFAFA
    b[5] = r; b[6] = g; b[7] = bl;
  }
  return ei(b);
}

function decodeLight(r) {
  const m = MODE_BY_IDX[r[1]];
  if (!m) return { mode: 'unknown', raw: hex(r.slice(0, 8)) };
  const speed = MAXSPEED - r[2];
  const brightness = r[3];
  const l = r[4];
  const u = l >> 4;
  const d = l & 15;
  let rgb = [r[5], r[6], r[7]];
  if (rgb[0] === 0xfa && rgb[1] === 0xfa && rgb[2] === 0xfa) rgb = [255, 255, 255];
  if (d !== DAZZLE && d !== NORMAL && COMMONCOLOR[d] !== undefined) {
    const c = COMMONCOLOR[d];
    rgb = [(c >> 16) & 255, (c >> 8) & 255, c & 255];
  }
  const out = { mode: m.key, speed: Math.max(0, Math.min(4, speed)), brightness, rgb, dazzle: d === DAZZLE };
  if (m.options) {
    if (m.key === 'wave') out.option = Object.keys(WAVEOP).find((k) => WAVEOP[k] === u) || 'right';
    else if (m.key === 'snake') out.option = u === 0 ? 'z' : 'return';
    else if (m.key === 'kaleidoscope') out.option = u === 0 ? 'out' : 'in';
    else if (m.key === 'lineWave') out.option = u === 0 ? 'right' : 'left';
    else if (m.key === 'circleWave') out.option = u === 0 ? 'anti-clockwise' : 'clockwise';
  }
  return out;
}

/* ---------- Класс клавиатуры ---------- */
class Keyboard extends EventEmitter {
  constructor() {
    super();
    this.dev = null;
    this.path = null;
    this.state = { connected: false };
    this.queue = Promise.resolve();
    this.connecting = false;
    this.timer = null;
  }

  start() {
    this.poll();
    this.timer = setInterval(() => this.poll(), 2000);
  }
  stop() {
    clearInterval(this.timer);
    this._drop();
  }

  log(kind, msg) { this.emit('log', { t: Date.now(), kind, msg }); }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  async poll() {
    if (this.connecting) return;
    if (this.dev) {
      // проверяем, что устройство всё ещё в системе
      const still = HID.devices().some((d) => d.path === this.path);
      if (!still) this._drop('Клавиатура отключена');
      return;
    }
    this.connecting = true;
    try { await this._tryConnect(); } catch (e) { this.log('ERR', e.message); }
    this.connecting = false;
  }

  async _tryConnect() {
    const all = HID.devices();
    const cands = all.filter((d) => SUPPORTED.some((s) => s.vid === d.vendorId && s.pid === d.productId)
      && d.usagePage === 1 && d.usage === 6);
    if (!cands.length) {
      if (this.state.connected !== false || this.state.reason !== 'notfound') {
        this.setState({ connected: false, reason: 'notfound' });
      }
      return;
    }
    for (const c of cands) {
      let dev;
      try { dev = new HID.HID(c.path); } catch (e) { this.log('ERR', 'open: ' + e.message); continue; }
      try {
        dev.sendFeatureReport([0, ...se(cmd(0x8f))]);
        await sleep(25);
        const res = Buffer.from(dev.getFeatureReport(0, 65)).slice(1);
        if (res[0] === 0x8f) {
          this.dev = dev; this.path = c.path;
          this.log('OK', 'подключено: ' + c.path);
          const id = res.readInt32LE(1);
          const model = modelFor(id, c.vendorId, c.productId);
          this.log('OK', `модель: ${model.name} (${model.family}${model.writable ? '' : ', только чтение'})`);
          this.setState({ connected: true, reason: null, deviceId: id, is24: !!res[5], vid: c.vendorId, pid: c.productId, model });
          return;
        }
        dev.close();
      } catch (e) {
        this.log('ERR', 'probe: ' + e.message);
        try { dev.close(); } catch (_) { /* ignore */ }
      }
    }
    this.setState({ connected: false, reason: 'noanswer' });
  }

  _drop(reason) {
    if (this.dev) { try { this.dev.close(); } catch (_) { /* ignore */ } }
    this.dev = null; this.path = null;
    this.setState({ connected: false, reason: reason ? 'lost' : this.state.reason });
  }

  _run(fn) {
    const p = this.queue.then(fn, fn);
    this.queue = p.catch(() => {});
    return p;
  }

  /** отправить 64 байта; если read=true, вернуть ответ (64 байта без report ID) */
  async xfer(buf, { read = true, wait = 20, after = 0, echo = true } = {}) {
    return this._run(async () => {
      if (!this.dev) throw new Error('Клавиатура не подключена');
      try {
        this.log('TX', hex(buf.slice(0, 16)));
        this.dev.sendFeatureReport([0, ...buf]);
        if (!read) { if (after) await sleep(after); return null; }
        let res = null;
        for (let attempt = 0; attempt < 4; attempt++) {
          await sleep(wait + attempt * 15);
          res = Buffer.from(this.dev.getFeatureReport(0, 65)).slice(1);
          if (!echo || res[0] === buf[0]) break;
        }
        this.log('RX', hex(res.slice(0, 16)));
        if (after) await sleep(after);
        return res;
      } catch (e) {
        this._drop('lost');
        throw e;
      }
    });
  }

  /* ----- Чтение ----- */
  async readInfo() {
    const idr = await this.xfer(se(cmd(CMD.GET_INFO)));
    const fw = await this.xfer(se(cmd(CMD.GET_REV)));
    const bat = await this.xfer(se(cmd(CMD.GET_BATTERY)));
    const profile = await this.getProfile();
    const rate = await this.xfer(se(cmd(CMD.GET_REPORT, profile)));
    const opt = await this.xfer(se(cmd(CMD.GET_KBOPTION, profile)));
    const rateMap = { 1: 1000, 2: 500, 4: 250, 8: 125 };
    return {
      deviceId: idr.readInt32LE(1),
      is24: !!idr[5],
      firmware: fw.readUInt16LE(1),
      battery: { level: bat[1], state: bat[2] === 0 ? 'none' : bat[2] === 1 ? 'charging' : 'full' },
      profile,
      reportRate: rateMap[rate[2]] || null,
      options: {
        winLock: !!(opt[2] & 1),
        wasdArrows: !!(opt[2] & 8),
        ledOff: !!(opt[2] & 16),
        raw: [opt[2], opt[3], opt[4]],
      },
    };
  }

  async getProfile() {
    return (await this.xfer(se(cmd(CMD.GET_PROFILE))))[1];
  }

  async readLight() {
    const r = await this.xfer(se(cmd(CMD.GET_LED)));
    return decodeLight(r);
  }

  /** Раскладка: 8 кусков по 64 байта -> массив из 128 записей по 4 байта */
  async readKeymap() {
    const prof = await this.getProfile();
    const chunks = [];
    for (let i = 0; i < 8; i++) {
      const r = await this.xfer(se(cmd(CMD.GET_KEYMATRIX, prof, i)), { echo: false, wait: 25 });
      chunks.push(r);
    }
    const all = Buffer.concat(chunks);
    const entries = [];
    for (let i = 0; i < 512; i += 4) entries.push([all[i], all[i + 1], all[i + 2], all[i + 3]]);
    return { profile: prof, entries };
  }

  /* ----- Запись ----- */
  _requireWritable(what) {
    const m = this.state.model;
    if (!m || !m.writable) throw new Error('Для этой модели запись не поддерживается — только чтение');
    if (what === 'keymap' && !m.keymap) throw new Error('Редактор раскладки пока есть только для NJ80');
  }

  async setLight(s) {
    this._requireWritable();
    const b = encodeLight(s);
    await this.xfer(b, { read: false, after: 500 });
    const r = await this.xfer(se(cmd(CMD.GET_LED)));
    if (r[1] !== b[1] || r[3] !== b[3]) throw new Error('Клавиатура не приняла подсветку (прочитано: ' + hex(r.slice(0, 8)) + ')');
    return decodeLight(r);
  }

  async setReportRate(rate) {
    const code = { 1000: 1, 500: 2, 250: 4, 125: 8 }[rate];
    if (!code) throw new Error('Недопустимая частота опроса');
    this._requireWritable();
    const prof = await this.getProfile();
    await this.xfer(se(cmd(CMD.SET_REPORT, prof, code)), { read: false, after: 200 });
    return true;
  }

  /** read-modify-write для флагов клавиатуры (cmd 0x06 / 0x86) */
  async setOption(name, value) {
    const bit = { winLock: 1, wasdArrows: 8 }[name];
    if (!bit) throw new Error('Неизвестная опция');
    this._requireWritable();
    const prof = await this.getProfile();
    const cur = await this.xfer(se(cmd(CMD.GET_KBOPTION, prof)));
    let b2 = cur[2];
    b2 = value ? (b2 | bit) : (b2 & ~bit);
    await this.xfer(se(cmd(CMD.SET_KBOPTION, prof, b2, cur[3], cur[4])), { read: false, after: 200 });
    return true;
  }

  /**
   * Запись раскладки (YC200Common._setKeyConfig в драйвере):
   * 9 пакетов = заголовок [0x09, профиль, 248, 1, номер, 0, 0, se] + 56 байт матрицы.
   * 9 * 56 = 504 байта -> записи 0..125 (126 и 127 на NJ80 пустые).
   * После записи раскладка читается обратно и сверяется.
   */
  async writeKeymap(entries) {
    this._requireWritable('keymap');
    if (!Array.isArray(entries) || entries.length !== 128) throw new Error('Нужно 128 записей раскладки');
    const flat = [];
    entries.forEach((e, i) => {
      if (!Array.isArray(e) || e.length !== 4 || e.some((b) => !Number.isInteger(b) || b < 0 || b > 255)) {
        throw new Error('Некорректная запись раскладки №' + i);
      }
      flat.push(...e);
    });
    if (!entries.some((e) => e[0] === 10)) throw new Error('В раскладке не осталось клавиши Fn — запись отменена');
    if (entries.slice(126).some((e) => e.some(Boolean))) throw new Error('Записи 126-127 протокол не записывает');

    const prof = await this.getProfile();
    for (let i = 0; i < 9; i++) {
      const b = Buffer.alloc(64);
      b[0] = CMD.SET_KEYMATRIX; b[1] = prof; b[2] = 248; b[3] = 1; b[4] = i;
      se(b);
      Buffer.from(flat.slice(56 * i, 56 * i + 56)).copy(b, 8);
      await this.xfer(b, { read: false, after: 20 });
    }
    await sleep(1000);
    const back = await this.readKeymap();
    const bad = back.entries.findIndex((e, i) => e.join() !== entries[i].join());
    if (bad >= 0) throw new Error(`Проверка не прошла: запись №${bad} прочиталась как [${back.entries[bad]}]`);
    return back;
  }

  async factoryReset() {
    this._requireWritable();
    await this.xfer(se(cmd(CMD.RESET)), { read: false, after: 800 });
    return true;
  }
}

module.exports = { Keyboard, MODES, encodeLight, decodeLight, se, ei, cmd };

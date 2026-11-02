'use strict';
/*
 * Клавиатуры на QMK с поддержкой VIA (raw HID: usagePage 0xFF60, usage 0x61, 32 байта, report ID 0).
 * Протокол VIA (quantum/via.h):
 *   0x01 версия протокола -> [01, hi, lo]
 *   0x11 число слоёв -> [11, n]
 *   0x07/0x08/0x09 custom set/get/save: [cmd, канал, value_id, данные…]
 *     канал 2 = rgblight, 3 = rgb_matrix; value_id 1 яркость, 2 эффект, 3 скорость, 4 цвет [hue, sat]
 *   ответ 0xFF = команда не поддерживается
 * Подсветка через custom-каналы есть в протоколе 12+ (VIA v3). На реальной VIA-клавиатуре не проверялось:
 * запись только по кнопке в интерфейсе.
 */
const HID = require('node-hid');
const EventEmitter = require('events');

const USAGE_PAGE = 0xff60, USAGE = 0x61;
const CH = { rgblight: 2, rgb_matrix: 3 };
const VAL = { brightness: 1, effect: 2, speed: 3, color: 4 };

class Via extends EventEmitter {
  constructor() {
    super();
    this.devs = new Map(); // path -> { dev, info, pending, queue }
    this.state = { devices: [] };
    this.timer = null;
  }

  start() {
    this.poll();
    this.timer = setInterval(() => this.poll(), 3000);
  }
  stop() {
    clearInterval(this.timer);
    for (const p of [...this.devs.keys()]) this._drop(p);
  }

  log(kind, msg) { this.emit('log', { t: Date.now(), kind, msg: 'VIA ' + msg }); }
  _emit() {
    this.state = { devices: [...this.devs.values()].filter((d) => d.info).map((d) => d.info) };
    this.emit('state', this.state);
  }

  async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      const found = HID.devices().filter((d) => d.usagePage === USAGE_PAGE && d.usage === USAGE);
      for (const p of [...this.devs.keys()]) if (!found.some((d) => d.path === p)) this._drop(p);
      for (const d of found) if (!this.devs.has(d.path)) await this._open(d);
    } catch (e) {
      this.log('ERR', e.message);
    } finally {
      this.polling = false;
    }
  }

  async _open(d) {
    const ctx = { dev: null, info: null, pending: null, queue: Promise.resolve() };
    this.devs.set(d.path, ctx);
    try {
      ctx.dev = await HID.HIDAsync.open(d.path);
    } catch (e) {
      this.log('ERR', 'open: ' + e.message);
      return; // остаётся в devs, чтобы не пытаться открыть каждые 3 с
    }
    ctx.dev.on('data', (r) => {
      const p = ctx.pending;
      if (p && (r[0] === p.cmd || r[0] === 0xff)) { ctx.pending = null; p.resolve(Buffer.from(r)); }
    });
    ctx.dev.on('error', () => this._drop(d.path));
    try {
      const v = await this._req(ctx, [0x01]);
      const protocol = (v[1] << 8) | v[2];
      let layers = null;
      try { const l = await this._req(ctx, [0x11]); if (l[0] === 0x11) layers = l[1]; } catch (_) { /* старый протокол */ }
      const lighting = {};
      if (protocol >= 12) {
        for (const [name, ch] of Object.entries(CH)) {
          try {
            const r = await this._req(ctx, [0x08, ch, VAL.brightness]);
            if (r[0] !== 0xff) lighting[name] = await this._readLight(ctx, ch);
          } catch (_) { /* канала нет */ }
        }
      }
      ctx.info = {
        path: d.path, vid: d.vendorId, pid: d.productId,
        name: [d.manufacturer, d.product].filter(Boolean).join(' ') || 'QMK-клавиатура',
        protocol, layers, lighting,
      };
      this.log('OK', `${ctx.info.name}: протокол ${protocol}, слоёв ${layers ?? '?'}, подсветка: ${Object.keys(lighting).join(', ') || 'нет'}`);
      this._emit();
    } catch (e) {
      this.log('ERR', 'опрос: ' + e.message);
    }
  }

  _drop(p) {
    const ctx = this.devs.get(p);
    if (!ctx) return;
    if (ctx.dev) ctx.dev.close().catch(() => {});
    if (ctx.pending) ctx.pending.reject(new Error('Устройство отключено'));
    this.devs.delete(p);
    this._emit();
  }

  _req(ctx, bytes, timeout = 500) {
    const run = () => new Promise((resolve, reject) => {
      if (!ctx.dev) { reject(new Error('Клавиатура не подключена')); return; }
      const b = new Array(33).fill(0); // report ID 0 + 32 байта
      bytes.forEach((x, i) => { b[1 + i] = x; });
      const t = setTimeout(() => { if (ctx.pending && ctx.pending.t === t) { ctx.pending = null; reject(new Error('нет ответа')); } }, timeout);
      ctx.pending = { cmd: bytes[0], t, resolve: (v) => { clearTimeout(t); resolve(v); } , reject: (e) => { clearTimeout(t); reject(e); } };
      ctx.dev.write(b).catch((e) => { ctx.pending = null; clearTimeout(t); reject(e); });
    });
    const p = ctx.queue.then(run, run);
    ctx.queue = p.catch(() => {});
    return p;
  }

  async _readLight(ctx, ch) {
    const get = async (id) => (await this._req(ctx, [0x08, ch, id])).subarray(3);
    return {
      brightness: (await get(VAL.brightness))[0],
      effect: (await get(VAL.effect))[0],
      speed: (await get(VAL.speed))[0],
      color: [...(await get(VAL.color)).subarray(0, 2)], // [hue, sat] 0-255
    };
  }

  /** Только по кнопке в интерфейсе: задать подсветку и сохранить в EEPROM */
  async setLight(path, channel, s) {
    const ctx = this.devs.get(path);
    if (!ctx || !ctx.info) throw new Error('VIA-клавиатура не подключена');
    const ch = CH[channel];
    if (!ch || !ctx.info.lighting[channel]) throw new Error('Этот канал подсветки клавиатура не поддерживает');
    const byte = (v) => Math.max(0, Math.min(255, v | 0));
    this.log('TX', `${channel}: яркость ${s.brightness}, эффект ${s.effect}, скорость ${s.speed}, цвет ${s.color}`);
    await this._req(ctx, [0x07, ch, VAL.effect, byte(s.effect)]);
    await this._req(ctx, [0x07, ch, VAL.brightness, byte(s.brightness)]);
    await this._req(ctx, [0x07, ch, VAL.speed, byte(s.speed)]);
    await this._req(ctx, [0x07, ch, VAL.color, byte(s.color[0]), byte(s.color[1])]);
    await this._req(ctx, [0x09, ch]);
    ctx.info.lighting[channel] = await this._readLight(ctx, ch);
    this._emit();
    return ctx.info.lighting[channel];
  }
}

module.exports = { Via };

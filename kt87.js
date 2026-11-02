'use strict';
/*
 * Подсветка KT87 (Winbond/Nuvoton NUC121, VID 0x0416, PID 0xB23C).
 * Протокол по открытому разбору для клавиатур с тем же ID (Pulsar PCMK TKL):
 * https://gist.github.com/DanielGibson/cd92c5faa6b2e0426351dc44193c6182
 *   - output report на vendor-интерфейсе (usagePage 0xFF1B), 64 байта вместе с report ID 1
 *   - [0]=1  [1]=7 клавиши / 8 логотип  [5]=0x0e клавиши / 0x0d логотип
 *     [6] эффект  [7] яркость 0-4  [8] скорость 0-4  [9..11] цвет  [12..14] фон
 *     [15] направление  [16] полноцветный режим (радуга)
 *   - контрольной суммы нет, чтения состояния нет
 * Проверено на KT87 (подсветка клавиш меняется). Команды уходят только по кнопке в интерфейсе.
 */
const HID = require('node-hid');
const EventEmitter = require('events');

const VID = 0x0416, PID = 0xb23c, USAGE_PAGE = 0xff1b;

const hex = (a) => Array.from(a).map((x) => x.toString(16).padStart(2, '0')).join(' ');

const EFFECTS = [
  { key: 'static',   id: 0, speed: false, dir: false, rgb: true },
  { key: 'breathe',  id: 1, speed: true,  dir: false, rgb: true },
  { key: 'wave',     id: 2, speed: true,  dir: true,  rgb: true },
  { key: 'neon',     id: 3, speed: true,  dir: false, rgb: false },
  { key: 'snake',    id: 5, speed: true,  dir: true,  rgb: true },
  { key: 'reactive', id: 6, speed: true,  dir: false, rgb: true },
  { key: 'aurora',   id: 7, speed: true,  dir: false, rgb: true },
  { key: 'ripple',   id: 8, speed: true,  dir: false, rgb: true },
];
const DIRECTIONS = ['right', 'left', 'up', 'down', 'outside', 'inside', 'clockwise', 'counterclockwise'];

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v | 0));
const rgb3 = (c) => (Array.isArray(c) && c.length === 3 ? c.map((x) => clamp(x, 0, 255)) : [0, 0, 0]);

function encodeMode(s) {
  const e = EFFECTS.find((x) => x.key === s.effect);
  if (!e) throw new Error('Неизвестный эффект: ' + s.effect);
  const logo = s.target === 'logo';
  const b = Buffer.alloc(64);
  b[0] = 1;
  b[1] = logo ? 8 : 7;
  b[5] = logo ? 0x0d : 0x0e;
  b[6] = e.id;
  b[7] = clamp(s.brightness, 0, 4);
  b[8] = clamp(s.speed, 0, 4);
  rgb3(s.rgb).forEach((v, i) => { b[9 + i] = v; });
  rgb3(s.bg).forEach((v, i) => { b[12 + i] = v; });
  b[15] = Math.max(0, DIRECTIONS.indexOf(s.direction));
  b[16] = s.rainbow ? 1 : 0;
  return b;
}

class Kt87 extends EventEmitter {
  constructor() {
    super();
    this.dev = null;
    this.path = null;
    this.state = { connected: false };
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

  log(kind, msg) { this.emit('log', { t: Date.now(), kind, msg: 'KT87 ' + msg }); }
  setState(patch) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  poll() {
    const d = HID.devices().find((x) => x.vendorId === VID && x.productId === PID && x.usagePage === USAGE_PAGE);
    if (this.dev) {
      if (!d || d.path !== this.path) this._drop();
      return;
    }
    if (!d) return;
    try {
      this.dev = new HID.HID(d.path);
      this.path = d.path;
      this.log('OK', 'подключено: ' + d.path);
      this.setState({ connected: true, product: d.product || 'Gaming Keyboard' });
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

  /** Только по кнопке в интерфейсе. Ответ клавиатуры (если есть) пишется в журнал. */
  setLight(s) {
    if (!this.dev) throw new Error('KT87 не подключена');
    const b = encodeMode(s);
    try {
      this.log('TX', hex(b.subarray(0, 20)));
      this.dev.write([...b]);
      const r = this.dev.readTimeout(150);
      if (r && r.length) this.log('RX', hex(r.slice(0, 20)));
    } catch (e) {
      this._drop();
      throw e;
    }
    return true;
  }
}

module.exports = { Kt87, KT87_EFFECTS: EFFECTS, KT87_DIRECTIONS: DIRECTIONS, encodeMode };

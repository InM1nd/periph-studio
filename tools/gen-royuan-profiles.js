'use strict';
/*
 * Генерирует profiles/royuan.json из таблицы моделей драйвера Keydous.
 *   1. скопируйте %APPDATA%\Keydous Driver\db во временный файл (оригинал не трогаем)
 *   2. node tools/gen-royuan-profiles.js <копия db>
 * В таблице d: id = 0x80000000 | ID платы (его отдаёт команда 0x8F), name = класс протокола.
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const src = process.argv[2];
if (!src) { console.error('Укажите путь к копии БД Keydous'); process.exit(1); }
const db = new DatabaseSync(src, { readOnly: true });
const rows = db.prepare('select id, vid, pid, name, displayName, usage, usagePage, featureReportByteLength, layout from d where type = ?').all('keyboard');

// типы подсветки драйвера -> ключи режимов hid.js
const LIGHT = {
  LightOff: 'off', LightAlwaysOn: 'alwaysOn', LightBreath: 'breath', LightNeon: 'neon', LightWave: 'wave',
  LightRipple: 'ripple', LightRaindrop: 'raindrop', LightSnake: 'snake', LightPressAction: 'pressAction',
  LightConverage: 'converge', LightSineWave: 'sineWave', LightKaleidoscope: 'kaleidoscope', LightLineWave: 'lineWave',
  LightLaser: 'laser', LightCircleWave: 'circleWave', LightDazzing: 'dazzling', LightRainDown: 'rainDown',
  LightMeteor: 'meteor', LightPressActionOff: 'pressActionOff',
};

const family = (name) => {
  const n = name.toLowerCase();
  if (n.startsWith('yc200')) return 'yc200';
  if (n.startsWith('yzw') || n === 'ry108' || n === 'helpyzw') return 'yzw';
  if (n.startsWith('k68') || n === 'help' || n === 'common') return 'sonix';
  return 'other';
};

const models = rows.map((r) => {
  let modes = null;
  try {
    const lay = JSON.parse(r.layout || '{}');
    if (lay.light && Array.isArray(lay.light.types)) modes = ['off', ...lay.light.types.map((t) => LIGHT[t.type]).filter(Boolean)];
  } catch (_) { /* без описания подсветки */ }
  return {
    board: (r.id >>> 0) & 0x7fffffff,
    vid: r.vid, pid: r.pid,
    cls: r.name, family: family(r.name), name: r.displayName,
    modes: modes ? [...new Set(modes)] : null,
  };
}).sort((a, b) => a.board - b.board);

// 05AC (Apple, Mac-режим) и 0C45 (Sonix, стоит в куче чужих клавиатур) не опрашиваем даже чтением
const SKIP_VID = new Set([0x05ac, 0x0c45]);
const ids = [...new Set(models.filter((m) => !SKIP_VID.has(m.vid)).map((m) => m.vid * 65536 + m.pid))].map((x) => ({ vid: x >>> 16, pid: x & 0xffff }));
const out = {
  source: 'Keydous Driver (таблица моделей d)',
  // NJ80-AP новой ревизии в таблице нет — добавлена вручную, проверена на устройстве
  extra: [{ board: 415, vid: 0x3151, pid: 0x4003, cls: 'yc200_nj80', family: 'yc200', name: 'Keydous NJ80-AP', modes: null, verified: true }],
  usbIds: [{ vid: 0x3151, pid: 0x4003 }, ...ids],
  models,
};
const file = path.join(__dirname, '..', 'profiles', 'royuan.json');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(out, null, 1));
const byFam = models.reduce((a, m) => { a[m.family] = (a[m.family] || 0) + 1; return a; }, {});
console.log('моделей:', models.length, JSON.stringify(byFam), 'USB ID:', out.usbIds.length, '->', file);

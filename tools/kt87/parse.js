'use strict';
/*
 * Разбор записи capture.ps1: достаёт из pcap (USBPcap, linktype 249) пакеты клавиатуры
 * KT87 (VID 0416, PID B23C) и раскладывает их по шагам из *-steps.txt.
 *
 *   node tools/kt87/parse.js [папка captures] [--all]
 *
 * По умолчанию берётся последняя запись. Повторяющиеся подряд одинаковые пакеты схлопываются.
 * --all показывает и пакеты обычных клавиатурных интерфейсов (нажатия клавиш).
 */
const fs = require('fs');
const path = require('path');

const VID = 0x0416, PID = 0xb23c;
const args = process.argv.slice(2);
const showAll = args.includes('--all');
const dir = args.find((a) => !a.startsWith('--')) || path.join(__dirname, 'captures');

const hex = (b) => Array.from(b).map((x) => x.toString(16).padStart(2, '0')).join(' ');
// хвост из нулей не печатаем: "01 07 ff … (64)"
const short = (b) => {
  let n = b.length;
  while (n > 0 && b[n - 1] === 0) n--;
  return n === b.length ? hex(b) : hex(b.subarray(0, Math.max(n, 1))) + ' …';
};

function readPcap(file) {
  const b = fs.readFileSync(file);
  if (b.length < 24) return [];
  const le = b.readUInt32LE(0) === 0xa1b2c3d4;
  const u32 = (o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
  if (u32(20) !== 249) throw new Error(file + ': не USBPcap (linktype ' + u32(20) + ')');
  const pk = [];
  for (let o = 24; o + 16 <= b.length;) {
    const ts = u32(o) + u32(o + 4) / 1e6;
    const incl = u32(o + 8);
    const d = b.subarray(o + 16, o + 16 + incl);
    o += 16 + incl;
    if (d.length < 27) continue;
    const hlen = d.readUInt16LE(0);
    pk.push({
      ts,
      status: d.readUInt32LE(10),
      fn: d.readUInt16LE(14),
      fromDevice: !!(d[16] & 1), // info: 1 = PDO->FDO (ответ устройства)
      bus: d.readUInt16LE(17),
      dev: d.readUInt16LE(19),
      ep: d[21],
      transfer: d[22], // 0 isoch, 1 interrupt, 2 control, 3 bulk
      stage: d[22] === 2 && hlen >= 28 ? d[27] : null,
      data: d.subarray(hlen),
    });
  }
  return pk;
}

function findKt87(pk) {
  // дескриптор устройства (18 байт, тип 1) в ответе на GET_DESCRIPTOR
  const keys = new Set();
  for (const p of pk) {
    const x = p.data;
    if (p.transfer === 2 && x.length >= 18 && x[0] === 18 && x[1] === 1 && x.readUInt16LE(8) === VID && x.readUInt16LE(10) === PID) {
      keys.add(p.bus + ':' + p.dev);
    }
  }
  return keys;
}

function steps(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter(Boolean).map((l) => {
    const [t, n, mark, text] = l.split('\t');
    return { ts: Date.parse(t) / 1000, n: Number(n), mark, text: text || mark };
  });
}

const files = fs.readdirSync(dir).filter((f) => /^kt87-.*-hub\d+\.pcap$/.test(f)).sort();
if (!files.length) { console.error('В ' + dir + ' нет записей kt87-*.pcap'); process.exit(1); }
const stamp = /^kt87-(\d{8}-\d{6})-/.exec(files[files.length - 1])[1];
const st = steps(path.join(dir, `kt87-${stamp}-steps.txt`));

let found = null;
for (const f of files.filter((f) => f.includes(stamp))) {
  const pk = readPcap(path.join(dir, f));
  const keys = findKt87(pk);
  if (keys.size) { found = { f, pk, keys }; break; }
}
if (!found) {
  console.error('KT87 в записи не найдена: нет дескриптора VID 0416 / PID B23C. Переподключите клавиатуру во время записи.');
  process.exit(1);
}
console.log(`Запись ${stamp}, файл ${found.f}, устройство ${[...found.keys].join(', ')}\n`);

const own = found.pk.filter((p) => found.keys.has(p.bus + ':' + p.dev) && p.transfer !== 2 && p.data.length);
const lines = [];
let si = 0;
let last = null, repeat = 0;
const flush = () => { if (repeat) lines.push(`        … повторено ещё ${repeat} раз`); repeat = 0; };
for (const p of own) {
  // обычные клавиатурные отчёты (нажатия) короче 64 байт — по умолчанию скрываем
  if (!showAll && p.data.length < 32) continue;
  // отметка ставится после действия, поэтому пакеты шага стоят НАД его отметкой
  while (si < st.length && st[si].ts <= p.ts) {
    flush();
    lines.push(`▲ конец шага ${st[si].n} [${st[si].mark}] ${st[si].text}\n`);
    si++; last = null;
  }
  const dirn = p.ep & 0x80 ? 'IN ' : 'OUT';
  const body = short(p.data);
  const key = dirn + p.ep + body;
  if (key === last) { repeat++; continue; }
  flush();
  last = key;
  const t = new Date(p.ts * 1000).toISOString().slice(11, 23);
  lines.push(`${t} ${dirn} ep${(p.ep & 0x7f)} ${String(p.data.length).padStart(2)}  ${body}`);
}
flush();
while (si < st.length) { lines.push(`▲ конец шага ${st[si].n} [${st[si].mark}] ${st[si].text}\n`); si++; }

const outFile = path.join(dir, `kt87-${stamp}-parsed.txt`);
fs.writeFileSync(outFile, lines.join('\n') + '\n');
console.log(lines.join('\n'));
console.log('\nСохранено: ' + outFile);

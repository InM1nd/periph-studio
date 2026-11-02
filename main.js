'use strict';
const { app, BrowserWindow, ipcMain, shell, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const HID = require('node-hid');
const { Keyboard, MODES } = require('./hid');
const { Kt87, KT87_EFFECTS, KT87_DIRECTIONS } = require('./kt87');
const { Logitech } = require('./logitech');
const { Via } = require('./via');
const { Sonix, SONIX_MODELS } = require('./sonix');
const ROYUAN = require('./profiles/royuan.json');

const kb = new Keyboard();
const kt = new Kt87();
const lg = new Logitech();
const via = new Via();
const sx = new Sonix();
let win = null;

const ALLOWED = new Set([
  'readInfo', 'readLight', 'readKeymap',
  'setLight', 'setReportRate', 'setOption', 'factoryReset',
]);

function createWindow() {
  win = new BrowserWindow({
    width: 1220,
    height: 800,
    minWidth: 1000,
    minHeight: 660,
    backgroundColor: '#0c0e13',
    title: 'Periph Studio',
    icon: path.join(__dirname, 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });
}

const send = (ch, v) => { if (win) win.webContents.send(ch, v); };
const wrap = (fn) => async (_e, ...args) => {
  try { return { ok: true, data: await fn(...args) }; } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
};

/* ---------- Royuan (NJ80 и семейство yc200) ---------- */
ipcMain.handle('kb:call', async (_e, method, ...args) => {
  if (!ALLOWED.has(method)) throw new Error('Недопустимая команда: ' + method);
  try {
    return { ok: true, data: await kb[method](...args) };
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
});
ipcMain.handle('kb:state', () => kb.state);
ipcMain.handle('kb:modes', () => MODES);
kb.on('state', (s) => send('kb:state', s));
kb.on('log', (l) => send('kb:log', l));

/* ---------- раскладка: запись только через бэкап ---------- */
// keymap-original.json — матрица до первой записи из приложения, не перезаписывается.
// keymap-<время>.json — снимок перед каждой записью.
const backupDir = () => path.join(app.getPath('userData'), 'backups');
const originalFile = () => path.join(backupDir(), 'keymap-original.json');

// до переименования приложение называлось NJ80 Studio — переносим его бэкапы один раз
function migrateBackups() {
  const old = path.join(app.getPath('appData'), 'NJ80 Studio', 'backups');
  if (fs.existsSync(old) && !fs.existsSync(backupDir())) fs.cpSync(old, backupDir(), { recursive: true });
}

function saveBackup(km) {
  fs.mkdirSync(backupDir(), { recursive: true });
  const data = JSON.stringify({ savedAt: new Date().toISOString(), deviceId: kb.state.deviceId, ...km }, null, 1);
  if (!fs.existsSync(originalFile())) fs.writeFileSync(originalFile(), data);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.writeFileSync(path.join(backupDir(), `keymap-${stamp}.json`), data);
}

function backupInfo() {
  if (!fs.existsSync(originalFile())) return { dir: backupDir(), original: null };
  const o = JSON.parse(fs.readFileSync(originalFile(), 'utf8'));
  return { dir: backupDir(), original: { savedAt: o.savedAt, entries: o.entries } };
}

async function backupAndWrite(entries) {
  saveBackup(await kb.readKeymap());
  return kb.writeKeymap(entries);
}

ipcMain.handle('keymap:write', wrap((entries) => backupAndWrite(entries)));
ipcMain.handle('keymap:restore', wrap(() => {
  const info = backupInfo();
  if (!info.original) throw new Error('Исходная раскладка ещё не сохранялась');
  return backupAndWrite(info.original.entries);
}));
ipcMain.handle('keymap:backupInfo', wrap(() => backupInfo()));
ipcMain.handle('keymap:openBackups', wrap(() => {
  fs.mkdirSync(backupDir(), { recursive: true });
  return shell.openPath(backupDir());
}));

/* ---------- семейство 0416:B23C (KT87 и др.) ---------- */
ipcMain.handle('kt87:setLight', wrap((s) => kt.setLight(s)));
ipcMain.handle('kt87:state', () => kt.state);
ipcMain.handle('kt87:meta', () => ({ effects: KT87_EFFECTS, directions: KT87_DIRECTIONS }));
kt.on('state', (s) => send('kt87:state', s));
kt.on('log', (l) => send('kb:log', l));

/* ---------- мыши Logitech ---------- */
ipcMain.handle('mouse:state', () => lg.state);
ipcMain.handle('mouse:refresh', wrap(() => lg.scan().then(() => lg.state.devices)));
ipcMain.handle('mouse:setDpi', wrap((idx, dpi) => lg.setDpi(idx, dpi)));
ipcMain.handle('mouse:setRate', wrap((idx, ms) => lg.setRate(idx, ms)));
lg.on('state', (s) => send('mouse:state', s));
lg.on('log', (l) => send('kb:log', l));

/* ---------- QMK / VIA ---------- */
ipcMain.handle('via:state', () => via.state);
ipcMain.handle('via:setLight', wrap((p, ch, s) => via.setLight(p, ch, s)));
via.on('state', (s) => send('via:state', s));
via.on('log', (l) => send('kb:log', l));

/* ---------- Sonix / DriveAll (MSI GK600, Womier SK80…) ---------- */
ipcMain.handle('sonix:state', () => sx.state);
ipcMain.handle('sonix:setLight', wrap((s) => sx.setLight(s)));
sx.on('state', (s) => send('sonix:state', s));
sx.on('log', (l) => send('kb:log', l));

/* ---------- все устройства и отчёт о неизвестных ---------- */
const hex4 = (n) => (n || 0).toString(16).toUpperCase().padStart(4, '0');
const ROYUAN_IDS = new Set(ROYUAN.usbIds.map((x) => x.vid * 65536 + x.pid));
const VIRTUAL = new Set([0x046dc232]); // виртуальная клавиатура Logitech G HUB

function inventory() {
  const map = new Map();
  for (const d of HID.devices()) {
    const key = d.vendorId * 65536 + d.productId;
    if (VIRTUAL.has(key)) continue;
    if (!map.has(key)) {
      map.set(key, { id: `${hex4(d.vendorId)}:${hex4(d.productId)}`, vid: d.vendorId, pid: d.productId, manufacturer: d.manufacturer || '', product: d.product || '', release: d.release, interfaces: [] });
    }
    const e = map.get(key);
    const usage = `${hex4(d.usagePage)}/${hex4(d.usage)}`;
    if (!e.interfaces.some((i) => i.interface === d.interface && i.usage === usage)) e.interfaces.push({ interface: d.interface, usage });
  }
  return [...map.values()].map((e) => {
    const has = (u) => e.interfaces.some((i) => i.usage === u);
    // мыши Logitech объявляют и клавиатурный интерфейс (кнопки-макросы), а клавиатуры — мышиный
    const logiMouse = e.vid === 0x046d && has('0001/0002') && !/keyboard|клавиат/i.test(e.product);
    const kind = logiMouse ? 'mouse' : has('0001/0006') ? 'keyboard' : has('0001/0002') ? 'mouse' : 'other';
    let support = null;
    if (ROYUAN_IDS.has(e.vid * 65536 + e.pid)) support = 'royuan';
    else if (e.vid === 0x0416 && e.pid === 0xb23c) support = 'b23c';
    else if (SONIX_MODELS.some((m) => m.vid === e.vid && m.pid === e.pid) && e.interfaces.some((i) => i.usage.startsWith('FF13/'))) support = 'sonix';
    else if (e.vid === 0x046d && has('FF00/0002')) support = 'logitech';
    else if (has('FF60/0061')) support = 'via';
    return { ...e, kind, support };
  }).filter((e) => e.kind !== 'other' || e.support).sort((a, b) => (a.support ? 0 : 1) - (b.support ? 0 : 1));
}

ipcMain.handle('devices:list', wrap(() => inventory()));
ipcMain.handle('devices:report', wrap(async (id) => {
  const dev = inventory().find((d) => d.id === id);
  if (!dev) throw new Error('Устройство уже отключено');
  const report = {
    generator: `Periph Studio ${app.getVersion()}`,
    createdAt: new Date().toISOString(),
    os: `${os.type()} ${os.release()} ${os.arch()}`,
    device: dev, // серийные номера не включаем
    note: 'Отчёт об устройстве для добавления поддержки. Содержит только идентификаторы USB и список HID-интерфейсов.',
  };
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Сохранить отчёт об устройстве',
    defaultPath: path.join(app.getPath('desktop'), `periph-report-${dev.id.replace(':', '-')}.json`),
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (canceled || !filePath) return null;
  fs.writeFileSync(filePath, JSON.stringify(report, null, 2));
  shell.showItemInFolder(filePath);
  return filePath;
}));

app.whenReady().then(() => {
  try { migrateBackups(); } catch (e) { console.error('migrateBackups', e); }
  createWindow();
  kb.start();
  kt.start();
  lg.start();
  via.start();
  sx.start();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
  kb.stop();
  kt.stop();
  lg.stop();
  via.stop();
  sx.stop();
  if (process.platform !== 'darwin') app.quit();
});

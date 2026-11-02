(() => {
  'use strict';

  /* ===================== утилиты ===================== */
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const hex2 = (n) => n.toString(16).padStart(2, '0');
  const hex4 = (n) => '0x' + n.toString(16).toUpperCase().padStart(4, '0');
  const rgbToHex = ([r, g, b]) => '#' + hex2(r) + hex2(g) + hex2(b);
  const hexToRgb = (h) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(h.trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  };
  function refreshRangeTracks() {
    $$('input[type="range"]').forEach((input) => {
      const min = Number(input.min || 0), max = Number(input.max || 100);
      input.style.setProperty('--range-progress', `${max > min ? Math.max(0, Math.min(100, (Number(input.value) - min) / (max - min) * 100)) : 0}%`);
    });
  }
  document.addEventListener('input', (e) => { if (e.target.matches('input[type="range"]')) refreshRangeTracks(); });

  let toastTimer = null;
  function toast(msg, isErr = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.toggle('err', isErr);
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), isErr ? 4200 : 1800);
  }

  async function api(fn, ...args) {
    const res = await fn(...args);
    if (!res.ok) throw new Error(res.error || 'Ошибка связи');
    return res.data;
  }

  function confirmModal(title, text, okLabel = 'Подтвердить') {
    return new Promise((resolve) => {
      $('#modalTitle').textContent = title;
      $('#modalText').textContent = text;
      $('#modalOk').textContent = okLabel;
      const m = $('#modal');
      m.hidden = false;
      const done = (v) => { m.hidden = true; $('#modalOk').onclick = $('#modalCancel').onclick = null; resolve(v); };
      $('#modalOk').onclick = () => done(true);
      $('#modalCancel').onclick = () => done(false);
    });
  }

  /* ===================== словари ===================== */
  const MODE_NAMES = {
    off: 'Выключено', alwaysOn: 'Статичный', breath: 'Дыхание', neon: 'Неон',
    wave: 'Волна', ripple: 'Рябь', raindrop: 'Капли', snake: 'Змейка',
    pressAction: 'Вспышка при нажатии', converge: 'Схождение', sineWave: 'Синусоида',
    kaleidoscope: 'Калейдоскоп', lineWave: 'Линейная волна', laser: 'Лазер',
    circleWave: 'Круговая волна', dazzling: 'Мерцание', rainDown: 'Дождь',
    meteor: 'Метеор', pressActionOff: 'Затухание после нажатия',
  };
  const OPTION_NAMES = {
    right: 'Вправо', left: 'Влево', down: 'Вниз', up: 'Вверх',
    z: 'Зигзаг', return: 'Обратный', out: 'Наружу', in: 'Внутрь',
    'anti-clockwise': 'Против часовой', clockwise: 'По часовой',
  };
  const ANIM = {
    breath: 'pulse',
    wave: 'sweep', lineWave: 'sweep', sineWave: 'sweep', circleWave: 'sweep', snake: 'sweep',
    laser: 'sweep', meteor: 'sweep', rainDown: 'sweep', kaleidoscope: 'sweep', converge: 'sweep',
    ripple: 'twinkle', raindrop: 'twinkle', neon: 'twinkle', pressAction: 'twinkle',
    pressActionOff: 'twinkle', dazzling: 'twinkle',
  };
  const SWATCHES = ['#FF0000', '#FF8000', '#FFFF00', '#00FF00', '#00FFFF', '#0000FF', '#FF00FF', '#FFFFFF'];

  const KEY_NAMES = (() => {
    const m = {};
    for (let i = 0; i < 26; i++) m[4 + i] = String.fromCharCode(65 + i);
    '1234567890'.split('').forEach((c, i) => { m[30 + i] = c; });
    Object.assign(m, {
      40: 'Enter', 41: 'Esc', 42: 'Backspace', 43: 'Tab', 44: 'Space', 45: '-', 46: '=', 47: '[', 48: ']',
      49: '\\', 50: '#', 51: ';', 52: "'", 53: '`', 54: ',', 55: '.', 56: '/', 57: 'Caps Lock',
      70: 'PrtSc', 71: 'ScrLk', 72: 'Pause', 73: 'Insert', 74: 'Home', 75: 'PgUp', 76: 'Delete',
      77: 'End', 78: 'PgDn', 79: '→', 80: '←', 81: '↓', 82: '↑', 100: '\\ (ISO)',
      224: 'Левый Ctrl', 225: 'Левый Shift', 226: 'Левый Alt', 227: 'Левый Win',
      228: 'Правый Ctrl', 229: 'Правый Shift', 230: 'Правый Alt', 231: 'Правый Win',
    });
    for (let i = 0; i < 12; i++) m[58 + i] = 'F' + (i + 1);
    return m;
  })();
  const CONSUMER = {
    0xe2: 'Без звука (Mute)', 0xe9: 'Громкость +', 0xea: 'Громкость −',
    0xcd: 'Play / Pause', 0xb5: 'Следующий трек', 0xb6: 'Предыдущий трек', 0xb7: 'Стоп',
    0x18a: 'Почта', 0x192: 'Калькулятор', 0x194: 'Мой компьютер', 0x221: 'Поиск', 0x223: 'Домашняя страница',
  };

  function describeEntry(e) {
    const [b0, b1, b2, b3] = e;
    if (!b0 && !b1 && !b2 && !b3) return 'Отключена';
    if (b0 === 0) {
      const mods = [];
      if (b1 & 1) mods.push('Ctrl');
      if (b1 & 2) mods.push('Shift');
      if (b1 & 4) mods.push('Alt');
      if (b1 & 8) mods.push('Win');
      const k = KEY_NAMES[b2] || (b2 ? 'код ' + b2 : '');
      let t = [...mods, k].filter(Boolean).join(' + ');
      if (b3) t += ' + ' + (KEY_NAMES[b3] || 'код ' + b3);
      return t || '—';
    }
    if (b0 === 3) { const u = b2 | (b3 << 8); return CONSUMER[u] || 'Мультимедиа ' + hex4(u); }
    if (b0 === 10) return 'Fn (функциональная клавиша)';
    if (b0 === 1) return 'Кнопка мыши';
    if (b0 === 9) return 'Макрос № ' + b2;
    return 'Системная функция';
  }

  /* ===================== схема клавиатуры ===================== */
  // индекс в матрице -> заводской код клавиши (из драйвера Keydous, 128 записей)
  const DEFAULT_CODES = [41, 53, 43, 57, 225, 224, 0, 30, 20, 4, 100, 0, 58, 31, 26, 22, 29, 227, 59, 32, 8, 7, 27, 226, 60, 33, 21, 9, 6, 44, 61, 34, 23, 10, 25, 230, 62, 35, 28, 11, 5, 0, 63, 36, 24, 13, 17, 228, 64, 37, 12, 14, 16, 80, 65, 38, 18, 15, 54, 81, 66, 39, 19, 51, 55, 79, 67, 45, 47, 52, 56, 76, 68, 46, 48, 50, 229, 75, 69, 42, 49, 40, 82, 78, 0, 0, 0, 0, 0, 234, 0, 0, 0, 0, 0, 233, 0, 0, 0, 0, 0, 205, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  const FN_INDEX = 41;
  const KNOB = { left: 89, right: 95, press: 101 };
  const defaultEntry = (i) => {
    if (i === FN_INDEX) return [10, 1, 0, 0];
    if (i === KNOB.left || i === KNOB.right || i === KNOB.press) return [3, 0, DEFAULT_CODES[i], 0];
    return [0, 0, DEFAULT_CODES[i], 0];
  };
  const sameEntry = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
  const KNOB_TITLES = { [KNOB.left]: 'Ручка: поворот влево', [KNOB.right]: 'Ручка: поворот вправо', [KNOB.press]: 'Ручка: нажатие' };
  const entryType = (e) => (e[0] === 3 ? 'media' : e[0] === 10 ? 'fn' : e.every((b) => !b) ? 'off' : e[0] === 0 ? 'key' : 'other');

  const idxOfCode = (code) => { for (let i = 0; i < 84; i++) if (DEFAULT_CODES[i] === code) return i; return -1; };

  const K = (l, c, w = 1) => ({ l, c, w });
  const letters = (s) => s.split('').map((ch) => K(ch, 4 + ch.charCodeAt(0) - 65));
  const ROWS = [
    [K('Esc', 41), ...[...Array(12)].map((_, i) => K('F' + (i + 1), 58 + i)), K('Del', 76)],
    [K('`', 53), ...'1234567890'.split('').map((d, i) => K(d, 30 + i)), K('-', 45), K('=', 46), K('Bksp', 42, 2), { gap: 0.5 }, K('PgUp', 75)],
    [K('Tab', 43, 1.5), ...letters('QWERTYUIOP'), K('[', 47), K(']', 48), K('\\', 49, 1.5), { gap: 0.5 }, K('PgDn', 78)],
    [K('Caps', 57, 1.75), ...letters('ASDFGHJKL'), K(';', 51), K("'", 52), K('Enter', 40, 2.25)],
    [K('Shift', 225, 2.25), ...letters('ZXCVBNM'), K(',', 54), K('.', 55), K('/', 56), K('Shift', 229, 1.75), K('↑', 82)],
    [K('Ctrl', 224, 1.25), K('Win', 227, 1.25), K('Alt', 226, 1.25), K('', 44, 5.25), K('Alt', 230), K('Fn', 'fn'), K('Ctrl', 228), K('←', 80), K('↓', 81), K('→', 79)],
  ];

  const U = 44;       // размер клетки, px
  const PAD = 3;      // зазор
  function buildBoard(container, { interactive }) {
    container.innerHTML = '';
    container.classList.toggle('interactive', !!interactive);
    const els = [];
    let maxX = 0;
    ROWS.forEach((row, ri) => {
      let x = 0;
      row.forEach((it) => {
        if (it.gap) { x += it.gap; return; }
        const idx = it.c === 'fn' ? FN_INDEX : idxOfCode(it.c);
        const d = document.createElement('div');
        d.className = 'key';
        d.textContent = it.l;
        d.style.left = x * U + 'px';
        d.style.top = ri * U + 'px';
        d.style.width = it.w * U - PAD + 'px';
        d.style.height = U - PAD + 'px';
        d.dataset.x = String(x);
        d.dataset.idx = String(idx);
        if (idx < 0) d.classList.add('disabled');
        container.appendChild(d);
        els.push({ el: d, idx, x, label: it.l });
        x += it.w;
      });
      maxX = Math.max(maxX, x);
    });
    // ручка
    const knob = document.createElement('div');
    knob.className = 'key knob';
    knob.style.left = (maxX + 0.5) * U + 'px';
    knob.style.top = '0px';
    knob.style.width = U * 1.25 - PAD + 'px';
    knob.style.height = U * 1.25 - PAD + 'px';
    knob.textContent = '⟲';
    knob.dataset.idx = String(KNOB.press);
    knob.dataset.x = String(maxX + 0.5);
    container.appendChild(knob);
    els.push({ el: knob, idx: KNOB.press, x: maxX + 0.5, label: 'Ручка', knob: true });
    container.style.width = (maxX + 0.5) * U + U * 1.25 + 'px';
    container.style.height = ROWS.length * U + 'px';
    const naturalWidth = (maxX + 0.5) * U + U * 1.25;
    const resize = () => { container.style.zoom = String(Math.min(1, container.parentElement.clientWidth / naturalWidth)); };
    new ResizeObserver(resize).observe(container.parentElement);
    resize();
    return els;
  }

  /* ===================== состояние ===================== */
  const S = {
    conn: { connected: false },
    modes: [],
    info: null,
    light: null,
    keymap: null,
    draft: null,     // редактируемая копия keymap.entries
    writing: false,
    backup: null,
    loaded: false,
    applying: false,
    selected: -1,
  };
  let lightBoard = [];
  let keyBoard = [];

  /* ===================== подключение ===================== */
  function renderConn() {
    const c = S.conn;
    const m = c.model || null;
    document.body.classList.toggle('offline', !c.connected);
    document.body.classList.toggle('ry-readonly', !!(c.connected && m && !m.writable));
    $$('.ry-nav').forEach((b) => { b.hidden = !c.connected; });
    $('#keysNav').hidden = !(c.connected && m && m.keymap);
    $('#ryNavSep').hidden = !c.connected;
    $('#ryNavSep').textContent = m ? m.name : 'Keydous / Royuan';
    const active = $('.nav-item.active');
    if (active && active.hidden) $('[data-tab=devices]').click();
    // режимы подсветки, которые есть у этой модели
    $$('#modeGrid .mode').forEach((b) => { b.hidden = !!(m && m.modes && !m.modes.includes(b.dataset.key)); });
    renderSideDevices();
    syncLightControls();
  }

  /* ===================== подключённые устройства (боковая панель) ===================== */
  const ICON = {
    keyboard: '<svg viewBox="0 0 24 24"><rect x="2.5" y="6" width="19" height="12" rx="3"/><path d="M6.5 10h.01M10 10h.01M13.5 10h.01M17 10h.01M7.5 14h9"/></svg>',
    mouse: '<svg viewBox="0 0 24 24"><rect x="6" y="3" width="12" height="18" rx="6"/><path d="M12 7v4"/></svg>',
  };

  function sideEntries() {
    const out = [];
    const c = S.conn;
    if (c.connected) {
      const m = c.model;
      out.push({ tab: 'overview', icon: 'keyboard', name: m ? m.name : 'Keydous', sub: m && !m.writable ? 'Только чтение' : S.info?.is24 ? '2.4G · Подключено' : 'USB · Подключено', state: m && !m.writable ? 'warn' : 'ok' });
    } else if (c.reason === 'noanswer' || c.reason === 'lost') {
      out.push({ tab: 'devices', icon: 'keyboard', name: 'Keydous / Royuan', sub: c.reason === 'lost' ? 'связь потеряна' : 'нет ответа — закройте Keydous Driver', state: 'err' });
    }
    // KT, SX, V, MS объявлены ниже, но вызывается это только после init(), когда все они уже заданы
    if (SX.conn.connected) out.push({ tab: 'sonix', icon: 'keyboard', name: SX.conn.name, sub: 'Sonix · подсветка', state: 'ok' });
    if (KT.conn.connected) out.push({ tab: 'kt87', icon: 'keyboard', name: 'KT87', sub: 'Winbond · подсветка', state: 'ok' });
    if (viaDevice()) out.push({ tab: 'via', icon: 'keyboard', name: viaDevice().name, sub: 'QMK · VIA', state: 'ok' });
    (MS.state.devices || []).forEach((d) => {
      const b = d.battery;
      const bat = !b ? '' : b.percent ? `${b.percent} %` : b.level ? LEVEL_NAMES[b.level] : '';
      const chg = b && b.charging === 'charging' ? ' · заряжается' : '';
      const brand = d.src === 'razer' ? 'Razer' : 'Logitech';
      out.push({ tab: 'mouse', mouse: d.id, icon: 'mouse', name: d.name, sub: d.online ? (bat ? 'заряд ' + bat + chg : brand) : 'спит — пошевелите', state: !d.online ? 'idle' : b && b.level === 'critical' && !chg ? 'warn' : 'ok' });
    });
    return out;
  }

  function renderSideDevices() {
    const list = sideEntries();
    const box = $('#sideDevList');
    $('#sideDevCount').textContent = list.length ? String(list.length) : '';
    if (!list.length) { box.innerHTML = '<div class="sdev-empty">Нет подключённых устройств</div>'; syncWorkspace(); return; }
    box.innerHTML = '';
    list.forEach((e) => {
      const b = document.createElement('button');
      b.className = 'sdev';
      b.dataset.tab = e.tab;
      if (e.mouse) b.dataset.mouse = e.mouse;
      b.innerHTML = `<span class="sdev-ico">${ICON[e.icon]}</span><span class="sdev-txt"><b></b><small></small></span><span class="dot ${e.state}"></span>`;
      $('b', b).textContent = e.name;
      $('small', b).textContent = e.sub;
      b.title = e.name + ' — ' + e.sub;
      b.addEventListener('click', () => {
        if (e.mouse) { MS.sel = e.mouse; MS.dpi = null; MS.rate = null; renderMouse(); }
        const n = $(`.nav-item[data-tab=${e.tab}]`); if (n && !n.hidden) n.click();
      });
      box.appendChild(b);
    });
    syncWorkspace();
  }

  async function loadAll() {
    const session = lightSession;
    S.loaded = true;
    try {
      const info = await api(window.kb.readInfo);
      if (session !== lightSession) return;
      S.info = info;
      renderOverview();
      renderSideDevices();
      const light = await api(window.kb.readLight);
      if (session !== lightSession) return;
      S.light = light;
      initLightControls();
      if (!S.conn.model || !S.conn.model.keymap) return; // схема клавиш есть только для NJ80
      const keymap = await api(window.kb.readKeymap);
      if (session !== lightSession) return;
      setKeymap(keymap);
      const backup = await api(window.kb.backupInfo);
      if (session !== lightSession) return;
      S.backup = backup;
      renderKeys();
    } catch (e) {
      if (session !== lightSession) return;
      S.loaded = false;
      toast('Не удалось прочитать данные: ' + e.message, true);
    }
  }

  /* ===================== обзор ===================== */
  function renderOverview() {
    const i = S.info;
    if (!i) return;
    const c = S.conn;
    $('#ovVidPid').textContent = `${hex4(c.vid || 0x3151)} : ${hex4(c.pid || 0x4003)}`;
    $('#ovModel').textContent = c.model ? c.model.name : '—';
    $('#ovId').textContent = String(i.deviceId);
    $('#ovFw').textContent = `${hex4(i.firmware)} (${i.firmware})`;
    $('#ovLink').textContent = i.is24 ? 'Беспроводной 2.4G' : 'Кабель USB';
    $('#ovProfile').textContent = String(i.profile + 1);

    const lvl = i.battery.level;
    $('#batRing').style.setProperty('--p', String(Math.min(100, lvl)));
    $('#batPct').textContent = lvl > 0 ? lvl + '%' : '—';
    $('#batState').textContent = i.battery.state === 'charging' ? 'Питание от USB' : i.battery.state === 'full' ? 'Заряжена' : (lvl > 0 ? 'От батареи' : 'Нет данных');
    $('#batNote').textContent = i.battery.state === 'charging' ? 'Идёт зарядка или питание по кабелю.' : '';

    $$('#rateSeg button').forEach((b) => b.classList.toggle('on', Number(b.dataset.v) === i.reportRate));
    $('#optWin').checked = i.options.winLock;
    $('#optWasd').checked = i.options.wasdArrows;
  }

  function wireOverview() {
    $('#rateSeg').addEventListener('click', async (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      const v = Number(b.dataset.v);
      try {
        await api(window.kb.setReportRate, v);
        S.info.reportRate = v;
        renderOverview();
        toast(`Частота опроса: ${v} Гц`);
      } catch (err) { toast(err.message, true); }
    });
    const opt = (id, name, label) => $(id).addEventListener('change', async (e) => {
      try {
        await api(window.kb.setOption, name, e.target.checked);
        toast(label + (e.target.checked ? ': включено' : ': выключено'));
      } catch (err) { e.target.checked = !e.target.checked; toast(err.message, true); }
    });
    opt('#optWin', 'winLock', 'Блокировка Win');
    opt('#optWasd', 'wasdArrows', 'WASD вместо стрелок');

    $('#resetBtn').addEventListener('click', async () => {
      const ok = await confirmModal('Сбросить к заводским?', 'Раскладка, подсветка и параметры вернутся к заводским значениям. Это нельзя отменить.', 'Сбросить');
      if (!ok) return;
      try {
        await api(window.kb.factoryReset);
        toast('Сброшено. Перечитываю данные…');
        S.loaded = false;
        setTimeout(() => { if (S.conn.connected) loadAll(); }, 1500);
      } catch (err) { toast(err.message, true); }
    });
  }

  /* ===================== подсветка ===================== */
  const L = { mode: 'alwaysOn', brightness: 4, speed: 2, rgb: [255, 255, 255], dazzle: false, option: undefined };
  let appliedLight = null;
  let lightSession = 0;
  let expandedEffects = false;
  const lightSnapshot = () => ({ ...L, rgb: [...L.rgb] });
  const lightWritable = () => S.conn.connected && S.conn.model?.writable !== false && !!appliedLight;
  const lightChanged = () => !!appliedLight && JSON.stringify(lightSnapshot()) !== JSON.stringify(appliedLight);

  function renderLightSaveBar() {
    const changed = lightChanged();
    $('#lightSaveBar').classList.toggle('dirty', changed);
    $('#lightSaveText').textContent = S.applying ? 'Применяю…' : !S.conn.connected ? 'Клавиатура не подключена' : !lightWritable() ? 'Настройка недоступна' : changed ? 'Есть изменения' : 'Изменений нет';
    $('#lightApply').disabled = !lightWritable() || !changed || S.applying;
    $('#lightDiscard').disabled = !changed || S.applying || !lightWritable();
  }

  const EFFECT_ICONS = {
    off: '<circle cx="16" cy="12" r="9"/><path d="m9 19 14-14"/>',
    alwaysOn: '<path d="M4 12h24"/>',
    breath: '<path d="M3 13q6-12 13 0t13 0"/>',
    wave: '<path d="M3 8q6-8 13 0t13 0M3 15q6-8 13 0t13 0"/>',
    ripple: '<circle cx="16" cy="12" r="3"/><circle cx="16" cy="12" r="7"/><circle cx="16" cy="12" r="11"/>',
    neon: '<path d="m3 12 6 0 4-9 6 18 4-9h6"/>',
  };

  function modeInfo() { return S.modes.find((m) => m.key === L.mode) || {}; }

  function buildModeGrid() {
    const g = $('#modeGrid');
    g.innerHTML = '';
    const favorites = ['alwaysOn', 'breath', 'wave', 'ripple', 'neon', 'off'];
    const modes = [...S.modes].sort((a, b) => {
      const order = (m) => favorites.includes(m.key) ? favorites.indexOf(m.key) : 99;
      return order(a) - order(b);
    });
    modes.forEach((m) => {
      const b = document.createElement('button');
      b.className = 'mode';
      b.dataset.key = m.key;
      b.dataset.favorite = String(favorites.includes(m.key));
      b.innerHTML = `<span class="mode-icon" aria-hidden="true"><svg viewBox="0 0 32 24">${EFFECT_ICONS[m.key] || '<path d="M4 17 11 7l7 10 10-10"/>'}</svg></span><span></span>`;
      $('span:last-child', b).textContent = MODE_NAMES[m.key] || m.key;
      g.appendChild(b);
    });
    g.addEventListener('click', (e) => {
      const b = e.target.closest('.mode');
      if (!b) return;
      L.mode = b.dataset.key;
      const m = modeInfo();
      if (m.options && !m.options.includes(L.option)) L.option = m.options[0];
      syncLightControls();
      scheduleApply();
    });
    const sw = $('#swatches');
    sw.innerHTML = '';
    SWATCHES.forEach((c) => {
      const d = document.createElement('button');
      d.type = 'button';
      d.setAttribute('aria-label', 'Цвет подсветки ' + c);
      d.className = 'swatch';
      d.style.background = c;
      d.dataset.c = c;
      sw.appendChild(d);
    });
    sw.addEventListener('click', (e) => {
      const d = e.target.closest('.swatch');
      if (!d) return;
      L.rgb = hexToRgb(d.dataset.c);
      L.dazzle = false;
      syncLightControls();
      scheduleApply();
    });
  }

  function syncLightControls() {
    const m = modeInfo();
    const available = S.conn.model?.modes;
    $$('#modeGrid .mode').forEach((b) => {
      b.classList.toggle('on', b.dataset.key === L.mode);
      b.setAttribute('aria-pressed', String(b.dataset.key === L.mode));
      b.hidden = !!(available && !available.includes(b.dataset.key)) || (!expandedEffects && b.dataset.favorite !== 'true' && b.dataset.key !== L.mode);
      b.disabled = !lightWritable() || S.applying;
    });
    $('#allEffects').textContent = expandedEffects ? 'Свернуть' : 'Все эффекты';
    $('#allEffects').setAttribute('aria-expanded', String(expandedEffects));

    const hx = rgbToHex(L.rgb);
    $('#colorInput').value = hx;
    if (document.activeElement !== $('#colorHex')) $('#colorHex').value = hx.toUpperCase();
    $$('#swatches .swatch').forEach((s) => s.classList.toggle('on', s.dataset.c.toLowerCase() === hx.toLowerCase() && !L.dazzle));
    $('#rainbow').checked = !!L.dazzle;
    $('#bright').value = String(L.brightness);
    $('#brightVal').textContent = String(L.brightness);
    $('#speed').value = String(L.speed);
    $('#speedVal').textContent = String(L.speed);

    $('#ctlColor').classList.toggle('dim', !m.rgb || L.dazzle);
    $('#ctlRainbow').classList.toggle('dim', !m.dazzle);
    $('#ctlRainbow').hidden = !m.dazzle;
    $('#ctlBright').classList.toggle('dim', L.mode === 'off');
    $('#ctlSpeed').classList.toggle('dim', !m.speed);
    $('#ctlOption').hidden = !m.options;
    const busy = !lightWritable() || S.applying;
    $('#colorInput').disabled = $('#colorHex').disabled = busy || !m.rgb || L.dazzle;
    $$('#swatches button').forEach((b) => { b.disabled = busy || !m.rgb || L.dazzle; });
    $('#rainbow').disabled = busy || !m.dazzle;
    $('#bright').disabled = busy || L.mode === 'off';
    $('#speed').disabled = busy || !m.speed;
    if (m.options) {
      const seg = $('#optionSeg');
      seg.innerHTML = '';
      m.options.forEach((o) => {
        const b = document.createElement('button');
        b.dataset.o = o;
        b.textContent = OPTION_NAMES[o] || o;
        b.classList.toggle('on', o === L.option);
        b.disabled = busy;
        seg.appendChild(b);
      });
    }
    updateLightPreview();
    renderLightSaveBar();
    refreshRangeTracks();
  }

  function initLightControls() {
    const s = S.light || {};
    if (s.mode && s.mode !== 'unknown') {
      L.mode = s.mode;
      L.brightness = s.brightness ?? 4;
      L.speed = s.speed ?? 2;
      L.rgb = s.rgb || L.rgb;
      L.dazzle = !!s.dazzle;
      L.option = s.option;
    }
    const m = modeInfo();
    if (m.options && !m.options.includes(L.option)) L.option = m.options[0];
    appliedLight = lightSnapshot();
    syncLightControls();
  }

  function wireLight() {
    $('#allEffects').addEventListener('click', () => { expandedEffects = !expandedEffects; syncLightControls(); });
    $('#lightApply').addEventListener('click', doApply);
    $('#lightDiscard').addEventListener('click', () => {
      if (!appliedLight || S.applying) return;
      Object.assign(L, appliedLight, { rgb: [...appliedLight.rgb] });
      syncLightControls();
    });
    $('#colorInput').addEventListener('input', (e) => { L.rgb = hexToRgb(e.target.value) || L.rgb; L.dazzle = false; syncLightControls(); scheduleApply(); });
    $('#colorHex').addEventListener('input', (e) => {
      const rgb = hexToRgb(e.target.value);
      if (rgb) { L.rgb = rgb; L.dazzle = false; syncLightControls(); scheduleApply(); }
    });
    $('#colorHex').addEventListener('blur', () => { $('#colorHex').value = rgbToHex(L.rgb).toUpperCase(); });
    $('#rainbow').addEventListener('change', (e) => { L.dazzle = e.target.checked; syncLightControls(); scheduleApply(); });
    $('#bright').addEventListener('input', (e) => { L.brightness = Number(e.target.value); syncLightControls(); scheduleApply(); });
    $('#speed').addEventListener('input', (e) => { L.speed = Number(e.target.value); syncLightControls(); scheduleApply(); });
    $('#optionSeg').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      L.option = b.dataset.o;
      syncLightControls();
      scheduleApply();
    });
  }

  function scheduleApply() {
    // Draft only. Hardware writes happen exclusively through the Apply button.
    renderLightSaveBar();
  }
  async function doApply() {
    if (!lightWritable() || !lightChanged() || S.applying) return;
    const session = lightSession;
    const draft = lightSnapshot();
    S.applying = true;
    syncLightControls();
    try {
      await api(window.kb.setLight, draft);
      if (session === lightSession) {
        appliedLight = draft;
        S.light = draft;
        toast('Подсветка применена');
      }
    } catch (e) {
      toast('Не удалось применить: ' + e.message, true);
    } finally {
      S.applying = false;
      syncLightControls();
    }
  }

  function updateLightPreview() {
    const board = $('#lightBoard');
    const m = modeInfo();
    board.classList.add('lit');
    board.classList.toggle('off', L.mode === 'off');
    ['pulse', 'sweep', 'twinkle'].forEach((a) => board.classList.remove('anim-' + a));
    const anim = ANIM[L.mode];
    if (anim && L.mode !== 'off') board.classList.add('anim-' + anim);
    const dur = 3.4 - L.speed * 0.6;
    board.style.setProperty('--dur', dur.toFixed(2) + 's');
    const alpha = 0.25 + L.brightness * 0.1875;
    const base = `rgb(${L.rgb.join(',')})`;
    lightBoard.forEach((k) => {
      if (k.knob) return;
      const useRainbow = L.dazzle && m.dazzle;
      const col = useRainbow ? `hsl(${Math.round((k.x / 15) * 300)} 90% 58%)` : base;
      k.el.style.setProperty('--kc', col);
      k.el.style.setProperty('--ka', String(alpha));
      const delay = anim === 'twinkle' ? ((k.x * 0.37 + (k.idx % 7) * 0.31) % dur) : k.x * 0.12;
      k.el.style.setProperty('--d', delay.toFixed(2) + 's');
    });
  }

  /* ===================== клавиши и ручка ===================== */
  function setKeymap(km) {
    S.keymap = km;
    S.draft = km.entries.map((e) => [...e]);
  }
  const pendingIdx = () => (S.draft ? S.draft.map((e, i) => i).filter((i) => !sameEntry(S.draft[i], S.keymap.entries[i])) : []);

  function renderKeys() {
    if (!S.draft) return;
    const ent = S.draft;
    keyBoard.forEach((k) => {
      if (k.idx < 0) return;
      k.el.classList.toggle('mod', !sameEntry(ent[k.idx], defaultEntry(k.idx)));
      k.el.classList.toggle('pending', !sameEntry(ent[k.idx], S.keymap.entries[k.idx]));
    });
    // ручка
    const list = $('#knobList');
    list.innerHTML = '';
    [['Поворот влево', KNOB.left], ['Поворот вправо', KNOB.right], ['Нажатие', KNOB.press]].forEach(([title, idx]) => {
      const e = ent[idx];
      const row = document.createElement('div');
      row.className = 'knob-item';
      row.dataset.idx = String(idx);
      row.classList.toggle('sel', S.selected === idx);
      row.classList.toggle('pending', !sameEntry(e, S.keymap.entries[idx]));
      const changed = !sameEntry(e, defaultEntry(idx));
      row.innerHTML = '<div><b></b><small></small></div><div class="val"><span></span><span class="mono"></span></div>';
      $('b', row).textContent = title;
      $('small', row).textContent = 'Заводское: ' + describeEntry(defaultEntry(idx));
      $('.val span', row).textContent = describeEntry(e) + (changed ? '  •' : '');
      $('.val .mono', row).textContent = e.map(hex2).join(' ');
      list.appendChild(row);
    });
    renderSaveBar();
    if (S.selected >= 0) selectKey(S.selected);
  }

  function renderSaveBar() {
    const n = pendingIdx().length;
    const busy = S.writing || !S.conn.connected;
    $('#saveBar').classList.toggle('dirty', n > 0);
    $('#saveText').textContent = S.writing ? 'Запись…'
      : n ? `Несохранённых изменений: ${n}. В клавиатуру они попадут только по кнопке «Записать».`
        : 'Изменений нет';
    $('#writeBtn').disabled = busy || !n;
    $('#discardBtn').disabled = S.writing || !n;
    $('#restoreBtn').disabled = busy || !(S.backup && S.backup.original);
    $('#restoreBtn').title = S.backup && S.backup.original
      ? 'Исходная раскладка от ' + new Date(S.backup.original.savedAt).toLocaleString('ru-RU')
      : 'Исходная раскладка сохраняется автоматически перед первой записью';
  }

  function selectKey(idx) {
    S.selected = idx;
    keyBoard.forEach((k) => k.el.classList.toggle('sel', k.idx === idx));
    $$('#knobList .knob-item').forEach((r) => r.classList.toggle('sel', Number(r.dataset.idx) === idx));
    if (!S.draft || idx < 0) return;
    const e = S.draft[idx];
    const dev = S.keymap.entries[idx];
    const d = defaultEntry(idx);
    const k = keyBoard.find((x) => x.idx === idx && !x.knob);
    $('#inspEmpty').hidden = true;
    $('#inspBody').hidden = false;
    $('#inspName').textContent = KNOB_TITLES[idx] || (k ? (KEY_NAMES[DEFAULT_CODES[idx]] || k.label || 'Клавиша') : 'Клавиша');
    $('#inspNow').textContent = describeEntry(e) + (sameEntry(e, dev) ? '' : ' (не записано)');
    $('#inspDef').textContent = describeEntry(d);
    $('#inspPos').textContent = `колонка ${Math.floor(idx / 6)}, ряд ${idx % 6} (№ ${idx})`;
    $('#inspRaw').textContent = e.map(hex2).join(' ');
    $('#inspBadge').hidden = sameEntry(e, d);

    const t = entryType(e);
    $$('#edType button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
    $('#edKey').hidden = t !== 'key';
    $('#edMedia').hidden = t !== 'media';
    if (t === 'key') fillSelect($('#edKey'), KEY_OPTIONS, e[2], (c) => 'код ' + c);
    if (t === 'media') fillSelect($('#edMedia'), MEDIA_OPTIONS, e[2] | (e[3] << 8), (u) => 'Мультимедиа ' + hex4(u));
    $('#edDefault').disabled = sameEntry(e, d);
    $('#edRevert').disabled = sameEntry(e, dev);
  }

  const KEY_OPTIONS = Object.keys(KEY_NAMES).map(Number).sort((a, b) => a - b).map((c) => [c, KEY_NAMES[c]]);
  const MEDIA_OPTIONS = Object.keys(CONSUMER).map(Number).map((u) => [u, CONSUMER[u]]);
  function fillSelect(sel, options, value, unknownLabel) {
    const opts = options.some(([v]) => v === value) ? options : [[value, unknownLabel(value)], ...options];
    sel.innerHTML = '';
    opts.forEach(([v, label]) => {
      const o = document.createElement('option');
      o.value = String(v);
      o.textContent = label;
      sel.appendChild(o);
    });
    sel.value = String(value);
  }

  function setDraft(idx, entry) {
    S.draft[idx] = entry;
    renderKeys();
  }

  async function writeDraft() {
    const changes = pendingIdx();
    if (!changes.length) return;
    if (!S.draft.some((e) => e[0] === 10)) { toast('Нельзя убрать Fn со всех клавиш', true); return; }
    const list = changes.slice(0, 6).map((i) => `№${i}: ${describeEntry(S.keymap.entries[i])} → ${describeEntry(S.draft[i])}`).join('\n');
    const ok = await confirmModal('Записать раскладку?',
      `Изменений: ${changes.length}.\n${list}${changes.length > 6 ? '\n…' : ''}\n\nПеред записью текущая раскладка будет сохранена в файл.`, 'Записать');
    if (!ok) return;
    await runWrite(() => api(window.kb.writeKeymap, S.draft), 'Раскладка записана и проверена');
  }

  async function restoreOriginal() {
    const o = S.backup && S.backup.original;
    if (!o) return;
    const ok = await confirmModal('Вернуть как было?',
      `Раскладка будет восстановлена из файла от ${new Date(o.savedAt).toLocaleString('ru-RU')} — такой она была до первой записи из NJ80 Studio. Несохранённые изменения пропадут.`, 'Восстановить');
    if (!ok) return;
    await runWrite(() => api(window.kb.restoreKeymap), 'Исходная раскладка восстановлена');
  }

  async function runWrite(fn, okMsg) {
    S.writing = true;
    renderSaveBar();
    try {
      setKeymap(await fn());
      toast(okMsg);
    } catch (e) {
      toast('Запись не удалась: ' + e.message, true);
      try { setKeymap(await api(window.kb.readKeymap)); } catch (_) { /* связь потеряна */ }
    } finally {
      S.writing = false;
      try { S.backup = await api(window.kb.backupInfo); } catch (_) { /* ignore */ }
      renderKeys();
    }
  }

  function wireKeys() {
    $('#keyBoard').addEventListener('click', (e) => {
      const el = e.target.closest('.key');
      if (!el || el.classList.contains('disabled')) return;
      selectKey(Number(el.dataset.idx));
    });
    $('#knobList').addEventListener('click', (e) => {
      const row = e.target.closest('.knob-item');
      if (row) selectKey(Number(row.dataset.idx));
    });
    $('#edType').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      const idx = S.selected;
      if (!b || idx < 0 || !S.draft) return;
      const cur = S.draft[idx];
      if (b.dataset.t === entryType(cur)) return;
      const def = defaultEntry(idx);
      const entry = {
        key: () => [0, 0, def[0] === 0 && def[2] ? def[2] : 4, 0],
        media: () => (def[0] === 3 ? [...def] : [3, 0, 0xcd, 0]),
        fn: () => [10, 1, 0, 0],
        off: () => [0, 0, 0, 0],
      }[b.dataset.t]();
      setDraft(idx, entry);
    });
    $('#edKey').addEventListener('change', (e) => {
      const cur = S.draft[S.selected];
      setDraft(S.selected, [0, cur[0] === 0 ? cur[1] : 0, Number(e.target.value), cur[0] === 0 ? cur[3] : 0]);
    });
    $('#edMedia').addEventListener('change', (e) => {
      const u = Number(e.target.value);
      setDraft(S.selected, [3, 0, u & 255, u >> 8]);
    });
    $('#edDefault').addEventListener('click', () => setDraft(S.selected, defaultEntry(S.selected)));
    $('#edRevert').addEventListener('click', () => setDraft(S.selected, [...S.keymap.entries[S.selected]]));
    $('#discardBtn').addEventListener('click', () => { setKeymap(S.keymap); renderKeys(); });
    $('#writeBtn').addEventListener('click', writeDraft);
    $('#restoreBtn').addEventListener('click', restoreOriginal);
    $('#backupsBtn').addEventListener('click', () => window.kb.openBackups());
  }

  /* ===================== KT87 ===================== */
  const KT_EFFECT_NAMES = {
    static: 'Статичный', breathe: 'Дыхание', wave: 'Волна', neon: 'Неон', snake: 'Змейка',
    reactive: 'Реакция на нажатие', aurora: 'Аврора', ripple: 'Рябь',
  };
  const KT_DIR_NAMES = {
    right: 'Вправо', left: 'Влево', up: 'Вверх', down: 'Вниз', outside: 'Наружу', inside: 'Внутрь',
    clockwise: 'По часовой', counterclockwise: 'Против часовой',
  };
  const KT = { conn: { connected: false }, meta: { effects: [], directions: [] }, busy: false };
  const KL = { target: 'keys', effect: 'static', rgb: [255, 100, 0], bg: [0, 0, 0], rainbow: false, brightness: 4, speed: 2, direction: 'right' };

  function renderKt87() {
    const on = !!KT.conn.connected;
    $('#ktNav').hidden = !on;
    updateNavSep();
    if (!on && $('#ktNav').classList.contains('active')) $('[data-tab=devices]').click();
    $('#ktStatus').textContent = on ? `Подключена: ${KT.conn.product} (VID 0416 · PID B23C)` : 'Клавиатура не подключена.';
    const e = KT.meta.effects.find((x) => x.key === KL.effect) || {};
    $$('#ktEffects .mode').forEach((b) => b.classList.toggle('on', b.dataset.key === KL.effect));
    $$('#ktTarget button').forEach((b) => b.classList.toggle('on', b.dataset.v === KL.target));
    $$('#ktDir button').forEach((b) => b.classList.toggle('on', b.dataset.v === KL.direction));
    $('#ktCtlColor').classList.toggle('dim', !e.rgb || KL.rainbow);
    $('#ktCtlSpeed').classList.toggle('dim', !e.speed);
    $('#ktCtlDir').hidden = !e.dir;
    $('#ktBrightVal').textContent = String(KL.brightness);
    $('#ktSpeedVal').textContent = String(KL.speed);
    $('#ktApply').disabled = !on || KT.busy;
  }

  async function initKt87() {
    KT.meta = await window.kb.kt87.getMeta();
    const grid = $('#ktEffects');
    KT.meta.effects.forEach((e) => {
      const b = document.createElement('button');
      b.className = 'mode';
      b.dataset.key = e.key;
      b.textContent = KT_EFFECT_NAMES[e.key] || e.key;
      grid.appendChild(b);
    });
    KT.meta.directions.forEach((d) => {
      const b = document.createElement('button');
      b.dataset.v = d;
      b.textContent = KT_DIR_NAMES[d] || d;
      $('#ktDir').appendChild(b);
    });
    grid.addEventListener('click', (ev) => { const b = ev.target.closest('.mode'); if (b) { KL.effect = b.dataset.key; renderKt87(); } });
    $('#ktTarget').addEventListener('click', (ev) => { const b = ev.target.closest('button'); if (b) { KL.target = b.dataset.v; renderKt87(); } });
    $('#ktDir').addEventListener('click', (ev) => { const b = ev.target.closest('button'); if (b) { KL.direction = b.dataset.v; renderKt87(); } });
    $('#ktColor').addEventListener('input', (ev) => { KL.rgb = hexToRgb(ev.target.value) || KL.rgb; });
    $('#ktBg').addEventListener('input', (ev) => { KL.bg = hexToRgb(ev.target.value) || KL.bg; });
    $('#ktRainbow').addEventListener('change', (ev) => { KL.rainbow = ev.target.checked; renderKt87(); });
    $('#ktBright').addEventListener('input', (ev) => { KL.brightness = Number(ev.target.value); renderKt87(); });
    $('#ktSpeed').addEventListener('input', (ev) => { KL.speed = Number(ev.target.value); renderKt87(); });
    $('#ktApply').addEventListener('click', async () => {
      KT.busy = true; renderKt87();
      try {
        await api(window.kb.kt87.setLight, { ...KL });
        toast('Отправлено на KT87. Если подсветка не изменилась — загляните в журнал обмена.');
      } catch (e) {
        toast('KT87: ' + e.message, true);
      } finally {
        KT.busy = false; renderKt87();
      }
    });
    window.kb.kt87.onState((s) => { KT.conn = s; renderKt87(); });
    KT.conn = await window.kb.kt87.getState();
    renderKt87();
  }

  function updateNavSep() {
    $('#ktNavSep').hidden = $('#ktNav').hidden && $('#msNav').hidden && $('#viaNav').hidden && $('#sxNav').hidden;
    renderSideDevices();
  }

  /* ===================== Sonix / DriveAll ===================== */
  const SX = { conn: { connected: false }, busy: false };
  const SL = { mode: 1, rgb: [255, 100, 0], rainbow: false, brightness: 5, speed: 3, direction: false };

  function renderSonix() {
    const on = !!SX.conn.connected;
    $('#sxNav').hidden = !on;
    updateNavSep();
    if (!on && $('#sxNav').classList.contains('active')) $('[data-tab=devices]').click();
    if (on) {
      $('#sxName').textContent = SX.conn.name + ' · подсветка';
      $('#sxNavLabel').textContent = (SX.conn.name.replace(/^MSI Forge /, '').split(' ')[0] || 'Sonix') + ' · подсветка';
    }
    $$('#sxModes .mode').forEach((b) => b.classList.toggle('on', Number(b.dataset.m) === SL.mode));
    $('#sxCtlColor').classList.toggle('dim', SL.rainbow || SL.mode === 0);
    $('#sxBrightVal').textContent = String(SL.brightness);
    $('#sxSpeedVal').textContent = String(SL.speed);
    $('#sxApply').disabled = !on || SX.busy;
  }

  async function initSonix() {
    const grid = $('#sxModes');
    for (let m = 0; m <= 21; m++) {
      const b = document.createElement('button');
      b.className = 'mode';
      b.dataset.m = String(m);
      b.textContent = m === 0 ? 'Выкл' : String(m);
      grid.appendChild(b);
    }
    grid.addEventListener('click', (e) => { const b = e.target.closest('.mode'); if (b) { SL.mode = Number(b.dataset.m); renderSonix(); } });
    $('#sxColor').addEventListener('input', (e) => { SL.rgb = hexToRgb(e.target.value) || SL.rgb; });
    $('#sxRainbow').addEventListener('change', (e) => { SL.rainbow = e.target.checked; renderSonix(); });
    $('#sxDir').addEventListener('change', (e) => { SL.direction = e.target.checked; });
    $('#sxBright').addEventListener('input', (e) => { SL.brightness = Number(e.target.value); renderSonix(); });
    $('#sxSpeed').addEventListener('input', (e) => { SL.speed = Number(e.target.value); renderSonix(); });
    $('#sxApply').addEventListener('click', async () => {
      SX.busy = true; renderSonix();
      try {
        await api(window.kb.sonix.setLight, { ...SL });
        toast('Отправлено. Если подсветка не изменилась — пришлите строки «Sonix» из журнала обмена.');
      } catch (e) {
        toast('Sonix: ' + e.message, true);
      } finally {
        SX.busy = false; renderSonix();
      }
    });
    window.kb.sonix.onState((s) => { SX.conn = s; renderSonix(); });
    SX.conn = await window.kb.sonix.getState();
    renderSonix();
  }

  /* ===================== все устройства ===================== */
  const SUPPORT = {
    royuan: { tab: 'overview', label: 'Keydous / Royuan', caps: ['подсветка', 'частота', 'раскладка'] },
    b23c: { tab: 'kt87', label: 'Winbond', caps: ['подсветка'] },
    logitech: { tab: 'mouse', label: 'Logitech', caps: ['DPI', 'частота', 'заряд'] },
    razer: { tab: 'mouse', label: 'Razer', caps: ['DPI', 'частота', 'заряд'] },
    via: { tab: 'via', label: 'QMK / VIA', caps: ['подсветка'] },
    sonix: { tab: 'sonix', label: 'Sonix', caps: ['подсветка'] },
  };
  let devTimer = null;
  let devSig = '';

  function devCard(d) {
    const sup = d.support && SUPPORT[d.support];
    const el = document.createElement('div');
    el.className = 'dev ' + (sup ? 'ok' : 'unknown');
    el.innerHTML = `<div class="dev-ico">${ICON[d.kind === 'mouse' ? 'mouse' : 'keyboard']}</div><div class="dev-main"><b></b><small></small><div class="dev-chips"></div></div>`;
    // у KT87 и клавиатур Sonix вместо модели в строке продукта «Gaming Keyboard»
    let name = d.product || d.manufacturer || (d.kind === 'mouse' ? 'Мышь' : 'Клавиатура');
    if (d.support === 'b23c') name = 'KT87 · ' + name;
    if (d.support === 'sonix' && SX.conn.connected) name = SX.conn.name;
    if (d.support === 'royuan' && S.conn.connected && S.conn.model) name = S.conn.model.name;
    $('b', el).textContent = name;
    $('small', el).textContent = d.id + (d.manufacturer && !/стандартные/i.test(d.manufacturer) && d.manufacturer !== name ? ' · ' + d.manufacturer : '');
    const chips = $('.dev-chips', el);
    if (sup) {
      chips.innerHTML = `<span class="chip fam"></span>` + sup.caps.map((c) => `<span class="chip">${c}</span>`).join('');
      $('.chip.fam', chips).textContent = sup.label;
      const go = document.createElement('span');
      go.className = 'dev-go';
      go.textContent = '›';
      el.appendChild(go);
      el.addEventListener('click', () => { const n = $(`.nav-item[data-tab=${sup.tab}]`); if (n && !n.hidden) n.click(); else toast('Устройство ещё подключается…'); });
    } else {
      chips.innerHTML = '<span class="chip">не поддерживается</span>';
      const b = document.createElement('button');
      b.className = 'ghost small';
      b.textContent = 'Отчёт…';
      b.title = 'Сохранить USB-идентификаторы и интерфейсы в файл';
      b.addEventListener('click', async () => {
        try { const f = await api(window.kb.devices.report, d.id); if (f) toast('Отчёт сохранён'); } catch (e) { toast(e.message, true); }
      });
      el.appendChild(b);
    }
    return el;
  }

  async function renderDevices() {
    let list;
    try { list = await api(window.kb.devices.list); } catch (e) { return; }
    // перерисовываем только при изменениях, чтобы список не мигал каждые 3 с
    const sig = JSON.stringify(list.map((d) => d.id + d.support)) + S.conn.connected + SX.conn.connected;
    if (sig === devSig) return;
    devSig = sig;
    const box = $('#devList');
    box.innerHTML = '';
    if (!list.length) { box.innerHTML = '<div class="insp-empty">Клавиатуры и мыши не найдены.</div>'; return; }
    const known = list.filter((d) => d.support);
    const unknown = list.filter((d) => !d.support);
    const section = (title, items) => {
      if (!items.length) return;
      const h = document.createElement('div');
      h.className = 'dev-section';
      h.textContent = title;
      box.appendChild(h);
      const g = document.createElement('div');
      g.className = 'dev-list';
      items.forEach((d) => g.appendChild(devCard(d)));
      box.appendChild(g);
    };
    section('Поддерживаются', known);
    section('Без поддержки', unknown);
  }

  function initDevices() {
    renderDevices();
    devTimer = setInterval(() => { if ($('#tab-devices').classList.contains('active')) renderDevices(); }, 3000);
  }

  /* ===================== QMK / VIA ===================== */
  const VIA_CH_NAMES = { rgb_matrix: 'RGB Matrix', rgblight: 'RGB Light' };
  const V = { state: { devices: [] }, ch: null, draft: null, busy: false };
  const viaDevice = () => V.state.devices[0] || null;
  const hsvToHex = (h, s) => {
    const H = (h / 255) * 6, S2 = s / 255, c = S2, x = c * (1 - Math.abs((H % 2) - 1)), m = 1 - c;
    const [r, g, b] = H < 1 ? [c, x, 0] : H < 2 ? [x, c, 0] : H < 3 ? [0, c, x] : H < 4 ? [0, x, c] : H < 5 ? [x, 0, c] : [c, 0, x];
    return rgbToHex([r, g, b].map((v) => Math.round((v + m) * 255)));
  };
  const hexToHs = (hx) => {
    const [r, g, b] = (hexToRgb(hx) || [255, 0, 0]).map((v) => v / 255);
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
    let h = 0;
    if (d) h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [Math.round(((h < 0 ? h + 6 : h) / 6) * 255), Math.round((max ? d / max : 0) * 255)];
  };

  function renderVia() {
    const d = viaDevice();
    $('#viaNav').hidden = !d;
    updateNavSep();
    if (!d) { V.ch = null; V.draft = null; if ($('#viaNav').classList.contains('active')) $('[data-tab=devices]').click(); return; }
    const chans = Object.keys(d.lighting);
    if (!V.ch || !chans.includes(V.ch)) { V.ch = chans[0] || null; V.draft = V.ch ? { ...d.lighting[V.ch] } : null; }
    $('#viaName').textContent = d.name;
    $('#viaSub').textContent = 'QMK · VIA';
    $('#viaIds').textContent = `${hex4(d.vid)} : ${hex4(d.pid)}`;
    $('#viaProto').textContent = String(d.protocol);
    $('#viaLayers').textContent = d.layers == null ? '—' : String(d.layers);
    $('#viaChannels').textContent = chans.map((c) => VIA_CH_NAMES[c]).join(', ') || (d.protocol < 12 ? 'нужен протокол VIA 12+' : 'нет');
    $('#viaLightCard').hidden = !V.ch;
    if (!V.ch) return;
    $('#viaCh').innerHTML = chans.map((c) => `<button data-c="${c}" class="${c === V.ch ? 'on' : ''}">${VIA_CH_NAMES[c]}</button>`).join('');
    $('#viaChCtl').hidden = chans.length < 2;
    const s = V.draft;
    $('#viaEffVal').textContent = String(s.effect);
    $('#viaBright').value = String(s.brightness); $('#viaBrightVal').textContent = String(s.brightness);
    $('#viaSpeed').value = String(s.speed); $('#viaSpeedVal').textContent = String(s.speed);
    if (document.activeElement !== $('#viaColor')) $('#viaColor').value = hsvToHex(s.color[0], s.color[1]);
    $('#viaApply').disabled = V.busy;
  }

  async function initVia() {
    $('#viaCh').addEventListener('click', (e) => {
      const b = e.target.closest('button'); const d = viaDevice();
      if (b && d) { V.ch = b.dataset.c; V.draft = { ...d.lighting[V.ch] }; renderVia(); }
    });
    $('#viaEffPrev').addEventListener('click', () => { if (V.draft) { V.draft.effect = Math.max(0, V.draft.effect - 1); renderVia(); } });
    $('#viaEffNext').addEventListener('click', () => { if (V.draft) { V.draft.effect = Math.min(255, V.draft.effect + 1); renderVia(); } });
    $('#viaBright').addEventListener('input', (e) => { V.draft.brightness = Number(e.target.value); renderVia(); });
    $('#viaSpeed').addEventListener('input', (e) => { V.draft.speed = Number(e.target.value); renderVia(); });
    $('#viaColor').addEventListener('input', (e) => { V.draft.color = hexToHs(e.target.value); });
    $('#viaApply').addEventListener('click', async () => {
      const d = viaDevice();
      if (!d || !V.ch) return;
      V.busy = true; renderVia();
      try {
        V.draft = { ...(await api(window.kb.via.setLight, d.path, V.ch, V.draft)) };
        toast('Подсветка VIA применена и сохранена');
      } catch (e) {
        toast('VIA: ' + e.message, true);
      } finally {
        V.busy = false; renderVia();
      }
    });
    window.kb.via.onState((s) => { V.state = s; renderVia(); });
    V.state = await window.kb.via.getState();
    renderVia();
  }

  /* ===================== мыши: Logitech и Razer ===================== */
  const LEVEL_NAMES = { critical: 'критический', low: 'низкий', good: 'хороший', full: 'полный' };
  const CHARGE_NAMES = { discharging: 'от батареи', charging: 'заряжается', full: 'заряжена', error: 'ошибка зарядки', unknown: '—' };
  const DPI_PRESETS = [400, 800, 1600, 3200];
  const MS = { state: { devices: [] }, sel: null, dpi: null, rate: null, busy: false };

  const msDevice = () => {
    const list = MS.state.devices || [];
    return list.find((d) => d.id === MS.sel) || list.find((d) => d.online) || list[0] || null;
  };

  function mouseSub(d) {
    if (!d.online) return 'Мышь не отвечает — пошевелите её, чтобы разбудить';
    if (d.src === 'razer') return 'Razer';
    // индекс 0xFF — устройство подключено напрямую, без приёмника
    return d.idx === 0xff ? 'Logitech · по кабелю' : 'Logitech · через приёмник';
  }

  function renderMouse() {
    const list = MS.state.devices || [];
    const d = msDevice();
    $('#msNav').hidden = !d;
    updateNavSep();
    if (!d) { if ($('#msNav').classList.contains('active')) $('[data-tab=devices]').click(); return; }
    if (MS.sel !== d.id) { MS.sel = d.id; MS.dpi = null; MS.rate = null; }
    // несколько мышей — переключатель
    const pick = $('#msPick');
    pick.hidden = list.length < 2;
    if (list.length > 1) {
      pick.innerHTML = '';
      list.forEach((m) => {
        const b = document.createElement('button');
        b.dataset.id = m.id;
        b.textContent = m.name;
        b.classList.toggle('on', m.id === d.id);
        pick.appendChild(b);
      });
    }
    $('#msName').textContent = d.name;
    $('#msSub').textContent = mouseSub(d);
    $('#msModel').textContent = d.name;
    $('#msProto').textContent = d.src === 'razer' ? `Razer · прошивка ${d.firmware || '—'}` : 'HID++ ' + d.protocol;
    const b = d.battery;
    const bat = $('#msBat');
    bat.className = b && b.level ? 'bat-' + b.level : '';
    bat.textContent = !b ? 'нет данных (проводная?)' : (b.percent ? (b.approx ? '≈ ' : '') + b.percent + ' %' : '') + (b.level ? (b.percent ? ' · ' : '') + LEVEL_NAMES[b.level] : '');
    $('#msCharge').textContent = b ? CHARGE_NAMES[b.charging] || '—' : '—';
    $('#msOnboard').hidden = !d.onboard;

    const dpi = d.dpi;
    $('#msDpiCard').hidden = !dpi;
    if (dpi) {
      if (MS.dpi === null) MS.dpi = dpi.value;
      const r = $('#msDpi');
      r.min = String(dpi.min); r.max = String(dpi.max); r.step = String(dpi.step || 50);
      r.value = String(MS.dpi);
      $('#msDpiVal').textContent = String(MS.dpi);
      $('#msDpiMin').textContent = String(dpi.min);
      $('#msDpiMax').textContent = String(dpi.max);
      if (document.activeElement !== $('#msDpiInput')) $('#msDpiInput').value = String(MS.dpi);
      $('#msDpiNow').textContent = `Сейчас в мыши: ${dpi.value}` + (dpi.def ? ` · заводское: ${dpi.def}` : '');
      $('#msDpiApply').disabled = MS.busy || !d.online || MS.dpi === dpi.value;
    }
    const rate = d.rate;
    $('#msRateCard').hidden = !rate;
    if (rate) {
      if (MS.rate === null) MS.rate = rate.hz;
      const seg = $('#msRate');
      seg.innerHTML = '';
      rate.supported.slice().sort((a, b2) => a - b2).forEach((hz) => {
        const btn = document.createElement('button');
        btn.dataset.hz = String(hz);
        btn.textContent = hz + ' Гц' + (hz === rate.hz ? ' · сейчас' : '');
        btn.classList.toggle('on', hz === MS.rate);
        seg.appendChild(btn);
      });
      $('#msRateApply').disabled = MS.busy || !d.online || MS.rate === rate.hz;
    }
  }

  function snapDpi(v) {
    const d = msDevice();
    if (!d || !d.dpi) return v;
    const step = d.dpi.step || 50;
    v = Math.round(v / step) * step;
    return Math.max(d.dpi.min, Math.min(d.dpi.max, v));
  }

  async function msApply(fn, okMsg) {
    MS.busy = true; renderMouse();
    try {
      await api(fn);
      toast(okMsg);
    } catch (e) {
      toast('Мышь: ' + e.message, true);
    } finally {
      MS.busy = false; renderMouse();
    }
  }

  async function initMouse() {
    $('#msPresets').innerHTML = DPI_PRESETS.map((v) => `<button data-v="${v}">${v}</button>`).join('');
    $('#msPresets').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { MS.dpi = snapDpi(Number(b.dataset.v)); renderMouse(); } });
    $('#msDpi').addEventListener('input', (e) => { MS.dpi = snapDpi(Number(e.target.value)); renderMouse(); });
    $('#msDpiInput').addEventListener('change', (e) => { const v = parseInt(e.target.value, 10); if (v) MS.dpi = snapDpi(v); e.target.value = String(MS.dpi); renderMouse(); });
    $('#msRate').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { MS.rate = Number(b.dataset.hz); renderMouse(); } });
    $('#msPick').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { MS.sel = b.dataset.id; MS.dpi = null; MS.rate = null; renderMouse(); } });
    $('#msDpiApply').addEventListener('click', () => {
      const d = msDevice();
      msApply(() => window.kb.mouse.setDpi(d.id, MS.dpi), `DPI: ${MS.dpi}`);
    });
    $('#msRateApply').addEventListener('click', () => {
      const d = msDevice();
      msApply(() => window.kb.mouse.setRate(d.id, MS.rate), `Частота опроса: ${MS.rate} Гц`);
    });
    $('#msRefresh').addEventListener('click', () => {
      MS.dpi = null; MS.rate = null;
      msApply(() => window.kb.mouse.refresh(), 'Данные мыши обновлены');
    });
    window.kb.mouse.onState((s) => { MS.state = s; renderMouse(); });
    MS.state = await window.kb.mouse.getState();
    renderMouse();
  }

  /* ===================== вкладки, журнал ===================== */
  function syncWorkspace() {
    const tab = $('.tab.active')?.id.replace('tab-', '') || 'devices';
    const family = ['overview', 'light', 'keys'].includes(tab) ? 'royuan' : tab;
    document.body.dataset.workspace = family;
    const devicePage = !['devices', 'settings'].includes(family);
    $('#workspaceHead').hidden = !devicePage;
    let name = '';
    let tag = 'USB';
    if (family === 'royuan') {
      name = S.conn.model?.name || 'Keydous / Royuan';
      if (S.info?.is24) tag = '2.4G';
    } else if (family === 'mouse') {
      const d = msDevice();
      name = d?.name || 'Мышь';
      tag = d?.online ? 'HID' : 'Сон';
    } else if (family === 'kt87') name = KT.conn.product || 'KT87';
    else if (family === 'sonix') name = SX.conn.name || 'Sonix';
    else if (family === 'via') name = viaDevice()?.name || 'QMK / VIA';
    $('#workspaceName').textContent = name;
    $('#workspaceTag').textContent = tag;
    $('#previewModel').textContent = S.conn.model?.name || 'Клавиатура';
    $$('.sdev').forEach((b) => {
      const bFamily = b.dataset.tab === 'overview' ? 'royuan' : b.dataset.tab;
      const active = bFamily === family && (family !== 'mouse' || b.dataset.mouse === msDevice()?.id);
      b.classList.toggle('active', active);
      b.setAttribute('aria-current', active ? 'page' : 'false');
    });
    $$('.nav-item').forEach((b) => {
      if (b.classList.contains('active')) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
    refreshRangeTracks();
  }

  function wireNav() {
    $('.app').addEventListener('click', (e) => {
      const b = e.target.closest('.nav-item');
      if (!b) return;
      $$('.nav-item').forEach((x) => x.classList.toggle('active', x === b));
      $$('.tab').forEach((t) => t.classList.toggle('active', t.id === 'tab-' + b.dataset.tab));
      syncWorkspace();
      $('.main').scrollTop = 0;
    });
  }

  function wireLog() {
    const drawer = $('#drawer');
    const body = $('#logBody');
    $('#logBtn').addEventListener('click', () => { drawer.hidden = !drawer.hidden; });
    $('#logClose').addEventListener('click', () => { drawer.hidden = true; });
    $('#logClear').addEventListener('click', () => { body.textContent = ''; });
    window.kb.onLog((l) => {
      const t = new Date(l.t).toISOString().slice(11, 23);
      body.textContent += `${t}  ${l.kind.padEnd(3)}  ${l.msg}\n`;
      if (body.textContent.length > 60000) body.textContent = body.textContent.slice(-40000);
      body.scrollTop = body.scrollHeight;
    });
  }

  /* ===================== запуск ===================== */
  async function init() {
    wireNav();
    S.modes = await window.kb.getModes();
    lightBoard = buildBoard($('#lightBoard'), { interactive: false });
    keyBoard = buildBoard($('#keyBoard'), { interactive: true });
    buildModeGrid();
    wireOverview(); wireLight(); wireKeys(); wireLog();
    syncLightControls();
    await initKt87();
    await initMouse();
    await initVia();
    await initSonix();
    initDevices();

    window.kb.onState((st) => {
      if (S.conn.connected !== st.connected || S.conn.deviceId !== st.deviceId) lightSession++;
      S.conn = st;
      if (!st.connected) { appliedLight = null; S.light = null; S.info = null; }
      renderConn();
      if (st.connected && !S.loaded) loadAll();
      if (!st.connected) S.loaded = false;
      renderSaveBar();
    });
    S.conn = await window.kb.getState();
    renderConn();
    if (S.conn.connected) loadAll();
  }

  window.prepareForUpdate = async () => {
    if (S.writing || S.applying || MS.busy || KT.busy || SX.busy || V.busy) {
      toast('Дождитесь завершения записи в устройство перед обновлением.', true);
      return false;
    }
    const mouse = msDevice();
    const mouseDraft = (mouse?.dpi && MS.dpi !== null && MS.dpi !== mouse.dpi.value) || (mouse?.rate && MS.rate !== null && MS.rate !== mouse.rate.hz);
    if (lightChanged() || pendingIdx().length || mouseDraft) {
      return confirmModal('Установить обновление?', 'Есть несохранённые изменения настроек устройства. При перезапуске они будут потеряны.', 'Установить и перезапустить');
    }
    return true;
  };
  init().then(() => window.updates?.startupReady?.()).catch((e) => toast('Не удалось запустить интерфейс: ' + e.message, true));
})();

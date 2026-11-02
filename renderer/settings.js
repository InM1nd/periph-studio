(() => {
  'use strict';
  const appearance = window.appearance;
  const picker = document.querySelector('#accentPicker');
  const hex = document.querySelector('#accentHex');
  const error = document.querySelector('#accentError');
  const status = document.querySelector('#appearanceStatus');
  const presets = [
    ['#6685E8', 'Синий'], ['#9B86E8', 'Лавандовый'], ['#D179B7', 'Розовый'],
    ['#DE886A', 'Терракотовый'], ['#D9B660', 'Золотой'], ['#7CB68A', 'Зелёный'],
    ['#65B8BD', 'Бирюзовый'], ['#A1A1AA', 'Графитовый'],
  ];
  function sync() {
    picker.value = appearance.accent;
    if (document.activeElement !== hex) hex.value = appearance.accent;
    document.querySelectorAll('.accent-preset').forEach((b) => {
      b.setAttribute('aria-pressed', String(b.dataset.color === appearance.accent));
    });
  }
  function save(value) {
    const saved = appearance.setAccent(value);
    error.textContent = '';
    hex.setAttribute('aria-invalid', 'false');
    status.textContent = saved ? 'Цвет сохранён. Он останется после перезапуска приложения.' : 'Цвет изменён, но сохранить его не удалось. После перезапуска он может сброситься.';
    sync();
  }
  presets.forEach(([color, name]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'accent-preset';
    b.dataset.color = color;
    b.style.background = color;
    b.style.setProperty('--swatch-ink', '#101011');
    b.title = `${name} · ${color}`;
    b.setAttribute('aria-label', b.title);
    b.addEventListener('click', () => save(color));
    document.querySelector('#accentPresets').appendChild(b);
  });
  picker.addEventListener('input', () => save(picker.value));
  hex.addEventListener('input', () => {
    const value = hex.value.trim();
    if (/^#?[0-9a-f]{6}$/i.test(value)) save(value.startsWith('#') ? value : '#' + value);
    else {
      hex.setAttribute('aria-invalid', 'true');
      error.textContent = 'Введите 6 символов HEX, например #6685E8.';
    }
  });
  hex.addEventListener('blur', () => {
    hex.value = appearance.accent;
    hex.setAttribute('aria-invalid', 'false');
    error.textContent = '';
  });
  document.querySelector('#accentReset').addEventListener('click', () => save(appearance.defaultAccent));
  sync();
})();

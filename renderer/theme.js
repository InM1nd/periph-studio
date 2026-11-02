(() => {
  'use strict';
  const DEFAULT = '#6685E8';
  const KEY = 'periph-studio.appearance.v1';
  const normalize = (value) => /^#[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : null;
  const luminance = (rgb) => rgb.map((v) => {
    const s = v / 255;
    return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4;
  }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
  // Keep arbitrary colors usable on both dark surfaces and filled buttons.
  function tokens(hex) {
    const rgb = hex.slice(1).match(/../g).map((x) => parseInt(x, 16));
    let text = [...rgb];
    while ((luminance(text) + .05) / (luminance([20, 20, 21]) + .05) < 4.5) {
      text = text.map((v) => Math.min(255, v + 1));
    }
    return { rgb, text: `rgb(${text.join(', ')})`, ink: luminance(rgb) > .179 ? '#101011' : '#FFFFFF' };
  }
  function apply(value) {
    const hex = normalize(value) || DEFAULT;
    const t = tokens(hex);
    const root = document.documentElement;
    root.style.setProperty('--accent', hex);
    root.style.setProperty('--accent-rgb', t.rgb.join(', '));
    root.style.setProperty('--accent-text', t.text);
    root.style.setProperty('--accent-ink', t.ink);
    root.style.setProperty('--accent-soft', `rgba(${t.rgb.join(', ')}, .12)`);
    root.style.setProperty('--accent-line', `color-mix(in srgb, ${t.text} 65%, transparent)`);
    return hex;
  }
  let current = DEFAULT;
  try { current = normalize(JSON.parse(localStorage.getItem(KEY))?.accent) || DEFAULT; } catch (_) { /* default on corrupt/unavailable storage */ }
  apply(current);
  window.appearance = {
    defaultAccent: DEFAULT,
    get accent() { return current; },
    setAccent(value) {
      const hex = normalize(value);
      if (!hex) return false;
      current = apply(hex);
      try { localStorage.setItem(KEY, JSON.stringify({ accent: current })); return true; }
      catch (_) { return false; }
    },
  };
})();

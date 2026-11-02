const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../renderer/theme.js'), 'utf8');

function boot(saved, unavailable = false) {
  const properties = {};
  const storage = new Map(saved === undefined ? [] : [['periph-studio.appearance.v1', saved]]);
  const context = {
    document: { documentElement: { style: { setProperty: (k, v) => { properties[k] = v; } } } },
    localStorage: {
      getItem: (k) => { if (unavailable) throw new Error('unavailable'); return storage.get(k) ?? null; },
      setItem: (k, v) => { if (unavailable) throw new Error('unavailable'); storage.set(k, v); },
    },
    window: {},
  };
  vm.runInNewContext(source, context);
  return { appearance: context.window.appearance, properties, storage };
}

test('restores saved accent and recovers from corrupt or unavailable storage', () => {
  assert.equal(boot('{"accent":"#a47be8"}').appearance.accent, '#A47BE8');
  for (const value of [undefined, 'null', '{bad', '{"accent":"red"}', '{"accent":"#12345"}']) {
    assert.equal(boot(value).appearance.accent, '#6685E8');
  }
  assert.equal(boot(undefined, true).appearance.accent, '#6685E8');
});

test('rejects malformed values without overwriting a valid preference', () => {
  const { appearance, properties, storage } = boot();
  assert.equal(appearance.setAccent('#FF8800'), true);
  for (const value of ['red', '#fff', '#12gg34', 'url(test)', null, '#000000; color:red']) {
    assert.equal(appearance.setAccent(value), false);
    assert.equal(appearance.accent, '#FF8800');
  }
  assert.equal(properties['--accent'], '#FF8800');
  assert.equal(JSON.parse(storage.get('periph-studio.appearance.v1')).accent, '#FF8800');
});

function luminance(rgb) {
  return rgb.map((v) => v / 255).map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4)
    .reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
}
test('arbitrary dark and bright accents keep readable labels and button text', () => {
  for (const color of ['#000000', '#FFFFFF', '#0000FF', '#FFFF00', '#6685E8', '#440011']) {
    const { appearance, properties } = boot();
    appearance.setAccent(color);
    const rgb = color.slice(1).match(/../g).map((v) => parseInt(v, 16));
    const label = properties['--accent-text'].match(/\d+/g).map(Number);
    assert.ok((luminance(label) + .05) / (luminance([20,20,21]) + .05) >= 4.5);
    const ink = properties['--accent-ink'] === '#FFFFFF' ? 1 : luminance([16,16,17]);
    const background = luminance(rgb);
    assert.ok((Math.max(ink, background) + .05) / (Math.min(ink, background) + .05) >= 4.5);
  }
});

test('storage failure still previews the chosen accent and reports failure', () => {
  const { appearance, properties } = boot(undefined, true);
  assert.equal(appearance.setAccent('#65B8BD'), false);
  assert.equal(appearance.accent, '#65B8BD');
  assert.equal(properties['--accent'], '#65B8BD');
});

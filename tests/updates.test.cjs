const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { PortableUpdates, releaseInfo, isNewer, trustedURL, parseChecksum } = require('../updates');

const data = Buffer.from('PK\x03\x04portable release fixture');
const digest = createHash('sha256').update(data).digest('hex');
const filename = 'Periph-Studio-0.5.0-Windows-x64.zip';
const url = `https://github.com/InM1nd/periph-studio/releases/download/v0.5.0/${filename}`;
function release(overrides = {}) {
  return { tag_name: 'v0.5.0', draft: false, prerelease: false, body: 'Исправления и новые возможности.', assets: [{ name: filename, state: 'uploaded', browser_download_url: url, size: data.length, digest: 'sha256:' + digest }], ...overrides };
}
async function setup(t, fetcher, options = {}) {
  const tempBase = path.resolve(process.env.PERIPH_TEST_TMPDIR || os.tmpdir());
  await fs.mkdir(tempBase, { recursive: true });
  const root = await fs.mkdtemp(path.join(tempBase, 'periph-updates-test-'));
  t.after(async () => {
    if (path.dirname(root) !== tempBase || !path.basename(root).startsWith('periph-updates-test-')) throw new Error('Unexpected test cleanup target');
    await fs.rm(root, { recursive: true, force: true });
  });
  const opened = [];
  const updater = new PortableUpdates({ currentVersion: '0.4.0', userData: root, supported: true, fetch: fetcher,
    openArchive: async (file) => { opened.push(file); return ''; }, reveal: async (file) => { opened.push(file); }, ...options });
  return { updater, root, opened };
}
const normalFetch = async (request) => request.endsWith('/latest') ? Response.json(release()) : new Response(data);

test('stable versions compare numerically and reject malformed tags', () => {
  assert.equal(isNewer('v0.10.0', '0.9.9'), true);
  assert.equal(isNewer('0.4.0', '0.4.0'), false);
  assert.equal(isNewer('0.3.9', '0.4.0'), false);
  assert.equal(isNewer('1.0.0', '0.99.0'), true);
  for (const v of ['1.2', 'v1.2.3-beta', '1.02.3', '../1.2.3', '1.2.3;test']) assert.throws(() => isNewer(v, '0.4.0'));
});

test('rejects drafts, missing artifacts/integrity, untrusted sources and unreasonable sizes', () => {
  assert.throws(() => releaseInfo(release({ draft: true }), '0.4.0'));
  assert.throws(() => releaseInfo(release({ prerelease: true }), '0.4.0'));
  assert.throws(() => releaseInfo(release({ assets: [] }), '0.4.0'));
  for (const asset of [
    { digest: undefined }, { size: 0 }, { size: 3 * 1024 ** 3 },
    { browser_download_url: 'https://github.com/other/project/releases/download/v0.5.0/app.zip' },
    { browser_download_url: 'https://github.com.evil.example/app.zip' },
  ]) assert.throws(() => releaseInfo(release({ assets: [{ ...release().assets[0], ...asset }] }), '0.4.0'));
  for (const candidate of ['http://github.com/x', 'file:///C:/test', 'https://user:pass@github.com/x', 'https://github.com:8443/x', 'https://example.com/x']) assert.throws(() => trustedURL(candidate, true));
  assert.equal(parseChecksum(`${digest}  ${filename}\n`, filename), digest);
  assert.throws(() => parseChecksum(`${digest}  wrong.zip`, filename));
});

test('check, streaming download, verified cached reuse and archive opening', async (t) => {
  let downloads = 0;
  const { updater, root, opened } = await setup(t, async (request) => {
    if (!request.endsWith('/latest')) downloads++;
    return normalFetch(request);
  });
  assert.equal((await updater.check()).status, 'available');
  assert.equal(updater.getState().version, '0.5.0');
  assert.equal((await updater.download()).status, 'ready');
  const file = path.join(root, 'updates', filename);
  assert.deepEqual(await fs.readFile(file), data);
  await updater.open(); await updater.showFile();
  assert.deepEqual(opened, [file, file]);
  await updater.check(); await updater.download();
  assert.equal(downloads, 1, 'matching cached archive is verified and reused');
  await fs.writeFile(file, 'tampered');
  await assert.rejects(() => updater.open());
  assert.equal(updater.getState().status, 'error');
  assert.equal(opened.length, 2, 'changed archive must not be opened');
  assert.equal((await updater.download()).status, 'ready', 'a corrupted cached archive can be replaced by a verified retry');
  await fs.unlink(file);
  await assert.rejects(() => updater.open());
  assert.equal(updater.getState().canDownload, true, 'a deleted archive can be downloaded again');
});

test('accepts companion SHA-256 when GitHub does not provide digest', async (t) => {
  const asset = { ...release().assets[0], digest: undefined };
  const checksum = { name: filename + '.sha256', state: 'uploaded', browser_download_url: url + '.sha256' };
  const { updater } = await setup(t, async (request) => {
    if (request.endsWith('/latest')) return Response.json(release({ assets: [asset, checksum] }));
    if (request.endsWith('.sha256')) return new Response(`${digest}  ${filename}\n`);
    return new Response(data);
  });
  await updater.check();
  assert.equal((await updater.download()).status, 'ready');
  await updater.open();
});

test('incomplete, oversized and corrupted downloads are never kept as ready', async (t) => {
  for (const payload of [data.subarray(0, 5), Buffer.concat([data, data]), Buffer.alloc(data.length)]) {
    await t.test('invalid archive', async (t) => {
      const { updater, root } = await setup(t, async (request) => request.endsWith('/latest') ? Response.json(release()) : new Response(payload));
      await updater.check();
      const result = await updater.download();
      assert.equal(result.status, 'error');
      assert.equal(result.canDownload, true);
      assert.deepEqual(await fs.readdir(path.join(root, 'updates')), []);
      await assert.rejects(() => updater.open());
    });
  }
});

test('cancels an active stream, cleans partial files and prevents concurrent operations', async (t) => {
  const { updater, root } = await setup(t, async (request, { signal }) => {
    if (request.endsWith('/latest')) return Response.json(release());
    const body = new ReadableStream({ start(controller) {
      controller.enqueue(data.subarray(0, 5));
      signal.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
    } });
    return new Response(body);
  });
  await updater.check();
  const received = new Promise((resolve) => updater.on('state', (s) => { if (s.received > 0) resolve(); }));
  const download = updater.download();
  await received;
  assert.equal((await updater.check()).status, 'downloading');
  assert.equal((await updater.download()).status, 'downloading');
  updater.cancel();
  assert.equal((await download).status, 'available');
  assert.deepEqual(await fs.readdir(path.join(root, 'updates')), []);
});

test('handles missing releases, current versions, rate limiting and offline errors', async (t) => {
  for (const [fetcher, status] of [
    [async () => new Response('', { status: 404 }), 'unpublished'],
    [async () => Response.json(release({ tag_name: 'v0.4.0' })), 'current'],
    [async () => new Response('', { status: 429 }), 'error'],
    [async () => { throw new Error('offline'); }, 'error'],
  ]) {
    const { updater } = await setup(t, fetcher);
    assert.equal((await updater.check()).status, status);
    assert.equal(updater.getState().canDownload, false);
  }
});

test('allows only trusted HTTPS storage redirects', async (t) => {
  const { updater, root } = await setup(t, async (request) => {
    if (request.endsWith('/latest')) return Response.json(release());
    return new Response(null, { status: 302, headers: { location: 'https://evil.example/archive.zip' } });
  });
  await updater.check();
  assert.equal((await updater.download()).status, 'error');
  assert.deepEqual(await fs.readdir(path.join(root, 'updates')), []);
  const { updater: good } = await setup(t, async (request) => {
    if (request.endsWith('/latest')) return Response.json(release());
    if (request.startsWith('https://github.com/')) return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/fixture.zip?token=test' } });
    return new Response(data);
  });
  await good.check();
  assert.equal((await good.download()).status, 'ready');
});

test('development or unsupported platform can check but cannot download', async (t) => {
  const { updater } = await setup(t, normalFetch, { supported: false });
  assert.equal((await updater.check()).status, 'available');
  assert.equal(updater.getState().canDownload, false);
  assert.equal((await updater.download()).status, 'available');
});

test('installation prepares before quitting and blocks competing update operations', async (t) => {
  let releasePreparation, prepared = false, quit = false;
  const waiting = new Promise((resolve) => { releasePreparation = resolve; });
  const { updater } = await setup(t, normalFetch, {
    installUpdate: async ({ sha256, version }) => { assert.equal(sha256, digest); assert.equal(version, '0.5.0'); prepared = true; await waiting; },
    quitForUpdate: () => { quit = true; },
  });
  await updater.check(); await updater.download();
  assert.equal(updater.getState().canInstall, true);
  const installing = updater.install();
  while (!prepared) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(updater.getState().status, 'preparing');
  assert.equal((await updater.check()).status, 'preparing');
  assert.equal((await updater.download()).status, 'preparing');
  assert.equal(quit, false);
  releasePreparation();
  assert.equal((await installing).status, 'installing');
  assert.equal(quit, true);
});

test('failed preparation keeps the application running and permits retry', async (t) => {
  let quit = false;
  const { updater } = await setup(t, normalFetch, { installUpdate: async () => { throw Error('no write permission'); }, quitForUpdate: () => { quit = true; } });
  await updater.check(); await updater.download();
  const result = await updater.install();
  assert.equal(result.status, 'ready');
  assert.equal(result.installError, true);
  assert.equal(result.canInstall, true);
  assert.equal(quit, false);
});

test('installation refuses an archive changed after download', async (t) => {
  let touched = false;
  const { updater, root } = await setup(t, normalFetch, { installUpdate: async () => { touched = true; }, quitForUpdate: () => { touched = true; } });
  await updater.check(); await updater.download();
  await fs.writeFile(path.join(root, 'updates', filename), 'changed');
  assert.equal((await updater.install()).status, 'error');
  assert.equal(touched, false);
});

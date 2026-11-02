'use strict';
const { EventEmitter } = require('events');
const fs = require('fs/promises');
const path = require('path');
const { createHash, randomUUID } = require('crypto');

const REPOSITORY = 'InM1nd/periph-studio';
const RELEASES_URL = `https://github.com/${REPOSITORY}/releases`;
const API_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const MAX_ARCHIVE = 2 * 1024 ** 3;

class UpdateError extends Error {}
function versionParts(value) {
  const match = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(String(value));
  if (!match) throw new UpdateError('Версия релиза должна иметь формат v1.2.3.');
  const parts = match.slice(1).map(Number);
  if (!parts.every(Number.isSafeInteger)) throw new UpdateError('Некорректная версия релиза.');
  return parts;
}
function isNewer(version, current) {
  const a = versionParts(version), b = versionParts(current);
  for (let i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return false;
}
function trustedURL(value, redirected = false) {
  let url;
  try { url = new URL(value); } catch (_) { throw new UpdateError('Некорректная ссылка на обновление.'); }
  const allowed = new Set(['api.github.com', 'github.com']);
  if (redirected) ['release-assets.githubusercontent.com', 'objects.githubusercontent.com', 'github-releases.githubusercontent.com'].forEach((host) => allowed.add(host));
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || !allowed.has(url.hostname)) {
    throw new UpdateError('Обновления разрешены только с GitHub.');
  }
  return url;
}
function assetURL(value, tag) {
  const url = trustedURL(value);
  const prefix = `/${REPOSITORY}/releases/download/${encodeURIComponent(tag)}/`.toLowerCase();
  if (url.hostname !== 'github.com' || !url.pathname.toLowerCase().startsWith(prefix) || url.search || url.hash) {
    throw new UpdateError('Архив должен находиться в релизе InM1nd/periph-studio.');
  }
  return url.href;
}
function releaseInfo(release, current) {
  if (!release || release.draft || release.prerelease) throw new UpdateError('Релиз ещё не опубликован как стабильный.');
  const version = versionParts(release.tag_name).join('.');
  if (!isNewer(version, current)) return null;
  const filename = `Periph-Studio-${version}-Windows-x64.zip`;
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const asset = assets.find((a) => a.name === filename && a.state === 'uploaded');
  if (!asset) throw new UpdateError('У нового релиза пока нет portable-архива Windows x64.');
  if (!Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > MAX_ARCHIVE) throw new UpdateError('Некорректный размер архива обновления.');
  const checksum = assets.find((a) => a.name === filename + '.sha256' && a.state === 'uploaded');
  const digest = /^sha256:([a-f0-9]{64})$/i.exec(asset.digest || '')?.[1]?.toLowerCase();
  if (!digest && !checksum) throw new UpdateError('В релизе нет контрольной суммы SHA-256 для проверки архива.');
  return {
    version, filename, size: asset.size,
    url: assetURL(asset.browser_download_url, release.tag_name),
    digest,
    checksumURL: checksum ? assetURL(checksum.browser_download_url, release.tag_name) : null,
    notes: typeof release.body === 'string' ? release.body.slice(0, 12000) : '',
    releaseURL: `${RELEASES_URL}/tag/${encodeURIComponent(release.tag_name)}`,
  };
}

async function textLimited(response, max) {
  const chunks = [];
  let received = 0;
  for await (const chunk of response.body) {
    received += chunk.length;
    if (received > max) throw new UpdateError('Ответ сервера обновлений слишком большой.');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}
function parseChecksum(text, filename) {
  for (const line of text.trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/i.exec(line.trim());
    if (match && match[2] === filename) return match[1].toLowerCase();
  }
  throw new UpdateError('Файл SHA-256 не соответствует архиву обновления.');
}
async function fileHash(filename) {
  const hash = createHash('sha256');
  const handle = await fs.open(filename, 'r');
  try { for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk); }
  finally { await handle.close(); }
  return hash.digest('hex');
}

class PortableUpdates extends EventEmitter {
  constructor({ currentVersion, userData, fetch: fetcher = global.fetch, supported = process.platform === 'win32' && process.arch === 'x64', openArchive, reveal, installUpdate, quitForUpdate }) {
    super();
    versionParts(currentVersion);
    this.currentVersion = currentVersion;
    this.directory = path.join(userData, 'updates');
    this.fetcher = fetcher;
    this.supported = supported;
    this.openArchive = openArchive;
    this.reveal = reveal;
    this.installUpdate = installUpdate;
    this.quitForUpdate = quitForUpdate;
    this.release = null;
    this.file = null;
    this.verifiedDigest = null;
    this.controller = null;
    this.state = { status: 'idle', currentVersion, version: null, message: 'Проверьте, появилась ли новая версия.', progress: 0, received: 0, total: 0, notes: '', checkedAt: null };
  }
  getState() {
    return { ...this.state, supported: this.supported, canInstall: this.supported && typeof this.installUpdate === 'function' && typeof this.quitForUpdate === 'function' && this.state.status === 'ready', canDownload: this.supported && !!this.release && ['available', 'error'].includes(this.state.status), releasesURL: RELEASES_URL };
  }
  setState(next) {
    Object.assign(this.state, next);
    this.emit('state', this.getState());
    return this.getState();
  }
  get busy() { return ['checking', 'downloading', 'preparing', 'installing'].includes(this.state.status); }
  async request(url, signal) {
    let current = trustedURL(url).href;
    for (let redirect = 0; redirect < 6; redirect++) {
      const response = await this.fetcher(current, {
        redirect: 'manual', signal,
        headers: { 'User-Agent': `Periph-Studio/${this.currentVersion}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location) throw new UpdateError('GitHub не вернул адрес загрузки.');
        current = trustedURL(new URL(location, current).href, true).href;
        continue;
      }
      if (!response.ok) await response.body?.cancel();
      return response;
    }
    throw new UpdateError('Слишком много перенаправлений при загрузке.');
  }
  networkError(error) {
    if (error instanceof UpdateError) return error.message;
    if (error.code === 'ENOSPC') return 'Недостаточно места для загрузки обновления.';
    if (['EACCES', 'EPERM'].includes(error.code)) return 'Нет доступа к папке обновлений. Проверьте права доступа.';
    return 'Не удалось связаться с сервером обновлений. Проверьте интернет и повторите попытку.';
  }
  async check() {
    if (this.busy) return this.getState();
    this.release = null;
    this.file = null;
    this.verifiedDigest = null;
    this.setState({ status: 'checking', message: 'Проверяю релизы на GitHub…', version: null, notes: '', progress: 0, received: 0, total: 0, installError: false });
    const controller = new AbortController();
    this.controller = controller;
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await this.request(API_URL, controller.signal);
      if (response.status === 404) return this.setState({ status: 'unpublished', message: 'Релизы пока недоступны. Проверьте страницу проекта на GitHub.', checkedAt: new Date().toISOString() });
      if ([403, 429].includes(response.status)) throw new UpdateError('GitHub временно ограничил запросы. Попробуйте проверить обновления позже.');
      if (!response.ok) throw new UpdateError(`GitHub вернул ошибку ${response.status}. Повторите проверку позже.`);
      let release;
      try { release = JSON.parse(await textLimited(response, 1024 * 1024)); }
      catch (e) { if (e instanceof UpdateError) throw e; throw new UpdateError('Сервер вернул некорректные данные релиза.'); }
      this.release = releaseInfo(release, this.currentVersion);
      if (!this.release) return this.setState({ status: 'current', message: 'У вас последняя версия.', checkedAt: new Date().toISOString() });
      return this.setState({ status: 'available', version: this.release.version, notes: this.release.notes, total: this.release.size, message: this.supported ? `Доступна версия ${this.release.version}.` : `Доступна версия ${this.release.version}. Скачивание из приложения доступно в portable-сборке Windows x64.`, checkedAt: new Date().toISOString() });
    } catch (e) {
      return this.setState({ status: 'error', message: this.networkError(e) });
    } finally { clearTimeout(timeout); this.controller = null; }
  }
  async download() {
    if (this.busy || !this.getState().canDownload) return this.getState();
    const release = this.release;
    const controller = new AbortController();
    this.controller = controller;
    this.cancelRequested = false;
    const timeout = setTimeout(() => controller.abort(), 30 * 60 * 1000);
    let temporary = null;
    let handle = null;
    this.setState({ status: 'downloading', progress: 0, received: 0, total: release.size, message: 'Скачиваю обновление…', installError: false });
    try {
      let expected = release.digest;
      if (!expected) {
        const response = await this.request(release.checksumURL, controller.signal);
        if (!response.ok) throw new UpdateError('Не удалось получить контрольную сумму архива.');
        expected = parseChecksum(await textLimited(response, 4096), release.filename);
      }
      this.verifiedDigest = expected;
      await fs.mkdir(this.directory, { recursive: true });
      const destination = path.join(this.directory, release.filename);
      try {
        const stat = await fs.lstat(destination);
        if (stat.isSymbolicLink() || !stat.isFile()) throw new UpdateError('Путь загрузки занят другим объектом.');
        if (stat.size === release.size && await fileHash(destination) === expected) {
          this.file = destination;
          return this.setState({ status: 'ready', progress: 100, received: release.size, message: 'Обновление скачано и проверено.' });
        }
      } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const response = await this.request(release.url, controller.signal);
      if (!response.ok) throw new UpdateError(`Не удалось скачать архив: ошибка ${response.status}.`);
      temporary = path.join(this.directory, `${release.filename}.${randomUUID()}.part`);
      handle = await fs.open(temporary, 'wx');
      const hash = createHash('sha256');
      let received = 0, lastProgress = 0;
      for await (const chunk of response.body) {
        if (controller.signal.aborted) throw new Error('aborted');
        received += chunk.length;
        if (received > release.size) throw new UpdateError('Размер загрузки превышает заявленный размер архива.');
        hash.update(chunk);
        await handle.writeFile(chunk);
        if (Date.now() - lastProgress >= 150) {
          lastProgress = Date.now();
          this.setState({ received, progress: Math.min(99, Math.floor(received / release.size * 100)) });
        }
      }
      if (received !== release.size) throw new UpdateError('Архив скачан не полностью. Повторите загрузку.');
      if (hash.digest('hex') !== expected) throw new UpdateError('Контрольная сумма не совпала. Архив удалён; повторите загрузку.');
      if (controller.signal.aborted) throw new Error('aborted');
      await handle.sync();
      await handle.close(); handle = null;
      // Only replace our own verified download, never application or user settings files.
      await fs.rename(temporary, destination);
      temporary = null;
      this.file = destination;
      return this.setState({ status: 'ready', progress: 100, received, message: 'Обновление скачано и проверено.' });
    } catch (e) {
      return this.setState({ status: this.cancelRequested ? 'available' : 'error', message: this.cancelRequested ? 'Загрузка отменена. Можно начать заново.' : controller.signal.aborted ? 'Время ожидания загрузки истекло. Повторите попытку.' : this.networkError(e), progress: 0, received: 0 });
    } finally {
      clearTimeout(timeout);
      if (handle) await handle.close().catch(() => {});
      if (temporary) await fs.unlink(temporary).catch(() => {});
      this.controller = null;
    }
  }
  cancel() {
    if (this.state.status === 'downloading') { this.cancelRequested = true; this.controller?.abort(); }
    return this.getState();
  }
  async open() {
    if (this.state.status !== 'ready' || !this.file) throw new UpdateError('Сначала скачайте обновление.');
    // Verify again if a downloaded archive was changed after completion.
    const filename = this.file;
    const expected = this.release.digest || this.verifiedDigest;
    let valid = false;
    try { valid = !!expected && await fileHash(filename) === expected; } catch (_) { /* missing or unreadable archive */ }
    if (!valid) {
      this.file = null;
      this.setState({ status: 'error', message: 'Скачанный архив изменился. Загрузите его заново.' });
      throw new UpdateError('Проверка скачанного архива не пройдена.');
    }
    const error = await this.openArchive(filename);
    if (error) throw new UpdateError('Не удалось открыть архив. Используйте «Показать в папке».');
  }
  async install() {
    if (this.busy || !this.getState().canInstall || !this.file) return this.getState();
    const archive = this.file;
    const sha256 = this.release.digest || this.verifiedDigest;
    this.setState({ status: 'preparing', message: 'Подготавливаю и проверяю новую версию…', installError: false });
    try {
      if (!sha256 || await fileHash(archive) !== sha256) {
        this.file = null;
        return this.setState({ status: 'error', message: 'Архив изменился. Скачайте обновление заново.' });
      }
      await this.installUpdate({ archive, sha256, version: this.release.version });
      this.setState({ status: 'installing', message: 'Устанавливаю обновление. Приложение сейчас перезапустится…' });
      this.quitForUpdate();
      return this.getState();
    } catch (e) {
      if (e.code === 'ENOENT') {
        this.file = null;
        return this.setState({ status: 'error', message: 'Скачанный архив не найден. Загрузите обновление заново.' });
      }
      return this.setState({ status: 'ready', installError: true, message: 'Установка не началась. ' + (e.message || 'Повторите попытку или откройте архив.') });
    }
  }
  async showFile() {
    if (this.state.status !== 'ready' || !this.file) throw new UpdateError('Сначала скачайте обновление.');
    await this.reveal(this.file);
  }
}

module.exports = { PortableUpdates, releaseInfo, isNewer, trustedURL, parseChecksum, RELEASES_URL };

'use strict';
const fs = require('fs/promises');
const path = require('path');
const { randomUUID, createHash } = require('crypto');
const { execFile, spawn } = require('child_process');
const { promisify } = require('util');
const run = promisify(execFile);

const APP_ID = 'periph-studio';
const MARKER = '.periph-studio-install.json';
const TOKEN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const inside = (child, parent) => {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
};

class PortableInstaller {
  constructor({ installDir, userData, currentVersion, parentPid = process.pid, protectedPaths = [] }) {
    this.installDir = path.resolve(installDir);
    this.userData = path.resolve(userData);
    this.currentVersion = currentVersion;
    this.parentPid = parentPid;
    this.protectedPaths = protectedPaths.filter(Boolean).map((p) => path.resolve(p));
    this.powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  }
  async prepare({ archive, sha256, version }) {
    if (!/^\d+\.\d+\.\d+$/.test(version) || !/^[a-f0-9]{64}$/i.test(sha256)) throw new Error('Некорректные данные обновления.');
    if (path.dirname(this.installDir) === this.installDir || this.protectedPaths.some((p) => p.toLowerCase() === this.installDir.toLowerCase()) || inside(this.userData, this.installDir) || this.userData.toLowerCase() === this.installDir.toLowerCase()) {
      throw new Error('Переместите приложение в отдельную папку перед автоматическим обновлением.');
    }
    let marker;
    try { marker = JSON.parse(await fs.readFile(path.join(this.installDir, MARKER), 'utf8')); } catch (_) { /* legacy/manual layouts */ }
    if (marker?.appId !== APP_ID || marker.format !== 1 || marker.version !== this.currentVersion) {
      throw new Error('Эту сборку нужно один раз установить вручную в отдельную папку. Следующие обновления будут устанавливаться автоматически.');
    }
    const updatesDir = path.join(this.userData, 'updates');
    const expectedArchive = path.join(updatesDir, `Periph-Studio-${version}-Windows-x64.zip`);
    if (path.resolve(archive).toLowerCase() !== expectedArchive.toLowerCase()) throw new Error('Неверный путь архива обновления.');
    const token = randomUUID();
    const jobDir = path.join(updatesDir, 'install-' + token);
    const parent = path.dirname(this.installDir);
    const plan = {
      format: 1, appId: APP_ID, token, jobDir, installDir: this.installDir,
      stageDir: path.join(parent, '.periph-studio-stage-' + token),
      backupDir: path.join(parent, '.periph-studio-backup-' + token),
      failedDir: path.join(parent, '.periph-studio-failed-' + token),
      archive: expectedArchive, sha256: sha256.toLowerCase(), version, currentVersion: this.currentVersion,
      exeName: 'Periph Studio.exe', parentPid: this.parentPid, protectedPaths: this.protectedPaths,
    };
    await fs.mkdir(jobDir, { recursive: false });
    const script = path.join(jobDir, 'installer.ps1');
    const launcher = path.join(jobDir, 'launcher.exe');
    const planFile = path.join(jobDir, 'plan.json');
    const launcherData = await fs.readFile(path.join(this.installDir, 'Periph Studio Updater.exe'));
    const launcherEntry = marker.files?.find((file) => file.path === 'Periph Studio Updater.exe');
    if (!launcherEntry || createHash('sha256').update(launcherData).digest('hex') !== launcherEntry.sha256) throw new Error('Помощник обновления повреждён. Переустановите portable-сборку.');
    await fs.writeFile(launcher, launcherData, { flag: 'wx' });
    // Copy from ASAR so Windows PowerShell can read the helper as a real file.
    await fs.writeFile(script, '\uFEFF' + await fs.readFile(path.join(__dirname, 'portable-installer.ps1'), 'utf8'), { flag: 'wx' });
    await fs.writeFile(planFile, JSON.stringify(plan), { flag: 'wx' });
    try {
      await run(this.powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-PlanFile', planFile, '-Mode', 'Prepare'], { windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024 });
      const receipt = JSON.parse(await fs.readFile(path.join(jobDir, 'prepared.json'), 'utf8'));
      if (receipt.token !== token || receipt.version !== version) throw new Error('Invalid preparation receipt');
    } catch (_) {
      let reason = 'Не удалось подготовить обновление. Приложение осталось без изменений.';
      try {
        const detail = JSON.parse(await fs.readFile(path.join(jobDir, 'result.json'), 'utf8')).message || '';
        if (/extra files|extra directories/i.test(detail)) reason = 'В папке приложения есть посторонние файлы. Переместите их в другую папку перед обновлением.';
        else if (/access.*denied|доступ.*запрещ|отказано в доступе/i.test(detail)) reason = 'Нет прав для замены файлов приложения. Переместите portable-папку в доступное для записи место.';
        else if (/modified|integrity|incomplete|manifest|archive/i.test(detail)) reason = 'Не удалось проверить состав обновления. Скачайте архив заново или используйте ручную установку.';
      } catch (_) { /* original app remains intact */ }
      throw new Error(reason);
    }
    return { token, jobDir, script, planFile, launcher };
  }
  async handoff(job) {
    if (!TOKEN.test(job.token) || path.resolve(job.jobDir) !== path.join(this.userData, 'updates', 'install-' + job.token) || job.script !== path.join(job.jobDir, 'installer.ps1') || job.planFile !== path.join(job.jobDir, 'plan.json') || job.launcher !== path.join(job.jobDir, 'launcher.exe')) throw new Error('Invalid installer job');
    const child = spawn(job.launcher, [job.script, job.planFile], { detached: true, windowsHide: true, stdio: 'ignore' });
    let failure;
    child.once('error', (e) => { failure = e; });
    child.once('exit', (code) => { if (code !== null) failure = new Error('Installer exited before handoff: ' + code); });
    try {
      const deadline = Date.now() + 30000;
      while (Date.now() < deadline) {
        if (failure) throw failure;
        try {
          const armed = JSON.parse(await fs.readFile(path.join(job.jobDir, 'armed.json'), 'utf8'));
          if (armed.token === job.token) {
            await fs.writeFile(path.join(job.jobDir, 'commit.json'), JSON.stringify({ token: job.token }), { flag: 'wx' });
            child.unref(); return;
          }
        } catch (e) { if (e.code !== 'ENOENT' && !(e instanceof SyntaxError)) throw e; }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('Installer handoff timed out');
    } catch (error) {
      // The helper will not replace anything while the parent application is alive.
      await fs.writeFile(path.join(job.jobDir, 'cancelled.json'), JSON.stringify({ token: job.token })).catch(() => {});
      child.unref();
      let reason = error;
      try { reason = new Error(JSON.parse(await fs.readFile(path.join(job.jobDir, 'result.json'), 'utf8')).message); } catch (_) { /* process startup failure */ }
      if (reason === error) { try { reason = new Error(error.message + ': ' + await fs.readFile(path.join(job.jobDir, 'installer.log'), 'utf8')); } catch (_) {} }
      throw new Error('Не удалось запустить установщик. Приложение осталось открытым; повторите попытку.', { cause: reason });
    }
  }
  async acknowledge(token) {
    if (!TOKEN.test(token)) return false;
    const jobDir = path.join(this.userData, 'updates', 'install-' + token);
    const plan = JSON.parse(await fs.readFile(path.join(jobDir, 'plan.json'), 'utf8'));
    if (plan.token !== token || plan.appId !== APP_ID || plan.version !== this.currentVersion || path.resolve(plan.installDir).toLowerCase() !== this.installDir.toLowerCase()) return false;
    await fs.writeFile(path.join(jobDir, 'started.json'), JSON.stringify({ token, version: this.currentVersion, pid: process.pid }));
    return true;
  }
  async outcome(token) {
    if (!TOKEN.test(token)) return null;
    const result = JSON.parse(await fs.readFile(path.join(this.userData, 'updates', 'install-' + token, 'result.json'), 'utf8'));
    return result.token === token ? result : null;
  }
}

module.exports = { PortableInstaller, APP_ID, MARKER };

'use strict';
/*
 * Сборка NJ80 Studio без консоли и npm при запуске.
 *
 *   node scripts/build.js           portable-папка dist\Periph Studio-win32-x64 + ярлык на рабочем столе
 *   node scripts/build.js --dev     только докачать Electron в node_modules\electron\dist (для npm start)
 *
 * Зачем свой скрипт: и electron/install.js, и @electron/packager распаковывают zip
 * через extract-zip, который под Node 26 молча обрывается (процесс выходит с кодом 0,
 * распаковано 1-2 файла). Здесь zip распаковывается системным tar.exe Windows.
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { createHash } = require('crypto');
const { writeManifest } = require('./install-manifest');
const { writeLauncher } = require('./build-launcher');

const ROOT = path.join(__dirname, '..');
const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const pkg = require(path.join(ROOT, 'package.json'));
const electronVersion = require(path.join(ROOT, 'node_modules', 'electron', 'package.json')).version;

function extractZip(zipPath, dir) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync(TAR, ['-xf', zipPath, '-C', dir], { stdio: 'inherit' });
}

async function electronZip() {
  const getPath = require.resolve('@electron/get', { paths: [path.join(ROOT, 'node_modules', 'electron')] });
  const { downloadArtifact } = require(getPath);
  return downloadArtifact({ version: electronVersion, artifactName: 'electron', platform: 'win32', arch: 'x64' });
}

async function fixDevElectron() {
  const dist = path.join(ROOT, 'node_modules', 'electron', 'dist');
  if (fs.existsSync(path.join(dist, 'electron.exe'))) {
    console.log('Electron уже на месте:', dist);
    return;
  }
  const zip = await electronZip();
  fs.rmSync(dist, { recursive: true, force: true });
  extractZip(zip, dist);
  fs.writeFileSync(path.join(ROOT, 'node_modules', 'electron', 'path.txt'), 'electron.exe');
  console.log('Electron распакован в', dist);
}

function createShortcut(exe, icon) {
  const lnk = `${pkg.productName}.lnk`;
  const ps = [
    '$d = [Environment]::GetFolderPath("Desktop")',
    // ярлык от прежнего названия приложения
    '$old = Join-Path $d "NJ80 Studio.lnk"; if (Test-Path $old) { Remove-Item $old }',
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $d '${lnk}'))`,
    `$s.TargetPath = '${exe.replace(/'/g, "''")}'`,
    `$s.WorkingDirectory = '${path.dirname(exe).replace(/'/g, "''")}'`,
    `$s.IconLocation = '${icon.replace(/'/g, "''")},0'`,
    `$s.Description = '${pkg.productName}'`,
    '$s.Save()',
    `Join-Path $d '${lnk}'`,
  ].join('; ');
  const out = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps]).toString().trim();
  console.log('Ярлык:', out);
}

async function build() {
  // подменяем распаковщик packager до его запуска
  const unzip = require('@electron/packager/dist/unzip');
  unzip.extractElectronZip = async (zipPath, dir) => extractZip(zipPath, dir);
  const { packager } = require('@electron/packager');

  const [outDir] = await packager({
    dir: ROOT,
    name: pkg.productName,
    executableName: pkg.productName,
    platform: 'win32',
    arch: 'x64',
    out: path.join(ROOT, 'dist'),
    overwrite: true,
    icon: path.join(ROOT, 'icon.ico'),
    asar: { unpack: '**/*.node' }, // нативный модуль node-hid не может грузиться из asar
    prune: true,
    ignore: [
      /^\/dist($|\/)/, /^\/scripts($|\/)/, /^\/tools($|\/)/, /^\/tests($|\/)/, /^\/\.github($|\/)/, /^\/README/, /^\/backups($|\/)/,
      // node-hid: исходники и сборки под другие платформы не нужны
      /^\/node_modules\/node-hid\/(hidapi|src)($|\/)/,
      /^\/node_modules\/node-hid\/prebuilds\/(?!HID-win32-x64)/,
      /^\/node_modules\/node-addon-api($|\/)/, // только заголовки для сборки
    ],
    appCopyright: `${pkg.productName} contributors`,
    win32metadata: { CompanyName: pkg.productName, FileDescription: pkg.productName, ProductName: pkg.productName },
  });

  const exe = path.join(outDir, pkg.productName + '.exe');
  const icon = path.join(outDir, 'icon.ico');
  fs.copyFileSync(path.join(ROOT, 'icon.ico'), icon);

  // проверка: .node-файл должен лежать снаружи asar
  const unpacked = path.join(outDir, 'resources', 'app.asar.unpacked', 'node_modules', 'node-hid', 'prebuilds', 'HID-win32-x64');
  if (!fs.readdirSync(unpacked).some((f) => f.endsWith('.node'))) throw new Error('node-hid .node не найден в ' + unpacked);
  writeLauncher(outDir);
  await writeManifest(outDir, pkg.version);
  console.log('Готово:', exe);

  if (!process.argv.includes('--no-shortcut')) createShortcut(exe, icon);
  if (process.argv.includes('--zip')) await makeZip(outDir);
}

/** Архив для передачи: папка программы + инструкция «Как запустить.txt» в корне */
async function makeZip(outDir) {
  const dist = path.dirname(outDir);
  const zip = path.join(dist, `Periph-Studio-${pkg.version}-Windows-x64.zip`);
  fs.rmSync(zip, { force: true });
  // ZipArchive writes explicit UTF-8 filenames and works across Windows tar versions.
  const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'create-archive.ps1'), '-AppDirectory', outDir, '-InstructionFile', path.join(__dirname, 'readme-for-users.txt'), '-InstructionName', 'Как запустить.txt', '-Archive', zip], { stdio: 'inherit', windowsHide: true });
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(zip)) hash.update(chunk);
  fs.writeFileSync(zip + '.sha256', `${hash.digest('hex')}  ${path.basename(zip)}\n`);
  console.log('Архив:', zip, `(${(fs.statSync(zip).size / 1048576).toFixed(0)} МБ)`);
  console.log('SHA-256:', zip + '.sha256');
}

(process.argv.includes('--dev') ? fixDevElectron() : build()).catch((e) => {
  console.error(e);
  process.exit(1);
});

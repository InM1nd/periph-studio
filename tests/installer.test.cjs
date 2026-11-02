const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { once } = require('node:events');
const { PortableInstaller } = require('../portable-installer');
const { writeManifest } = require('../scripts/install-manifest');
const { writeLauncher } = require('../scripts/build-launcher');
const run = promisify(execFile);
const windows = process.platform === 'win32';
const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

async function fixture(t, broken = false) {
  const requestedBase = path.resolve(process.env.PERIPH_TEST_TMPDIR || os.tmpdir());
  await fs.mkdir(requestedBase, { recursive: true });
  // Windows runners expose TEMP through an 8.3 alias; use one canonical path
  // for both ZIP entry names and the generated fixture application.
  const base = await fs.realpath(requestedBase);
  const root = await fs.mkdtemp(path.join(base, 'periph-installer-test-'));
  const installDir = path.join(root, 'Приложение [stable]');
  const userData = path.join(root, 'Профиль [data]');
  const packageDir = path.join(root, 'package');
  const nextDir = path.join(packageDir, 'Periph Studio-win32-x64');
  const updates = path.join(userData, 'updates');
  await fs.mkdir(updates, { recursive: true });
  const parent = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 90000)'], { windowsHide: true, stdio: 'ignore' });
  t.after(async () => {
    parent.kill();
    if (path.dirname(root) !== base || !path.basename(root).startsWith('periph-installer-test-')) throw Error('Unsafe test cleanup');
    await fs.rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 200 });
  });
  await fs.writeFile(path.join(userData, 'preferences.json'), '{"accent":"#6685E8"}');
  for (const [directory, version] of [[installDir, '0.5.0'], [nextDir, '0.5.1']]) {
    await fs.mkdir(path.join(directory, 'resources'), { recursive: true });
    await fs.writeFile(path.join(directory, 'resources', 'app.asar'), 'fixture-' + version);
    await fs.writeFile(path.join(directory, 'icudtl.dat'), 'fixture ICU');
    const source = path.join(root, 'fixture-' + version + '.cs');
    const code = `using System; using System.IO; using System.Diagnostics; using System.Threading;
class Fixture { static void Main(string[] args) {
  ${broken && version === '0.5.1' ? 'Environment.Exit(2);' : ''}
  string profile = ${JSON.stringify(userData)};
  File.WriteAllText(Path.Combine(profile, "launched-${version}.txt"), string.Join(" ", args));
  foreach (string arg in args) { if(arg.StartsWith("--periph-update-token=")) {
    string token=arg.Substring("--periph-update-token=".Length);
    string receipt="{\\"token\\":\\""+token+"\\",\\"version\\":\\"${version}\\",\\"pid\\":"+Process.GetCurrentProcess().Id+"}";
    File.WriteAllText(Path.Combine(profile,"updates","install-"+token,"started.json"),receipt);
  }}
  Thread.Sleep(1800);
}}`;
    await fs.writeFile(source, '\uFEFF' + code);
    await run(compiler, ['/nologo', '/target:winexe', '/out:' + path.join(directory, 'Periph Studio.exe'), source], { windowsHide: true });
    writeLauncher(directory);
    await writeManifest(directory, version);
  }
  await fs.writeFile(path.join(packageDir, 'readme.txt'), 'fixture release');
  const archive = path.join(updates, 'Periph-Studio-0.5.1-Windows-x64.zip');
  const zipper = path.join(root, 'zip.ps1');
  await fs.writeFile(zipper, `param([string]$Source,[string]$Target)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::Open($Target, [IO.Compression.ZipArchiveMode]::Create)
try { foreach($item in Get-ChildItem -LiteralPath $Source -File -Recurse) {
  $name = $item.FullName.Substring($Source.Length + 1).Replace('\\', '/')
  [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $item.FullName, $name) | Out-Null
} } finally { $zip.Dispose() }
`);
  await run(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', zipper, '-Source', packageDir, '-Target', archive], { windowsHide: true });
  const sha256 = createHash('sha256').update(await fs.readFile(archive)).digest('hex');
  const installer = new PortableInstaller({ installDir, userData, currentVersion: '0.5.0', parentPid: parent.pid, protectedPaths: [base] });
  return { root, installDir, userData, archive, sha256, installer, parent, nextDir };
}
async function until(fn, timeout = 20000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { const result = await fn(); if (result) return result; } catch (_) { }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw Error('Timed out waiting for installer result');
}
async function stopParent(parent) { const exited = once(parent, 'exit'); parent.kill(); await exited; }

test('native installer swaps directories, restarts new version and preserves profile', { skip: !windows }, async (t) => {
  const f = await fixture(t);
  const job = await f.installer.prepare({ archive: f.archive, sha256: f.sha256, version: '0.5.1' });
  await f.installer.handoff(job);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.installDir, '.periph-studio-install.json'), 'utf8')).version, '0.5.0', 'running app remains untouched');
  await stopParent(f.parent);
  const result = await until(async () => JSON.parse(await fs.readFile(path.join(job.jobDir, 'result.json'), 'utf8')));
  assert.equal(result.status, 'installed', JSON.stringify(result));
  assert.equal(JSON.parse(await fs.readFile(path.join(f.installDir, '.periph-studio-install.json'), 'utf8')).version, '0.5.1');
  assert.equal(JSON.parse(await fs.readFile(path.join(f.userData, 'preferences.json'), 'utf8')).accent, '#6685E8');
  const plan = JSON.parse(await fs.readFile(job.planFile, 'utf8'));
  assert.equal(JSON.parse(await fs.readFile(path.join(plan.backupDir, '.periph-studio-install.json'), 'utf8')).version, '0.5.0');
});

test('native installer restores and restarts the previous version when new startup fails', { skip: !windows }, async (t) => {
  const f = await fixture(t, true);
  const job = await f.installer.prepare({ archive: f.archive, sha256: f.sha256, version: '0.5.1' });
  await f.installer.handoff(job);
  await stopParent(f.parent);
  const result = await until(async () => JSON.parse(await fs.readFile(path.join(job.jobDir, 'result.json'), 'utf8')));
  assert.equal(result.status, 'rolledBack', JSON.stringify(result));
  assert.equal(JSON.parse(await fs.readFile(path.join(f.installDir, '.periph-studio-install.json'), 'utf8')).version, '0.5.0');
  await until(async () => (await fs.readFile(path.join(f.userData, 'launched-0.5.0.txt'), 'utf8')).includes('--periph-update-failed-token='));
  assert.equal(await fs.readFile(path.join(f.userData, 'preferences.json'), 'utf8'), '{"accent":"#6685E8"}');
});

test('preparation rejects extra personal files before touching the application', { skip: !windows }, async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.installDir, 'personal.txt'), 'keep me');
  await assert.rejects(() => f.installer.prepare({ archive: f.archive, sha256: f.sha256, version: '0.5.1' }));
  assert.equal(await fs.readFile(path.join(f.installDir, 'personal.txt'), 'utf8'), 'keep me');
  assert.equal(JSON.parse(await fs.readFile(path.join(f.installDir, '.periph-studio-install.json'), 'utf8')).version, '0.5.0');
});

test('preparation rejects changed archives and legacy application folders', { skip: !windows }, async (t) => {
  const f = await fixture(t);
  await fs.appendFile(f.archive, 'tampered');
  await assert.rejects(() => f.installer.prepare({ archive: f.archive, sha256: f.sha256, version: '0.5.1' }));
  await fs.unlink(path.join(f.installDir, '.periph-studio-install.json'));
  await assert.rejects(() => f.installer.prepare({ archive: f.archive, sha256: f.sha256, version: '0.5.1' }), /один раз/);
});

test('helper survives the updater parent process exiting after handoff', { skip: !windows }, async (t) => {
  const f = await fixture(t);
  await stopParent(f.parent);
  const bootstrap = path.join(f.root, 'updater-parent.cjs');
  const jobFile = path.join(f.root, 'job.json');
  await fs.writeFile(bootstrap, `
const fs=require('fs');
const {PortableInstaller}=require(${JSON.stringify(path.resolve(__dirname, '../portable-installer'))});
(async()=>{
 const installer=new PortableInstaller(${JSON.stringify({ installDir: f.installDir, userData: f.userData, currentVersion: '0.5.0' })});
 const job=await installer.prepare(${JSON.stringify({ archive: f.archive, sha256: f.sha256, version: '0.5.1' })});
 await installer.handoff(job);
 fs.writeFileSync(${JSON.stringify(jobFile)},JSON.stringify(job));
 process.exit(0);
})().catch(e=>{console.error(e);process.exit(1)});
`);
  await run(process.execPath, [bootstrap], { windowsHide: true, timeout: 15000 });
  const job = JSON.parse(await fs.readFile(jobFile, 'utf8'));
  const result = await until(async () => JSON.parse(await fs.readFile(path.join(job.jobDir, 'result.json'), 'utf8')));
  assert.equal(result.status, 'installed', JSON.stringify(result));
});

test('path traversal in an otherwise authenticated ZIP is rejected before replacement', { skip: !windows }, async (t) => {
  const f = await fixture(t);
  const tamper = path.join(f.root, 'add-entry.ps1');
  await fs.writeFile(tamper, `param([string]$Archive)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip=[IO.Compression.ZipFile]::Open($Archive,[IO.Compression.ZipArchiveMode]::Update)
try { $entry=$zip.CreateEntry('Periph Studio-win32-x64/../../escape.txt'); $stream=$entry.Open(); $stream.WriteByte(65); $stream.Dispose() } finally { $zip.Dispose() }
`);
  await run(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', tamper, '-Archive', f.archive], { windowsHide: true });
  const sha256 = createHash('sha256').update(await fs.readFile(f.archive)).digest('hex');
  await assert.rejects(() => f.installer.prepare({ archive: f.archive, sha256, version: '0.5.1' }));
  assert.equal(JSON.parse(await fs.readFile(path.join(f.installDir, '.periph-studio-install.json'), 'utf8')).version, '0.5.0');
  await assert.rejects(() => fs.access(path.join(f.root, 'escape.txt')));
});

test('a helper without committed handoff never installs when the parent closes', { skip: !windows }, async (t) => {
  const f = await fixture(t);
  const job = await f.installer.prepare({ archive: f.archive, sha256: f.sha256, version: '0.5.1' });
  const helper = spawn(job.launcher, [job.script, job.planFile], { detached: true, windowsHide: true, stdio: 'ignore' });
  const exited = once(helper, 'exit');
  await until(async () => JSON.parse(await fs.readFile(path.join(job.jobDir, 'armed.json'), 'utf8')));
  await stopParent(f.parent);
  const result = await until(async () => JSON.parse(await fs.readFile(path.join(job.jobDir, 'result.json'), 'utf8')));
  assert.equal(result.status, 'failed');
  assert.equal(JSON.parse(await fs.readFile(path.join(f.installDir, '.periph-studio-install.json'), 'utf8')).version, '0.5.0');
  await exited;
});

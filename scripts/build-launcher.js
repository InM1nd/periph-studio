'use strict';
const path = require('path');
const { execFileSync } = require('child_process');

function writeLauncher(directory) {
  const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const output = path.join(directory, 'Periph Studio Updater.exe');
  execFileSync(compiler, ['/nologo', '/target:winexe', '/optimize+', '/out:' + output, path.join(__dirname, 'portable-launcher.cs')], { windowsHide: true, stdio: 'pipe' });
  return output;
}
module.exports = { writeLauncher };

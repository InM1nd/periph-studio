'use strict';
const fs = require('fs/promises');
const { createReadStream } = require('fs');
const path = require('path');
const { createHash } = require('crypto');

async function writeManifest(directory, version) {
  const files = [], directories = [];
  async function walk(current, prefix = '') {
    const entries = await fs.readdir(current, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const relative = prefix + entry.name;
      if (relative === '.periph-studio-install.json') continue;
      if (entry.isSymbolicLink()) throw new Error('Installation packages cannot contain links');
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) { directories.push(relative); await walk(full, relative + '/'); }
      else if (entry.isFile()) {
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(full)) hash.update(chunk);
        files.push({ path: relative, size: (await fs.stat(full)).size, sha256: hash.digest('hex') });
      } else throw new Error('Unsupported installation entry: ' + relative);
    }
  }
  await walk(directory);
  await fs.writeFile(path.join(directory, '.periph-studio-install.json'), JSON.stringify({ format: 1, appId: 'periph-studio', version, directories, files }));
}
module.exports = { writeManifest };

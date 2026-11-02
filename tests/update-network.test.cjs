const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {execFile} = require('node:child_process');
const {promisify} = require('node:util');
test('Electron network exposes redirects, streams downloads and cancels requests', {skip:process.platform !== 'win32', timeout:60000}, async () => {
  const requested = path.resolve(process.env.PERIPH_TEST_TMPDIR || os.tmpdir());
  await fs.mkdir(requested,{recursive:true});
  const base = await fs.realpath(requested);
  const profile = await fs.mkdtemp(path.join(base,'periph-network-test-'));
  try {
    const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
    let failure;
    try { await promisify(execFile)(process.env.PERIPH_TEST_ELECTRON || require('electron'), [path.join(__dirname,'fixtures/update-network.cjs'),profile], {env,windowsHide:true,timeout:50000}); }
    catch (error) { failure = error; }
    const result = JSON.parse(await fs.readFile(path.join(profile,'result.json'),'utf8').catch(() => JSON.stringify({error:failure?.message || 'Missing Electron report'})));
    assert.equal(result.passed,true,result.error);
  } finally {
    if (path.dirname(profile) !== base || !path.basename(profile).startsWith('periph-network-test-')) throw Error('Unsafe test cleanup');
    await fs.rm(profile,{recursive:true,force:true,maxRetries:10,retryDelay:200});
  }
});

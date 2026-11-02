const { app, net } = require('electron');
const http = require('node:http');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createUpdateFetch } = require('../../update-fetch');
const profile = process.argv[2];
app.setPath('userData', profile);
const report = (value) => fs.writeFileSync(path.join(profile, 'result.json'), JSON.stringify(value));
let phase = 'startup';
const trace = [];
const deadline = setTimeout(() => { report({error:'Electron integration timeout at ' + phase + ': ' + trace.join(', ')}); app.exit(1); }, 45000);
app.whenReady().then(async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, {location:'/archive'}); res.end(); }
    else if (req.url === '/archive') { res.writeHead(200); res.write('portable-'); setTimeout(() => res.end('archive'), 30); }
    else if (req.url === '/slow') { res.writeHead(200); res.write('first'); const timer = setInterval(() => res.write('more'), 100); res.on('close', () => clearInterval(timer)); }
    else { res.writeHead(404); res.end('missing'); }
  });
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const root = `http://127.0.0.1:${server.address().port}`;
    const fetcher = createUpdateFetch({request(options) {
      const request = net.request(options);
      for (const event of ['redirect','finish','close','error','abort','response']) request.on(event, () => trace.push(phase + ':' + event));
      return request;
    }});
    phase = 'redirect';
    const redirected = await fetcher(root + '/redirect');
    assert.equal(redirected.status, 302);
    assert.equal(redirected.headers.get('location'), root + '/archive');
    phase = 'archive';
    const response = await fetcher(redirected.headers.get('location'));
    assert.equal(await response.text(), 'portable-archive');
    phase = 'missing';
    const missing = await fetcher(root + '/missing');
    assert.equal(missing.status, 404);
    assert.equal(await missing.text(), 'missing');
    phase = 'pre-abort';
    const aborted = new AbortController(); aborted.abort();
    await assert.rejects(fetcher(root, {signal:aborted.signal}));
    phase = 'stream-abort';
    const controller = new AbortController();
    const slow = await fetcher(root + '/slow', {signal:controller.signal});
    const read = slow.text(); controller.abort();
    await assert.rejects(read);
    report({passed:true,electron:process.versions.electron,checks:['manual redirect','stream download','HTTP errors','abort before request','abort during download']});
    clearTimeout(deadline); server.close(); app.exit(0);
  } catch (error) { report({error:error.stack}); clearTimeout(deadline); server.close(); app.exit(1); }
});

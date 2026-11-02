'use strict';
const { Readable } = require('node:stream');

// net.fetch rejects manual redirects in Electron 33. Expose each redirect as a
// response so PortableUpdates can validate the destination before requesting it.
// net.request retains Chromium's Windows proxy and certificate configuration.
function createUpdateFetch(net) {
  return (url, { headers = {}, signal, redirect = 'manual' } = {}) => new Promise((resolve, reject) => {
    if (redirect !== 'manual') return reject(new Error('Update requests require manual redirects'));
    if (signal?.aborted) return reject(signal.reason || new Error('Request aborted'));
    const request = net.request({ url: String(url), method: 'GET', redirect: 'manual', useSessionCookies: false });
    let incoming;
    let redirected = false;
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const abort = () => {
      const error = signal.reason || new Error('Request aborted');
      incoming?.destroy(error);
      reject(error);
      request.abort();
      cleanup();
    };
    request.on('error', (error) => {
      if (!redirected) { incoming?.destroy(error); reject(error); }
      cleanup();
    });
    request.once('close', cleanup);
    request.once('redirect', (status, method, destination) => {
      redirected = true;
      resolve(new Response(null, { status, headers: { location: destination } }));
      cleanup();
      request.abort();
    });
    request.once('response', (response) => {
      incoming = response;
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(response.headers)) {
        for (const item of Array.isArray(value) ? value : [value]) responseHeaders.append(key, item);
      }
      response.once('aborted', () => response.destroy(new Error('Response interrupted')));
      response.once('end', cleanup);
      const empty = [204, 205, 304].includes(response.statusCode);
      const body = Readable.toWeb(response);
      resolve(new Response(empty ? null : body, { status: response.statusCode, headers: responseHeaders }));
      if (empty) response.resume();
    });
    signal?.addEventListener('abort', abort, { once: true });
    for (const [key, value] of Object.entries(headers)) request.setHeader(key, value);
    request.end();
  });
}

module.exports = { createUpdateFetch };

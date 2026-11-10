import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';

import { serveStatic } from '../skills/actua11y/_lib/_serve.ts';
import { tempDir } from './_fixtures.ts';

// A raw request, because fetch and URL would tidy up the path before it ever reached the server.
const rawStatus = (base: string, path: string): Promise<number> =>
  new Promise((resolve, reject) => {
    const url = new URL(base);
    const req = request({ host: url.hostname, port: url.port, path, method: 'GET' }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });

test('the static server serves its folder, refuses to leave it, and survives a malformed path', async () => {
  const root = tempDir('serve');
  writeFileSync(join(root, 'index.html'), '<h1>Moth Club</h1>');
  const server = await serveStatic(root);
  try {
    const home = await fetch(server.url);
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type') ?? '', /text\/html/);
    assert.equal(await rawStatus(server.url, '/..%2f..%2f..%2fetc%2fhosts'), 403, 'an encoded slash survives URL parsing, so the server itself has to refuse');
    assert.equal(await rawStatus(server.url, '/../../etc/hosts'), 404, 'a plain ../ is already collapsed to a path inside the folder');
    assert.equal(await rawStatus(server.url, '/50%-off'), 400);
    assert.equal(await rawStatus(server.url, '/missing.html'), 404);
    assert.equal((await fetch(server.url)).status, 200, 'still up after the bad requests');
  } finally {
    await server.close();
  }
});

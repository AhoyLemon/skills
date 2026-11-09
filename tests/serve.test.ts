import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { serveStatic } from '../skills/actua11y/_lib/_serve.ts';

test('the static server serves its folder, and never anything outside it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'actua11y-test-serve-'));
  writeFileSync(join(root, 'index.html'), '<h1>Moth Club</h1>');
  const server = await serveStatic(root);
  try {
    const home = await fetch(server.url);
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type') ?? '', /text\/html/);
    const escaped = await fetch(new URL('/%2e%2e/%2e%2e/etc/hosts', server.url));
    assert.ok(escaped.status === 403 || escaped.status === 404);
  } finally {
    await server.close();
  }
});

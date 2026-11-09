import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { execAsync } from '../skills/actua11y/_lib/_exec.ts';
import { discoverPages } from '../skills/actua11y/_lib/_pages.ts';
import { serveStatic } from '../skills/actua11y/_lib/_serve.ts';

const site = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'actua11y-test-serve-'));
  writeFileSync(join(root, 'index.html'), '<a href="index.html">Home</a> <a href="about.html">About</a> <a href="style.css">css</a> <a href="https://example.com/">away</a>');
  writeFileSync(join(root, 'about.html'), '<a href="/">Home</a> <a href="team.html#top">Team</a>');
  writeFileSync(join(root, 'team.html'), '<p>Team</p>');
  return root;
};

test('page discovery stays on the site, skips assets, and counts / and /index.html once', async () => {
  const server = await serveStatic(site());
  try {
    assert.deepEqual(await discoverPages(server.url), ['/', '/about.html', '/team.html']);
  } finally {
    await server.close();
  }
});

test('the static server never serves outside its folder', async () => {
  const server = await serveStatic(site());
  try {
    const escaped = await fetch(new URL('/%2e%2e/%2e%2e/etc/hosts', server.url));
    assert.ok(escaped.status === 403 || escaped.status === 404);
  } finally {
    await server.close();
  }
});

test('a child process can reach the in-process server while the runner waits on it', async () => {
  const server = await serveStatic(site());
  try {
    const script = `fetch(${JSON.stringify(server.url)}).then((r) => process.stdout.write(String(r.status)))`;
    const result = await execAsync(process.execPath, ['-e', script]);
    assert.equal(result.stdout, '200');
  } finally {
    await server.close();
  }
});

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { serveStatic } from '../skills/actua11y/_lib/_serve.ts';
import { makeSite, tempDir } from './_fixtures.ts';

const run = promisify(execFile);
const scan = join(import.meta.dirname, '..', 'skills', 'actua11y', 'kit', 'scan.ts');

interface ScanResult {
  browser: { channel: string };
  violations: { id: string; nodeCount: number }[];
}

// Async on purpose: a blocking child would stall the static server in this same process, and every scan would time out.
const kit = (...args: string[]): Promise<{ stdout: string }> => run(process.execPath, [scan, ...args], { timeout: 60_000 });

const hasBrowser = async (): Promise<boolean> => {
  try {
    await kit('--probe');
    return true;
  } catch {
    return false;
  }
};

test('the browser kit scans a served page with axe and records what it found', async (t) => {
  if (!(await hasBrowser())) {
    assert.ok(!process.env['CI'], 'CI has Chrome, so a failed probe there is a real failure');
    t.skip('no Chrome, Edge or Playwright Chromium on this machine');
    return;
  }
  const server = await serveStatic(makeSite());
  const out = join(tempDir('kit'), 'scan.json');
  try {
    await kit('--url', server.url, '--tags', 'wcag2a,wcag21a', '--out', out);
  } finally {
    await server.close();
  }
  const result = JSON.parse(readFileSync(out, 'utf8')) as ScanResult;
  assert.ok(result.browser.channel);
  assert.deepEqual(result.violations.find((rule) => rule.id === 'image-alt')?.nodeCount, 1, 'the fixture\'s moth image has no alt');
});

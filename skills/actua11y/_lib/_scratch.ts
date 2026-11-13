// One fresh scratch folder per run, with the browser kit installed inside it (never in the skill or the user's project), deleted however the run ends.
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve as resolvePath } from 'node:path';
import { spawn } from 'node:child_process';

import { exec } from './_exec.ts';

// Pinned so every run drives the same axe rules. playwright-core never downloads a browser: it drives the Chrome or Edge already installed, or a Chromium installed for this exact Playwright version.
export const KIT_PACKAGES = ['playwright-core@1.65.0', '@axe-core/playwright@4.14.0'];

const KIT_SOURCE = join(import.meta.dirname, '..', 'kit');

export const makeScratch = (label: string): string => realpathSync(mkdtempSync(join(tmpdir(), `actua11y-${label}-`)));

export interface KitResult {
  ok: boolean;
  detail: string;
}

export const installKit = (dir: string): KitResult => {
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ private: true, type: 'module' }, null, 2)}\n`);
  const install = exec('npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel', 'error', ...KIT_PACKAGES], { cwd: dir });
  if (install.code !== 0) return { ok: false, detail: install.stderr.trim().split('\n').slice(-3).join(' ') || 'npm install failed' };
  mkdirSync(join(dir, 'kit'), { recursive: true });
  for (const file of readdirSync(KIT_SOURCE)) if (file.endsWith('.ts')) copyFileSync(join(KIT_SOURCE, file), join(dir, 'kit', file));
  return { ok: true, detail: KIT_PACKAGES.join(', ') };
};

export interface Probe {
  ok: boolean;
  channel: string;
  version: string;
  axeVersion: string;
  detail: string;
}

export const probeBrowser = (dir: string): Probe => {
  const result = exec('node', [join(dir, 'kit', 'scan.ts'), '--probe'], { cwd: dir });
  if (result.code !== 0) return { ok: false, channel: '', version: '', axeVersion: '', detail: result.stderr.trim().split('\n').slice(-2).join(' ') };
  const probe = JSON.parse(result.stdout) as { channel: string; version: string; axeVersion: string };
  return { ok: true, ...probe, detail: `${probe.channel} ${probe.version}` };
};

export const removeDir = (dir: string): void => {
  rmSync(dir, { recursive: true, force: true });
};

export interface BrowserServer {
  endpoint: string;
  close: () => Promise<void>;
}

// The browser lives with the runner when a session's sandbox cannot launch it.
export const startBrowserServer = (dir: string, channel: string): Promise<BrowserServer> => new Promise((resolve, reject) => {
  const root = resolvePath(dir);
  const child = spawn(process.execPath, [join(root, 'kit', 'browser-server.ts'), channel], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let errors = '';
  let settled = false;
  const timer = setTimeout(() => fail('browser server did not start in 30 seconds'), 30_000);
  const fail = (message: string): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    child.kill('SIGTERM');
    reject(new Error(message));
  };
  child.stderr.on('data', (chunk: Buffer) => { errors = (errors + chunk.toString()).slice(-4000); });
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
    const newline = output.indexOf('\n');
    if (newline < 0 || settled) return;
    const endpoint = output.slice(0, newline).trim();
    if (!endpoint.startsWith('ws://127.0.0.1:')) return fail('browser server returned an unexpected endpoint');
    settled = true;
    clearTimeout(timer);
    resolve({ endpoint, close: async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((done) => {
        child.once('exit', () => done());
        child.kill('SIGTERM');
        const force = setTimeout(() => { child.kill('SIGKILL'); done(); }, 5000);
        force.unref();
        child.once('exit', () => clearTimeout(force));
      });
    } });
  });
  child.on('error', (error) => fail(`couldn't start browser server: ${error.message}`));
  child.on('exit', (code) => fail(`browser server exited (${code}): ${errors.trim()}`));
});

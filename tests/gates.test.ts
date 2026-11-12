import assert from 'node:assert/strict';
import { test } from 'node:test';

import { emptyUsage } from '../skills/actua11y/_lib/_backend.ts';
import { fileRefusal } from '../skills/actua11y/_lib/_cmd-file.ts';
import { dryRunIsFresh } from '../skills/actua11y/_lib/_cmd-run.ts';
import { reportHash, type DryRunRecord, type RunMeta } from '../skills/actua11y/_lib/_runs.ts';

const NOW = Date.parse('2026-11-10T12:00:00Z');
const HOUR = 60 * 60 * 1000;

const dryRun = (overrides: Partial<DryRunRecord> = {}): DryRunRecord => ({
  at: new Date(NOW - HOUR).toISOString(),
  backend: 'Claude Code',
  model: 'claude-opus-5-5',
  effort: 'high',
  clean: true,
  problems: [],
  answer: 'Nothing loaded.',
  usage: emptyUsage(),
  transcriptPath: '/tmp/dry.jsonl',
  ...overrides,
});

const wanted = { backend: 'Claude Code', model: 'claude-opus-5-5', effort: 'high' };

test('a finder starts only after a clean dry run with the same backend, model and effort from the last six hours', () => {
  assert.equal(dryRunIsFresh(dryRun(), wanted, NOW), true);
  assert.equal(dryRunIsFresh(null, wanted, NOW), false, 'no dry run at all');
  assert.equal(dryRunIsFresh(dryRun({ clean: false }), wanted, NOW), false, 'a dry run that loaded something it shouldn\'t');
  assert.equal(dryRunIsFresh(dryRun({ model: 'claude-sonnet-5-5' }), wanted, NOW), false, 'another model');
  assert.equal(dryRunIsFresh(dryRun({ effort: 'medium' }), wanted, NOW), false, 'another effort');
  assert.equal(dryRunIsFresh(dryRun({ backend: 'Codex' }), wanted, NOW), false, 'another backend');
  assert.equal(dryRunIsFresh(dryRun({ at: new Date(NOW - 7 * HOUR).toISOString() }), wanted, NOW), false, 'seven hours old');
});

const REPORT = '{"schema": "actua11y.finder/1"}\n';

const meta = (session: Partial<NonNullable<RunMeta['session']>> = {}, role: RunMeta['role'] = 'finder'): RunMeta => ({
  runId: '20261110-120000-abcd',
  role,
  createdAt: '2026-11-10T11:00:00Z',
  finishedAt: '2026-11-10T11:30:00Z',
  repoRoot: '/work/moth-club',
  repo: { owner: 'AhoyLemon', name: 'skills' },
  commit: '0123456789abcdef0123456789abcdef01234567',
  branch: 'main',
  level: 'A',
  scope: ['.'],
  baseUrl: 'http://127.0.0.1:4173/',
  site: { url: 'http://127.0.0.1:4173/', serve: null },
  pages: [],
  served: null,
  browser: null,
  axe: null,
  backend: 'Claude Code',
  model: 'claude-opus-5-5',
  effort: 'high',
  maxTurns: 300,
  maxBudgetUsd: 20,
  dryRun: null,
  session: { sessionId: 's', attempts: 1, usage: emptyUsage(), transcriptPath: '/tmp/t.jsonl', errors: [], permissionDenials: 0, offLimitsMentions: [], strays: [], ignoredStrays: [], valid: true, reportSha256: reportHash(REPORT), ...session },
  pass: null,
});

test('filing refuses an invalid run, an edited report, a run that wrote to the app, and unexplained gitignored paths', () => {
  assert.equal(fileRefusal(meta(), REPORT, []), null, 'a clean run files');
  assert.match(fileRefusal(meta({ valid: false }), REPORT, []) ?? '', /no validated report/);
  assert.match(fileRefusal(meta(), null, []) ?? '', /no validated report/, 'report.json missing');
  assert.match(fileRefusal(meta(), REPORT.replace('finder', 'fixer'), []) ?? '', /changed after the finder ran/, 'edited after the run');
  assert.match(fileRefusal(meta({ reportSha256: null }), REPORT, []) ?? '', /changed after the finder ran/, 'a run with no recorded hash');
  assert.match(fileRefusal(meta({ strays: [' M index.html'] }), REPORT, ['index.html']) ?? '', /changed tracked or untracked files/, 'no way past a write to the app');
  assert.match(fileRefusal(meta({ ignoredStrays: ['.cache/'] }), REPORT, []) ?? '', /\.cache\//);
  assert.equal(fileRefusal(meta({ ignoredStrays: ['.cache/'] }), REPORT, ['.cache']), null, 'acknowledged with --allow-ignored');
  assert.match(fileRefusal(meta({ errors: ['stopped at start: MCP servers loaded: slack'] }), REPORT, []) ?? '', /stopped at its first event/, 'a session that loaded something it shouldn\'t, whatever it reported');
});

test('a certifier run meets the same refusals, in its own name', () => {
  assert.equal(fileRefusal(meta({}, 'certifier'), REPORT, []), null);
  assert.match(fileRefusal(meta({}, 'certifier'), REPORT.replace('finder', 'fixer'), []) ?? '', /changed after the certifier ran/);
  assert.match(fileRefusal(meta({ strays: [' M index.html'] }, 'certifier'), REPORT, []) ?? '', /changed tracked or untracked files/);
  assert.match(fileRefusal(meta({ errors: ['stopped at start: skills loaded: x'] }, 'certifier'), REPORT, []) ?? '', /run the dry run and the certifier again/);
});

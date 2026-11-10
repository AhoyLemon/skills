import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RoleSpec } from '../skills/actua11y/_lib/_backend.ts';
import { fillTemplate, placeholdersIn, readBrief } from '../skills/actua11y/_lib/_brief.ts';
import { finderBrief } from '../skills/actua11y/_lib/_cmd-run.ts';
import { criteriaAt } from '../skills/actua11y/_lib/_criteria.ts';
import { ALL_DENIES } from '../skills/actua11y/_lib/_rules.ts';

const spec: RoleSpec = {
  role: 'finder',
  brief: '',
  cwd: '/work/moth-club',
  scratch: '/tmp/actua11y-run-abc',
  readOnly: true,
  noTools: false,
  deny: ALL_DENIES,
  offLimits: ['/work/moth-club/.git/', '/work/answers/'],
  model: 'claude-opus-5-5',
  effort: 'high',
  maxTurns: 300,
  maxBudgetUsd: 20,
  timeoutMs: 60_000,
  transcriptPath: '/tmp/t.jsonl',
};

const brief = (level: 'A' | 'AA' | 'AAA'): string =>
  finderBrief({ level, scope: ['.'], repoRoot: '/work/moth-club', baseUrl: 'http://127.0.0.1:4173/', pages: ['/', '/join.html'], scratch: '/tmp/actua11y-run-abc', browser: 'chrome 157 (headless)', channel: 'chrome', spec });

test('the finder brief leaves no placeholder unfilled', () => {
  assert.doesNotMatch(brief('AA'), /\{\{[A-Z0-9_]+\}\}/);
  assert.throws(() => fillTemplate('Hi {{NAME}} and {{OTHER}}', { NAME: 'x' }), /OTHER/);
  assert.ok(placeholdersIn(readBrief('finder')).includes('CRITERIA_TABLE'));
  const unnamed = finderBrief({ level: 'A', scope: ['.'], repoRoot: '/work/moth-club', baseUrl: 'http://127.0.0.1:4173/', pages: [], scratch: '/tmp/actua11y-run-abc', browser: 'chrome 157 (headless)', channel: 'chrome', spec });
  assert.match(unnamed, /find every page in scope yourself/);
});

test('the brief lists exactly the criteria at the target, with levels from the table', () => {
  const text = brief('A');
  for (const criterion of criteriaAt('A')) assert.ok(text.includes(`| ${criterion.num} `), criterion.num);
  assert.ok(!text.includes('| 2.4.7 '), 'Focus Visible is AA and must not appear at A');
  assert.match(brief('AA'), /\| 2\.4\.7 Focus Visible \| AA \|/);
});

test('the rules in the brief come from the same list the backend enforces', () => {
  const text = brief('AA');
  assert.match(text, /No git commands at all/);
  assert.match(text, /No gh and no GitHub API/);
  assert.doesNotMatch(text, /\/work\/answers\//, 'the brief must not name the user\'s other folders');
  assert.match(text, /Read nothing outside the repository and your scratch folder/);
  assert.match(text, /scratch folder is \/tmp\/actua11y-run-abc/);
});

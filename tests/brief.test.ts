import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { RoleSpec } from '../skills/actua11y/_lib/_backend.ts';
import { fillTemplate, placeholdersIn, readBrief } from '../skills/actua11y/_lib/_brief.ts';
import { finderBrief } from '../skills/actua11y/_lib/_cmd-run.ts';
import { criteriaAt } from '../skills/actua11y/_lib/_criteria.ts';
import { certifierBrief } from '../skills/actua11y/_lib/_cmd-certifier.ts';
import { FIXER_SCHEMA } from '../skills/actua11y/_lib/_fixer.ts';
import { addHuman, applyFixer, initialLedger, startLoop, type LoopView } from '../skills/actua11y/_lib/_ledger.ts';
import { validateReport } from '../skills/actua11y/_lib/_report.ts';
import { ALL_DENIES } from '../skills/actua11y/_lib/_rules.ts';
import { makeFacts, makeReport, makeSite } from './_fixtures.ts';

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

const loopView = (): LoopView => {
  const result = validateReport(makeReport('A'), { criteria: criteriaAt('A'), repoRoot: makeSite(), tracked: new Set(['index.html', 'css/site.css']) });
  if (!result.ok) throw new Error(result.errors.join('\n'));
  const started = startLoop(initialLedger(result.report, makeFacts('A'), { url: 'http://127.0.0.1:4173/', serve: null }), { branch: 'actua11y-a-1', pr: null, budgetUsd: 60 });
  const ledger = applyFixer(started, { schema: FIXER_SCHEMA, brief: 'x', findings: [{ id: 'A1', outcome: 'fixed', commit: 'a'.repeat(40), how: 'SECRET FIXER ACCOUNT of the alt text' }, { id: 'A2', outcome: 'couldnt', why: 'SECRET FIXER REASON' }] }, { round: 1, sha: 'a'.repeat(40), base: 'b'.repeat(40), at: 'now', reported: { tokens: 1, minutes: 1 }, commentUrls: [] });
  return { ledger, finder: result.report, passes: new Map() };
};

const certifierText = (view: LoopView): string => certifierBrief(view, { root: '/work/moth-club', commit: 'c'.repeat(40), baseUrl: 'http://127.0.0.1:4173/', scratch: '/tmp/actua11y-run-abc', browser: 'chrome 157 (headless)', channel: 'chrome', spec: { ...spec, role: 'certifier' } });

test("the certifier's brief is blind: the finder's list and the carried steps, never a status or the fixer's account", () => {
  const text = certifierText(loopView());
  assert.doesNotMatch(text, /\{\{[A-Z0-9_]+\}\}/);
  assert.doesNotMatch(text, /SECRET FIXER|claimed|fixer round/i);
  assert.match(text, /### A1 · 1\.1\.1 Non-text Content \(A\)/);
  assert.match(text, /\*\*A2\*\*, `from: 0` \(the finder's own steps[^\n]*\n    1\. Load \/\n    2\. Press Tab until focus leaves the page/, "the finder's behaviour repro is carried word for word");
  assert.match(text, /- P1 \(1\.1\.1\): Whether the moth photo is decorative or carries meaning\. A person checks this one, and only they can close it/);
  assert.match(text, /No git commands at all/);
});

test("in the human round the certifier gets the person's fixes in their own words, and what they accepted as out of scope", () => {
  const view = loopView();
  const human = { ...view.ledger, stage: 'human' as const };
  const withFix = addHuman(human, { words: 'The Join button is hard to hit on my phone', tag: { kind: 'wcag', num: '2.5.8' }, decision: { choice: 'fix', reason: null, how: 'Make it at least 44px tall' }, check: 'P1' }).ledger;
  const both = addHuman(withFix, { words: 'The footer is a bit grey', tag: { kind: 'ux' }, decision: { choice: 'accept', reason: 'Brand colours', how: null } }).ledger;
  const text = certifierText({ ...view, ledger: both });
  assert.match(text, /### H1 · a person's own finding · WCAG 2\.5\.8 Target Size \(Minimum\) \(AA\)\n\n- \*\*In their words:\*\* "The Join button is hard to hit on my phone"/);
  assert.match(text, /- \*\*How they want it solved, in their words:\*\* "Make it at least 44px tall"/, 'the certifier sees the person\'s how-to, so it judges by their call');
  assert.match(text, /- \*\*It came from check P1, which they looked at and found a problem with:\*\* Whether the moth photo/);
  assert.match(text, /They decided it should be fixed\. Judge it, but it sits outside the target\./, '2.5.8 is AA, outside an A target');
  assert.match(text, /- H2 \(UX\): "The footer is a bit grey"\. A person accepted it as it is/);
  assert.match(text, /guarding a human round/);
});

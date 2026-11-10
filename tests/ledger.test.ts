import assert from 'node:assert/strict';
import { test } from 'node:test';

import { emptyUsage } from '../skills/actua11y/_lib/_backend.ts';
import { CERTIFIER_SCHEMA, passVerdict, type CertifierReport } from '../skills/actua11y/_lib/_certifier.ts';
import { criteriaAt } from '../skills/actua11y/_lib/_criteria.ts';
import { FIXER_SCHEMA } from '../skills/actua11y/_lib/_fixer.ts';
import { addHuman, applyFixer, applyPass, decide, initialLedger, ledgerBlock, parseLedger, passPlan, startLoop, waitingOnPerson, type Ledger } from '../skills/actua11y/_lib/_ledger.ts';
import { GITHUB_LIMIT, renderAgentIssue } from '../skills/actua11y/_lib/_render.ts';
import { validateReport, type FinderReport } from '../skills/actua11y/_lib/_report.ts';
import { makeFacts, makeReport, makeSite } from './_fixtures.ts';

const finder = (): FinderReport => {
  const result = validateReport(makeReport('A'), { criteria: criteriaAt('A'), repoRoot: makeSite(), tracked: new Set(['index.html', 'css/site.css']) });
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.report;
};

const started = (): Ledger => startLoop(initialLedger(finder(), makeFacts('A'), { url: 'http://127.0.0.1:4173/', serve: null }), { branch: 'actua11y-a-1', pr: null, budgetUsd: 60 });

const failing = (ids: string[], extra: Partial<CertifierReport> = {}): CertifierReport => ({
  schema: CERTIFIER_SCHEMA,
  used: { tools: ['Read'], pages: ['/'] },
  items: ids.map((id) => ({ id, notFixed: { file: 'index.html', line: 5, what: 'Still fails', steps: ['Load /'] } })),
  reran: [],
  rewalk: { criteria: [], newFails: [], newChecks: [] },
  ...extra,
});

const passInput = (pass: number) => ({ pass, sha: `${pass}`.repeat(40), at: '2026-11-11T10:00:00Z', runId: `run-${pass}`, model: 'claude-opus-5-5', effort: 'high', browser: null, usage: { ...emptyUsage(), costUsd: 2 }, dryRun: null, commentUrls: [] });

const fixerRound = (ledger: Ledger, round: number): Ledger => applyFixer(ledger, { schema: FIXER_SCHEMA, brief: 'x', findings: [] }, { round, sha: `f${round}`.padEnd(40, '0'), base: 'b'.repeat(40), at: '2026-11-11T09:00:00Z', reported: { tokens: null, minutes: null }, commentUrls: [] });

test('ids follow the finder\'s report order, so the same report always gets the same ids', () => {
  const ledger = initialLedger(finder(), makeFacts('A'), { url: null, serve: 'site' });
  assert.deepEqual(ledger.items.map((item) => [item.id, item.source]), [['A1', { kind: 'finder', num: '1.1.1', index: 0 }], ['A2', { kind: 'finder', num: '2.1.1', index: 0 }]]);
  assert.deepEqual(ledger.checks.map((check) => check.id), ['P1', 'P2']);
  assert.equal(ledger.spentUsd, 3.27, 'the finder and its dry run count against the budget from the start');
});

test('the ledger round-trips through an issue body, backticks in a person\'s words and all', () => {
  const { ledger } = addHuman(started(), { words: 'The ```Join``` button is <tiny> and \\ odd', tag: { kind: 'ux' }, decision: { choice: 'fix', reason: null } });
  const body = `Some issue text\r\n\r\n${ledgerBlock(ledger)}\r\n`;
  assert.deepEqual(parseLedger(body.replace(/\n/g, '\r\n')), ledger);
  assert.equal(parseLedger('No ledger here'), null);
});

test('three fixer rounds without an approving pass hit the cap: every open fail moves to the person, needing a decision', () => {
  let ledger = started();
  for (const round of [1, 2, 3]) {
    ledger = fixerRound(ledger, round);
    const report = failing(['A2'], { items: [{ id: 'A1', fixed: [{ did: 'd', saw: 's' }] }, { id: 'A2', notFixed: { file: 'index.html', line: 6, what: 'Still a div', steps: ['Load /', 'Press Tab'] } }] });
    const outcome = applyPass(ledger, report, passVerdict(report, new Set(['A1', 'A2'])), passInput(round));
    ledger = outcome.ledger;
    if (round < 3) assert.equal(outcome.ended, null);
    else {
      assert.deepEqual(outcome.ended, { why: 'cap', pass: 3 });
      assert.deepEqual(outcome.moved, ['A2']);
    }
  }
  assert.equal(ledger.stage, 'human');
  const moved = ledger.items.find((item) => item.id === 'A2');
  assert.equal(moved?.status, 'moved');
  assert.equal(moved?.moved?.by, 'cap');
  assert.deepEqual(moved?.carried, [1, 2, 3], 'every pass\'s steps travel with it');
  assert.deepEqual(waitingOnPerson(ledger, new Set(['P1', 'P2'])).undecided, ['A2']);
  assert.equal(ledger.items.find((item) => item.id === 'A1')?.status, 'certified');
  const decided = decide(ledger, 'A2', { choice: 'fix', reason: null });
  assert.deepEqual(passPlan(decided).items, ['A1', 'A2'], 'a fail the person decides to fix goes back to the certifier');
  assert.deepEqual(passPlan(decide(ledger, 'A2', { choice: 'accept', reason: 'Later' })).items, ['A1'], 'an accepted one is out of scope');
});

test('a certifier 🕵️ turns an item into a check, and a new fail in the human round waits on the person', () => {
  let ledger = fixerRound(started(), 1);
  const report: CertifierReport = { ...failing([]), items: [{ id: 'A1', fixed: [{ did: 'd', saw: 's' }] }, { id: 'A2', needsPerson: { what: 'Whether Join announces itself', how: 'VoiceOver', whyNotAMachine: 'Speech output' } }] };
  const outcome = applyPass(ledger, report, passVerdict(report, new Set(['A1', 'A2'])), passInput(1));
  ledger = outcome.ledger;
  assert.deepEqual(outcome.ended, { why: 'approved', pass: 1 });
  assert.equal(ledger.items.find((item) => item.id === 'A2')?.moved?.check, 'P3');
  assert.deepEqual(waitingOnPerson(ledger, new Set()).unticked, ['P1', 'P2', 'P3']);
  assert.deepEqual(waitingOnPerson(ledger, new Set()).undecided, [], 'a check needs a tick, not a decision');
  const human: CertifierReport = { ...failing([]), items: [{ id: 'A1', fixed: [{ did: 'd', saw: 's' }] }], rewalk: { criteria: [], newFails: [{ num: '2.1.1', file: 'index.html', line: 6, what: 'A new trap', whoItHurts: 'Keyboard users', behaviour: false }], newChecks: [] } };
  const after = applyPass(ledger, human, passVerdict(human, new Set(['A1'])), passInput(2));
  assert.equal(after.ledger.items.find((item) => item.id === 'A3')?.status, 'moved');
  assert.deepEqual(waitingOnPerson(after.ledger, new Set(['P1', 'P2', 'P3'])).undecided, ['A3']);
});

test('a long loop still fits: with 200 fails after six passes, the whole agent issue, ledger included, stays inside GitHub\'s limit', () => {
  const big = finder();
  const target = big.criteria.find((item) => item.num === '1.1.1');
  if (!target) throw new Error('fixture lost 1.1.1');
  target.fails = Array.from({ length: 200 }, (_, i) => ({ file: 'index.html', line: 5, what: `Fail ${i}`, whoItHurts: 'Someone', behaviour: false }));
  let ledger = startLoop(initialLedger(big, makeFacts('A'), { url: null, serve: 'site' }), { branch: 'b', pr: 'https://github.com/o/r/pull/3', budgetUsd: 500 });
  const ids = ledger.items.map((item) => item.id);
  for (const pass of [1, 2, 3, 4, 5, 6]) {
    if (ledger.stage === 'ai') ledger = fixerRound(ledger, pass);
    const report = failing(ids.filter((id) => !ledger.items.find((item) => item.id === id && item.status === 'moved')));
    ledger = applyPass(ledger, report, passVerdict(report, new Set(ids)), passInput(pass)).ledger;
  }
  const view = { ledger, finder: big, passes: new Map() };
  const agent = renderAgentIssue(view, { personUrl: 'https://github.com/o/r/issues/2' });
  assert.ok(agent.body.length <= GITHUB_LIMIT, `the body is ${agent.body.length} characters`);
  assert.ok(agent.comments.some((comment) => comment.kind === 'fails'), 'the rows moved into comments, and the ledger stayed');
  assert.deepEqual(parseLedger(agent.body), ledger);
});

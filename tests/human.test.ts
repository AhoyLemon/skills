import assert from 'node:assert/strict';
import { test } from 'node:test';

import { emptyUsage } from '../skills/actua11y/_lib/_backend.ts';
import { CERTIFIER_SCHEMA, passVerdict, type CertifierReport } from '../skills/actua11y/_lib/_certifier.ts';
import { criteriaAt } from '../skills/actua11y/_lib/_criteria.ts';
import type { GhIssue } from '../skills/actua11y/_lib/_gh.ts';
import { closeOutCheck, foundVerbatim, personSources, yourTurn } from '../skills/actua11y/_lib/_human.ts';
import { nextStep } from '../skills/actua11y/_lib/_cmd-loop.ts';
import { addHuman, applyPass, decide, humanPassesSinceApproval, initialLedger, startLoop, stopAi, type Ledger } from '../skills/actua11y/_lib/_ledger.ts';
import { validateReport } from '../skills/actua11y/_lib/_report.ts';
import { renderCloseOutBody } from '../skills/actua11y/_lib/_render-loop.ts';
import { makeFacts, makeReport, makeSite, viewOf } from './_fixtures.ts';

test("only the person's own region and their unmarked comments count as their words", () => {
  const person: GhIssue = {
    url: 'https://github.com/AhoyLemon/skills/issues/2',
    number: 2,
    state: 'OPEN',
    body: '## 🕵️ To check\n\n- [ ] **P1** Whether the photo is decorative\n\n<!-- actua11y:yours -->\nThe Join   button is\ntiny on my phone.\n<!-- actua11y:/yours -->\n\n## Your findings\n\n- **H1** “Accept the menu as it is”',
    comments: [{ url: 'c1', body: 'Also, the footer links blur together.' }, { url: 'c2', body: '<!-- actua11y:fixer v1 round=1 -->\nMenu should close on Escape' }],
  };
  const sources = personSources(person);
  assert.ok(foundVerbatim('The Join button is tiny on my phone.', sources), 'whitespace is forgiven, words are not');
  assert.ok(foundVerbatim('the footer links blur together', sources));
  assert.ok(!foundVerbatim('Whether the photo is decorative', sources), "the runner's checklist isn't theirs");
  assert.ok(!foundVerbatim('Accept the menu as it is', sources), "nor is the runner's quote of them");
  assert.ok(!foundVerbatim('Menu should close on Escape', sources), 'nor a comment the runner posted');
  assert.ok(!foundVerbatim('   ', sources));
});

const approvedLedger = (): Ledger => {
  const result = validateReport(makeReport('A'), { criteria: criteriaAt('A'), repoRoot: makeSite(), tracked: new Set(['index.html', 'css/site.css']) });
  if (!result.ok) throw new Error(result.errors.join('\n'));
  const ledger = startLoop(initialLedger(result.report, makeFacts('A'), { url: null, serve: 'site' }), { branch: 'b', pr: 'https://github.com/AhoyLemon/skills/pull/3', budgetUsd: 60 });
  const report: CertifierReport = { schema: CERTIFIER_SCHEMA, used: { tools: ['Read'], pages: ['/'] }, items: ['A1', 'A2'].map((id) => ({ id, fixed: [{ did: 'd', saw: 's' }] })), reran: [], rewalk: { criteria: [], newFails: [], newChecks: [] } };
  return applyPass(ledger, report, passVerdict(report, new Set(['A1', 'A2'])), { pass: 1, sha: 'a'.repeat(40), at: 'now', runId: 'r1', model: 'm', effort: 'high', browser: null, usage: emptyUsage(), dryRun: null, commentUrls: [] }).ledger;
};

test('Codex next steps preserve the backend for certifiers in both rounds', () => {
  const base = approvedLedger();
  const previous = base.rounds[0];
  assert.ok(previous);
  const fixer = { ...previous, kind: 'fixer' as const, stage: 'ai' as const };
  const ai = { ...base, stage: 'ai' as const, facts: { ...base.facts, backend: 'Codex' }, rounds: [fixer] };
  assert.match(nextStep(ai, new Set(), 'https://github.com/AhoyLemon/skills/issues/1').command ?? '', /run certifier --backend codex --issue 1/);
  const human = { ...ai, stage: 'human' as const, rounds: [{ ...fixer, stage: 'human' as const }] };
  assert.match(nextStep(human, new Set(), 'https://github.com/AhoyLemon/skills/issues/1').command ?? '', /run certifier --backend codex --issue 1/);
  const unjudged = { ...human, rounds: [], items: human.items.map((item) => ({ ...item, status: 'claimed' as const, judged: null })) };
  assert.match(nextStep(unjudged, new Set(), 'https://github.com/AhoyLemon/skills/issues/1').command ?? '', /run certifier --backend codex --issue 1/);
});

test('close-out waits for every tick and decision, and for a pass that judged every fix', () => {
  const ledger = approvedLedger();
  assert.deepEqual(closeOutCheck(ledger, new Set(['P1', 'P2']), false).refusals, [], 'approved, ticked, nothing undecided');
  assert.match(closeOutCheck(ledger, new Set(['P1']), false).refusals.join(' '), /hasn't ticked P2, or turned it into a finding/);
  const fixLater = addHuman(ledger, { words: 'Join is tiny', tag: { kind: 'wcag', num: '2.5.8' }, decision: { choice: 'fix', reason: null, how: null } }).ledger;
  assert.match(closeOutCheck(fixLater, new Set(['P1', 'P2']), false).refusals.join(' '), /didn't judge H1, so run the certifier once more/, 'a fix decided after the last pass needs another');
  const accepted = addHuman(ledger, { words: 'Join is tiny', tag: { kind: 'ux' }, decision: { choice: 'accept', reason: 'Fine for now', how: null } }).ledger;
  assert.deepEqual(closeOutCheck(accepted, new Set(['P1', 'P2']), false).refusals, [], 'an accepted finding needs no pass');
});

test('at the human cap, close-out needs --at-cap and names what still fails', () => {
  let ledger = addHuman(approvedLedger(), { words: 'Join is tiny', tag: { kind: 'wcag', num: '2.5.8' }, decision: { choice: 'fix', reason: null, how: null } }).ledger;
  const stillTiny: CertifierReport = { schema: CERTIFIER_SCHEMA, used: { tools: ['Read'], pages: ['/'] }, items: [{ id: 'A1', fixed: [{ did: 'd', saw: 's' }] }, { id: 'A2', fixed: [{ did: 'd', saw: 's' }] }, { id: 'H1', notFixed: { file: 'index.html', line: 6, what: 'Still 20px', steps: ['Measure Join'] } }], reran: [], rewalk: { criteria: [], newFails: [], newChecks: [] } };
  for (const pass of [2, 3, 4]) ledger = applyPass(ledger, stillTiny, passVerdict(stillTiny, new Set(['A1', 'A2'])), { pass, sha: `${pass}`.repeat(40), at: 'now', runId: `r${pass}`, model: 'm', effort: 'high', browser: null, usage: emptyUsage(), dryRun: null, commentUrls: [] }).ledger;
  assert.equal(ledger.rounds.at(-1)?.approved, true, '2.5.8 is AA, so at an A target H1 never blocks');
  const blocking = { ...ledger, facts: { ...ledger.facts, level: 'AA' as const } };
  const refused = closeOutCheck({ ...blocking, rounds: blocking.rounds.map((round) => ({ ...round, approved: round.n === 1 })) }, new Set(['P1', 'P2']), false);
  assert.match(refused.refusals.join(' '), /hit its cap of 3 certifier runs without an approving pass. Pass --at-cap/);
  const atCap = closeOutCheck({ ...blocking, rounds: blocking.rounds.map((round) => ({ ...round, approved: round.n === 1 })) }, new Set(['P1', 'P2']), true);
  assert.deepEqual(atCap.refusals, []);
  assert.deepEqual(atCap.stillFailing, ['H1']);
});

test("while a fail waits on the person's decision, the next step is theirs, not another pass", () => {
  const capped = stopAi({ ...approvedLedger(), stage: 'ai', stopped: null }, { why: 'cap', pass: 1 }).ledger;
  const reopened = { ...capped, items: capped.items.map((item) => (item.id === 'A1' ? { ...item, status: 'moved' as const, moved: { by: 'cap' as const, at: 1, why: 'cap', check: null }, judged: { pass: 1, result: 'notFixed' as const }, decision: null } : item)) };
  const waiting = nextStep(reopened, new Set(['P1', 'P2']), 'https://github.com/AhoyLemon/skills/issues/1');
  assert.equal(waiting.command, null);
  assert.match(waiting.says, /Waiting on the person to decide A1/);
  const decided = decide(reopened, 'A1', { choice: 'fix', reason: null, how: 'Describe the moth' });
  assert.match(nextStep(decided, new Set(['P1', 'P2']), 'https://github.com/AhoyLemon/skills/issues/1').command ?? '', /brief fixer/, 'a fix decision brings the fixer back');
});

test("a pass that approved never uses up the human round's cap, and at a real cap --at-cap lists a late fix as never judged instead of sticking", () => {
  let ledger = approvedLedger();
  const approve: CertifierReport = { schema: CERTIFIER_SCHEMA, used: { tools: ['Read'], pages: ['/'] }, items: ['A1', 'A2'].map((id) => ({ id, fixed: [{ did: 'd', saw: 's' }] })), reran: [], rewalk: { criteria: [], newFails: [], newChecks: [] } };
  const fail: CertifierReport = { ...approve, items: ['A1', 'A2', 'H1'].map((id) => ({ id, fixed: [{ did: 'd', saw: 's' }] })), rewalk: { criteria: [], newFails: [{ num: '2.1.1', file: 'index.html', line: 6, what: 'A trap', whoItHurts: 'Keyboard users', behaviour: false }], newChecks: [] } };
  const pass = (report: CertifierReport, n: number): void => {
    ledger = applyPass(ledger, report, passVerdict(report, new Set(['A1', 'A2'])), { pass: n, sha: `${n}`.repeat(40), at: 'now', runId: `r${n}`, model: 'm', effort: 'high', browser: null, usage: emptyUsage(), dryRun: null, commentUrls: [] }).ledger;
  };
  pass(approve, 2);
  pass(approve, 3);
  pass(approve, 4);
  assert.equal(humanPassesSinceApproval(ledger), 0, 'three approving passes leave the whole cap');
  const late = addHuman(ledger, { words: 'Join is tiny', tag: { kind: 'wcag', num: '2.5.8' }, decision: { choice: 'fix', reason: null, how: 'Make it bigger' } }).ledger;
  assert.match(nextStep(late, new Set(['P1', 'P2']), 'https://github.com/AhoyLemon/skills/issues/1').command ?? '', /brief fixer/, 'so a fix decided after the third pass still gets a fixer and a certifier');
  ledger = late;
  pass(fail, 5);
  pass(fail, 6);
  pass(fail, 7);
  const later = addHuman(ledger, { words: 'The footer links blur together', tag: { kind: 'ux' }, decision: { choice: 'fix', reason: null, how: null } }).ledger;
  const decided = decide(later, 'A3', { choice: 'accept', reason: 'Later', how: null });
  const decided2 = decide(decided, 'A4', { choice: 'accept', reason: 'Later', how: null });
  const settled = decide(decided2, 'A5', { choice: 'accept', reason: 'Later', how: null });
  assert.match(closeOutCheck(settled, new Set(['P1', 'P2']), false).refusals.join(' '), /at its cap\. Pass --at-cap/);
  const atCap = closeOutCheck(settled, new Set(['P1', 'P2']), true);
  assert.deepEqual(atCap.refusals, []);
  assert.deepEqual(atCap.neverJudged, ['H2'], 'listed plainly, not a dead end');
});

test("close-out shows a fix the certifier left to the person as their check, never as still failing", () => {
  const result = validateReport(makeReport('A'), { criteria: criteriaAt('A'), repoRoot: makeSite(), tracked: new Set(['index.html', 'css/site.css']) });
  if (!result.ok) throw new Error(result.errors.join('\n'));
  const asked = addHuman(approvedLedger(), { words: 'The steppers feel too small', tag: { kind: 'ux' }, decision: { choice: 'fix', reason: null, how: null } }).ledger;
  const report: CertifierReport = { schema: CERTIFIER_SCHEMA, used: { tools: ['Read'], pages: ['/'] }, items: [...['A1', 'A2'].map((id) => ({ id, fixed: [{ did: 'd', saw: 's' }] })), { id: 'H1', needsPerson: { what: 'Whether 40px feels big enough', how: 'Use them', whyNotAMachine: 'A feeling' } }], reran: [], rewalk: { criteria: [], newFails: [], newChecks: [] } };
  const ledger = applyPass(asked, report, passVerdict(report, new Set(['A1', 'A2'])), { pass: 2, sha: '2'.repeat(40), at: 'now', runId: 'r2', model: 'm', effort: 'high', browser: null, usage: emptyUsage(), dryRun: null, commentUrls: [] }).ledger;
  const check = ledger.checks.at(-1)?.id ?? '';
  const body = renderCloseOutBody({ ...viewOf(result.report), ledger }, { agentNumber: 1, personNumber: 2, prNumber: 3, sha: '2'.repeat(40), pass: 2, approved: true, uncertified: [], stillFailing: [], neverJudged: [], ticked: new Set(['P1', 'P2', check]), days: 1, headSha: '2'.repeat(40) });
  const line = body.split('\n').find((text) => text.includes('**H1**')) ?? '';
  assert.doesNotMatch(line, /still failing/, 'no pass found it failing');
  assert.match(line, new RegExp(`left to the person by certifier pass 2 as ${check}, which they ticked`));
});

test("the person's turn is a few lines: their issue, what's left to tick or decide, and that their words go on the issue, not in chat", () => {
  const ledger = { ...approvedLedger(), personUrl: 'https://github.com/AhoyLemon/skills/issues/2' };
  const turn = yourTurn(ledger, new Set(['P1']));
  assert.ok(turn.length <= 5, 'short enough to relay as it stands');
  assert.equal(turn[0], 'Your turn, on https://github.com/AhoyLemon/skills/issues/2:');
  assert.match(turn.join('\n'), /1 check to try \(P2\)\. Tick each one that holds up\./);
  assert.match(turn.join('\n'), /comment on that issue in your own words[^\n]*Only words on the issue go on the record/);
  assert.match(turn.join('\n'), /Then say so in chat/);
  assert.deepEqual(yourTurn(ledger, new Set(['P1', 'P2'])), [], 'nothing left, so nothing to relay');
  assert.deepEqual(yourTurn({ ...ledger, stage: 'ai' }, new Set()), [], 'never during the AI rounds');
});

test('their words count only whole, so "fine" never matches inside "define"', () => {
  assert.ok(!foundVerbatim('fine', ['Please define the scope']));
  assert.ok(!foundVerbatim('The Join butt', ['The Join button is tiny']));
  assert.ok(foundVerbatim('This is not fine (really).', ['Honestly. This is not fine (really). Thanks']));
});

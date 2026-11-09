import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AAA_WARNING, BEST_FAITH } from '../skills/actua11y/_lib/_copy.ts';
import { criteriaAt, type Level } from '../skills/actua11y/_lib/_criteria.ts';
import { GITHUB_LIMIT, renderAgentIssue, renderPersonIssue, renderRawComments, safeText } from '../skills/actua11y/_lib/_render.ts';
import { validateReport, type FinderReport } from '../skills/actua11y/_lib/_report.ts';
import { makeFacts, makeReport, makeSite } from './_fixtures.ts';

const repoRoot = makeSite();

const validReport = (level: Level): FinderReport => {
  const result = validateReport(makeReport(level), { criteria: criteriaAt(level), repoRoot, tracked: new Set(['index.html', 'css/site.css']) });
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.report;
};

const renderAll = (level: Level): string[] => {
  const report = validReport(level);
  const facts = makeFacts(level);
  const agent = renderAgentIssue(report, facts, { personUrl: 'https://github.com/AhoyLemon/skills/issues/2' });
  const person = renderPersonIssue(report, facts, { agentUrl: 'https://github.com/AhoyLemon/skills/issues/1' });
  return [agent.title, agent.body, ...agent.comments, person.title, person.body, ...person.comments, ...renderRawComments(report, facts)];
};

const bodies = (level: Level): string[] => {
  const report = validReport(level);
  const facts = makeFacts(level);
  return [renderAgentIssue(report, facts, { personUrl: null }).body, renderPersonIssue(report, facts, { agentUrl: 'https://github.com/AhoyLemon/skills/issues/1' }).body];
};

test('both issues carry the best-faith line, and the AAA warning only at AAA', () => {
  for (const body of bodies('A')) {
    assert.ok(body.includes(BEST_FAITH));
    assert.ok(!body.includes(AAA_WARNING));
  }
  for (const body of bodies('AAA')) assert.ok(body.includes(AAA_WARNING));
});

test('nothing actua11y renders says the target passes', () => {
  // The rule itself ("it can never prove a pass") is the one place the word may appear.
  const claim = /\b(pass|passes|passed|passing|compliant|conformant|conforms|certified)\b/i;
  for (const level of ['A', 'AA', 'AAA'] as const) {
    for (const piece of renderAll(level)) assert.doesNotMatch(piece.split(BEST_FAITH).join(''), claim);
  }
});

test('fails go to agents with code links, checks go to the person, evidence stays visible but collapsed', () => {
  const report = validReport('A');
  const facts = makeFacts('A');
  const agent = renderAgentIssue(report, facts, { personUrl: 'https://github.com/AhoyLemon/skills/issues/2' });
  const person = renderPersonIssue(report, facts, { agentUrl: 'https://github.com/AhoyLemon/skills/issues/1' });
  assert.match(agent.body, /- \[ \] \[`index\.html:5`\]\(https:\/\/github\.com\/AhoyLemon\/skills\/blob\/0123456789abcdef0123456789abcdef01234567\/index\.html#L5\)/);
  assert.match(agent.body, /1\. Load \//);
  assert.match(agent.body, /<details>\n<summary>✅ A machine found no fail in 1 criterion\./);
  assert.match(agent.body, /\[the person's issue\]\(https:\/\/github\.com\/AhoyLemon\/skills\/issues\/2\)/);
  assert.match(person.body, /\[the agent issue\]\(https:\/\/github\.com\/AhoyLemon\/skills\/issues\/1\)/);
  assert.match(person.body, /- \[ \] Whether the moth photo is decorative/);
  assert.match(person.body, /1\.1\.1 Non-text Content.*also has proven fails/);
  assert.match(person.body, /## What I found by using it/);
  assert.equal(agent.title, 'actua11y: WCAG 2.2 A, for agents (2 fails in 2 criteria)');
  assert.equal(person.title, 'actua11y: WCAG 2.2 A, for a person (2 checks)');
});

test('the evidence moves to the first comment when the body would pass the limit', () => {
  const report = validReport('A');
  const filler = 'x'.repeat(2000);
  const target = report.criteria.find((item) => item.num === '2.4.2');
  if (!target) throw new Error('fixture lost 2.4.2');
  target.evidence = Array.from({ length: 40 }, () => ({ did: filler, saw: filler }));
  const agent = renderAgentIssue(report, makeFacts('A'), { personUrl: null });
  assert.ok(agent.body.length <= GITHUB_LIMIT);
  assert.ok(agent.comments.length >= 2, 'evidence this long spans more than one comment');
  assert.ok(agent.comments.every((comment) => comment.length <= GITHUB_LIMIT && comment.includes('<details>')));
  assert.match(agent.body, /in the first comment/);
});

test('cross-linking later never changes which parts live in comments', () => {
  const report = validReport('A');
  const target = report.criteria.find((item) => item.num === '2.4.2');
  if (!target) throw new Error('fixture lost 2.4.2');
  // Pad the evidence until the body sits right at the limit, where a longer link could tip it over.
  for (let size = 500; size < 70_000; size += 500) {
    target.evidence = [{ did: 'x'.repeat(size), saw: 'y' }];
    const first = renderAgentIssue(report, makeFacts('A'), { personUrl: null });
    const linked = renderAgentIssue(report, makeFacts('A'), { personUrl: 'https://github.com/AhoyLemon/skills/issues/1234567' });
    assert.deepEqual(linked.comments, first.comments, `size ${size}`);
    assert.ok(linked.body.length <= GITHUB_LIMIT, `size ${size}`);
  }
});

test("an oversized person's checklist moves into comments instead of failing", () => {
  const report = validReport('A');
  const target = report.criteria.find((item) => item.num === '1.3.1');
  if (!target) throw new Error('fixture lost 1.3.1');
  target.checks = Array.from({ length: 60 }, (_, i) => ({ what: `Check ${i} ${'w'.repeat(1500)}`, how: 'Look', whyNotAMachine: 'Judgement' }));
  const person = renderPersonIssue(report, makeFacts('A'), { agentUrl: 'https://github.com/AhoyLemon/skills/issues/1' });
  assert.ok(person.body.length <= GITHUB_LIMIT);
  assert.match(person.body, /checklist is in the comments below/);
  assert.ok(person.comments.length >= 2);
  assert.ok(person.comments.every((comment) => comment.length <= GITHUB_LIMIT));
  assert.equal(person.comments.join('').match(/- \[ \] Check /g)?.length, 60);
});

test('finder text cannot ping people, auto-link issues or inject HTML', () => {
  assert.equal(safeText('Uses @media and #12 then </details>'), 'Uses &#64;media and &#35;12 then &lt;/details>');
  assert.equal(safeText('Leaves `@media (x)` alone'), 'Leaves `@media (x)` alone');
  assert.equal(safeText('two\n  lines'), 'two lines');
});

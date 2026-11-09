import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AAA_WARNING, BEST_FAITH } from '../skills/actua11y/_lib/_copy.ts';
import { criteriaAt, type Level } from '../skills/actua11y/_lib/_criteria.ts';
import { GITHUB_LIMIT, renderAgentIssue, renderPersonIssue, renderRawComments, safeText } from '../skills/actua11y/_lib/_render.ts';
import { validateReport, type FinderReport } from '../skills/actua11y/_lib/_report.ts';
import { makeFacts, makeReport, makeSite } from './_fixtures.ts';

const repoRoot = makeSite();

const validReport = (level: Level): FinderReport => {
  const result = validateReport(makeReport(level), { criteria: criteriaAt(level), repoRoot });
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.report;
};

const renderAll = (level: Level): string[] => {
  const report = validReport(level);
  const facts = makeFacts(level);
  const agent = renderAgentIssue(report, facts, { personUrl: 'https://github.com/example/moth-club/issues/2' });
  const person = renderPersonIssue(report, facts, { agentUrl: 'https://github.com/example/moth-club/issues/1' });
  return [agent.title, agent.body, agent.evidenceComment ?? '', person.title, person.body, ...renderRawComments(report, facts)];
};

test('every rendered piece carries the best-faith line, and the AAA warning only at AAA', () => {
  const [, agentBody, , , personBody] = renderAll('A');
  for (const body of [agentBody, personBody]) {
    assert.ok(body?.includes(BEST_FAITH));
    assert.ok(!body?.includes(AAA_WARNING));
  }
  const [, aaaAgent, , , aaaPerson] = renderAll('AAA');
  for (const body of [aaaAgent, aaaPerson]) assert.ok(body?.includes(AAA_WARNING));
});

test('nothing actua11y renders says the target passes', () => {
  const claim = /\b(passes|passed|compliant|conformant|conforms|certified)\b/i;
  for (const level of ['A', 'AA', 'AAA'] as const) {
    for (const piece of renderAll(level)) assert.doesNotMatch(piece, claim);
  }
});

test('fails go to agents with code links, checks go to the person, evidence stays visible but collapsed', () => {
  const report = validReport('A');
  const facts = makeFacts('A');
  const agent = renderAgentIssue(report, facts, { personUrl: 'https://github.com/example/moth-club/issues/2' });
  const person = renderPersonIssue(report, facts, { agentUrl: 'https://github.com/example/moth-club/issues/1' });
  assert.match(agent.body, /- \[ \] \[`index\.html:5`\]\(https:\/\/github\.com\/example\/moth-club\/blob\/0123456789abcdef0123456789abcdef01234567\/index\.html#L5\)/);
  assert.match(agent.body, /1\. Load \//);
  assert.match(agent.body, /<details>\n<summary>✅ A machine found no fail in 1 criteria/);
  assert.match(agent.body, /\[the person's issue\]\(https:\/\/github\.com\/example\/moth-club\/issues\/2\)/);
  assert.match(person.body, /\[the agent issue\]\(https:\/\/github\.com\/example\/moth-club\/issues\/1\)/);
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
  assert.ok(agent.evidenceComment?.includes('<details>'));
  assert.match(agent.body, /in the first comment/);
});

test('finder text cannot ping people, auto-link issues or inject HTML', () => {
  assert.equal(safeText('Uses @media and #12 then </details>'), 'Uses &#64;media and &#35;12 then &lt;/details>');
  assert.equal(safeText('Leaves `@media (x)` alone'), 'Leaves `@media (x)` alone');
  assert.equal(safeText('two\n  lines'), 'two lines');
});

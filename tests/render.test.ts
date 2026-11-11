import assert from 'node:assert/strict';
import { test } from 'node:test';

import { AAA_WARNING, BEST_FAITH } from '../skills/actua11y/_lib/_copy.ts';
import { criteriaAt, type Level } from '../skills/actua11y/_lib/_criteria.ts';
import { GITHUB_LIMIT, freshKept, regionOf, renderAgentIssue, renderPersonIssue, renderRawComments, safeText, tickedIn, YOURS_END, YOURS_START } from '../skills/actua11y/_lib/_render.ts';
import { validateReport, type FinderReport } from '../skills/actua11y/_lib/_report.ts';
import { fitWithRaw } from '../skills/actua11y/_lib/_render-loop.ts';
import { claimFree, CLAIM, makeFacts, makeReport, makeSite, viewOf } from './_fixtures.ts';

const repoRoot = makeSite();
const AGENT_URL = 'https://github.com/AhoyLemon/skills/issues/1';
const PERSON_URL = 'https://github.com/AhoyLemon/skills/issues/2';

const validReport = (level: Level): FinderReport => {
  const result = validateReport(makeReport(level), { criteria: criteriaAt(level), repoRoot, tracked: new Set(['index.html', 'css/site.css']) });
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.report;
};

const agentOf = (report: FinderReport, level: Level = 'A', personUrl: string | null = PERSON_URL) => renderAgentIssue(viewOf(report, makeFacts(level)), { personUrl });
const personOf = (report: FinderReport, level: Level = 'A') => renderPersonIssue(viewOf(report, makeFacts(level)), { agentUrl: AGENT_URL }, freshKept());

const renderAll = (level: Level): string[] => {
  const report = validReport(level);
  const agent = agentOf(report, level);
  const person = personOf(report, level);
  return [agent.title, agent.body, ...agent.comments.map((comment) => comment.body), person.title, person.body, ...person.comments.map((comment) => comment.body), ...renderRawComments(report, makeFacts(level))];
};

test('both issues carry the best-faith line, and the AAA warning only at AAA', () => {
  for (const body of [agentOf(validReport('A')).body, personOf(validReport('A')).body]) {
    assert.ok(body.includes(BEST_FAITH));
    assert.ok(!body.includes(AAA_WARNING));
  }
  for (const body of [agentOf(validReport('AAA'), 'AAA').body, personOf(validReport('AAA'), 'AAA').body]) assert.ok(body.includes(AAA_WARNING));
});

test('nothing actua11y renders says the target passes', () => {
  for (const level of ['A', 'AA', 'AAA'] as const) {
    for (const piece of renderAll(level)) assert.doesNotMatch(claimFree(piece), CLAIM);
  }
});

test('the claim guard allows only the agreed vocabulary', () => {
  assert.doesNotMatch(claimFree('✅ certified at `abc` by pass 2, by the certifier, at the certified commit'), CLAIM);
  for (const claim of ['the site passes', 'it passed', 'this pass found', 'certified', 'certifies', 'compliant', 'conforms']) assert.match(claimFree(claim), CLAIM, claim);
});

test("a page the finder names can't break out of its code span to ping anyone", () => {
  const report = { ...validReport('A'), used: { tools: ['Read'], pages: ['http://127.0.0.1:4173/`@everyone`'] } };
  assert.ok(agentOf(report).body.includes('`` http://127.0.0.1:4173/`@everyone` ``'));
});

test('both issues say what the fences caught, whose word the pages list is, and what the runner served', () => {
  const facts = { ...makeFacts('A'), fences: { denials: 2, mentions: 1 }, served: ['/', '/about.html'] };
  const view = viewOf(validReport('A'), facts);
  for (const body of [renderAgentIssue(view, { personUrl: PERSON_URL }).body, renderPersonIssue(view, { agentUrl: AGENT_URL }, freshKept()).body]) {
    assert.match(body, /\*\*Fences:\*\* the rules refused 2 tool calls, and 1 tool call named a path the finder must never read/);
    assert.match(body, /\*\*Pages, as the finder reports them:\*\*/);
    assert.match(body, /\*\*Paths the runner's own server sent, to check that list against:\*\* `\/`, `\/about\.html`/);
  }
});

test('a long pages list is cut short in the issue, so a paid run can still be filed', () => {
  const pages = Array.from({ length: 1500 }, (_, i) => `http://127.0.0.1:4173/page-${i}.html`);
  const report = { ...validReport('AA'), used: { tools: ['Read'], pages } };
  const agent = agentOf(report, 'AA');
  assert.match(agent.body, /and 1,450 more, every one of them in the raw report/);
  assert.ok(!agent.body.includes('page-1499.html'));
});

test('the raw report never splits an emoji between two comments', () => {
  const room = GITHUB_LIMIT - 600;
  const base = validReport('A');
  const withSaw = (saw: string): FinderReport => ({ ...base, criteria: base.criteria.map((item) => (item.num === '2.4.2' ? { ...item, evidence: [{ did: 'Read the titles', saw }] } : item)) });
  // Pad until the emoji's first half is the last character a full comment holds.
  const at = JSON.stringify(withSaw('MARK🦋'), null, 2).indexOf('🦋');
  const report = withSaw(`${'x'.repeat(room - 1 - at)}MARK🦋`);
  const json = JSON.stringify(report, null, 2);
  assert.equal(json.indexOf('🦋'), room - 1, 'the fixture puts the emoji across the boundary');
  const parts = renderRawComments(report, makeFacts('A')).map((comment) => comment.match(/```+json\n([\s\S]*)\n```+\n/)?.[1] ?? '');
  assert.ok(parts.length > 1);
  assert.equal(parts.join(''), json);
  for (const part of parts) assert.ok(!/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(part), 'no half emoji at either end');
});

test('fails go to agents with ids and code links, checks go to the person, evidence stays visible but collapsed', () => {
  const report = validReport('A');
  const agent = agentOf(report);
  const person = personOf(report);
  assert.match(agent.body, /- \[ \] \*\*A1\*\* \[`index\.html:5`\]\(https:\/\/github\.com\/AhoyLemon\/skills\/blob\/0123456789abcdef0123456789abcdef01234567\/index\.html#L5\)/);
  assert.match(agent.body, /\*\*A2\*\*[^\n]*Join is a div/);
  assert.match(agent.body, /1\. Load \//);
  assert.match(agent.body, /- \*\*Status:\*\* open/);
  assert.match(agent.body, /<details>\n<summary>✅ The finder found no fail in 1 criterion\./);
  assert.match(agent.body, /\[the person's issue\]\(https:\/\/github\.com\/AhoyLemon\/skills\/issues\/2\)/);
  assert.match(agent.body, /<!-- actua11y:ledger v1 -->/, 'the ledger rides in the body from the start');
  assert.match(person.body, /\[the agent issue\]\(https:\/\/github\.com\/AhoyLemon\/skills\/issues\/1\)/);
  assert.match(person.body, /- \[ \] \*\*P1\*\* Whether the moth photo is decorative/);
  assert.match(person.body, /1\.1\.1 Non-text Content.*also has proven fails/);
  assert.match(person.body, /## What I found by using it/);
  assert.ok(person.body.includes(`${YOURS_START}\n\n${YOURS_END}`), "the person's region starts empty");
  assert.equal(agent.title, 'actua11y: WCAG 2.2 A, for agents (2 fails in 2 criteria)');
  assert.equal(person.title, 'actua11y: WCAG 2.2 A, for a person (2 checks)');
});

test("a re-render keeps the person's region byte for byte, and their ticks", () => {
  const report = validReport('A');
  const first = personOf(report).body;
  const theirs = '\n- The Join button is tiny on my phone.\n  <b>Really</b> tiny. ```not code``` @someone #12\n';
  const edited = first.replace(`${YOURS_START}\n\n${YOURS_END}`, `${YOURS_START}${theirs}${YOURS_END}`).replace('- [ ] **P2**', '- [x] **P2**').replace(/\n/g, '\r\n');
  const kept = { region: regionOf(edited) ?? '', ticked: tickedIn([edited]) };
  assert.equal(kept.region, theirs, 'GitHub hands bodies back with CRLF, and the region still comes back exactly');
  assert.deepEqual([...kept.ticked], ['P2']);
  const again = renderPersonIssue(viewOf(report), { agentUrl: AGENT_URL }, kept).body;
  assert.ok(again.includes(`${YOURS_START}${theirs}${YOURS_END}`));
  assert.match(again, /- \[x\] \*\*P2\*\*/);
  assert.match(again, /- \[ \] \*\*P1\*\*/);
  assert.equal(regionOf(again.replace(YOURS_END, '')), null, 'with a marker gone there is nowhere safe to keep it');
});

test('the evidence moves to the first comment when the body would pass the limit', () => {
  const report = validReport('A');
  const filler = 'x'.repeat(2000);
  const target = report.criteria.find((item) => item.num === '2.4.2');
  if (!target) throw new Error('fixture lost 2.4.2');
  target.evidence = Array.from({ length: 40 }, () => ({ did: filler, saw: filler }));
  const agent = agentOf(report, 'A', null);
  assert.ok(agent.body.length <= GITHUB_LIMIT);
  assert.ok(agent.comments.length >= 2, 'evidence this long spans more than one comment');
  assert.ok(agent.comments.every((comment) => comment.kind === 'evidence' && comment.body.length <= GITHUB_LIMIT && comment.body.includes('<details>')));
  assert.match(agent.body, /in the first comment/);
  assert.match(agent.body, /<!-- actua11y:ledger v1 -->/, 'the ledger never leaves the body');
});

test('cross-linking later never changes which parts live in comments', () => {
  const report = validReport('A');
  const target = report.criteria.find((item) => item.num === '2.4.2');
  if (!target) throw new Error('fixture lost 2.4.2');
  // Pad the evidence until the body sits right at the limit, where a longer link could tip it over.
  for (let size = 500; size < 70_000; size += 500) {
    target.evidence = [{ did: 'x'.repeat(size), saw: 'y' }];
    const first = agentOf(report, 'A', null);
    const linked = agentOf(report, 'A', 'https://github.com/AhoyLemon/skills/issues/1234567');
    assert.deepEqual(linked.comments, first.comments, `size ${size}`);
    assert.ok(linked.body.length <= GITHUB_LIMIT, `size ${size}`);
  }
});

test("an oversized person's checklist moves into comments instead of failing", () => {
  const report = validReport('A');
  const target = report.criteria.find((item) => item.num === '1.3.1');
  if (!target) throw new Error('fixture lost 1.3.1');
  target.checks = Array.from({ length: 60 }, (_, i) => ({ what: `Check ${i} ${'w'.repeat(1500)}`, how: 'Look', whyNotAMachine: 'Judgement' }));
  const person = personOf(report);
  assert.ok(person.body.length <= GITHUB_LIMIT);
  assert.match(person.body, /checklist is in the comments below/);
  assert.ok(person.comments.length >= 2);
  assert.ok(person.comments.every((comment) => comment.kind === 'checks' && comment.body.length <= GITHUB_LIMIT));
  assert.equal(person.comments.map((comment) => comment.body).join('').match(/- \[ \] \*\*P\d+\*\* Check /g)?.length, 60);
});

test('finder text cannot ping people, auto-link issues or inject HTML', () => {
  assert.equal(safeText('Uses @media and #12 then </details>'), 'Uses &#64;media and &#35;12 then &lt;/details>');
  assert.equal(safeText('Leaves `@media (x)` alone'), 'Leaves `@media (x)` alone');
  assert.equal(safeText('two\n  lines'), 'two lines');
});

test('a loop comment too long for GitHub splits at its sections, each part under the limit and marked once', () => {
  const sections = Array.from({ length: 30 }, (_, i) => `### Section ${i}\n\n${'Evidence that goes on. '.repeat(200)}`);
  const body = ['<!-- actua11y:certifier v1 pass=2 -->', '## actua11y · certifier pass 2', '', ...sections].join('\n');
  const comments = fitWithRaw(body, ['<!-- raw part -->\nraw']);
  assert.ok(comments.length > 2);
  assert.ok(comments.every((comment) => comment.length <= GITHUB_LIMIT));
  const heads = comments.map((comment) => comment.split('\n')[0]);
  assert.equal(heads[0], '<!-- actua11y:certifier v1 pass=2 -->');
  assert.equal(new Set(heads).size, heads.length, 'every comment has its own first line');
  assert.equal(comments.join('').match(/### Section /g)?.length, 30, 'nothing lost');
});

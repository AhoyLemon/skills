import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import type { Options } from '../skills/actua11y/_lib/_args.ts';
import { emptyUsage } from '../skills/actua11y/_lib/_backend.ts';
import { CERTIFIER_SCHEMA, validateCertifierReport, type CertifierReport } from '../skills/actua11y/_lib/_certifier.ts';
import { fileCertifierRun } from '../skills/actua11y/_lib/_cmd-certifier.ts';
import { cmdCloseOut, cmdRecordFinding } from '../skills/actua11y/_lib/_cmd-human.ts';
import { cmdLoopStart, cmdRecordFixer, fixerBrief, nextStep } from '../skills/actua11y/_lib/_cmd-loop.ts';
import { criteriaAt } from '../skills/actua11y/_lib/_criteria.ts';
import { fileIssues } from '../skills/actua11y/_lib/_filing.ts';
import { FIXER_SCHEMA } from '../skills/actua11y/_lib/_fixer.ts';
import { carriedFor, ledgerHash, passPlan, type Ledger } from '../skills/actua11y/_lib/_ledger.ts';
import { loadLoop, saveLoop } from '../skills/actua11y/_lib/_loop.ts';
import { renderUnfiledComments } from '../skills/actua11y/_lib/_render-loop.ts';
import { renderAgentIssue, renderPersonIssue, YOURS_END, YOURS_START } from '../skills/actua11y/_lib/_render.ts';
import { validateReport } from '../skills/actua11y/_lib/_report.ts';
import { emptyFiled, reportHash, type RunMeta } from '../skills/actua11y/_lib/_runs.ts';
import { claimFree, CLAIM, makeFacts, makeReport, tempDir } from './_fixtures.ts';
import { fakeGithub, type FakeGithub } from './_github.ts';

const SLUG = 'AhoyLemon/moth-club';

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

// The same made-up site the other tests use, committed and pushed to a bare remote so pushes and PR heads are real.
const makeRepo = (): { root: string; remote: string } => {
  const parent = tempDir('loop');
  const remote = join(parent, 'remote.git');
  const root = join(parent, 'moth-club');
  git(parent, 'init', '-q', '--bare', remote);
  mkdirSync(join(root, 'css'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  writeFileSync(join(root, 'index.html'), ['<!doctype html>', '<html>', '<head><title>Moth Club</title></head>', '<body>', '<img src="moth.png">', '<div onclick="go()">Join</div>', '</body>', '</html>', ''].join('\n'));
  writeFileSync(join(root, 'css', 'site.css'), ['body { color: #777; }', 'a:focus { outline: none; }', ''].join('\n'));
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'Moth Club');
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-q', '-u', 'origin', 'main');
  return { root, remote };
};

const options = (root: string, issue: string, extra: Partial<Options> = {}): Options => ({
  command: '', subject: '', cwd: root, level: null, scope: ['.'], url: null, serve: null, pages: [], allowIgnored: [], model: 'claude-opus-5-5', effort: 'high', maxTurns: 300, maxBudgetUsd: 20, timeoutMinutes: 60,
  run: null, preview: false, help: false, issue, branch: null, budgetUsd: 60, words: null, criterion: null, ux: false, decision: null, reason: null, how: null, check: null, item: null, tokens: null, minutes: null, uncertifiedOk: false, atCap: false,
  ...extra,
});

// The runner talks to the terminal as it goes. The tests only care about what lands on GitHub.
const quietly = <T>(run: () => T): T => {
  const write = process.stdout.write.bind(process.stdout);
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    return run();
  } finally {
    process.stdout.write = write;
  }
};

const commit = (root: string, file: string, from: string, to: string, message: string): string => {
  const path = join(root, file);
  writeFileSync(path, readFileSync(path, 'utf8').replace(from, to));
  git(root, 'commit', '-q', '-am', message);
  return git(root, 'rev-parse', 'HEAD');
};

const fenced = (value: unknown): string => `Done.\n\n\`\`\`json\n${JSON.stringify(value)}\n\`\`\`\n`;

const ledgerOf = (gh: FakeGithub, agentUrl: string): Ledger => loadLoop(gh, agentUrl).view.ledger;

// A certifier pass, as `run certifier` would have left it: a validated report and its run record. The session itself is the only part a test can't run.
const filePass = (gh: FakeGithub, root: string, agentUrl: string, build: (carried: { id: string; from: number; steps: string[] }[]) => Omit<CertifierReport, 'schema' | 'used'>): { code: number; again: () => number } => {
  const state = loadLoop(gh, agentUrl);
  const ledger = state.view.ledger;
  const plan = passPlan(ledger);
  const carried = plan.items.flatMap((id) => carriedFor(state.view, id)).map(({ id, from, steps }) => ({ id, from, steps }));
  const checked = validateCertifierReport({ schema: CERTIFIER_SCHEMA, used: { tools: ['Read', 'kit/scan.ts'], pages: ['/'] }, ...build(carried) }, { criteria: criteriaAt('A'), repoRoot: root, tracked: new Set(git(root, 'ls-files').split('\n')), items: plan.items, carried });
  if (!checked.ok) throw new Error(checked.errors.join('\n'));
  const dir = tempDir('run');
  const reportText = `${JSON.stringify(checked.report, null, 2)}\n`;
  writeFileSync(join(dir, 'report.json'), reportText);
  const pass = ledger.rounds.filter((round) => round.kind === 'certifier').length + 1;
  const sha = git(root, 'rev-parse', 'HEAD');
  const meta: RunMeta = {
    runId: `run-pass-${pass}`, role: 'certifier', createdAt: '2026-11-11T10:00:00Z', finishedAt: '2026-11-11T10:20:00Z', repoRoot: root, repo: { owner: 'AhoyLemon', name: 'moth-club' }, commit: sha, branch: 'actua11y-a-1', level: 'A', scope: ['.'],
    baseUrl: 'http://127.0.0.1:4173/', site: { url: 'http://127.0.0.1:4173/', serve: null }, pages: ['/'], served: null, browser: { channel: 'chrome', version: '157.0.0.0' }, axe: null, backend: 'Claude Code', model: 'claude-opus-5-5', effort: 'high', maxTurns: 300, maxBudgetUsd: 20,
    dryRun: { at: '2026-11-11T09:55:00Z', backend: 'Claude Code', model: 'claude-opus-5-5', effort: 'high', clean: true, problems: [], answer: '', usage: { ...emptyUsage(), costUsd: 0.05 }, transcriptPath: '/tmp/dry.jsonl' },
    session: { sessionId: 's', attempts: 1, usage: { ...emptyUsage(), costUsd: 2.5, turns: 30, durationMs: 600_000 }, transcriptPath: join(dir, 'transcript.jsonl'), errors: [], permissionDenials: 0, offLimitsMentions: [], strays: [], ignoredStrays: [], valid: true, reportSha256: reportHash(reportText) },
    pass: { issueUrl: agentUrl, pass, stage: ledger.stage === 'human' ? 'human' : 'ai', sha, items: plan.items, blocking: plan.blocking, carried, ledgerSha256: ledgerHash(ledger) },
  };
  const file = (): number => quietly(() => fileCertifierRun({ options: options(root, agentUrl), meta, dir, reportText, client: gh }));
  return { code: file(), again: file };
};

const walked = (): { num: string; did: string }[] => criteriaAt('A').map((criterion) => ({ num: criterion.num, did: 'Loaded / and checked it again' }));

test('a whole loop runs on GitHub alone: two fixer rounds, two passes, a human finding and close-out, and a fresh load rebuilds the same record', () => {
  const { root, remote } = makeRepo();
  const gh = fakeGithub(SLUG, remote);

  // File, as `file` does after a finder run.
  const validated = validateReport(makeReport('A'), { criteria: criteriaAt('A'), repoRoot: root, tracked: new Set(['index.html', 'css/site.css']) });
  if (!validated.ok) throw new Error(validated.errors.join('\n'));
  const finder = validated.report;
  const facts = { ...makeFacts('A'), repo: { owner: 'AhoyLemon', name: 'moth-club' }, commit: git(root, 'rev-parse', 'HEAD') };
  const filed = emptyFiled();
  fileIssues({ report: finder, facts, site: { url: 'http://127.0.0.1:4173/', serve: null }, slug: SLUG, filed, gh, save: () => undefined, progress: () => undefined });
  const agentUrl = filed.agentUrl ?? '';
  assert.equal(ledgerOf(gh, agentUrl).stage, 'filed', 'filing writes the ledger, so assess-only can become a loop later');

  // Start the loop.
  assert.equal(quietly(() => cmdLoopStart(options(root, agentUrl), gh)), 0);
  assert.equal(git(root, 'rev-parse', '--abbrev-ref', 'HEAD'), 'actua11y-a-1');
  assert.equal(ledgerOf(gh, agentUrl).stage, 'ai');

  // Fixer round 1: one finding fixed, one fixed in part.
  const brief1 = fixerBrief(loadLoop(gh, agentUrl).view, root, git(root, 'rev-parse', 'HEAD'));
  assert.deepEqual(brief1.items, ['A1', 'A2']);
  assert.match(brief1.text, /Brief id: `[0-9a-f]{12}`/);
  const alt = commit(root, 'index.html', '<img src="moth.png">', '<img src="moth.png" alt="A moth on a lamp">', 'Describe the moth photo');
  const button = commit(root, 'index.html', '<div onclick="go()">Join</div>', '<button type="button" onclick="go()">Join</button>', 'Make Join a button');
  const report1 = { schema: FIXER_SCHEMA, brief: brief1.id, findings: [{ id: 'A1', outcome: 'fixed', commit: alt.slice(0, 8), how: 'Gave the photo alt text that says what it shows' }, { id: 'A2', outcome: 'partial', commit: button, how: 'Join is a real button now', left: 'Its focus ring is still hidden by the stylesheet' }] };
  assert.equal(quietly(() => cmdRecordFixer(options(root, agentUrl, { tokens: 45_000, minutes: 4 }), gh, fenced(report1))), 0);
  const pr = [...gh.prs.values()][0];
  assert.ok(pr?.isDraft, 'the first commit opens a draft PR');
  assert.doesNotMatch(pr?.body ?? '', /This closes/, 'no closing lines until close-out');
  assert.match(pr?.comments[0]?.body ?? '', /<!-- actua11y:fixer v1 round=1 report=[0-9a-f]{12} -->[\s\S]*### Fixed in part \(1\)[\s\S]*\*\*Left:\*\* Its focus ring/);
  assert.match(gh.issues.get(agentUrl)?.body ?? '', /\*\*A1\*\*[\s\S]*?claimed at `[0-9a-f]{12}` by fixer round 1/);
  assert.throws(() => quietly(() => cmdRecordFixer(options(root, agentUrl), gh, fenced(report1))), /isn't the fixer's turn/, 'the same report again is refused: it is the certifier\'s turn');

  // Pass 1: A1 holds, A2 still fails, and the re-walk finds something new.
  const pass1 = filePass(gh, root, agentUrl, (carried) => ({
    items: [{ id: 'A1', fixed: [{ did: 'Read the img on / in the running page', saw: 'alt is `A moth on a lamp`' }] }, { id: 'A2', notFixed: { file: 'css/site.css', line: 2, what: 'Join shows no focus ring', steps: ['Load /', 'Press Tab once', 'Look at Join'] } }],
    reran: carried.map((ref) => ({ ...ref, saw: 'Focus reaches Join now', reproduced: false })),
    rewalk: { criteria: walked(), newFails: [{ num: '4.1.2', file: 'index.html', line: 6, what: 'Join has no accessible name in one state', whoItHurts: 'Screen reader users', behaviour: false }], newChecks: [] },
  }));
  assert.equal(pass1.code, 0);
  let ledger = ledgerOf(gh, agentUrl);
  assert.deepEqual(ledger.items.map((item) => [item.id, item.status]), [['A1', 'certified'], ['A2', 'open'], ['A3', 'open']]);
  assert.deepEqual(ledger.items.find((item) => item.id === 'A2')?.carried, [1]);
  assert.equal(ledger.stage, 'ai');
  assert.match(nextStep(ledger, new Set(), agentUrl).command ?? '', /brief fixer/);
  const comments = pr?.comments.length ?? 0;
  assert.equal(pass1.again(), 0, 'filing the same run again is a no-op');
  assert.equal([...gh.prs.values()][0]?.comments.length, comments, 'and posts nothing twice');

  // Fixer round 2 works the two still open, and its brief carries pass 1's exact steps.
  const brief2 = fixerBrief(loadLoop(gh, agentUrl).view, root, git(root, 'rev-parse', 'HEAD'));
  assert.deepEqual(brief2.items, ['A2', 'A3']);
  assert.match(brief2.text, /Still failing at certifier pass 1\*\* \(chrome 157\.0\.0\.0\)[\s\S]*1\. Load \/\n  2\. Press Tab once/);
  const ring = commit(root, 'css/site.css', 'a:focus { outline: none; }', 'a:focus-visible { outline: 2px solid; }', 'Show the focus ring');
  const name = commit(root, 'index.html', '>Join</button>', ' aria-describedby="join-help">Join</button>', 'Name Join in every state');
  const report2 = { schema: FIXER_SCHEMA, brief: brief2.id, findings: [{ id: 'A2', outcome: 'fixed', commit: ring, how: 'Brought back a visible focus ring' }, { id: 'A3', outcome: 'fixed', commit: name, how: 'Join keeps its name in every state' }] };
  assert.equal(quietly(() => cmdRecordFixer(options(root, agentUrl), gh, fenced(report2))), 0);

  // Pass 2 reruns every carried repro exactly and approves, which ends the AI rounds.
  assert.equal(filePass(gh, root, agentUrl, (carried) => {
    assert.deepEqual(carried.map((ref) => `${ref.id} from ${ref.from}`), ['A2 from 0', 'A2 from 1']);
    return {
      items: ['A1', 'A2', 'A3'].map((id) => ({ id, fixed: [{ did: `Checked ${id} in the running page`, saw: 'No fail' }] })),
      reran: carried.map((ref) => ({ ...ref, saw: 'Focus ring visible on Join', reproduced: false })),
      rewalk: { criteria: walked(), newFails: [], newChecks: [] },
    };
  }).code, 0);
  ledger = ledgerOf(gh, agentUrl);
  assert.equal(ledger.stage, 'human');
  assert.deepEqual(ledger.stopped, { why: 'approved', pass: 2 });
  assert.ok(pr?.comments.some((entry) => entry.body.startsWith('<!-- actua11y:report-back v1')), 'the report back lands on the PR');

  // The human round: the person checks two things. P1 holds up, so they tick it. P2 doesn't, so they write what's wrong and how they want it solved, and accept something else as it is.
  const person = gh.issues.get(ledger.personUrl ?? '');
  if (!person) throw new Error('no person issue');
  const theirs = "\nThe Join button is hard to hit on my phone. Make it at least 44px tall. The footer is a bit grey, but I'm fine with that, it's the brand.\n";
  person.body = person.body.replace(`${YOURS_START}\n\n${YOURS_END}`, `${YOURS_START}${theirs}${YOURS_END}`).replace('- [ ] **P1**', '- [x] **P1**');
  assert.throws(() => quietly(() => cmdRecordFinding(options(root, agentUrl, { words: 'Join is too small', ux: true, decision: 'fix' }), gh)), /word for word/, 'words they never wrote');
  assert.throws(() => quietly(() => cmdRecordFinding(options(root, agentUrl, { words: 'Whether the moth photo is decorative', ux: true, decision: 'fix' }), gh)), /word for word/, "words only the runner's own sections hold");
  assert.throws(() => quietly(() => cmdRecordFinding(options(root, agentUrl, { words: 'The Join button is hard to hit on my phone.', criterion: '2.5.8', decision: 'fix', how: 'Make it 48px' }), gh)), /How they want it solved isn't in the person's issue/, 'a how-to they never wrote');
  assert.equal(quietly(() => cmdRecordFinding(options(root, agentUrl, { words: 'The Join button is hard to hit on my phone.', criterion: '2.5.8', check: 'P2', decision: 'fix', how: 'Make it at least 44px tall.' }), gh)), 0);
  assert.equal(quietly(() => cmdRecordFinding(options(root, agentUrl, { words: 'The footer is a bit grey', ux: true, decision: 'accept', reason: "I'm fine with that, it's the brand." }), gh)), 0);
  assert.ok(gh.issues.get(person.url)?.body.includes(`${YOURS_START}${theirs}${YOURS_END}`), 'their words survive the re-render byte for byte');
  assert.match(gh.issues.get(person.url)?.body ?? '', /- \[x\] \*\*P1\*\*/);
  assert.match(gh.issues.get(person.url)?.body ?? '', /- \[ \] \*\*P2\*\*[^\n]*\n(?:  - [^\n]*\n)*  - \*\*You found a problem:\*\* H1, below/, 'P2 is settled by a finding, not a tick');
  assert.match(gh.issues.get(person.url)?.body ?? '', /\*\*H1\*\* “The Join button is hard to hit on my phone\.”\n  - \*\*Tag:\*\* WCAG [^\n]*2\.5\.8[^\n]*outside the target[^\n]*\n  - \*\*From your check:\*\* P2\n  - \*\*Your decision:\*\* fix it, like this: “Make it at least 44px tall\.”/);
  ledger = ledgerOf(gh, agentUrl);
  assert.match(nextStep(ledger, new Set(['P1']), agentUrl).command ?? '', /brief fixer/, 'the person decided on a fix, so the fixer comes back');

  // The person tidies one thing by hand first, then hands the rest to the fixer. Its brief is their words, their how-to and the check it came from.
  commit(root, 'index.html', '<title>Moth Club</title>', '<title>Moth Club: join the club</title>', 'Say what the page is for in its title');
  const brief3 = fixerBrief(loadLoop(gh, agentUrl).view, root, git(root, 'rev-parse', 'HEAD'));
  assert.deepEqual(brief3.items, ['H1']);
  assert.match(brief3.text, /fixer round in the human round/);
  assert.match(brief3.text, /### H1 · a person's own finding · WCAG 2\.5\.8 Target Size \(Minimum\) \(AA\)\n\n- \*\*In their words:\*\* "The Join button is hard to hit on my phone\."\n- \*\*How they want it solved, in their words:\*\* "Make it at least 44px tall\."\n- \*\*It came from check P2/);
  assert.match(brief3.text, /There's no `needsPerson` in this round/);
  const tall = commit(root, 'css/site.css', 'body { color: #777; }', 'body { color: #777; }\nbutton { min-height: 44px; }', 'Make Join at least 44px tall');
  assert.equal(quietly(() => cmdRecordFixer(options(root, agentUrl), gh, fenced({ schema: FIXER_SCHEMA, brief: brief3.id, findings: [{ id: 'H1', outcome: 'partial', commit: tall, how: 'Taller', left: 'Width', needsPerson: 'A design call' }] }))), 1, 'everything here is already the person\'s, so nothing moves to them');
  assert.equal(quietly(() => cmdRecordFixer(options(root, agentUrl, { tokens: 20_000, minutes: 2 }), gh, fenced({ schema: FIXER_SCHEMA, brief: brief3.id, findings: [{ id: 'H1', outcome: 'fixed', commit: tall, how: 'Every button is at least 44px tall now, Join included' }] }))), 0, "the person's own commit came before the brief, so the fixer doesn't have to cite it");
  assert.match(pr?.comments.at(-1)?.body ?? '', /## actua11y · fixer round 3, in the human round[\s\S]*### The person's own commits, made before this round \(1\)[\s\S]*Say what the page is for in its title/);
  assert.match(gh.issues.get(person.url)?.body ?? '', /\*\*H1\*\*[\s\S]*?- \*\*Fixer:\*\* claimed at `[0-9a-f]{12}` by fixer round 3/);
  ledger = ledgerOf(gh, agentUrl);
  assert.match(nextStep(ledger, new Set(['P1']), agentUrl).command ?? '', /run certifier/);

  // Pass 3 guards the human round, the person's how-to in its brief, and approves.
  assert.equal(filePass(gh, root, agentUrl, (carried) => ({
    items: ['A1', 'A2', 'A3', 'H1'].map((id) => ({ id, fixed: [{ did: `Checked ${id} in the running page`, saw: 'No fail' }] })),
    reran: carried.map((ref) => ({ ...ref, saw: 'Focus ring visible on Join', reproduced: false })),
    rewalk: { criteria: walked(), newFails: [], newChecks: [] },
  })).code, 0);

  // Close-out.
  assert.equal(quietly(() => cmdCloseOut(options(root, agentUrl), gh)), 0);
  const closed = gh.prs.get(pr?.url ?? '');
  assert.equal(closed?.isDraft, false);
  assert.match(closed?.body ?? '', /\*\*The certified commit:\*\* `[0-9a-f]{12}`, approved by certifier pass 3\./);
  assert.match(closed?.body ?? '', /--match-head-commit [0-9a-f]{40}/);
  assert.match(closed?.body ?? '', /\*\*Checks where the person found a problem:\*\* P2, now H1/);
  assert.match(closed?.body ?? '', /\*\*H1\*\*[^\n]*: certified at `[0-9a-f]{12}` by pass 3/);
  assert.match(closed?.body ?? '', /\*\*H2\*\*[^\n]*accept as is, because “I'm fine with that, it's the brand\.”/);
  assert.match(closed?.body ?? '', /This closes #1\nThis closes #2\n$/, 'the closing lines come last, one per line');
  assert.equal(ledgerOf(gh, agentUrl).stage, 'closed');

  // A fresh load from GitHub alone renders exactly what's there.
  const fresh = loadLoop(gh, agentUrl);
  assert.equal(renderAgentIssue(fresh.view, { personUrl: fresh.view.ledger.personUrl }).body, gh.issues.get(agentUrl)?.body);
  assert.equal(renderPersonIssue(fresh.view, { agentUrl }, fresh.kept ?? { region: '', ticked: new Set() }).body, gh.issues.get(person.url)?.body);
  for (const text of gh.everything()) assert.doesNotMatch(claimFree(text.replace(theirs, '')), CLAIM);
});

test('a fixer report that skips a commit, cites one outside the round or answers an old brief is refused', () => {
  const { root, remote } = makeRepo();
  const gh = fakeGithub(SLUG, remote);
  const validated = validateReport(makeReport('A'), { criteria: criteriaAt('A'), repoRoot: root, tracked: new Set(['index.html', 'css/site.css']) });
  if (!validated.ok) throw new Error(validated.errors.join('\n'));
  const filed = emptyFiled();
  fileIssues({ report: validated.report, facts: { ...makeFacts('A'), commit: git(root, 'rev-parse', 'HEAD') }, site: { url: null, serve: '.' }, slug: SLUG, filed, gh, save: () => undefined, progress: () => undefined });
  const agentUrl = filed.agentUrl ?? '';
  quietly(() => cmdLoopStart(options(root, agentUrl), gh));
  const brief = fixerBrief(loadLoop(gh, agentUrl).view, root, git(root, 'rev-parse', 'HEAD'));
  const first = commit(root, 'index.html', '<img src="moth.png">', '<img src="moth.png" alt="A moth">', 'Alt text');
  commit(root, 'index.html', '<title>', '<title lang="en">', 'Something nobody cites');
  const record = (report: unknown): number => quietly(() => cmdRecordFixer(options(root, agentUrl), gh, fenced(report)));
  const findings = [{ id: 'A1', outcome: 'fixed', commit: first, how: 'Alt text' }, { id: 'A2', outcome: 'couldnt', why: 'Needs a design call' }];
  assert.equal(record({ schema: FIXER_SCHEMA, brief: brief.id, findings }), 1, 'an uncited commit');
  assert.equal(record({ schema: FIXER_SCHEMA, brief: 'deadbeef0000', findings }), 1, 'a stale brief');
  assert.equal(gh.prs.size, 0, 'nothing reaches GitHub from a refused report');
});

test("a certifier run that can never be filed still counts against the budget, once", () => {
  const { root, remote } = makeRepo();
  const gh = fakeGithub(SLUG, remote);
  const validated = validateReport(makeReport('A'), { criteria: criteriaAt('A'), repoRoot: root, tracked: new Set(['index.html', 'css/site.css']) });
  if (!validated.ok) throw new Error(validated.errors.join('\n'));
  const filed = emptyFiled();
  fileIssues({ report: validated.report, facts: { ...makeFacts('A'), commit: git(root, 'rev-parse', 'HEAD') }, site: { url: null, serve: '.' }, slug: SLUG, filed, gh, save: () => undefined, progress: () => undefined });
  const agentUrl = filed.agentUrl ?? '';
  quietly(() => cmdLoopStart(options(root, agentUrl), gh));
  const before = loadLoop(gh, agentUrl);
  const spent = before.view.ledger.spentUsd;
  const usage = { ...emptyUsage(), costUsd: 4.25, turns: 40, durationMs: 1_200_000 };
  for (const body of renderUnfiledComments(before.view, { runId: 'run-x', usage, why: 'It ended without a usable report.', transcriptPath: '/t.jsonl' })) gh.commentOn(agentUrl, body);
  const after = loadLoop(gh, agentUrl);
  assert.equal(Number((after.view.ledger.spentUsd - spent).toFixed(2)), 4.25);
  assert.equal(ledgerHash(after.view.ledger), ledgerHash(before.view.ledger), 'spend alone never makes a pass look stale');
  saveLoop(gh, after, { ledger: after.view.ledger, passes: after.view.passes });
  assert.equal(Number((loadLoop(gh, agentUrl).view.ledger.spentUsd - spent).toFixed(2)), 4.25, 'saved, and still counted once');
});

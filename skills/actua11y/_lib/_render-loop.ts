// Everything the loop writes besides the two issues: what the fixer and certifier are told about each item, the PR comment for every run, the report back, and the PR body. All of it is rendered from the ledger and the raw reports, never by a model.
import type { Usage } from './_backend.ts';
import type { CertifierReport, PassVerdict } from './_certifier.ts';
import { criterionByNum } from './_criteria.ts';
import { rawBlocks, GITHUB_LIMIT } from './_fence.ts';
import type { FixerReport } from './_fixer.ts';
import { budgetLeft, carriedFor, checkOf, checksWithFindings, failOf, MAX_FIXER_ROUNDS, numOf, passSha, roundOf, type AgentItem, type HumanItem, type Ledger, type LoopView, type PassPlan } from './_ledger.ts';
import { chunkBlocks, codeLink, COST_NOTE, costRows, costTable, criterionHeading, decisionText, fixerCostRow, formatUsage, pagesList, plural, safeText, servedLine, shortSha, tagText, warningBlock } from './_render.ts';
import type { Used } from './_report.ts';

const oneLine = (text: string): string => text.replace(/\s*\n\s*/g, ' ').trim();

const criterionLabel = (num: string): string => {
  const criterion = criterionByNum(num);
  return criterion ? `${num} ${criterion.name} (${criterion.level})` : num;
};

const steps = (list: string[], indent = '  '): string => list.map((step, i) => `${indent}${i + 1}. ${oneLine(step)}`).join('\n');

// ---- What the roles are told. Briefs go to a model, so they're plain text, never escaped for GitHub. ----

const howLine = (how: string | null): string[] => (how ? [`- **How they want it solved, in their words:** "${oneLine(how)}"`] : []);

const checkLine = (view: LoopView, check: string | null): string[] => {
  const found = check ? view.ledger.checks.find((entry) => entry.id === check) : undefined;
  return found ? [`- **It came from check ${found.id}, which they looked at and found a problem with:** ${oneLine(checkOf(view, found).check.what)}`] : [];
};

const carriedLines = (view: LoopView, id: string): string[] =>
  carriedFor(view, id)
    .filter((entry) => entry.from > 0)
    .flatMap((repro) => [`- **Still failing at certifier pass ${repro.from}**${repro.engine ? ` (${repro.engine})` : ''}: \`${repro.file}\` line ${repro.line}. ${oneLine(repro.what)}`, steps(repro.steps)]);

const humanHeading = (item: HumanItem): string => `### ${item.id} · a person's own finding · ${item.tag.kind === 'ux' ? 'a UX problem, outside WCAG' : `WCAG ${criterionLabel(item.tag.num)}`}`;

// What the fixer is told about each item: a proven fail in the finder's or certifier's words, or a person's own finding in theirs, with how they want it solved when they said.
export const fixerItemsText = (view: LoopView, ids: string[]): string =>
  ids
    .map((id) => {
      const human = view.ledger.human.find((entry) => entry.id === id);
      if (human) {
        const lines = [humanHeading(human), '', `- **In their words:** "${oneLine(human.words)}"`, ...howLine(human.decision.how), ...checkLine(view, human.check), ...carriedLines(view, id)];
        if (human.claim?.outcome === 'couldnt') lines.push(`- **Last round:** the fixer couldn't fix it in round ${human.claim.round}. Try again, or say why not.`);
        return lines.join('\n');
      }
      const item = view.ledger.items.find((entry) => entry.id === id);
      if (!item) return '';
      const { num, fail } = failOf(view, item);
      const lines = [`### ${item.id} · ${criterionLabel(num)}`, '', `- **Where:** \`${fail.file}\` line ${fail.line}, when it was found (lines may have moved since)`, `- **What's wrong:** ${oneLine(fail.what)}`, `- **Who it hurts:** ${oneLine(fail.whoItHurts)}`];
      if (fail.repro && fail.repro.length > 0) lines.push('- **How it shows:**', steps(fail.repro));
      if (item.status === 'moved' && item.decision?.choice === 'fix') lines.push('- **A person decided this one should be fixed.**', ...howLine(item.decision.how));
      lines.push(...carriedLines(view, id));
      if (item.claim?.outcome === 'couldnt') lines.push(`- **Last round:** the fixer couldn't fix it in round ${item.claim.round}. Try again, or say why not.`);
      return lines.join('\n');
    })
    .filter((text) => text !== '')
    .join('\n\n');

const humanItemText = (view: LoopView, item: HumanItem, blocking: boolean): string =>
  [humanHeading(item), '', `- **In their words:** "${oneLine(item.words)}"`, `- They decided it should be fixed.${blocking ? '' : ' Judge it, but it sits outside the target.'}`, ...howLine(item.decision.how), ...checkLine(view, item.check)].join('\n');

export const certifierItemsText = (view: LoopView, plan: PassPlan): string =>
  plan.items
    .map((id) => {
      const human = view.ledger.human.find((item) => item.id === id);
      if (human) return humanItemText(view, human, plan.blocking.includes(id));
      const item = view.ledger.items.find((entry) => entry.id === id);
      if (!item) return '';
      const { num, fail } = failOf(view, item);
      const lines = [`### ${id} · ${criterionLabel(num)}`, '', `- **Where it was found:** \`${fail.file}\` line ${fail.line} (lines may have moved since)`, `- **What was wrong:** ${oneLine(fail.what)}`, `- **Who it hurts:** ${oneLine(fail.whoItHurts)}`];
      if (item.status === 'moved' && item.decision?.choice === 'fix') lines.push('- A person decided this one should be fixed.', ...howLine(item.decision.how));
      if (!plan.blocking.includes(id)) lines.push('- Judge it, but it sits outside the target.');
      return lines.join('\n');
    })
    .filter((text) => text !== '')
    .join('\n\n');

export const carriedText = (view: LoopView, plan: PassPlan): { text: string; count: number } => {
  const repros = plan.items.flatMap((id) => carriedFor(view, id));
  if (repros.length === 0) return { text: 'None on this pass. Leave `reran` as an empty list.', count: 0 };
  const text = repros
    .map((repro) => [`- **${repro.id}**, \`from: ${repro.from}\` (${repro.from === 0 ? "the finder's own steps" : `certifier pass ${repro.from}`}${repro.engine ? `, on ${repro.engine}` : ''}): \`${repro.file}\` line ${repro.line}. ${oneLine(repro.what)}`, steps(repro.steps, '    ')].join('\n'))
    .join('\n');
  return { text, count: repros.length };
};

export const outOfScopeText = (view: LoopView, plan: PassPlan): string => {
  const { ledger } = view;
  const lines: string[] = [];
  for (const item of ledger.items) {
    if (plan.items.includes(item.id) || item.status !== 'moved' || item.moved?.check) continue;
    const { num, fail } = failOf(view, item);
    const state = item.decision === null ? "waiting on a person's decision" : item.decision.choice === 'accept' ? 'a person accepted it as it is' : 'a person decided it doesn\'t apply';
    lines.push(`- ${item.id} (${num}): ${oneLine(fail.what)}. ${state}`);
  }
  for (const item of ledger.human) {
    if (plan.items.includes(item.id)) continue;
    lines.push(`- ${item.id} (${item.tag.kind === 'wcag' ? item.tag.num : 'UX'}): "${oneLine(item.words)}". ${item.decision.choice === 'accept' ? 'A person accepted it as it is' : 'A person decided it doesn\'t apply'}`);
  }
  for (const check of ledger.checks) {
    const content = checkOf(view, check);
    lines.push(`- ${check.id} (${content.num}${content.check.group ? `, grouped under "${oneLine(content.check.group)}"` : ''}): ${oneLine(content.check.what)}. A person checks this one, and only they can close it`);
  }
  return lines.length > 0 ? lines.join('\n') : 'Nothing yet.';
};

// ---- PR comments ----

const bestFaith = (view: LoopView): string => warningBlock(view.ledger.facts.level);


export interface FixerCommentInput {
  round: number;
  // A hash of the report, so a corrected report for the same round is posted rather than mistaken for the one already there.
  reportId: string;
  stage: 'ai' | 'human';
  sha: string;
  base: string;
  commits: { sha: string; subject: string }[];
  // Commits the person made on the branch before this round began. The fixer doesn't claim them.
  before: { sha: string; subject: string }[];
  reported: { tokens: number | null; minutes: number | null };
  // When the runner recorded the round, the same instant the ledger keeps.
  at: string;
}

export const renderFixerComments = (view: LoopView, report: FixerReport, input: FixerCommentInput): string[] => {
  const label = (id: string): string => {
    const num = numOf(view, id);
    return `**${id}** ${num === 'UX' ? 'UX' : criterionHeading(num)}`;
  };
  const group = (title: string, outcome: string, line: (entry: FixerReport['findings'][number]) => string): string[] => {
    const entries = report.findings.filter((entry) => entry.outcome === outcome && (outcome !== 'couldnt' || !entry.needsPerson));
    return entries.length === 0 ? [] : [`### ${title} (${entries.length})`, '', ...entries.map(line), ''];
  };
  const moved = report.findings.filter((entry) => entry.needsPerson);
  const body = [
    `<!-- actua11y:fixer v1 round=${input.round} report=${input.reportId} -->`,
    input.stage === 'human' ? `## actua11y · fixer round ${input.round}, in the human round` : `## actua11y · fixer round ${input.round} of at most ${MAX_FIXER_ROUNDS}`,
    '',
    bestFaith(view),
    '',
    `**By:** a subagent in your own session, handed the runner's brief unchanged · **Commits:** ${shortSha(input.base)} to ${shortSha(input.sha)}`,
    '',
    '### This run',
    '',
    ...costTable([fixerCostRow(input.round, input.at, input.reported, view.ledger.loop ? budgetLeft(view.ledger) : null)], view.ledger),
    '',
    COST_NOTE,
    '',
    'Each of these is a claim. Only a blind certifier, which never sees this comment, can make one ✅.',
    '',
    ...group('Fixed', 'fixed', (entry) => `- ${label(entry.id)}, in ${(entry.commits ?? []).map(shortSha).join(', ')}: ${safeText(entry.how ?? '')}`),
    ...group('Fixed in part', 'partial', (entry) => `- ${label(entry.id)}, in ${(entry.commits ?? []).map(shortSha).join(', ')}: ${safeText(entry.how ?? '')}\n  - **Left:** ${safeText(entry.left ?? '')}`),
    ...group("Couldn't fix", 'couldnt', (entry) => `- ${label(entry.id)}: ${safeText(entry.why ?? '')}${entry.commits ? ` (an attempt, in ${entry.commits.map(shortSha).join(', ')})` : ''}`),
    ...(moved.length === 0 ? [] : [`### Moved to the person's issue (${moved.length})`, '', ...moved.map((entry) => `- ${label(entry.id)}: ${safeText(entry.needsPerson ?? '')}`), '']),
    `### Commits (${input.commits.length})`,
    '',
    ...input.commits.map((commit) => `- ${shortSha(commit.sha)} ${safeText(commit.subject)}`),
    '',
    ...(input.before.length === 0 ? [] : [`### Commits made before this round began (${input.before.length})`, '', 'This fixer doesn\'t claim these. The runner can\'t tell who made them: the person by hand, or an earlier fixer whose report was never recorded. The next certifier guards them like everything else.', '', ...input.before.map((commit) => `- ${shortSha(commit.sha)} ${safeText(commit.subject)}`), '']),
  ].join('\n');
  return fitWithRaw(body, rawBlocks('fixer', { round: String(input.round), report: input.reportId }, "The fixer's raw report", report));
};

// The rendered comment and its raw report travel together when they fit, and the raw parts follow in comments of their own when they don't.
// A body too long for one comment splits at its section headings, and every comment after the first gets a marker of its own so rerunning a command never posts it twice.
export const fitWithRaw = (body: string, raw: string[]): string[] => {
  const joined = `${body}\n${raw.join('\n')}`;
  if (joined.length <= GITHUB_LIMIT) return [joined];
  const head = body.split('\n')[0] ?? '';
  const tagged = (tag: string, text: string): string => `${head.replace(' v1 ', ` v1 ${tag} `)}\n${text}`;
  const parts = body.length <= GITHUB_LIMIT ? [body] : chunkBlocks(body.slice(head.length + 1).split(/\n(?=### )/), GITHUB_LIMIT - 500).map((chunk, i) => (i === 0 ? `${head}\n${chunk}` : tagged(`part=${i + 1}`, chunk)));
  return [...parts, ...raw.map((part, i) => tagged(`raw=${i + 1}`, part))];
};

export interface CertifierCommentInput {
  pass: number;
  // Two runs can share a pass number when filing one stopped partway, so every comment and raw report names its run.
  runId: string;
  stage: 'ai' | 'human';
  sha: string;
  model: string;
  effort: string;
  usage: Usage;
  transcriptPath: string;
  browser: { channel: string; version: string } | null;
  served: string[] | null;
  fences: { denials: number; mentions: number };
  newItems: string[];
  newChecks: string[];
}

const usedLines = (used: Used, input: CertifierCommentInput): string[] => [
  `- **Browser:** ${input.browser ? `${input.browser.channel} ${input.browser.version}, headless. One engine checked` : 'none'}`,
  `- **Pages, as the certifier reports them:** ${pagesList(used.pages)}`,
  ...servedLine(input.served),
  `- **Tools:** ${used.tools.map(safeText).join(', ')}`,
  `- **Fences:** the rules refused ${plural(input.fences.denials, 'tool call', 'tool calls')}, and ${plural(input.fences.mentions, 'tool call', 'tool calls')} named a path the certifier must never read`,
];

export const verdictText = (verdict: PassVerdict): string => {
  if (verdict.approved) return 'approved: nothing it judged that blocks is still failing, and its re-walk found no new fail';
  const parts = [verdict.blockers.length > 0 ? `${plural(verdict.blockers.length, 'item', 'items')} still failing (${verdict.blockers.join(', ')})` : '', verdict.newFails > 0 ? `${plural(verdict.newFails, 'new fail', 'new fails')} from its re-walk` : ''].filter((part) => part !== '');
  return `not approved: ${parts.join(', and ')}`;
};

export const renderCertifierComments = (view: LoopView, report: CertifierReport, verdict: PassVerdict, input: CertifierCommentInput): string[] => {
  const facts = view.ledger.facts;
  const label = (id: string): string => {
    const num = numOf(view, id);
    return `**${id}** ${num === 'UX' ? 'UX' : criterionHeading(num)}`;
  };
  const fixed = report.items.filter((item) => item.fixed);
  const notFixed = report.items.filter((item) => item.notFixed);
  const needsPerson = report.items.filter((item) => item.needsPerson);
  const engine = input.browser ? `${input.browser.channel} ${input.browser.version}` : 'unknown';
  const lines = [
    `<!-- actua11y:certifier v1 pass=${input.pass} run=${input.runId} -->`,
    `## actua11y · certifier pass ${input.pass}, ${input.stage === 'ai' ? 'checking the AI rounds' : 'guarding the human round'}`,
    '',
    bestFaith(view),
    '',
    `**Verdict, computed by the runner from the list below:** ${verdictText(verdict)}.`,
    '',
    `**Commit:** ${shortSha(input.sha)} · **Transcript:** \`${input.transcriptPath}\`, kept on the machine that ran it`,
    '',
    '### This run',
    '',
    ...costTable(costRows(view.ledger).filter((row) => row.key === `certifier-${input.runId}`), view.ledger),
    '',
    COST_NOTE,
    '',
    'A fresh, read-only session that never saw this PR, the issues, git history or anyone\'s account of the fixes. ✅ here means it found no fail at this commit, by doing what it says.',
    '',
  ];
  if (fixed.length > 0) {
    lines.push(`### ✅ No fail found at ${shortSha(input.sha)} (${fixed.length})`, '');
    for (const item of fixed) lines.push(`- ${label(item.id)}`, ...(item.fixed ?? []).map((entry) => `  - **Did:** ${safeText(entry.did)} **Saw:** ${safeText(entry.saw)}`));
    lines.push('');
  }
  if (notFixed.length > 0) {
    lines.push(`### ❌ Still failing (${notFixed.length})`, '');
    for (const item of notFixed) {
      const entry = item.notFixed;
      if (!entry) continue;
      lines.push(`- ${label(item.id)} ${codeLink(facts, input.sha, entry.file, entry.line)} ${safeText(entry.what)}`, `  - **Engine:** ${engine}`, '  - **Steps, which the next certifier runs again exactly:**', ...entry.steps.map((step, i) => `    ${i + 1}. ${safeText(step)}`));
    }
    lines.push('');
  }
  if (needsPerson.length > 0) {
    lines.push(`### 🕵️ Only a person can settle (${needsPerson.length})`, '');
    for (const item of needsPerson) if (item.needsPerson) lines.push(`- ${label(item.id)} ${safeText(item.needsPerson.what)}`, `  - **How:** ${safeText(item.needsPerson.how)}`, `  - **Why a machine can't:** ${safeText(item.needsPerson.whyNotAMachine)}`);
    lines.push('');
  }
  if (report.reran.length > 0) {
    lines.push(`### Carried repros, run again exactly (${report.reran.length})`, '');
    for (const rerun of report.reran) lines.push(`- **${rerun.id}**, ${rerun.from === 0 ? "the finder's steps" : `pass ${rerun.from}'s steps`}: ${rerun.reproduced ? '❌ still reproduced' : 'no longer reproduced'}. **Saw:** ${safeText(rerun.saw)}`);
    lines.push('');
  }
  lines.push(`### The re-walk (${plural(report.rewalk.criteria.length, 'criterion', 'criteria')})`, '');
  if (report.rewalk.newFails.length === 0) lines.push('- No new fails.');
  report.rewalk.newFails.forEach((fail, i) => lines.push(`- ❌ new, now **${input.newItems[i] ?? '?'}** on the agent issue: ${criterionHeading(fail.num)} ${codeLink(facts, input.sha, fail.file, fail.line)} ${safeText(fail.what)}`));
  if (report.rewalk.newChecks.length === 0) lines.push('- Nothing new for a person.');
  report.rewalk.newChecks.forEach((check, i) => lines.push(`- 🕵️ new, now **${input.newChecks[i] ?? '?'}** on the person's issue: ${criterionHeading(check.num)} ${safeText(check.what)}`));
  lines.push('', '<details>', '<summary>What it did for each criterion</summary>', '', ...report.rewalk.criteria.map((entry) => `- **${entry.num}:** ${safeText(entry.did)}`), '', '</details>', '');
  lines.push(...usedLines(report.used, input), '');
  return fitWithRaw(lines.join('\n'), rawBlocks('certifier', { pass: String(input.pass), run: input.runId }, `Certifier pass ${input.pass}'s raw report`, report));
};

// ---- The report back, and the PR body ----

const certifiedList = (view: LoopView): string[] =>
  view.ledger.items.filter((item) => item.status === 'certified' && item.judged).map((item) => `- **${item.id}** ${criterionHeading(failOf(view, item).num)}, certified at ${shortSha(passSha(view.ledger, item.judged?.pass ?? 0))} by pass ${item.judged?.pass}${item.claim?.commit ? `, fixed in ${shortSha(item.claim.commit)}` : ''}`);



export const testUrlText = (ledger: Ledger): string => (ledger.site.serve ? `\`node runner.ts serve --serve ${ledger.site.serve}\` serves it on localhost until you stop it` : (ledger.site.url ?? 'the site the loop audited'));

const STOP_TEXT: Record<'cap' | 'budget' | 'asked', string> = {
  cap: `They stopped at the cap of ${MAX_FIXER_ROUNDS} fixer rounds, without a certifier approving.`,
  budget: "They stopped when the loop's budget ran out, before a certifier approved.",
  asked: 'They stopped at your call, before a certifier approved.',
};

export const renderReportBack = (view: LoopView, links: { agentUrl: string }): string => {
  const { ledger } = view;
  const stopped = ledger.stopped;
  const moved = ledger.items.filter((item) => item.status === 'moved' && item.moved?.by === 'cap');
  const headline = !stopped
    ? 'The finder proved no fails, so there was nothing for the fixer.'
    : stopped.why === 'approved'
      ? `Certifier pass ${stopped.pass} approved commit ${shortSha(roundOf(ledger, 'certifier', stopped.pass)?.sha ?? '')}.`
      : `${STOP_TEXT[stopped.why]} ${plural(moved.length, 'fail', 'fails')} still failing moved to the person's issue, each with its repro steps.`;
  const decide = ledger.items.filter((item) => item.status === 'moved' && item.moved?.check === null).length;
  const certified = certifiedList(view);
  return [
    `<!-- actua11y:report-back v1 pass=${stopped?.pass ?? 0} -->`,
    '## actua11y · where the loop stands',
    '',
    bestFaith(view),
    '',
    `**The AI rounds are done.** ${headline}`,
    '',
    '### What the AI did alone',
    '',
    ...(certified.length > 0 ? certified : ['- Nothing has a certifier\'s ✅ yet.']),
    '',
    '### Waiting on a person',
    '',
    `[The person's issue](${ledger.personUrl ?? ''}): ${plural(ledger.checks.length, 'check', 'checks')} to tick, ${plural(decide, 'fail', 'fails')} to decide, and whatever you find by using it. The proven fails and their history are on [the agent issue](${links.agentUrl}).`,
    '',
    '### Cost so far',
    '',
    ...costTable(costRows(ledger), ledger, true),
    '',
    COST_NOTE,
    '',
    '### Test it',
    '',
    `${testUrlText(ledger)}. Use it with real devices, a screen reader and your own thumbs, and write what you find in your issue.`,
    '',
  ].join('\n');
};

export const renderDraftPrBody = (view: LoopView, links: { agentUrl: string }): string =>
  [
    '<!-- actua11y:pr v1 -->',
    bestFaith(view),
    '',
    `**A draft, opened by actua11y's fix-and-certify loop.** It fixes what [the agent issue](${links.agentUrl}) lists, and [the person's issue](${view.ledger.personUrl ?? ''}) holds what only a person can do.`,
    '',
    "Don't merge it yet. It isn't done until a certifier approves and a person has worked their issue. The closing lines, and the exact commit to merge, go in at close-out.",
    '',
  ].join('\n');

export interface CloseOutInput {
  agentNumber: number;
  personNumber: number;
  prNumber: number;
  sha: string;
  pass: number;
  approved: boolean;
  uncertified: { sha: string; subject: string }[];
  stillFailing: string[];
  neverJudged: string[];
  ticked: ReadonlySet<string>;
  days: number;
  headSha: string;
}

export const renderCloseOutBody = (view: LoopView, input: CloseOutInput): string => {
  const { ledger } = view;
  const decided = (item: AgentItem): boolean => item.status === 'moved' && item.moved?.check === null;
  const accepted = [...ledger.items.filter((item) => decided(item) && item.decision && item.decision.choice !== 'fix').map((item) => `- **${item.id}** ${criterionHeading(failOf(view, item).num)}: ${decisionText(item.decision)}`), ...ledger.human.filter((item) => item.decision.choice !== 'fix').map((item) => `- **${item.id}** “${safeText(item.words)}”: ${decisionText(item.decision)}`)];
  const handedOver = ledger.items.filter((item) => item.status === 'moved' && item.moved?.check).map((item) => `${item.id}, as ${item.moved?.check ?? ''}`);
  const personFixed = [...ledger.items.filter((item) => decided(item) && item.decision?.choice === 'fix'), ...ledger.human.filter((item) => item.decision.choice === 'fix')];
  const fixLine = (item: AgentItem | HumanItem): string => {
    const label = 'words' in item ? `“${safeText(item.words)}” (${tagText(item, ledger.facts.level)})` : criterionHeading(failOf(view, item).num);
    const judged = item.judged;
    const handed = ledger.checks.filter((check) => check.source.kind === 'item' && check.source.item === item.id && check.source.pass === judged?.pass).map((check) => check.id);
    const state = !judged ? 'never judged'
      : judged.result === 'fixed' ? `certified at ${shortSha(passSha(ledger, judged.pass))} by pass ${judged.pass}`
      : judged.result === 'notFixed' ? `❌ still failing at ${shortSha(passSha(ledger, judged.pass))}`
      : `🕵️ left to the person by certifier pass ${judged.pass} as ${handed.join(' and ') || 'a check'}, which they ticked`;
    return `- **${item.id}** ${label}: ${state}`;
  };
  const headline = input.approved
    ? `**The certified commit:** ${shortSha(input.sha)}, approved by certifier pass ${input.pass}.`
    : `**No certifier approved.** The human round hit its cap. The last commit a certifier checked is ${shortSha(input.sha)}, and these still failed there: ${input.stillFailing.join(', ') || 'none'}.${input.neverJudged.length > 0 ? ` These were decided after it, so no certifier ever judged them: ${input.neverJudged.join(', ')}.` : ''}`;
  return [
    '<!-- actua11y:pr v1 closed -->',
    bestFaith(view),
    '',
    headline,
    ...(input.uncertified.length > 0 ? ['', '**Landed after it, and never seen by a blind certifier:**', ...input.uncertified.map((commit) => `- ${shortSha(commit.sha)} ${safeText(commit.subject)}`)] : []),
    '',
    `Merge exactly what was checked: \`gh pr merge ${input.prNumber} --match-head-commit ${input.uncertified.length > 0 ? input.headSha : input.sha}\`${input.uncertified.length > 0 ? ', which pins it to the head, uncertified commits and all' : ''}. The merge is yours.`,
    '',
    '## What the AI did alone',
    '',
    ...(certifiedList(view).length > 0 ? certifiedList(view) : ['- Nothing has a certifier\'s ✅.']),
    '',
    '## What needed a person',
    '',
    `- **Checks:** ${plural(input.ticked.size, 'check', 'checks')} ticked by the person: ${[...input.ticked].sort((x, y) => Number(x.slice(1)) - Number(y.slice(1))).join(', ') || 'none'}`,
    ...(handedOver.length > 0 ? [`- **Fails a certifier handed to the person as checks:** ${handedOver.join('; ')}`] : []),
    ...(checksWithFindings(ledger).size > 0 ? [`- **Checks where the person found a problem:** ${[...checksWithFindings(ledger)].map(([check, findings]) => `${check}, now ${findings.join(' and ')}`).join('; ')}`] : []),
    ...(personFixed.length > 0 ? ['- **Fixed at their call:**', ...personFixed.map((item) => `  ${fixLine(item)}`)] : []),
    '',
    '## Accepted, and why',
    '',
    ...(accepted.length > 0 ? accepted : ['- Nothing accepted as is.']),
    '',
    '## Cost and time',
    '',
    ...costTable(costRows(ledger), ledger, true),
    '',
    COST_NOTE,
    '',
    `**From filing to close-out:** ${plural(input.days, 'day', 'days')}.`,
    '',
    `This closes #${input.agentNumber}`,
    `This closes #${input.personNumber}`,
    '',
  ].join('\n');
};

export interface UnfiledInput {
  runId: string;
  usage: Usage;
  why: string;
  transcriptPath: string;
}

// A certifier run that can never be filed still spent money. This comment puts that on the record, and loadLoop adds it to what the loop has spent, so the budget can't leak.
export const renderUnfiledComments = (view: LoopView, input: UnfiledInput): string[] =>
  fitWithRaw(
    [`<!-- actua11y:unfiled v1 run=${input.runId} -->`, `## actua11y · certifier run \`${input.runId}\` can't be filed`, '', bestFaith(view), '', `${safeText(input.why)} It cost ${formatUsage(input.usage)}, which counts against the loop's budget. Its transcript is \`${input.transcriptPath}\`, kept on the machine that ran it.`, ''].join('\n'),
    rawBlocks('unfiled', { run: input.runId }, 'What this run cost', { runId: input.runId, usd: input.usage.costUsd }),
  );

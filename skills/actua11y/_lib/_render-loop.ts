// Everything the loop writes besides the two issues: what the fixer and certifier are told about each item, the PR comment for every run, the report back, and the PR body. All of it is rendered from the ledger and the raw reports, never by a model.
import type { Usage } from './_backend.ts';
import type { CertifierReport, PassVerdict } from './_certifier.ts';
import { criterionByNum } from './_criteria.ts';
import { rawBlocks, GITHUB_LIMIT } from './_fence.ts';
import type { FixerReport } from './_fixer.ts';
import { carriedFor, checkOf, failOf, MAX_FIXER_ROUNDS, numOf, passes, passSha, roundOf, type AgentItem, type HumanItem, type Ledger, type LoopView, type PassPlan } from './_ledger.ts';
import { codeLink, criterionHeading, decisionText, formatUsage, pagesList, plural, safeText, servedLine, shortSha, tagText, warningBlock } from './_render.ts';
import type { Used } from './_report.ts';

const oneLine = (text: string): string => text.replace(/\s*\n\s*/g, ' ').trim();

const criterionLabel = (num: string): string => {
  const criterion = criterionByNum(num);
  return criterion ? `${num} ${criterion.name} (${criterion.level})` : num;
};

const steps = (list: string[], indent = '  '): string => list.map((step, i) => `${indent}${i + 1}. ${oneLine(step)}`).join('\n');

// ---- What the roles are told. Briefs go to a model, so they're plain text, never escaped for GitHub. ----

export const fixerItemsText = (view: LoopView, items: AgentItem[]): string =>
  items
    .map((item) => {
      const { num, fail } = failOf(view, item);
      const lines = [`### ${item.id} · ${criterionLabel(num)}`, '', `- **Where:** \`${fail.file}\` line ${fail.line}, when it was found (lines may have moved since)`, `- **What's wrong:** ${oneLine(fail.what)}`, `- **Who it hurts:** ${oneLine(fail.whoItHurts)}`];
      if (fail.repro && fail.repro.length > 0) lines.push('- **How it shows:**', steps(fail.repro));
      for (const repro of carriedFor(view, item.id).filter((entry) => entry.from > 0)) {
        lines.push(`- **Still failing at certifier pass ${repro.from}**${repro.engine ? ` (${repro.engine})` : ''}: \`${repro.file}\` line ${repro.line}. ${oneLine(repro.what)}`, steps(repro.steps));
      }
      if (item.claim?.outcome === 'couldnt') lines.push(`- **Last round:** the fixer couldn't fix it in round ${item.claim.round}. Try again, or say why not.`);
      return lines.join('\n');
    })
    .join('\n\n');

const humanItemText = (item: HumanItem, blocking: boolean): string => {
  const tag = item.tag.kind === 'ux' ? 'a UX problem, outside WCAG' : `WCAG ${criterionLabel(item.tag.num)}`;
  return [`### ${item.id} · a person's own finding · ${tag}`, '', `In their words: "${oneLine(item.words)}"`, '', `They decided it should be fixed.${blocking ? '' : ' Judge it, but it sits outside the target.'}`].join('\n');
};

export const certifierItemsText = (view: LoopView, plan: PassPlan): string =>
  plan.items
    .map((id) => {
      const human = view.ledger.human.find((item) => item.id === id);
      if (human) return humanItemText(human, plan.blocking.includes(id));
      const item = view.ledger.items.find((entry) => entry.id === id);
      if (!item) return '';
      const { num, fail } = failOf(view, item);
      const lines = [`### ${id} · ${criterionLabel(num)}`, '', `- **Where it was found:** \`${fail.file}\` line ${fail.line} (lines may have moved since)`, `- **What was wrong:** ${oneLine(fail.what)}`, `- **Who it hurts:** ${oneLine(fail.whoItHurts)}`];
      if (item.status === 'moved' && item.decision?.choice === 'fix') lines.push('- A person decided this one should be fixed.');
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
    lines.push(`- ${check.id} (${content.num}): ${oneLine(content.check.what)}. A person checks this one, and only they can close it`);
  }
  return lines.length > 0 ? lines.join('\n') : 'Nothing yet.';
};

// ---- PR comments ----

const bestFaith = (view: LoopView): string => warningBlock(view.ledger.facts.level);

const tokensText = (tokens: number | null): string => (tokens === null ? 'unreported' : tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(2)}M tokens` : `${Math.round(tokens / 1000)}k tokens`);

export interface FixerCommentInput {
  round: number;
  sha: string;
  base: string;
  commits: { sha: string; subject: string }[];
  reported: { tokens: number | null; minutes: number | null };
}

export const renderFixerComments = (view: LoopView, report: FixerReport, input: FixerCommentInput): string[] => {
  const label = (id: string): string => {
    const item = view.ledger.items.find((entry) => entry.id === id);
    return item ? `**${id}** ${criterionHeading(failOf(view, item).num)}` : `**${id}**`;
  };
  const group = (title: string, outcome: string, line: (entry: FixerReport['findings'][number]) => string): string[] => {
    const entries = report.findings.filter((entry) => entry.outcome === outcome && (outcome !== 'couldnt' || !entry.needsPerson));
    return entries.length === 0 ? [] : [`### ${title} (${entries.length})`, '', ...entries.map(line), ''];
  };
  const moved = report.findings.filter((entry) => entry.needsPerson);
  const minutes = input.reported.minutes === null ? 'unreported' : `${input.reported.minutes} min`;
  const body = [
    `<!-- actua11y:fixer v1 round=${input.round} -->`,
    `## actua11y · fixer round ${input.round} of at most ${MAX_FIXER_ROUNDS}`,
    '',
    bestFaith(view),
    '',
    '| Role | Commits | Usage, as the orchestrating session reported it |',
    '|---|---|---|',
    `| A subagent in your own session, handed the runner's brief unchanged | ${shortSha(input.base)} to ${shortSha(input.sha)} | ${tokensText(input.reported.tokens)} · ${minutes}. Its cost isn't measured, since it ran in your session and bills there |`,
    '',
    'Each of these is a claim. Only a blind certifier, which never sees this comment, can make one ✅.',
    '',
    ...group('Fixed', 'fixed', (entry) => `- ${label(entry.id)} at ${shortSha(entry.commit ?? '')}: ${safeText(entry.how ?? '')}`),
    ...group('Fixed in part', 'partial', (entry) => `- ${label(entry.id)} at ${shortSha(entry.commit ?? '')}: ${safeText(entry.how ?? '')}\n  - **Left:** ${safeText(entry.left ?? '')}`),
    ...group("Couldn't fix", 'couldnt', (entry) => `- ${label(entry.id)}: ${safeText(entry.why ?? '')}`),
    ...(moved.length === 0 ? [] : [`### Moved to the person's issue (${moved.length})`, '', ...moved.map((entry) => `- ${label(entry.id)}: ${safeText(entry.needsPerson ?? '')}`), '']),
    `### Commits (${input.commits.length})`,
    '',
    ...input.commits.map((commit) => `- ${shortSha(commit.sha)} ${safeText(commit.subject)}`),
    '',
  ].join('\n');
  return fitWithRaw(body, rawBlocks('fixer', { round: String(input.round) }, "The fixer's raw report", report));
};

// The rendered comment and its raw report travel together when they fit, and the raw parts follow in comments of their own when they don't.
const fitWithRaw = (body: string, raw: string[]): string[] => {
  const joined = `${body}\n${raw.join('\n')}`;
  return joined.length <= GITHUB_LIMIT ? [joined] : [body, ...raw.map((part, i) => `${body.split('\n')[0]?.replace(' v1 ', ` v1 raw=${i + 1} `)}\n${part}`)];
};

export interface CertifierCommentInput {
  pass: number;
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
    `<!-- actua11y:certifier v1 pass=${input.pass} -->`,
    `## actua11y · certifier pass ${input.pass}, ${input.stage === 'ai' ? 'checking the AI rounds' : 'guarding the human round'}`,
    '',
    bestFaith(view),
    '',
    `**Verdict, computed by the runner from the list below:** ${verdictText(verdict)}.`,
    '',
    '| Commit | Model and effort | Turns | Minutes | Tokens | Cost | Transcript |',
    '|---|---|---|---|---|---|---|',
    `| ${shortSha(input.sha)} | \`${input.model}\` at \`${input.effort}\` | ${formatUsage(input.usage).split(' · ').join(' | ')} | \`${input.transcriptPath}\`, kept on the machine that ran it |`,
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
  return fitWithRaw(lines.join('\n'), rawBlocks('certifier', { pass: String(input.pass) }, `Certifier pass ${input.pass}'s raw report`, report));
};

// ---- The report back, and the PR body ----

const certifiedList = (view: LoopView): string[] =>
  view.ledger.items.filter((item) => item.status === 'certified' && item.judged).map((item) => `- **${item.id}** ${criterionHeading(failOf(view, item).num)}, certified at ${shortSha(passSha(view.ledger, item.judged?.pass ?? 0))} by pass ${item.judged?.pass}${item.claim?.commit ? `, fixed in ${shortSha(item.claim.commit)}` : ''}`);

export const fixerUsage = (ledger: Ledger): { rounds: number; tokens: number; minutes: number; unreported: boolean } => {
  const rounds = ledger.rounds.filter((round) => round.kind === 'fixer');
  return {
    rounds: rounds.length,
    tokens: rounds.reduce((sum, round) => sum + (round.reported?.tokens ?? 0), 0),
    minutes: rounds.reduce((sum, round) => sum + (round.reported?.minutes ?? 0), 0),
    unreported: rounds.some((round) => round.reported?.tokens === null || round.reported?.minutes === null),
  };
};

const costLines = (ledger: Ledger): string[] => {
  const runs = passes(ledger).length;
  const fixer = fixerUsage(ledger);
  return [
    `- **What the runner started** (dry runs, the finder, and the certifier ${plural(runs, 'time', 'times')}): $${ledger.spentUsd.toFixed(2)}${ledger.loop ? ` of a $${ledger.loop.budgetUsd.toFixed(2)} budget` : ''}. Costs are the agent's own estimates`,
    `- **The fixer**, in your own session, ${plural(fixer.rounds, 'round', 'rounds')}: ${tokensText(fixer.tokens)} and ${fixer.minutes} min as that session reported them${fixer.unreported ? ', with some unreported' : ''}. Not in the total above, since it bills your session`,
  ];
};

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
    ...costLines(ledger),
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
  ticked: ReadonlySet<string>;
  days: number;
  headSha: string;
}

export const renderCloseOutBody = (view: LoopView, input: CloseOutInput): string => {
  const { ledger } = view;
  const decided = (item: AgentItem): boolean => item.status === 'moved' && item.moved?.check === null;
  const accepted = [...ledger.items.filter((item) => decided(item) && item.decision && item.decision.choice !== 'fix').map((item) => `- **${item.id}** ${criterionHeading(failOf(view, item).num)}: ${decisionText(item.decision)}`), ...ledger.human.filter((item) => item.decision.choice !== 'fix').map((item) => `- **${item.id}** “${safeText(item.words)}”: ${decisionText(item.decision)}`)];
  const personFixed = [...ledger.items.filter((item) => decided(item) && item.decision?.choice === 'fix'), ...ledger.human.filter((item) => item.decision.choice === 'fix')];
  const fixLine = (item: AgentItem | HumanItem): string => {
    const label = 'words' in item ? `“${safeText(item.words)}” (${tagText(item, ledger.facts.level)})` : criterionHeading(failOf(view, item).num);
    const judged = item.judged;
    const state = judged?.result === 'fixed' ? `certified at ${shortSha(passSha(ledger, judged.pass))} by pass ${judged.pass}` : judged ? `❌ still failing at ${shortSha(passSha(ledger, judged.pass))}` : 'never judged';
    return `- **${item.id}** ${label}: ${state}`;
  };
  const headline = input.approved
    ? `**The certified commit:** ${shortSha(input.sha)}, approved by certifier pass ${input.pass}.`
    : `**No certifier approved.** The human round hit its cap. The last commit a certifier checked is ${shortSha(input.sha)}, and these still failed there: ${input.stillFailing.join(', ')}.`;
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
    `- **Checks:** ${plural(input.ticked.size, 'check', 'checks')} ticked by the person: ${[...input.ticked].join(', ') || 'none'}`,
    ...(personFixed.length > 0 ? ['- **Fixed at their call:**', ...personFixed.map((item) => `  ${fixLine(item)}`)] : []),
    '',
    '## Accepted, and why',
    '',
    ...(accepted.length > 0 ? accepted : ['- Nothing accepted as is.']),
    '',
    '## Cost and time',
    '',
    ...costLines(ledger),
    `- **From filing to close-out:** ${plural(input.days, 'day', 'days')}`,
    '',
    `This closes #${input.agentNumber}`,
    `This closes #${input.personNumber}`,
    '',
  ].join('\n');
};

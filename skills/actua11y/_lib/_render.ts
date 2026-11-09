// Turns a validated finder report into the two GitHub issues people actually read. The model never writes this Markdown, so a summary can't contradict its own list.
import { totalTokens, type Usage } from './_backend.ts';
import { criterionByNum, levelLabel, type Level } from './_criteria.ts';
import { VERDICT_KEY, warningsFor } from './_copy.ts';
import { tallyOf, verdictOf, VERDICT_MARK, type CriterionResult, type Fail, type FinderReport } from './_report.ts';

// GitHub refuses an issue body or comment longer than 65,536 characters. Leave headroom for its own counting.
export const GITHUB_LIMIT = 65_000;

export interface RunFacts {
  runId: string;
  level: Level;
  scope: string[];
  repo: { owner: string; name: string };
  commit: string;
  branch: string;
  baseUrl: string;
  pages: string[];
  browser: { channel: string; version: string } | null;
  axe: { version: string; tags: string[] } | null;
  backend: string;
  model: string;
  effort: string;
  usage: Usage;
  dryRunUsage: Usage | null;
  finishedAt: string;
}

export interface RenderedIssue {
  title: string;
  body: string;
}

export interface RenderedAgentIssue extends RenderedIssue {
  evidenceComment: string | null;
}

const ENTITIES: Record<string, string> = { '<': '&lt;', '@': '&#64;', '#': '&#35;' };

// Escapes finder text outside code spans in one pass (so one escape can't mangle another): no raw HTML, no accidental @mentions, no #123 auto-links, and one line per item.
export const safeText = (text: string): string =>
  text
    .replace(/\s*\n\s*/g, ' ')
    .split(/(`[^`]*`)/)
    .map((part) => (part.startsWith('`') && part.endsWith('`') && part.length > 1 ? part : part.replace(/<|@(?=\w)|#(?=\d)/g, (char) => ENTITIES[char] ?? char)))
    .join('');

const encodePath = (file: string): string => file.split('/').map(encodeURIComponent).join('/');

export const codeLink = (facts: RunFacts, file: string, line: number): string => `[\`${file}:${line}\`](https://github.com/${facts.repo.owner}/${facts.repo.name}/blob/${facts.commit}/${encodePath(file)}#L${line})`;

const criterionHeading = (num: string): string => {
  const criterion = criterionByNum(num);
  return criterion ? `[${num} ${criterion.name}](${criterion.understanding}) · ${criterion.level}` : num;
};

export const formatUsage = (usage: Usage): string => {
  const minutes = (usage.durationMs / 60_000).toFixed(1);
  const tokens = totalTokens(usage);
  const tokenText = tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(2)}M` : `${Math.round(tokens / 1000)}k`;
  return `${usage.turns} turns · ${minutes} min · $${usage.costUsd.toFixed(2)} · ${tokenText} tokens`;
};

const marker = (kind: string, facts: RunFacts): string => `<!-- actua11y:${kind} v1 run=${facts.runId} level=${facts.level} commit=${facts.commit} -->`;

const warningBlock = (level: Level): string => warningsFor(level).map((line) => `> ${line}`).join('\n>\n');

const targetLine = (facts: RunFacts): string => {
  const scope = facts.scope.map((path) => `\`${path}\``).join(', ');
  return `**WCAG 2.2 ${levelLabel(facts.level)}** · scope ${scope} · at \`${facts.commit.slice(0, 12)}\` on \`${facts.branch}\``;
};

const usedSection = (report: FinderReport, facts: RunFacts): string => {
  const lines = [
    '## What the finder used',
    '',
    `- **Browser:** ${facts.browser ? `${facts.browser.channel} ${facts.browser.version}, headless, recorded by the runner. One engine checked, so behaviour in other engines is a person's call` : 'none'}`,
    `- **axe:** ${facts.axe ? `axe-core ${facts.axe.version}, tags ${facts.axe.tags.map((tag) => `\`${tag}\``).join(' ')}. An axe result covers one rule, never a whole criterion, and axe covers only part of WCAG` : 'not run'}`,
    `- **Pages:** ${report.used.pages.length > 0 ? report.used.pages.map((page) => `\`${page}\``).join(', ') : 'none loaded'} (base ${facts.baseUrl})`,
    `- **Tools:** ${report.used.tools.map(safeText).join(', ')}`,
    `- **Session:** a fresh, read-only ${facts.backend} session with none of your settings, memory or plugins. Model \`${facts.model}\`, effort \`${facts.effort}\``,
    `- **Cost:** finder ${formatUsage(facts.usage)}${facts.dryRunUsage ? `, dry run ${formatUsage(facts.dryRunUsage)}` : ''}. Costs are the agent's own estimates`,
    `- **Run:** \`${facts.runId}\`, finished ${facts.finishedAt}`,
  ];
  return lines.join('\n');
};

const verdictKey = (): string => VERDICT_KEY.map(({ mark, means }) => `${mark} ${means}`).join(' · ');

const tallyTable = (report: FinderReport): string => {
  const tally = tallyOf(report);
  return [
    '| ❌ | 🕵️ | ✅ | n/a |',
    '|---|---|---|---|',
    `| ${tally.fail} | ${tally.check} | ${tally['found-no-fail']} | ${tally.na} |`,
    '',
    `Counts are criteria. ${tally.failItems} fail(s) for agents, ${tally.checkItems} check(s) for a person. ${verdictKey()}.`,
  ].join('\n');
};

const failItem = (facts: RunFacts, fail: Fail): string => {
  const lines = [`- [ ] ${codeLink(facts, fail.file, fail.line)} ${safeText(fail.what)}`, `  - **Hurts:** ${safeText(fail.whoItHurts)}`];
  if (fail.repro && fail.repro.length > 0) {
    lines.push('  - **Repro:**');
    fail.repro.forEach((step, i) => lines.push(`    ${i + 1}. ${safeText(step)}`));
  }
  return lines.join('\n');
};

const evidenceSection = (results: CriterionResult[]): string => {
  const parts = results.map((result) => [`#### ${criterionHeading(result.num)}`, '', ...result.evidence.map((item) => `- **Did:** ${safeText(item.did)}\n  **Saw:** ${safeText(item.saw)}`)].join('\n'));
  return [`<details>`, `<summary>✅ A machine found no fail in ${results.length} criteria. Here's what it did, so you can challenge it</summary>`, '', ...parts, '', '</details>'].join('\n');
};

const naSection = (results: CriterionResult[]): string =>
  results.length === 0 ? '' : ['## Not applicable', '', ...results.map((result) => `- ${criterionHeading(result.num)}: ${safeText(result.na ?? '')}`)].join('\n');

export const renderAgentIssue = (report: FinderReport, facts: RunFacts, links: { personUrl: string | null }): RenderedAgentIssue => {
  const tally = tallyOf(report);
  const failing = report.criteria.filter((result) => verdictOf(result) === 'fail');
  const clear = report.criteria.filter((result) => verdictOf(result) === 'found-no-fail');
  const na = report.criteria.filter((result) => verdictOf(result) === 'na');
  const person = links.personUrl ? `[the person's issue](${links.personUrl})` : "the person's issue (being filed)";

  const failSection = failing.length === 0
    ? '## ❌ For agents\n\nThe finder proved no fails. That is not a pass: see the person\'s issue for everything a machine couldn\'t settle.'
    : ['## ❌ For agents', '', 'Each of these is proven, with the file and line, who it hurts and, for behaviour, exact repro steps. Fix for people, not for a checker, and prefer native HTML to ARIA.', '', ...failing.map((result) => [`### ${criterionHeading(result.num)}`, '', ...result.fails.map((fail) => failItem(facts, fail))].join('\n'))].join('\n\n');

  const head = [marker('agent-issue', facts), warningBlock(facts.level), '', `${targetLine(facts)} · ${person}`, '', '## Tally', '', tallyTable(report), '', failSection, '', usedSection(report, facts), '', naSection(na)].join('\n');
  const evidence = clear.length > 0 ? evidenceSection(clear) : '';
  const title = `actua11y: WCAG 2.2 ${facts.level}, for agents (${tally.failItems} fail${tally.failItems === 1 ? '' : 's'} in ${tally.fail} criteri${tally.fail === 1 ? 'on' : 'a'})`;

  const inline = `${head}\n\n${evidence}\n`;
  if (inline.length <= GITHUB_LIMIT) return { title, body: inline, evidenceComment: null };
  const body = `${head}\n\nThe ✅ list and its evidence are in the first comment, because this body would pass GitHub's 65,536-character limit.\n`;
  if (body.length > GITHUB_LIMIT) throw new Error(`The agent issue is ${body.length} characters even without its evidence, past GitHub's limit`);
  return { title, body, evidenceComment: `${marker('evidence', facts)}\n\n${evidence}\n` };
};

export const renderPersonIssue = (report: FinderReport, facts: RunFacts, links: { agentUrl: string }): RenderedIssue => {
  const tally = tallyOf(report);
  const withChecks = report.criteria.filter((result) => result.checks.length > 0);
  const checkSection = withChecks.length === 0
    ? '## 🕵️ To check\n\nThe finder left nothing for a person in its list. That is unusual, so use the site yourself before trusting it.'
    : [
        '## 🕵️ To check',
        '',
        "A machine couldn't settle these, so each says what to check, how, and why it needs you. Tick one once you've checked it yourself.",
        '',
        ...withChecks.map((result) =>
          [
            `### ${criterionHeading(result.num)}${verdictOf(result) === 'fail' ? ' (also has proven fails on the agent issue)' : ''}`,
            '',
            ...result.checks.map((check) => `- [ ] ${safeText(check.what)}\n  - **How:** ${safeText(check.how)}\n  - **Why a machine can't:** ${safeText(check.whyNotAMachine)}`),
          ].join('\n'),
        ),
      ].join('\n\n');

  const body = [
    marker('person-issue', facts),
    warningBlock(facts.level),
    '',
    `${targetLine(facts)} · [the agent issue](${links.agentUrl})`,
    '',
    checkSection,
    '',
    '## What I found by using it',
    '',
    '_Real devices, a screen reader, your own thumbs. Add what you find here, and say whether each one is a WCAG criterion (which one, and whether it is inside the target) or a UX problem._',
    '',
    usedSection(report, facts),
    '',
  ].join('\n');
  if (body.length > GITHUB_LIMIT) throw new Error(`The person's issue is ${body.length} characters, past GitHub's limit`);
  return { title: `actua11y: WCAG 2.2 ${facts.level}, for a person (${tally.checkItems} check${tally.checkItems === 1 ? '' : 's'})`, body };
};

// The raw report rides along, collapsed, so a later session can resume from GitHub alone and anyone can check the rendering.
export const renderRawComments = (report: FinderReport, facts: RunFacts): string[] => {
  const json = JSON.stringify(report, null, 2);
  const room = GITHUB_LIMIT - 400;
  const chunks: string[] = [];
  for (let start = 0; start < json.length; start += room) chunks.push(json.slice(start, start + room));
  return chunks.map((chunk, i) => {
    const part = chunks.length > 1 ? ` (part ${i + 1} of ${chunks.length}, join the parts to parse)` : '';
    const longestRun = Math.max(0, ...[...chunk.matchAll(/`+/g)].map((match) => match[0].length));
    const fence = '`'.repeat(Math.max(3, longestRun + 1));
    return `${marker('raw-report', facts)}\n<details>\n<summary>The finder's raw report${part}</summary>\n\n${fence}json\n${chunk}\n${fence}\n\n</details>\n`;
  });
};

export const verdictLine = (result: CriterionResult): string => `${VERDICT_MARK[verdictOf(result)]} ${result.num}`;

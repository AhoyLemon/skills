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
  browser: { channel: string; version: string } | null;
  axe: { version: string; tags: string[] } | null;
  backend: string;
  model: string;
  effort: string;
  usage: Usage;
  dryRunUsage: Usage | null;
  finishedAt: string;
}

// An issue plus the comments to post on it, in order, straight after it is created.
export interface RenderedIssue {
  title: string;
  body: string;
  comments: string[];
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

// A code span that a backtick inside the text can't close early.
const codeSpan = (text: string): string => {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const pad = longest > 0 ? ' ' : '';
  return `${'`'.repeat(longest + 1)}${pad}${text}${pad}${'`'.repeat(longest + 1)}`;
};

export const codeLink = (facts: RunFacts, file: string, line: number): string => `[${codeSpan(`${file}:${line}`)}](https://github.com/${facts.repo.owner}/${facts.repo.name}/blob/${facts.commit}/${encodePath(file)}#L${line})`;

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
    `- **Pages:** ${report.used.pages.length > 0 ? report.used.pages.map(codeSpan).join(', ') : 'none loaded'} (base ${facts.baseUrl})`,
    `- **Tools:** ${report.used.tools.map(safeText).join(', ')}`,
    `- **Session:** a fresh, read-only ${facts.backend} session with none of your settings, memory or plugins. Model \`${facts.model}\`, effort \`${facts.effort}\``,
    `- **Cost:** finder ${formatUsage(facts.usage)}${facts.dryRunUsage ? `, dry run ${formatUsage(facts.dryRunUsage)}` : ''}. Costs are the agent's own estimates`,
    `- **Run:** \`${facts.runId}\`, finished ${facts.finishedAt}`,
  ];
  return lines.join('\n');
};

const verdictKey = (): string => VERDICT_KEY.map(({ mark, means }) => `${mark} ${means}`).join(' · ');

export const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

const tallyTable = (report: FinderReport): string => {
  const tally = tallyOf(report);
  return [
    '| ❌ | 🕵️ | ✅ | n/a |',
    '|---|---|---|---|',
    `| ${tally.fail} | ${tally.check} | ${tally['found-no-fail']} | ${tally.na} |`,
    '',
    `Counts are criteria. ${plural(tally.failItems, 'fail', 'fails')} for agents, ${plural(tally.checkItems, 'check', 'checks')} for a person. ${verdictKey()}.`,
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

// Room in one comment for content, after its marker and heading.
const COMMENT_ROOM = GITHUB_LIMIT - 500;

// Packs list blocks into comment-sized chunks, keeping each block whole unless one is bigger than a comment by itself.
export const chunkBlocks = (blocks: string[], room = COMMENT_ROOM): string[] => {
  const chunks: string[] = [];
  let current = '';
  for (const block of blocks) {
    const pieces: string[] = [];
    for (let start = 0; start < block.length; start += room) pieces.push(block.slice(start, start + room));
    for (const piece of pieces) {
      if (current !== '' && current.length + piece.length + 2 > room) {
        chunks.push(current);
        current = '';
      }
      current = current === '' ? piece : `${current}\n\n${piece}`;
    }
  }
  if (current !== '') chunks.push(current);
  return chunks;
};

const continuations = (kind: string, facts: RunFacts, heading: string, chunks: string[]): string[] =>
  chunks.map((chunk, i) => `${marker(kind, facts)}\n\n${heading}${chunks.length > 1 ? ` (part ${i + 1} of ${chunks.length})` : ''}\n\n${chunk}\n`);

const evidenceBlocks = (results: CriterionResult[]): string[] =>
  results.map((result) => [`#### ${criterionHeading(result.num)}`, '', ...result.evidence.map((item) => `- **Did:** ${safeText(item.did)}\n  **Saw:** ${safeText(item.saw)}`)].join('\n'));

const wrapEvidence = (count: number, inner: string, part = ''): string =>
  [`<details>`, `<summary>✅ A machine found no fail in ${plural(count, 'criterion', 'criteria')}${part}. Here's what it did, so you can challenge it</summary>`, '', inner, '', '</details>'].join('\n');

const naSection = (results: CriterionResult[]): string =>
  results.length === 0 ? '' : ['## Not applicable', '', ...results.map((result) => `- ${criterionHeading(result.num)}: ${safeText(result.na ?? '')}`)].join('\n');

const TOO_LONG = "because it won't fit in GitHub's 65,536-character limit for an issue body";

// The agent issue's layout is decided once, against the longest plausible link to the person's issue, so cross-linking it afterwards can't change which parts live in comments.
const LAYOUT_ISSUE_NUMBER = 9_999_999;

export const renderAgentIssue = (report: FinderReport, facts: RunFacts, links: { personUrl: string | null }): RenderedIssue => {
  const tally = tallyOf(report);
  const failing = report.criteria.filter((result) => verdictOf(result) === 'fail');
  const clear = report.criteria.filter((result) => verdictOf(result) === 'found-no-fail');
  const na = report.criteria.filter((result) => verdictOf(result) === 'na');
  const failBlocks = failing.map((result) => [`### ${criterionHeading(result.num)}`, '', ...result.fails.map((fail) => failItem(facts, fail))].join('\n'));
  const evidence = evidenceBlocks(clear);
  const intro = 'Each of these is proven, with the file and line, who it hurts and, for behaviour, exact repro steps. Fix for people, not for a checker, and prefer native HTML to ARIA.';

  const compose = (personUrl: string | null, failsInline: boolean, evidenceInline: boolean): string => {
    const person = personUrl ? `[the person's issue](${personUrl})` : "the person's issue (being filed)";
    const failSection = failing.length === 0
      ? "## ❌ For agents\n\nThe finder proved no fails. That's not the same as finding nothing wrong: see the person's issue for everything a machine couldn't settle."
      : ['## ❌ For agents', intro, ...(failsInline ? failBlocks : [`The list is in the comments below, ${TOO_LONG}.`])].join('\n\n');
    const evidencePart = clear.length === 0 ? '' : evidenceInline ? wrapEvidence(clear.length, evidence.join('\n\n')) : `The ✅ list and its evidence are in the first comment, ${TOO_LONG}.`;
    return [marker('agent-issue', facts), warningBlock(facts.level), '', `${targetLine(facts)} · ${person}`, '', '## Tally', '', tallyTable(report), '', failSection, '', usedSection(report, facts), '', naSection(na), '', evidencePart, ''].join('\n');
  };

  const layoutUrl = `https://github.com/${facts.repo.owner}/${facts.repo.name}/issues/${LAYOUT_ISSUE_NUMBER}`;
  const layout = ([[true, true], [true, false], [false, false]] as const).find(([fails, ev]) => compose(layoutUrl, fails, ev).length <= GITHUB_LIMIT);
  if (!layout) throw new Error("The agent issue won't fit GitHub's limit even with its lists moved into comments");
  const [failsInline, evidenceInline] = layout;

  const comments: string[] = [];
  if (clear.length > 0 && !evidenceInline) {
    const chunks = chunkBlocks(evidence);
    chunks.forEach((chunk, i) => comments.push(`${marker('evidence', facts)}\n\n${wrapEvidence(clear.length, chunk, chunks.length > 1 ? `, part ${i + 1} of ${chunks.length}` : '')}\n`));
  }
  if (!failsInline) comments.push(...continuations('fails', facts, '## ❌ For agents, continued', chunkBlocks(failBlocks)));
  const title = `actua11y: WCAG 2.2 ${facts.level}, for agents (${plural(tally.failItems, 'fail', 'fails')} in ${plural(tally.fail, 'criterion', 'criteria')})`;
  return { title, body: compose(links.personUrl, failsInline, evidenceInline), comments };
};

export const renderPersonIssue = (report: FinderReport, facts: RunFacts, links: { agentUrl: string }): RenderedIssue => {
  const tally = tallyOf(report);
  const withChecks = report.criteria.filter((result) => result.checks.length > 0);
  const checkBlocks = withChecks.map((result) =>
    [
      `### ${criterionHeading(result.num)}${verdictOf(result) === 'fail' ? ' (also has proven fails on the agent issue)' : ''}`,
      '',
      ...result.checks.map((check) => `- [ ] ${safeText(check.what)}\n  - **How:** ${safeText(check.how)}\n  - **Why a machine can't:** ${safeText(check.whyNotAMachine)}`),
    ].join('\n'),
  );
  const intro = "A machine couldn't settle these, so each says what to check, how, and why it needs you. Tick one once you've checked it yourself.";

  const compose = (checksInline: boolean): string => {
    const checkSection = withChecks.length === 0
      ? "## 🕵️ To check\n\nThe finder left nothing for a person in its list. That's unusual, so use the site yourself before trusting it."
      : ['## 🕵️ To check', intro, ...(checksInline ? checkBlocks : [`The checklist is in the comments below, ${TOO_LONG}. You can tick boxes there too.`])].join('\n\n');
    return [
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
  };

  const inline = compose(true);
  const title = `actua11y: WCAG 2.2 ${facts.level}, for a person (${plural(tally.checkItems, 'check', 'checks')})`;
  if (inline.length <= GITHUB_LIMIT) return { title, body: inline, comments: [] };
  const body = compose(false);
  if (body.length > GITHUB_LIMIT) throw new Error("The person's issue won't fit GitHub's limit even with its checklist moved into comments");
  return { title, body, comments: continuations('checks', facts, '## 🕵️ To check, continued', chunkBlocks(checkBlocks)) };
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

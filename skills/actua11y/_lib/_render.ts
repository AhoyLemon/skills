// Turns the loop's state into the two GitHub issues people actually read. The model never writes this Markdown, so a summary can't contradict its own list.
import { totalTokens, type Usage } from './_backend.ts';
import { criterionByNum, levelLabel, type Level } from './_criteria.ts';
import { VERDICT_KEY, warningsFor } from './_copy.ts';
import { GITHUB_LIMIT, rawBlocks } from './_fence.ts';
import { checkOf, failOf, insideTarget, ledgerBlock, passSha, STOP_WHY, type AgentItem, type Decision, type HumanItem, type Judged, type Ledger, type LoopView } from './_ledger.ts';
import { tallyOf, verdictOf, VERDICT_MARK, type CriterionResult, type Fail, type FinderReport } from './_report.ts';

export { GITHUB_LIMIT };

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
  // What the fences caught: tool calls the rules refused, and tool calls that named an off-limits path anyway.
  fences: { denials: number; mentions: number } | null;
  // Every path the runner's own server sent back, when it served the site.
  served: string[] | null;
  finishedAt: string;
}

export type OverflowKind = 'evidence' | 'fails' | 'checks';

// An issue plus the comments its lists overflowed into, in order. Comments of one kind are edited in place on every re-render.
export interface RenderedIssue {
  title: string;
  body: string;
  comments: { kind: OverflowKind; body: string }[];
}

const ENTITIES: Record<string, string> = { '<': '&lt;', '@': '&#64;', '#': '&#35;' };

// Escapes text a model or a person wrote, outside code spans, in one pass (so one escape can't mangle another): no raw HTML, no accidental @mentions, no #123 auto-links, and one line per item.
export const safeText = (text: string): string =>
  text
    .replace(/\s*\n\s*/g, ' ')
    .split(/(`[^`]*`)/)
    .map((part) => (part.startsWith('`') && part.endsWith('`') && part.length > 1 ? part : part.replace(/<|@(?=\w)|#(?=\d)/g, (char) => ENTITIES[char] ?? char)))
    .join('');

const encodePath = (file: string): string => file.split('/').map(encodeURIComponent).join('/');

// A code span that a backtick inside the text can't close early.
export const codeSpan = (text: string): string => {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length));
  const pad = longest > 0 ? ' ' : '';
  return `${'`'.repeat(longest + 1)}${pad}${text}${pad}${'`'.repeat(longest + 1)}`;
};

export const shortSha = (sha: string): string => `\`${sha.slice(0, 12)}\``;

export const codeLink = (facts: Pick<RunFacts, 'repo'>, commit: string, file: string, line: number): string => `[${codeSpan(`${file}:${line}`)}](https://github.com/${facts.repo.owner}/${facts.repo.name}/blob/${commit}/${encodePath(file)}#L${line})`;

export const criterionHeading = (num: string): string => {
  const criterion = criterionByNum(num);
  return criterion ? `[${num} ${criterion.name}](${criterion.understanding}) · ${criterion.level}` : num;
};

export const formatUsage = (usage: Usage): string => {
  const minutes = (usage.durationMs / 60_000).toFixed(1);
  const tokens = totalTokens(usage);
  const tokenText = tokens >= 1_000_000 ? `${(tokens / 1_000_000).toFixed(2)}M` : `${Math.round(tokens / 1000)}k`;
  return `${usage.turns} turns · ${minutes} min · $${usage.costUsd.toFixed(2)} · ${tokenText} tokens`;
};

export const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

export const marker = (kind: string, facts: RunFacts): string => `<!-- actua11y:${kind} v1 run=${facts.runId} level=${facts.level} commit=${facts.commit} -->`;

export const warningBlock = (level: Level): string => warningsFor(level).map((line) => `> ${line}`).join('\n>\n');

const targetLine = (facts: RunFacts): string => {
  const scope = facts.scope.map((path) => `\`${path}\``).join(', ');
  return `**WCAG 2.2 ${levelLabel(facts.level)}** · scope ${scope} · audited at \`${facts.commit.slice(0, 12)}\` on \`${facts.branch}\``;
};

// The finder's list has no upper bound, and a long one mustn't stop a paid run from being filed. The raw report keeps every page.
const PAGES_SHOWN = 50;

export const pagesList = (pages: string[]): string => {
  if (pages.length === 0) return 'none loaded';
  const rest = pages.length - PAGES_SHOWN;
  return `${pages.slice(0, PAGES_SHOWN).map(codeSpan).join(', ')}${rest > 0 ? `, and ${rest.toLocaleString('en-US')} more, every one of them in the raw report` : ''}`;
};

export const servedLine = (served: string[] | null): string[] => (served === null ? [] : [`- **Paths the runner's own server sent, to check that list against:** ${served.length > 0 ? pagesList(served).replace('in the raw report', 'in the run record') : 'none'}`]);

const usedSection = (report: FinderReport, facts: RunFacts): string => {
  const lines = [
    '## What the finder used',
    '',
    `- **Browser:** ${facts.browser ? `${facts.browser.channel} ${facts.browser.version}, headless, recorded by the runner. One engine checked, so behaviour in other engines is a person's call` : 'none'}`,
    `- **axe:** ${facts.axe ? `axe-core ${facts.axe.version}, tags ${facts.axe.tags.map((tag) => `\`${tag}\``).join(' ')}. An axe result covers one rule, never a whole criterion, and axe covers only part of WCAG` : 'not run'}`,
    `- **Pages, as the finder reports them:** ${pagesList(report.used.pages)} (base ${facts.baseUrl})`,
    ...servedLine(facts.served ?? null),
    `- **Tools:** ${report.used.tools.map(safeText).join(', ')}`,
    `- **Session:** a fresh, read-only ${facts.backend} session with none of your settings, memory or plugins. Model \`${facts.model}\`, effort \`${facts.effort}\``,
    ...(facts.fences ? [`- **Fences:** the rules refused ${plural(facts.fences.denials, 'tool call', 'tool calls')}, and ${plural(facts.fences.mentions, 'tool call', 'tool calls')} named a path the finder must never read`] : []),
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
    `Counts are the finder's, by criterion. ${plural(tally.failItems, 'fail', 'fails')} for agents, ${plural(tally.checkItems, 'check', 'checks')} for a person. ${verdictKey()}.`,
  ].join('\n');
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

const continuations = (kind: OverflowKind, facts: RunFacts, heading: string, chunks: string[]): { kind: OverflowKind; body: string }[] =>
  chunks.map((chunk, i) => ({ kind, body: `${marker(kind, facts)}\n\n${heading}${chunks.length > 1 ? ` (part ${i + 1} of ${chunks.length})` : ''}\n\n${chunk}\n` }));

const evidenceBlocks = (results: CriterionResult[]): string[] =>
  results.map((result) => [`#### ${criterionHeading(result.num)}`, '', ...result.evidence.map((item) => `- **Did:** ${safeText(item.did)}\n  **Saw:** ${safeText(item.saw)}`)].join('\n'));

const wrapEvidence = (count: number, inner: string, part = ''): string =>
  [`<details>`, `<summary>✅ The finder found no fail in ${plural(count, 'criterion', 'criteria')}${part}. Here's what it did, so you can challenge it</summary>`, '', inner, '', '</details>'].join('\n');

const naSection = (results: CriterionResult[]): string =>
  results.length === 0 ? '' : ['## Not applicable', '', ...results.map((result) => `- ${criterionHeading(result.num)}: ${safeText(result.na ?? '')}`)].join('\n');

const TOO_LONG = "because it won't fit in GitHub's 65,536-character limit for an issue body";

// Layouts are decided against the longest plausible link to the other issue, so cross-linking afterwards can't change which parts live in comments.
const LAYOUT_ISSUE_NUMBER = 9_999_999;

const reproLines = (steps: string[], indent = '  '): string[] => [`${indent}- **Repro:**`, ...steps.map((step, i) => `${indent}  ${i + 1}. ${safeText(step)}`)];

const failLines = (view: LoopView, item: AgentItem, fail: Fail, commit: string): string[] => {
  const lines = [`**${item.id}** ${codeLink(view.ledger.facts, commit, fail.file, fail.line)} ${safeText(fail.what)}`, `  - **Hurts:** ${safeText(fail.whoItHurts)}`];
  if (fail.repro && fail.repro.length > 0) lines.push(...reproLines(fail.repro));
  return lines;
};

export const judgedText = (ledger: Ledger, judged: Judged | null): string | null => {
  if (!judged) return null;
  const sha = passSha(ledger, judged.pass);
  if (judged.result === 'fixed') return `✅ certified at ${shortSha(sha)} by pass ${judged.pass}`;
  if (judged.result === 'notFixed') return `❌ still failing at ${shortSha(sha)} (certifier pass ${judged.pass}, with exact steps on the PR)`;
  return `🕵️ certifier pass ${judged.pass} at ${shortSha(sha)} says only a person can settle it`;
};

const movedWhy = (item: AgentItem): string => (item.moved?.by === 'cap' ? (STOP_WHY[item.moved.why as keyof typeof STOP_WHY] ?? item.moved.why) : (item.moved?.why ?? ''));

const movedText = (item: AgentItem, personUrl: string | null): string => {
  const person = personUrl ? `[the person's issue](${personUrl})` : "the person's issue";
  if (!item.moved) return `moved to ${person}`;
  const by = item.moved.by === 'fixer' ? `by fixer round ${item.moved.at}` : item.moved.by === 'cap' ? `when the AI rounds ended after pass ${item.moved.at}` : `by certifier pass ${item.moved.at}`;
  return `moved to ${person} ${by}${item.moved.check ? `, as check ${item.moved.check}` : ''}: ${safeText(movedWhy(item))}`;
};

export const agentStatus = (ledger: Ledger, item: AgentItem, personUrl: string | null): string => {
  if (item.status === 'moved') return movedText(item, personUrl);
  if (item.status === 'certified') return judgedText(ledger, item.judged) ?? '✅';
  const claim = item.claim;
  if (item.status === 'claimed' && claim?.commit) return `claimed${claim.outcome === 'partial' ? ' in part' : ''} at ${shortSha(claim.commit)} by fixer round ${claim.round}, waiting for a certifier`;
  const failing = item.judged?.result === 'notFixed' ? judgedText(ledger, item.judged) : null;
  const couldnt = claim?.outcome === 'couldnt' ? `the fixer couldn't fix it in round ${claim.round}` : null;
  return ['open', failing, couldnt].filter((part): part is string => part !== null).join(': ');
};

const groupByNum = <T>(entries: { num: string; value: T }[]): Map<string, T[]> => {
  const groups = new Map<string, T[]>();
  for (const entry of entries) groups.set(entry.num, [...(groups.get(entry.num) ?? []), entry.value]);
  return groups;
};

const loopLine = (view: LoopView): string => {
  const { ledger } = view;
  if (!ledger.loop) return '';
  const count = (status: AgentItem['status']): number => ledger.items.filter((item) => item.status === status).length;
  const stage = ledger.stage === 'ai' ? 'the AI rounds' : ledger.stage === 'human' ? 'the human round' : 'closed';
  const pr = ledger.loop.pr ? ` · [the PR](${ledger.loop.pr})` : '';
  return `## The loop\n\nNow in ${stage}. ${count('open')} open · ${count('claimed')} claimed · ${count('certified')} with a certifier's ✅ · ${count('moved')} moved to the person · $${ledger.spentUsd.toFixed(2)} of a $${ledger.loop.budgetUsd.toFixed(2)} budget spent by what the runner starts${pr}\n`;
};

export const renderAgentIssue = (view: LoopView, links: { personUrl: string | null }): RenderedIssue => {
  const { ledger, finder } = view;
  const facts = ledger.facts;
  const tally = tallyOf(finder);
  const clear = finder.criteria.filter((result) => verdictOf(result) === 'found-no-fail');
  const na = finder.criteria.filter((result) => verdictOf(result) === 'na');
  const rows = groupByNum(ledger.items.map((item) => {
    const content = failOf(view, item);
    const lines = failLines(view, item, content.fail, content.commit);
    if (content.origin !== 'the finder') lines.push(`  - **Found by:** ${content.origin}, in its re-walk`);
    lines.push(`  - **Status:** ${agentStatus(ledger, item, links.personUrl)}`);
    return { num: content.num, value: `- [${item.status === 'certified' ? 'x' : ' '}] ${lines.join('\n')}` };
  }));
  const order = finder.criteria.map((result) => result.num);
  const failBlocks = [...rows.entries()].sort(([a], [b]) => order.indexOf(a) - order.indexOf(b)).map(([num, items]) => [`### ${criterionHeading(num)}`, '', ...items].join('\n'));
  const evidence = evidenceBlocks(clear);
  const intro = 'Each of these is proven, with the file and line, who it hurts and, for behaviour, exact repro steps. Fix for people, not for a checker, and prefer native HTML to ARIA. Only a certifier ticks a box here.';

  const compose = (personUrl: string | null, failsInline: boolean, evidenceInline: boolean): string => {
    const person = personUrl ? `[the person's issue](${personUrl})` : "the person's issue (being filed)";
    const failSection = failBlocks.length === 0
      ? "## ❌ For agents\n\nThe finder proved no fails. That's not the same as finding nothing wrong: see the person's issue for everything a machine couldn't settle."
      : ['## ❌ For agents', intro, ...(failsInline ? failBlocks : [`The list is in the comments below, ${TOO_LONG}.`])].join('\n\n');
    const evidencePart = clear.length === 0 ? '' : evidenceInline ? wrapEvidence(clear.length, evidence.join('\n\n')) : `The ✅ list and its evidence are in the first comment, ${TOO_LONG}.`;
    return [marker('agent-issue', facts), warningBlock(facts.level), '', `${targetLine(facts)} · ${person}`, '', '## Tally', '', tallyTable(finder), '', loopLine(view), failSection, '', usedSection(finder, facts), '', naSection(na), '', evidencePart, '', ledgerBlock(ledger), ''].join('\n');
  };

  const layoutUrl = `https://github.com/${facts.repo.owner}/${facts.repo.name}/issues/${LAYOUT_ISSUE_NUMBER}`;
  const layout = ([[true, true], [true, false], [false, false]] as const).find(([fails, ev]) => compose(layoutUrl, fails, ev).length <= GITHUB_LIMIT);
  if (!layout) throw new Error("The agent issue won't fit GitHub's limit even with its lists moved into comments");
  const [failsInline, evidenceInline] = layout;

  const comments: RenderedIssue['comments'] = [];
  if (clear.length > 0 && !evidenceInline) {
    const chunks = chunkBlocks(evidence);
    chunks.forEach((chunk, i) => comments.push({ kind: 'evidence', body: `${marker('evidence', facts)}\n\n${wrapEvidence(clear.length, chunk, chunks.length > 1 ? `, part ${i + 1} of ${chunks.length}` : '')}\n` }));
  }
  if (!failsInline) comments.push(...continuations('fails', facts, '## ❌ For agents, continued', chunkBlocks(failBlocks)));
  const title = `actua11y: WCAG 2.2 ${facts.level}, for agents (${plural(tally.failItems, 'fail', 'fails')} in ${plural(tally.fail, 'criterion', 'criteria')})`;
  return { title, body: compose(links.personUrl, failsInline, evidenceInline), comments };
};

// ---- The person's issue ----

export const YOURS_START = '<!-- actua11y:yours -->';
export const YOURS_END = '<!-- actua11y:/yours -->';

// What a re-render must never overwrite: the person's own region, byte for byte, and the boxes they ticked.
export interface Kept {
  region: string;
  ticked: ReadonlySet<string>;
}

export const freshKept = (): Kept => ({ region: '\n\n', ticked: new Set() });

const quoted = (text: string): string => `“${safeText(text)}”`;

export const decisionText = (decision: Decision | null): string => {
  if (!decision) return 'not yet. Fix it, accept it as it is (with your reason), or call it not applicable (with your reason)';
  if (decision.choice === 'fix') return 'fix';
  return `${decision.choice === 'accept' ? 'accept as is' : 'not applicable'}, because ${quoted(decision.reason ?? '')}`;
};

export const tagText = (item: HumanItem, level: Level): string => {
  if (item.tag.kind === 'ux') return 'UX, outside WCAG, so it never holds up close-out';
  const inside = insideTarget(item.tag.num, level);
  return `WCAG ${criterionHeading(item.tag.num)}, ${inside ? 'inside the target' : 'outside the target, so it never holds up close-out'}`;
};

export const renderPersonIssue = (view: LoopView, links: { agentUrl: string }, kept: Kept): RenderedIssue => {
  const { ledger, finder } = view;
  const facts = ledger.facts;
  const order = finder.criteria.map((result) => result.num);
  const checks = groupByNum(ledger.checks.map((item) => {
    const content = checkOf(view, item);
    const origin = content.origin === 'the finder' ? '' : `\n  - **From:** ${content.origin}`;
    return { num: content.num, value: `- [${kept.ticked.has(item.id) ? 'x' : ' '}] **${item.id}** ${safeText(content.check.what)}\n  - **How:** ${safeText(content.check.how)}\n  - **Why a machine can't:** ${safeText(content.check.whyNotAMachine)}${origin}` };
  }));
  const checkBlocks = [...checks.entries()].sort(([a], [b]) => order.indexOf(a) - order.indexOf(b)).map(([num, items]) => {
    const failing = finder.criteria.find((result) => result.num === num);
    return [`### ${criterionHeading(num)}${failing && verdictOf(failing) === 'fail' ? ' (also has proven fails on the agent issue)' : ''}`, '', ...items].join('\n');
  });
  const moved = ledger.items.filter((item) => item.status === 'moved' && item.moved?.check === null);
  const movedBlocks = moved.map((item) => {
    const content = failOf(view, item);
    const lines = [`- ${failLines(view, item, content.fail, content.commit).join('\n')}`, `  - **Why it's here:** ${movedText(item, null).replace(/^moved to the person's issue /, 'moved ')}`, `  - **Your decision:** ${decisionText(item.decision)}`];
    const since = item.decision ? judgedText(ledger, item.judged) : null;
    if (since) lines.push(`  - **Since then:** ${since}`);
    return lines.join('\n');
  });
  const humanBlocks = ledger.human.map((item) => {
    const lines = [`- **${item.id}** ${quoted(item.words)}`, `  - **Tag:** ${tagText(item, facts.level)}`, `  - **Your decision:** ${decisionText(item.decision)}`];
    const since = judgedText(ledger, item.judged);
    if (since) lines.push(`  - **Since then:** ${since}`);
    return lines.join('\n');
  });
  const intro = "A machine couldn't settle these, so each says what to check, how, and why it needs you. Tick one once you've checked it yourself. Only you tick these, never a certifier.";

  const compose = (checksInline: boolean): string => {
    const checkSection = checkBlocks.length === 0
      ? "## 🕵️ To check\n\nThe finder left nothing for a person in its list. That's unusual, so use the site yourself before trusting it."
      : ['## 🕵️ To check', intro, ...(checksInline ? checkBlocks : [`The checklist is in the comments below, ${TOO_LONG}. You can tick boxes there too.`])].join('\n\n');
    const movedSection = movedBlocks.length === 0 ? '' : ['## ❌ Moved to you from the agent issue', "Proven fails the AI rounds didn't settle. Each needs your decision: fix it, accept it as it is, or call it not applicable. Write your reason in the section below, and the session running actua11y records it word for word.", ...movedBlocks].join('\n\n');
    const humanSection = humanBlocks.length === 0 ? '' : ['## Your findings and decisions', 'Recorded from what you wrote above, word for word.', ...humanBlocks].join('\n\n');
    return [
      marker('person-issue', facts),
      warningBlock(facts.level),
      '',
      `${targetLine(facts)} · [the agent issue](${links.agentUrl})${ledger.loop?.pr ? ` · [the PR](${ledger.loop.pr})` : ''}`,
      '',
      checkSection,
      '',
      movedSection,
      '',
      '## What I found by using it',
      '',
      "_Real devices, a screen reader, your own thumbs. Write what you find between the two markers you'll see when you edit this issue. actua11y keeps everything between them exactly as you wrote it. Say whether each one is a WCAG criterion (which one) or a UX problem, and what you want done about it: fix it, accept it as it is (and why), or not applicable (and why)._",
      '',
      `${YOURS_START}${kept.region}${YOURS_END}`,
      '',
      humanSection,
      '',
      usedSection(finder, facts),
      '',
    ].join('\n');
  };

  const title = `actua11y: WCAG 2.2 ${facts.level}, for a person (${plural(ledger.checks.length, 'check', 'checks')}${moved.length > 0 ? `, ${plural(moved.length, 'fail', 'fails')} to decide` : ''})`;
  const inline = compose(true);
  if (inline.length <= GITHUB_LIMIT) return { title, body: inline, comments: [] };
  const body = compose(false);
  if (body.length > GITHUB_LIMIT) throw new Error("The person's issue won't fit GitHub's limit even with its checklist moved into comments");
  return { title, body, comments: continuations('checks', facts, '## 🕵️ To check, continued', chunkBlocks(checkBlocks)) };
};

const normalise = (text: string): string => text.replace(/\r\n/g, '\n');

// The person's region, exactly as it stands, or null when its markers are gone and a re-render would have nowhere safe to put it.
export const regionOf = (body: string): string | null => {
  const text = normalise(body);
  const start = text.indexOf(YOURS_START);
  const end = text.indexOf(YOURS_END, start + YOURS_START.length);
  return start < 0 || end < 0 ? null : text.slice(start + YOURS_START.length, end);
};

// Ticked check ids, read from the body and any comments the checklist overflowed into.
export const tickedIn = (texts: string[]): Set<string> => {
  const ticked = new Set<string>();
  for (const text of texts) for (const match of normalise(text).matchAll(/^\s*- \[[xX]\] \*\*(P\d+)\*\*/gm)) if (match[1]) ticked.add(match[1]);
  return ticked;
};

// The raw report rides along, collapsed, so a later session can resume from GitHub alone and anyone can check the rendering.
export const renderRawComments = (report: FinderReport, facts: RunFacts): string[] => rawBlocks('finder', { run: facts.runId }, "The finder's raw report", report);

export const verdictLine = (result: CriterionResult): string => `${VERDICT_MARK[verdictOf(result)]} ${result.num}`;

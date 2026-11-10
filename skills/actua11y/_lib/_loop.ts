// Loads the loop's whole state from the two issues and the PR, and writes it back, through an interface a test can fake. The runner keeps nothing of its own between commands, so a loop can pick up days later from GitHub alone.
import type { CertifierReport } from './_certifier.ts';
import { readRaw } from './_fence.ts';
import * as gh from './_gh.ts';
import type { GhComment, GhIssue, GhPr, NewIssue, NewPr } from './_gh.ts';
import { parseLedger, passes, type Ledger, type LoopView } from './_ledger.ts';
import { renderDraftPrBody } from './_render-loop.ts';
import { marker, regionOf, renderAgentIssue, renderPersonIssue, tickedIn, type Kept, type OverflowKind, type RenderedIssue } from './_render.ts';
import type { FinderReport } from './_report.ts';

export interface LoopGh {
  readIssue: (url: string) => GhIssue;
  readPr: (url: string) => GhPr;
  findPr: (slug: string, head: string) => string | null;
  findAgentIssues: (slug: string) => { url: string; title: string }[];
  ensureLabel: (slug: string) => void;
  createIssue: (issue: NewIssue) => string;
  editIssueBody: (url: string, body: string) => void;
  commentOn: (url: string, body: string) => string;
  editComment: (url: string, body: string) => void;
  createDraftPr: (pr: NewPr) => string;
  editPrBody: (url: string, body: string) => void;
  commentOnPr: (url: string, body: string) => string;
  markReady: (url: string) => void;
}

export const realLoopGh: LoopGh = {
  readIssue: gh.readIssue,
  readPr: gh.readPr,
  findPr: gh.findOpenPr,
  findAgentIssues: gh.findAgentIssues,
  ensureLabel: gh.ensureLabel,
  createIssue: gh.createIssue,
  editIssueBody: gh.editIssueBody,
  commentOn: gh.commentOn,
  editComment: gh.editComment,
  createDraftPr: gh.createDraftPr,
  editPrBody: gh.editPrBody,
  commentOnPr: gh.commentOnPr,
  markReady: gh.markReady,
};

export interface LoopState {
  agent: GhIssue;
  person: GhIssue;
  pr: GhPr | null;
  view: LoopView;
  // Null when the person's region markers are gone, so a re-render would have nowhere safe to keep their words.
  kept: Kept | null;
}

// --issue takes a number or a URL. With neither, the one open agent issue on the repository, if there's exactly one.
export const resolveAgentUrl = (client: LoopGh, slug: string, issue: string | null): string => {
  if (issue && /^\d+$/.test(issue)) return `https://github.com/${slug}/issues/${issue}`;
  if (issue) return issue;
  const open = client.findAgentIssues(slug);
  if (open.length === 1 && open[0]) return open[0].url;
  if (open.length === 0) throw new Error(`No open actua11y agent issue on ${slug}. Pass --issue <number>`);
  throw new Error(`More than one open actua11y agent issue on ${slug}, so pass --issue <number>:\n${open.map((item) => `  ${item.url}  ${item.title}`).join('\n')}`);
};

const bodies = (comments: GhComment[]): string[] => comments.map((comment) => comment.body);

export const loadLoop = (client: LoopGh, agentUrl: string): LoopState => {
  const agent = client.readIssue(agentUrl);
  const ledger = parseLedger(agent.body);
  if (!ledger) throw new Error(`${agentUrl} has no actua11y ledger. Issues filed before actua11y 1.0 can't become a loop, so run the finder again`);
  const finder = readRaw(bodies(agent.comments), 'finder', { run: ledger.facts.runId }) as FinderReport | null;
  if (!finder) throw new Error(`The finder's raw report for run ${ledger.facts.runId} is missing from ${agentUrl}'s comments, so the loop can't be rebuilt. If filing stopped partway, run \`file --run ${ledger.facts.runId}\` again`);
  if (!ledger.personUrl) throw new Error(`${agentUrl} isn't linked to a person's issue yet. If filing stopped partway, run \`file --run ${ledger.facts.runId}\` again`);
  const person = client.readIssue(ledger.personUrl);
  const pr = ledger.loop?.pr ? client.readPr(ledger.loop.pr) : null;
  const reports = new Map<number, CertifierReport>();
  // A pass posts on the PR, or on the agent issue while no commit has given the loop a PR yet.
  const runBodies = [...(pr ? bodies(pr.comments) : []), ...bodies(agent.comments)];
  for (const round of passes(ledger)) {
    const report = readRaw(runBodies, 'certifier', { pass: String(round.n) }) as CertifierReport | null;
    if (!report) throw new Error(`Certifier pass ${round.n}'s raw report is missing from the PR and the agent issue, so the loop can't be rebuilt`);
    reports.set(round.n, report);
  }
  const region = regionOf(person.body);
  const kept = region === null ? null : { region, ticked: tickedIn([person.body, ...bodies(person.comments)]) };
  return { agent, person, pr, view: { ledger, finder, passes: reports }, kept };
};

// Posts a comment only if no comment already carries its marker, so rerunning a command after a failure never posts twice.
export const postOnce = (existing: GhComment[], body: string, post: (body: string) => string): string => {
  const first = body.split('\n')[0] ?? '';
  const found = first.startsWith('<!-- actua11y:') ? existing.find((comment) => comment.body.split('\n')[0] === first) : undefined;
  return found ? found.url : post(body);
};

// Edits the comments a list overflowed into in place, adds any it now needs, and empties any it no longer does.
const syncOverflow = (client: LoopGh, issue: GhIssue, rendered: RenderedIssue, ledger: Ledger): void => {
  const kinds: OverflowKind[] = ['evidence', 'fails', 'checks'];
  for (const kind of kinds) {
    const prefix = `<!-- actua11y:${kind} v1 run=${ledger.facts.runId} `;
    const existing = issue.comments.filter((comment) => comment.body.startsWith(prefix));
    const wanted = rendered.comments.filter((comment) => comment.kind === kind).map((comment) => comment.body);
    wanted.forEach((body, i) => {
      const current = existing[i];
      if (!current) client.commentOn(issue.url, body);
      else if (current.body !== body) client.editComment(current.url, body);
    });
    for (const extra of existing.slice(wanted.length)) {
      const empty = `${marker(kind, ledger.facts)}\n\n_This part is empty now: the list got shorter._\n`;
      if (extra.body !== empty) client.editComment(extra.url, empty);
    }
  }
};

export interface SaveInput {
  ledger: Ledger;
  passes: ReadonlyMap<number, CertifierReport>;
}

// Writes both issues from a new ledger. The person's issue is read again just before it's written, so a box they ticked a moment ago survives. The agent issue, which holds the ledger, goes last: until it lands, rerunning the command repeats the work rather than skipping it.
export const saveLoop = (client: LoopGh, state: LoopState, input: SaveInput): void => {
  const view: LoopView = { ledger: input.ledger, finder: state.view.finder, passes: input.passes };
  const person = client.readIssue(state.person.url);
  const region = regionOf(person.body);
  if (region === null) throw new Error(`The markers around your own notes in ${state.person.url} are gone, so actua11y won't rewrite that issue and risk losing them. Put back the two lines \`<!-- actua11y:yours -->\` and \`<!-- actua11y:/yours -->\` around your notes, then run this again`);
  const kept: Kept = { region, ticked: tickedIn([person.body, ...bodies(person.comments)]) };
  const renderedPerson = renderPersonIssue(view, { agentUrl: state.agent.url }, kept);
  if (renderedPerson.body !== person.body) client.editIssueBody(person.url, renderedPerson.body);
  syncOverflow(client, person, renderedPerson, input.ledger);
  const renderedAgent = renderAgentIssue(view, { personUrl: input.ledger.personUrl });
  syncOverflow(client, state.agent, renderedAgent, input.ledger);
  client.editIssueBody(state.agent.url, renderedAgent.body);
};

export const slugOf = (ledger: Ledger): string => `${ledger.facts.repo.owner}/${ledger.facts.repo.name}`;

// Where a run's comment goes: the PR once there is one, the agent issue before then.
export const runTarget = (state: LoopState, ledger: Ledger): { url: string; existing: GhComment[]; post: (client: LoopGh, body: string) => string } => {
  const pr = ledger.loop?.pr ?? null;
  if (pr) return { url: pr, existing: state.pr?.url === pr ? state.pr.comments : [], post: (client, body) => client.commentOnPr(pr, body) };
  return { url: state.agent.url, existing: state.agent.comments, post: (client, body) => client.commentOn(state.agent.url, body) };
};

// GitHub won't open a PR with no commits, so the draft opens with the first commit the loop pushes. It's a draft until close-out, so it can't be merged by accident mid-loop.
export const ensurePr = (client: LoopGh, ledger: Ledger, view: LoopView, agentUrl: string, hasCommits: boolean): string | null => {
  if (!ledger.loop) return null;
  if (ledger.loop.pr) return ledger.loop.pr;
  if (!hasCommits) return null;
  const slug = slugOf(ledger);
  return client.findPr(slug, ledger.loop.branch) ?? client.createDraftPr({ slug, base: ledger.facts.branch, head: ledger.loop.branch, title: `actua11y: WCAG 2.2 ${ledger.facts.level} fixes`, body: renderDraftPrBody(view, { agentUrl }) });
};

// Comments for one run, each posted once. Returns their URLs in order.
export const postRun = (client: LoopGh, target: ReturnType<typeof runTarget>, comments: string[]): string[] => comments.map((body) => postOnce(target.existing, body, (text) => target.post(client, text)));

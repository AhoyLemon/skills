// The filing sequence, kept apart from gh so a test can drive it with a fake. Every step is recorded as it lands, so a rerun after a failure picks up exactly where it stopped instead of filing twice.
import { initialLedger, type LoopView } from './_ledger.ts';
import { freshKept, renderAgentIssue, renderPersonIssue, renderRawComments, type RunFacts } from './_render.ts';
import type { FinderReport } from './_report.ts';
import type { FiledRecord } from './_runs.ts';

export interface GhClient {
  ensureLabel: (slug: string) => void;
  createIssue: (issue: { slug: string; title: string; body: string; assignToMe: boolean }) => string;
  editIssueBody: (url: string, body: string) => void;
  commentOn: (url: string, body: string) => string;
}

export interface FilingInput {
  report: FinderReport;
  facts: RunFacts;
  site: { url: string | null; serve: string | null };
  slug: string;
  filed: FiledRecord;
  gh: GhClient;
  save: () => void;
  progress: (line: string) => void;
}

const postRemaining = (gh: GhClient, url: string, comments: string[], posted: string[], save: () => void): void => {
  for (let i = posted.length; i < comments.length; i += 1) {
    posted.push(gh.commentOn(url, comments[i] ?? ''));
    save();
  }
};

export const fileIssues = (input: FilingInput): void => {
  const { report, facts, slug, filed, gh, save, progress } = input;
  // The ledger goes into the agent issue from the start, so an assess-only run can become a loop later without filing again.
  const ledger = initialLedger(report, facts, input.site);
  const view = (personUrl: string | null): LoopView => ({ ledger: { ...ledger, personUrl }, finder: report, passes: new Map() });
  // Render everything before touching GitHub, so a report that can't be rendered fails before anything is filed.
  const agentDraft = renderAgentIssue(view(null), { personUrl: null });
  renderPersonIssue(view(null), { agentUrl: `https://github.com/${slug}/issues/0` }, freshKept());
  const raw = renderRawComments(report, facts);

  gh.ensureLabel(slug);
  if (!filed.agentUrl) {
    filed.agentUrl = gh.createIssue({ slug, title: agentDraft.title, body: agentDraft.body, assignToMe: false });
    save();
    progress(`agent issue: ${filed.agentUrl}`);
  }
  postRemaining(gh, filed.agentUrl, agentDraft.comments.map((comment) => comment.body), filed.agentCommentUrls, save);

  const person = renderPersonIssue(view(null), { agentUrl: filed.agentUrl }, freshKept());
  if (!filed.personUrl) {
    filed.personUrl = gh.createIssue({ slug, title: person.title, body: person.body, assignToMe: true });
    save();
    progress(`person's issue (assigned to you): ${filed.personUrl}`);
  }
  postRemaining(gh, filed.personUrl, person.comments.map((comment) => comment.body), filed.personCommentUrls, save);

  if (!filed.agentLinked) {
    gh.editIssueBody(filed.agentUrl, renderAgentIssue(view(filed.personUrl), { personUrl: filed.personUrl }).body);
    filed.agentLinked = true;
    save();
    progress('cross-linked the two');
  }
  postRemaining(gh, filed.agentUrl, raw, filed.rawCommentUrls, save);
  progress("attached the finder's raw report, collapsed");
};

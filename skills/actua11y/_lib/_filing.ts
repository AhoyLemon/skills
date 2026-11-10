// The filing sequence, kept apart from gh so a test can drive it with a fake. Every step is recorded as it lands, so a rerun after a failure picks up exactly where it stopped instead of filing twice.
import { renderAgentIssue, renderPersonIssue, renderRawComments, type RunFacts } from './_render.ts';
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
  // Render everything before touching GitHub, so a report that can't be rendered fails before anything is filed.
  const agentDraft = renderAgentIssue(report, facts, { personUrl: null });
  renderPersonIssue(report, facts, { agentUrl: `https://github.com/${slug}/issues/0` });
  const raw = renderRawComments(report, facts);

  gh.ensureLabel(slug);
  if (!filed.agentUrl) {
    filed.agentUrl = gh.createIssue({ slug, title: agentDraft.title, body: agentDraft.body, assignToMe: false });
    save();
    progress(`agent issue: ${filed.agentUrl}`);
  }
  postRemaining(gh, filed.agentUrl, agentDraft.comments, filed.agentCommentUrls, save);

  const person = renderPersonIssue(report, facts, { agentUrl: filed.agentUrl });
  if (!filed.personUrl) {
    filed.personUrl = gh.createIssue({ slug, title: person.title, body: person.body, assignToMe: true });
    save();
    progress(`person's issue (assigned to you): ${filed.personUrl}`);
  }
  postRemaining(gh, filed.personUrl, person.comments, filed.personCommentUrls, save);

  if (!filed.agentLinked) {
    gh.editIssueBody(filed.agentUrl, renderAgentIssue(report, facts, { personUrl: filed.personUrl }).body);
    filed.agentLinked = true;
    save();
    progress('cross-linked the two');
  }
  postRemaining(gh, filed.agentUrl, raw, filed.rawCommentUrls, save);
  progress("attached the finder's raw report, collapsed");
};

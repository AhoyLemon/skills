// Every GitHub write actua11y makes goes through here, and only the orchestrator's runner makes them. A finder never touches GitHub.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { exec, execOrThrow } from './_exec.ts';

export const LABEL = 'actua11y';

interface RepoInfo {
  hasIssuesEnabled: boolean;
  nameWithOwner: string;
}

export const ghSignedIn = (): boolean => exec('gh', ['auth', 'status']).code === 0;

export const repoInfo = (slug: string): RepoInfo | null => {
  const result = exec('gh', ['repo', 'view', slug, '--json', 'hasIssuesEnabled,nameWithOwner']);
  return result.code === 0 ? (JSON.parse(result.stdout) as RepoInfo) : null;
};

const withBodyFile = <T>(body: string, use: (path: string) => T): T => {
  const dir = mkdtempSync(join(tmpdir(), 'actua11y-body-'));
  const path = join(dir, 'body.md');
  try {
    writeFileSync(path, body);
    return use(path);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

export const ensureLabel = (slug: string): void => {
  const existing = exec('gh', ['label', 'list', '--repo', slug, '--search', LABEL, '--json', 'name', '--jq', '.[].name']);
  if (existing.code === 0 && existing.stdout.split('\n').includes(LABEL)) return;
  execOrThrow('gh', ['label', 'create', LABEL, '--repo', slug, '--color', '6f42c1', '--description', 'Filed by actua11y, an accessibility audit for coding agents']);
};

export interface NewIssue {
  slug: string;
  title: string;
  body: string;
  assignToMe: boolean;
}

export const createIssue = (issue: NewIssue): string =>
  withBodyFile(issue.body, (path) => {
    const args = ['issue', 'create', '--repo', issue.slug, '--title', issue.title, '--body-file', path, '--label', LABEL];
    if (issue.assignToMe) args.push('--assignee', '@me');
    return execOrThrow('gh', args).split('\n').filter((line) => line.startsWith('https://')).at(-1) ?? '';
  });

export const editIssueBody = (url: string, body: string): void => {
  withBodyFile(body, (path) => execOrThrow('gh', ['issue', 'edit', url, '--body-file', path]));
};

export const commentOn = (url: string, body: string): string =>
  withBodyFile(body, (path) => execOrThrow('gh', ['issue', 'comment', url, '--body-file', path]).split('\n').filter((line) => line.startsWith('https://')).at(-1) ?? '');

export interface GhComment {
  url: string;
  body: string;
}

export interface GhIssue {
  url: string;
  number: number;
  state: string;
  body: string;
  comments: GhComment[];
}

export interface GhPr {
  url: string;
  number: number;
  state: string;
  isDraft: boolean;
  body: string;
  headSha: string;
  headRef: string;
  baseRef: string;
  comments: GhComment[];
}

interface RawComment {
  url?: string;
  body?: string;
}

const comments = (raw: unknown): GhComment[] => (Array.isArray(raw) ? (raw as RawComment[]).map((comment) => ({ url: comment.url ?? '', body: (comment.body ?? '').replace(/\r\n/g, '\n') })) : []);

// gh pages through every comment when the comments field is asked for, so a long thread still comes back whole.
export const readIssue = (url: string): GhIssue => {
  const raw = JSON.parse(execOrThrow('gh', ['issue', 'view', url, '--json', 'url,number,state,body,comments'])) as Record<string, unknown>;
  return { url: String(raw['url']), number: Number(raw['number']), state: String(raw['state']), body: String(raw['body'] ?? '').replace(/\r\n/g, '\n'), comments: comments(raw['comments']) };
};

export const readPr = (url: string): GhPr => {
  const raw = JSON.parse(execOrThrow('gh', ['pr', 'view', url, '--json', 'url,number,state,isDraft,body,headRefOid,headRefName,baseRefName,comments'])) as Record<string, unknown>;
  return { url: String(raw['url']), number: Number(raw['number']), state: String(raw['state']), isDraft: raw['isDraft'] === true, body: String(raw['body'] ?? '').replace(/\r\n/g, '\n'), headSha: String(raw['headRefOid']), headRef: String(raw['headRefName']), baseRef: String(raw['baseRefName']), comments: comments(raw['comments']) };
};

export const findOpenPr = (slug: string, head: string): string | null => {
  const result = execOrThrow('gh', ['pr', 'list', '--repo', slug, '--head', head, '--state', 'open', '--json', 'url', '--jq', '.[0].url // ""']);
  return result === '' ? null : result;
};

export const findAgentIssues = (slug: string): { url: string; title: string }[] => {
  const raw = JSON.parse(execOrThrow('gh', ['issue', 'list', '--repo', slug, '--label', LABEL, '--state', 'open', '--limit', '100', '--json', 'url,title,body'])) as { url: string; title: string; body: string }[];
  return raw.filter((issue) => issue.body.includes('<!-- actua11y:agent-issue v1')).map(({ url, title }) => ({ url, title }));
};

export interface NewPr {
  slug: string;
  base: string;
  head: string;
  title: string;
  body: string;
}

// Always a draft, so nothing can be merged by accident while the loop is still running.
export const createDraftPr = (pr: NewPr): string =>
  withBodyFile(pr.body, (path) => execOrThrow('gh', ['pr', 'create', '--repo', pr.slug, '--draft', '--base', pr.base, '--head', pr.head, '--title', pr.title, '--body-file', path]).split('\n').filter((line) => line.startsWith('https://')).at(-1) ?? '');

export const editPrBody = (url: string, body: string): void => {
  withBodyFile(body, (path) => execOrThrow('gh', ['pr', 'edit', url, '--body-file', path]));
};

export const commentOnPr = (url: string, body: string): string =>
  withBodyFile(body, (path) => execOrThrow('gh', ['pr', 'comment', url, '--body-file', path]).split('\n').filter((line) => line.startsWith('https://')).at(-1) ?? '');

const COMMENT_URL = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/\d+#issuecomment-(\d+)$/;

// Issue and PR comments share one endpoint, addressed by the id at the end of the comment's URL.
export const editComment = (url: string, body: string): void => {
  const match = url.match(COMMENT_URL);
  if (!match) throw new Error(`Can't edit ${url}: it isn't a GitHub comment URL`);
  withBodyFile(body, (path) => execOrThrow('gh', ['api', '--method', 'PATCH', `repos/${match[1]}/${match[2]}/issues/comments/${match[3]}`, '-F', `body=@${path}`]));
};

export const markReady = (url: string): void => {
  execOrThrow('gh', ['pr', 'ready', url]);
};

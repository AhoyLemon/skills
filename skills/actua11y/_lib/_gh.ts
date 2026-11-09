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

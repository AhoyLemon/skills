// An in-memory GitHub for the loop's tests: issues, one PR per branch, and comments, with a PR's head read from a real bare remote so it moves when the runner pushes.
import { execFileSync } from 'node:child_process';

import type { GhComment, GhIssue, GhPr, NewIssue, NewPr } from '../skills/actua11y/_lib/_gh.ts';
import type { LoopGh } from '../skills/actua11y/_lib/_loop.ts';

interface Thread {
  url: string;
  number: number;
  title: string;
  state: string;
  body: string;
  comments: GhComment[];
}

interface PullRequest extends Thread {
  isDraft: boolean;
  head: string;
  base: string;
}

export interface FakeGithub extends LoopGh {
  issues: Map<string, Thread>;
  prs: Map<string, PullRequest>;
  calls: string[];
  // Every body and comment on GitHub right now, for checks that look at all of it.
  everything: () => string[];
}

const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

export const fakeGithub = (slug: string, bareRemote: string): FakeGithub => {
  const issues = new Map<string, Thread>();
  const prs = new Map<string, PullRequest>();
  const calls: string[] = [];
  let numbers = 0;
  let commentIds = 0;
  const thread = (url: string): Thread => {
    const found = issues.get(url) ?? prs.get(url);
    if (!found) throw new Error(`no such thread ${url}`);
    return found;
  };
  const comment = (url: string, body: string): string => {
    const target = thread(url);
    commentIds += 1;
    const commentUrl = `${url}#issuecomment-${commentIds}`;
    target.comments.push({ url: commentUrl, body });
    return commentUrl;
  };
  const headOf = (branch: string): string => execFileSync('git', ['--git-dir', bareRemote, 'rev-parse', `refs/heads/${branch}`], { encoding: 'utf8' }).trim();
  return {
    issues,
    prs,
    calls,
    everything: () => [...issues.values(), ...prs.values()].flatMap((item) => [item.title, item.body, ...item.comments.map((entry) => entry.body)]),
    readIssue: (url): GhIssue => {
      const found = issues.get(url);
      if (!found) throw new Error(`no such issue ${url}`);
      return copy({ url: found.url, number: found.number, state: found.state, body: found.body, comments: found.comments });
    },
    readPr: (url): GhPr => {
      const found = prs.get(url);
      if (!found) throw new Error(`no such PR ${url}`);
      return copy({ url: found.url, number: found.number, state: found.state, isDraft: found.isDraft, body: found.body, headSha: headOf(found.head), headRef: found.head, baseRef: found.base, comments: found.comments });
    },
    findPr: (_slug, head) => [...prs.values()].find((pr) => pr.head === head && pr.state === 'OPEN')?.url ?? null,
    findAgentIssues: () => [...issues.values()].filter((issue) => issue.state === 'OPEN' && issue.body.includes('<!-- actua11y:agent-issue v1')).map(({ url, title }) => ({ url, title })),
    ensureLabel: () => {
      calls.push('label');
    },
    createIssue: (issue: NewIssue) => {
      numbers += 1;
      const url = `https://github.com/${slug}/issues/${numbers}`;
      issues.set(url, { url, number: numbers, title: issue.title, state: 'OPEN', body: issue.body, comments: [] });
      calls.push(`create issue ${numbers}`);
      return url;
    },
    editIssueBody: (url, body) => {
      thread(url).body = body;
      calls.push(`edit ${url.split('/').at(-1)}`);
    },
    commentOn: (url, body) => {
      calls.push(`comment on ${url.split('/').at(-1)}`);
      return comment(url, body);
    },
    editComment: (url, body) => {
      const found = [...issues.values(), ...prs.values()].flatMap((item) => item.comments).find((entry) => entry.url === url);
      if (!found) throw new Error(`no such comment ${url}`);
      found.body = body;
      calls.push('edit comment');
    },
    createDraftPr: (pr: NewPr) => {
      numbers += 1;
      const url = `https://github.com/${slug}/pull/${numbers}`;
      prs.set(url, { url, number: numbers, title: pr.title, state: 'OPEN', body: pr.body, comments: [], isDraft: true, head: pr.head, base: pr.base });
      calls.push(`create draft PR ${numbers}`);
      return url;
    },
    editPrBody: (url, body) => {
      thread(url).body = body;
      calls.push('edit PR body');
    },
    commentOnPr: (url, body) => {
      calls.push('comment on PR');
      return comment(url, body);
    },
    markReady: (url) => {
      const pr = prs.get(url);
      if (pr) pr.isDraft = false;
      calls.push('ready');
    },
  };
};

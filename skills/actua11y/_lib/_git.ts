// Read-only git questions the preflight and the stray check ask about the target repository.
import { basename } from 'node:path';

import { exec, execOrThrow } from './_exec.ts';

export interface RepoSlug {
  owner: string;
  name: string;
}

export interface TreeState {
  head: string;
  branch: string;
  status: string[];
  ignored: string[];
}

const git = (cwd: string, args: string[]): string => execOrThrow('git', args, { cwd });

export const repoRoot = (cwd: string): string | null => {
  const result = exec('git', ['rev-parse', '--show-toplevel'], { cwd });
  return result.code === 0 ? result.stdout.trim() : null;
};

export const headCommit = (root: string): string => git(root, ['rev-parse', 'HEAD']);

export const currentBranch = (root: string): string => git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);

const isNoise = (path: string): boolean => basename(path.replace(/\/$/, '')) === '.DS_Store';

// Porcelain with -z: NUL-separated and never quoted, so paths with spaces or non-ASCII characters survive. A rename or copy carries its source path as an extra field.
const statusEntries = (root: string, args: string[]): string[] => {
  const result = exec('git', ['status', '--porcelain', '-z', ...args], { cwd: root });
  if (result.code !== 0) throw new Error(`git status failed: ${result.stderr.trim()}`);
  const fields = result.stdout.split('\0');
  const entries: string[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i] ?? '';
    if (field === '') continue;
    entries.push(field);
    if (field.startsWith('R') || field.startsWith('C')) i += 1;
  }
  return entries.filter((entry) => !isNoise(entry.slice(3)));
};

export const porcelain = (root: string): string[] => statusEntries(root, []);

// Gitignored entries inside the given paths, with ignored folders collapsed to one line the way git reports them.
export const ignoredIn = (root: string, paths: string[]): string[] =>
  statusEntries(root, ['--ignored', '--untracked-files=normal', '--', ...paths])
    .filter((entry) => entry.startsWith('!! '))
    .map((entry) => entry.slice(3));

export const trackedFiles = (root: string): Set<string> => new Set(git(root, ['ls-files', '-z']).split('\0').filter((path) => path !== ''));

// Tracked and untracked files are listed in full. Ignored folders stay collapsed, so a dev server rewriting its cache inside one doesn't look like the finder changed the app.
export const treeState = (root: string): TreeState => ({
  head: headCommit(root),
  branch: currentBranch(root),
  status: statusEntries(root, ['--untracked-files=all']),
  ignored: ignoredIn(root, ['.']),
});

const under = (path: string, allowed: string[]): boolean => {
  const clean = path.replace(/\/$/, '');
  return allowed.some((entry) => clean === entry || clean.startsWith(`${entry}/`));
};

export interface TreeChanges {
  tree: string[];
  ignored: string[];
}

// Changes to tracked or untracked files mean the run wrote to the app, which is never acceptable. New gitignored paths outside the acknowledged ones are reported separately, since a dev server can create those too.
export const treeChanges = (before: TreeState, after: TreeState, allowedIgnored: string[] = []): TreeChanges => {
  const tree: string[] = [];
  if (before.head !== after.head) tree.push(`HEAD moved from ${before.head.slice(0, 12)} to ${after.head.slice(0, 12)}`);
  if (before.branch !== after.branch) tree.push(`the branch changed from ${before.branch} to ${after.branch}`);
  const was = new Set(before.status);
  for (const line of after.status) if (!was.has(line)) tree.push(`new or changed: ${line}`);
  const now = new Set(after.status);
  for (const line of before.status) if (!now.has(line)) tree.push(`gone or changed: ${line}`);
  const wasIgnored = new Set(before.ignored);
  const nowIgnored = new Set(after.ignored);
  const ignored = [...after.ignored.filter((path) => !wasIgnored.has(path)), ...before.ignored.filter((path) => !nowIgnored.has(path))].filter((path) => !under(path, allowedIgnored));
  return { tree, ignored };
};

export interface UpstreamState {
  upstream: string | null;
  ahead: number;
  behind: number;
  fetchError: string | null;
}

export const upstreamState = (root: string): UpstreamState => {
  const upstream = exec('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { cwd: root });
  if (upstream.code !== 0) return { upstream: null, ahead: 0, behind: 0, fetchError: null };
  const name = upstream.stdout.trim();
  const [remote, ...branchParts] = name.split('/');
  const fetched = exec('git', ['fetch', '--quiet', remote ?? 'origin', branchParts.join('/')], { cwd: root });
  const counts = exec('git', ['rev-list', '--left-right', '--count', `HEAD...@{u}`], { cwd: root }).stdout.trim().split(/\s+/).map(Number);
  return { upstream: name, ahead: counts[0] ?? 0, behind: counts[1] ?? 0, fetchError: fetched.code === 0 ? null : fetched.stderr.trim() };
};

export const parseGithubSlug = (url: string): RepoSlug | null => {
  const match = url.trim().match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
  return match?.[1] && match[2] ? { owner: match[1], name: match[2] } : null;
};

export const originSlug = (root: string): RepoSlug | null => {
  const remote = exec('git', ['remote', 'get-url', 'origin'], { cwd: root });
  return remote.code === 0 ? parseGithubSlug(remote.stdout) : null;
};

export const slugText = (slug: RepoSlug): string => `${slug.owner}/${slug.name}`;

// ---- The few writes the loop makes, all on the loop's own branch. Only the orchestrator's runner makes them, never a role. ----

export const branchExists = (root: string, branch: string): boolean => exec('git', ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { cwd: root }).code === 0;

export const createBranch = (root: string, branch: string, at: string): void => {
  git(root, ['switch', '--quiet', '-c', branch, at]);
};

export const switchBranch = (root: string, branch: string): void => {
  git(root, ['switch', '--quiet', branch]);
};

export const pushBranch = (root: string, branch: string): void => {
  git(root, ['push', '--quiet', '-u', 'origin', branch]);
};

export const isAncestor = (root: string, ancestor: string, of: string): boolean => exec('git', ['merge-base', '--is-ancestor', ancestor, of], { cwd: root }).code === 0;

// Full shas in base..head, oldest first.
export const commitsBetween = (root: string, base: string, head: string): string[] => git(root, ['rev-list', '--reverse', `${base}..${head}`]).split('\n').filter((sha) => sha !== '');

export const commitSubject = (root: string, sha: string): string => git(root, ['log', '-1', '--format=%s', sha]);

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
}

const git = (cwd: string, args: string[]): string => execOrThrow('git', args, { cwd });

export const repoRoot = (cwd: string): string | null => {
  const result = exec('git', ['rev-parse', '--show-toplevel'], { cwd });
  return result.code === 0 ? result.stdout.trim() : null;
};

export const headCommit = (root: string): string => git(root, ['rev-parse', 'HEAD']);

export const currentBranch = (root: string): string => git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);

export const porcelain = (root: string): string[] => git(root, ['status', '--porcelain']).split('\n').filter((line) => line !== '');

const isNoise = (path: string): boolean => basename(path.replace(/\/$/, '')) === '.DS_Store';

// Gitignored entries inside the given paths, collapsed to directories the way git reports them.
export const ignoredIn = (root: string, paths: string[]): string[] =>
  git(root, ['status', '--porcelain', '--ignored', '--', ...paths])
    .split('\n')
    .filter((line) => line.startsWith('!! '))
    .map((line) => line.slice(3))
    .filter((path) => !isNoise(path));

// Everything git can see, ignored files included, for the before-and-after stray check.
export const treeState = (root: string): TreeState => ({
  head: headCommit(root),
  branch: currentBranch(root),
  status: git(root, ['status', '--porcelain', '--ignored', '--untracked-files=all'])
    .split('\n')
    .filter((line) => line !== '' && !isNoise(line.slice(3))),
});

export const treeChanges = (before: TreeState, after: TreeState): string[] => {
  const changes: string[] = [];
  if (before.head !== after.head) changes.push(`HEAD moved from ${before.head.slice(0, 12)} to ${after.head.slice(0, 12)}`);
  if (before.branch !== after.branch) changes.push(`the branch changed from ${before.branch} to ${after.branch}`);
  const was = new Set(before.status);
  for (const line of after.status) if (!was.has(line)) changes.push(`new or changed: ${line}`);
  const now = new Set(after.status);
  for (const line of before.status) if (!now.has(line)) changes.push(`gone or changed: ${line}`);
  return changes;
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

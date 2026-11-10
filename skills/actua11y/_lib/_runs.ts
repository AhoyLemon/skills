// Where a run's local record lives between commands. GitHub holds the record people read. This folder holds what's too big or too private to post, transcripts included.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';

import type { Usage } from './_backend.ts';
import type { Level } from './_criteria.ts';
import type { RepoSlug } from './_git.ts';

export const reportHash = (text: string): string => createHash('sha256').update(text).digest('hex');

export interface DryRunRecord {
  at: string;
  backend: string;
  model: string;
  effort: string;
  clean: boolean;
  problems: string[];
  answer: string;
  usage: Usage;
  transcriptPath: string;
}

export interface FinderRecord {
  sessionId: string;
  attempts: number;
  usage: Usage;
  transcriptPath: string;
  errors: string[];
  permissionDenials: number;
  strays: string[];
  ignoredStrays: string[];
  valid: boolean;
  reportSha256: string | null;
}

export interface RunMeta {
  runId: string;
  createdAt: string;
  finishedAt: string | null;
  repoRoot: string;
  repo: RepoSlug;
  commit: string;
  branch: string;
  level: Level;
  scope: string[];
  baseUrl: string;
  pages: string[];
  browser: { channel: string; version: string } | null;
  axe: { version: string; tags: string[] } | null;
  backend: string;
  model: string;
  effort: string;
  maxTurns: number;
  maxBudgetUsd: number;
  dryRun: DryRunRecord | null;
  finder: FinderRecord | null;
}

export interface FiledRecord {
  agentUrl: string | null;
  agentCommentUrls: string[];
  personUrl: string | null;
  personCommentUrls: string[];
  agentLinked: boolean;
  rawCommentUrls: string[];
}

export const stateRoot = (): string => join(process.env['XDG_STATE_HOME'] ?? join(homedir(), '.local', 'state'), 'actua11y', 'runs');

const repoDir = (repo: RepoSlug): string => join(stateRoot(), `${repo.owner}__${repo.name}`);

export const runDir = (repo: RepoSlug, runId: string): string => join(repoDir(repo), runId);

export const newRunId = (now = new Date()): string => `${now.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}-${randomBytes(2).toString('hex')}`;

export const writeJson = (path: string, value: unknown): void => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
};

export const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

export const findRunDir = (runId: string): string | null => {
  const root = stateRoot();
  if (!existsSync(root)) return null;
  for (const repo of readdirSync(root)) {
    const candidate = join(root, repo, runId);
    if (existsSync(join(candidate, 'meta.json'))) return candidate;
  }
  return null;
};

export const dryRunsDir = (repo: RepoSlug): string => join(repoDir(repo), 'dry-runs');

export const saveDryRun = (repo: RepoSlug, record: DryRunRecord): string => {
  const path = join(dryRunsDir(repo), `${record.at.replace(/[-:.]/g, '')}.json`);
  writeJson(path, record);
  return path;
};

export const latestDryRun = (repo: RepoSlug): DryRunRecord | null => {
  const dir = dryRunsDir(repo);
  if (!existsSync(dir)) return null;
  const latest = readdirSync(dir).filter((file) => file.endsWith('.json')).sort().at(-1);
  return latest ? readJson<DryRunRecord>(join(dir, latest)) : null;
};

export const emptyFiled = (): FiledRecord => ({ agentUrl: null, agentCommentUrls: [], personUrl: null, personCommentUrls: [], agentLinked: false, rawCommentUrls: [] });

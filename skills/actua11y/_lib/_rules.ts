// What a role may not touch, worked out from what's on disk rather than typed by hand, and the same list in words for the brief so the rules and the brief can't drift apart.
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import type { DenyCategory, RoleSpec } from './_backend.ts';

export const ALL_DENIES: DenyCategory[] = ['git', 'github', 'web', 'subagents', 'installs'];

const SENSITIVE_HOME = ['.claude', '.agents', '.codex', '.config/gh', '.ssh', '.aws', '.gnupg', '.npmrc', '.netrc', '.docker', '.kube'];

export interface OffLimitsInput {
  repoRoot: string;
  runsRoot: string;
  scratch: string | null;
  ignoredInRepo: string[];
}

const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
};

export const computeOffLimits = (input: OffLimitsInput): string[] => {
  const paths = new Set<string>();
  // Directories end in a slash, so a backend can tell them apart without touching the disk again.
  const scratch = input.scratch ? real(input.scratch) : null;
  // Never bar the run from its own scratch folder, even when the temp directory sits next to the repository.
  const holdsScratch = (path: string): boolean => scratch !== null && (scratch === path || scratch.startsWith(`${path}/`));
  const add = (path: string): void => {
    if (!existsSync(path)) return;
    const resolved = real(path);
    if (holdsScratch(resolved)) return;
    paths.add(statSync(path).isDirectory() ? `${resolved}/` : resolved);
  };
  add(join(input.repoRoot, '.git'));
  for (const entry of input.ignoredInRepo) add(join(input.repoRoot, entry.replace(/\/$/, '')));
  const parent = dirname(input.repoRoot);
  for (const sibling of readdirSync(parent)) if (sibling !== basename(input.repoRoot)) add(join(parent, sibling));
  add(input.runsRoot);
  const temp = real(tmpdir());
  const ownScratch = input.scratch ? basename(input.scratch) : null;
  for (const entry of readdirSync(temp)) if (entry.startsWith('actua11y-') && entry !== ownScratch) add(join(temp, entry));
  for (const entry of SENSITIVE_HOME) add(join(homedir(), entry));
  return [...paths].sort();
};

const DENY_WORDS: Record<DenyCategory, string> = {
  git: 'No git commands at all: no history, no log, show, blame or diff, and no commits. Read the working tree with your file tools.',
  github: "No gh and no GitHub API. You file nothing, and you don't read issues or pull requests.",
  web: 'No web search and no web fetch. Everything you judge comes from the repository and the running pages.',
  subagents: 'No subagents. Do the work yourself, in this session.',
  installs: 'No installs (npm, npx, pnpm, yarn, bun, pip, brew). Everything you need is already installed in your scratch folder.',
};

export const rulesInWords = (spec: RoleSpec): string[] => {
  const rules: string[] = [];
  if (spec.readOnly) rules.push(`Don't change, create or delete anything in the repository (${spec.cwd}). Your scratch folder is the only place you may write.`);
  for (const category of spec.deny) rules.push(DENY_WORDS[category]);
  if (spec.scratch) rules.push(`Your scratch folder is ${spec.scratch}, made fresh for this run and deleted afterwards. Other runs have used this machine, so don't open any other folder in the temp directory.`);
  // The brief says this in general terms on purpose. Listing every blocked path would hand the session the names of the user's other projects.
  if (spec.offLimits.length > 0) rules.push("Read nothing outside the repository and your scratch folder. The repository's .git folder and its gitignored files are off-limits too. Specific paths are blocked by rule, so if a read is denied, leave it alone and don't look for a way round it.");
  rules.push("Don't leave anything running in the background when you finish.");
  return rules;
};

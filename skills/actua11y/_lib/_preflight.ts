// Everything that has to be true before a run starts. Any failure refuses the run: a half-isolated audit is worse than none.
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { failLine, heading, hintLine, okLine, warnLine } from './_ansi.ts';
import type { Backend, BackendCheck } from './_backend.ts';
import { ghSignedIn, repoInfo } from './_gh.ts';
import { ignoredIn, originSlug, porcelain, repoRoot, slugText, upstreamState } from './_git.ts';
import { installKit, makeScratch, probeBrowser, removeDir, type Probe } from './_scratch.ts';

export interface Check extends BackendCheck {
  group: string;
}

export interface PreflightInput {
  cwd: string;
  scope: string[];
  allowIgnored: string[];
  url: string | null;
  serve: string | null;
  backend: Backend;
  github: boolean;
  browser: boolean;
}

export interface PreflightResult {
  checks: Check[];
  ok: boolean;
  root: string | null;
  probe: Probe | null;
}

export const MIN_NODE = [22, 18] as const;

export const nodeIsNewEnough = (version: string): boolean => {
  const [major = 0, minor = 0] = version.replace(/^v/, '').split('.').map(Number);
  return major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
};

const check = (group: string, name: string, status: Check['status'], detail: string, hint?: string): Check => (hint ? { group, name, status, detail, hint } : { group, name, status, detail });

const localChecks = (input: PreflightInput, root: string): Check[] => {
  const checks: Check[] = [];
  const dirty = porcelain(root);
  if (dirty.length === 0) checks.push(check('Repository', 'Clean tree', 'ok', 'nothing uncommitted or untracked'));
  else {
    const skillInstall = dirty.some((line) => /(\.agents|\.claude)\/skills/.test(line));
    checks.push(check('Repository', 'Clean tree', 'fail', `${dirty.length} uncommitted or untracked path(s): ${dirty.slice(0, 5).map((line) => line.slice(3)).join(', ')}${dirty.length > 5 ? ', ...' : ''}`, skillInstall ? 'A project install of a skill shows up here. Install actua11y globally instead (npx skills add ahoylemon/skills -g), then remove the project copy.' : 'Commit, stash or remove them. The finder reads the working tree, and its links point at a pushed commit.'));
  }

  const upstream = upstreamState(root);
  if (!upstream.upstream) checks.push(check('Repository', 'Matches its remote', 'fail', 'this branch has no upstream', 'Push it with `git push -u origin <branch>`, so the issues can link to the exact commit.'));
  else if (upstream.fetchError) checks.push(check('Repository', 'Matches its remote', 'fail', `couldn't fetch ${upstream.upstream}: ${upstream.fetchError}`));
  else if (upstream.ahead > 0 || upstream.behind > 0) checks.push(check('Repository', 'Matches its remote', 'fail', `${upstream.ahead} ahead and ${upstream.behind} behind ${upstream.upstream}`, 'Push or pull until they match.'));
  else checks.push(check('Repository', 'Matches its remote', 'ok', `level with ${upstream.upstream}`));

  const missing = input.scope.filter((path) => !existsSync(join(root, path)));
  checks.push(missing.length > 0 ? check('Repository', 'Scope exists', 'fail', `not found: ${missing.join(', ')}`) : check('Repository', 'Scope exists', 'ok', input.scope.join(', ')));

  const ignored = missing.length > 0 ? [] : ignoredIn(root, input.scope);
  const allowed = new Set(input.allowIgnored);
  const strays = ignored.filter((path) => !allowed.has(path.replace(/\/$/, '')));
  if (strays.length > 0) checks.push(check('Repository', 'No gitignored strays in scope', 'fail', `found ${strays.join(', ')}`, `A stray (a node_modules, a stray package.json, a previous run's output) can feed the finder things that aren't the app. Remove it, or pass --allow-ignored ${strays[0]?.replace(/\/$/, '')} if it belongs there, and the finder will be barred from reading it.`));
  else checks.push(check('Repository', 'No gitignored strays in scope', 'ok', ignored.length > 0 ? `acknowledged and off-limits to the finder: ${ignored.join(', ')}` : 'none'));
  return checks;
};

const githubChecks = (root: string): Check[] => {
  const slug = originSlug(root);
  if (!slug) return [check('GitHub', 'Origin is on GitHub', 'fail', "origin isn't a GitHub repository", 'actua11y files its findings as GitHub issues.')];
  const checks = [check('GitHub', 'Origin is on GitHub', 'ok', slugText(slug))];
  if (!ghSignedIn()) return [...checks, check('GitHub', 'gh signed in', 'fail', '`gh auth status` failed', 'Run `gh auth login`.')];
  checks.push(check('GitHub', 'gh signed in', 'ok', 'yes'));
  const info = repoInfo(slugText(slug));
  if (!info) checks.push(check('GitHub', 'Issues are on', 'fail', `couldn't read ${slugText(slug)} with gh`));
  else checks.push(info.hasIssuesEnabled ? check('GitHub', 'Issues are on', 'ok', info.nameWithOwner) : check('GitHub', 'Issues are on', 'fail', `${info.nameWithOwner} has issues turned off`, 'Turn them on in the repository settings.'));
  return checks;
};

const targetCheck = async (input: PreflightInput, root: string): Promise<Check> => {
  if (input.serve) {
    const dir = join(root, input.serve);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return check('Target', 'Folder to serve', 'fail', `${input.serve} isn't a folder in the repository`);
    return existsSync(join(dir, 'index.html')) ? check('Target', 'Folder to serve', 'ok', `${input.serve} (served on localhost for the run)`) : check('Target', 'Folder to serve', 'warn', `${input.serve} has no index.html, so name pages with --page`);
  }
  if (!input.url) return check('Target', 'Site to audit', 'fail', 'no --url or --serve', 'Start the dev server and pass its --url, or pass --serve <folder> for a static site.');
  try {
    const response = await fetch(input.url, { redirect: 'follow' });
    return response.ok ? check('Target', 'Site to audit', 'ok', `${input.url} answered ${response.status}`) : check('Target', 'Site to audit', 'fail', `${input.url} answered ${response.status}`);
  } catch (error) {
    return check('Target', 'Site to audit', 'fail', `${input.url} didn't answer: ${error instanceof Error ? error.message : String(error)}`, 'Start the dev server first.');
  }
};

const browserCheck = (): { check: Check; probe: Probe | null } => {
  const dir = makeScratch('preflight');
  try {
    const kit = installKit(dir);
    if (!kit.ok) return { check: check('Browser', 'Browser kit', 'fail', `couldn't install ${kit.detail}`, 'The kit installs with npm into a temp folder. Check your network and npm.'), probe: null };
    const probe = probeBrowser(dir);
    if (!probe.ok) return { check: check('Browser', 'A browser to drive', 'fail', probe.detail, 'Install Chrome or Edge. Only if neither is possible, run `npx playwright install chromium` once (it downloads a browser, so ask first).'), probe: null };
    return { check: check('Browser', 'A browser to drive', 'ok', `${probe.channel} ${probe.version}, axe-core ${probe.axeVersion}`), probe };
  } finally {
    removeDir(dir);
  }
};

export const runPreflight = async (input: PreflightInput): Promise<PreflightResult> => {
  const checks: Check[] = [];
  checks.push(nodeIsNewEnough(process.version) ? check('Runtime', 'Node', 'ok', process.version) : check('Runtime', 'Node', 'fail', `${process.version} is older than 22.18`, 'actua11y runs TypeScript directly, which needs Node 22.18 or later.'));
  const root = repoRoot(input.cwd);
  if (!root) {
    checks.push(check('Repository', 'A git repository', 'fail', `${input.cwd} isn't inside one`));
    return { checks, ok: false, root: null, probe: null };
  }
  checks.push(...localChecks(input, root));
  checks.push(...input.backend.preflight(root).map((item) => ({ ...item, group: 'Agent' })));
  if (input.github) checks.push(...githubChecks(root));
  if (input.url || input.serve) checks.push(await targetCheck(input, root));
  let probe: Probe | null = null;
  if (input.browser) {
    const result = browserCheck();
    checks.push(result.check);
    probe = result.probe;
  }
  return { checks, ok: checks.every((item) => item.status !== 'fail'), root, probe };
};

export const printChecks = (checks: Check[]): void => {
  let group = '';
  for (const item of checks) {
    if (item.group !== group) {
      group = item.group;
      heading(group);
    }
    const line = `${item.name}: ${item.detail}`;
    if (item.status === 'ok') okLine(line);
    else if (item.status === 'warn') warnLine(line);
    else failLine(line);
    if (item.hint && item.status !== 'ok') hintLine(item.hint);
  }
};

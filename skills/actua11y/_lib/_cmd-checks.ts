// The two commands that run before any real work: the preflight, and the dry run that proves a fresh session loads nothing beyond its brief.
import { basename, join } from 'node:path';

import { bold, dim, failLine, heading, hintLine, okLine, out } from './_ansi.ts';
import type { Options } from './_args.ts';
import type { Backend, RoleSpec } from './_backend.ts';
import { banner } from './_banner.ts';
import { readBrief } from './_brief.ts';
import { originSlug, repoRoot, type RepoSlug } from './_git.ts';
import { printChecks, runPreflight } from './_preflight.ts';
import { formatUsage } from './_render.ts';
import { ALL_DENIES, computeOffLimits } from './_rules.ts';
import { dryRunsDir, saveDryRun, stateRoot } from './_runs.ts';

export const repoSlugFor = (root: string): RepoSlug => originSlug(root) ?? { owner: 'local', name: basename(root) };

export const cmdPreflight = async (options: Options, backend: Backend): Promise<number> => {
  banner(options.level);
  const result = await runPreflight({ cwd: options.cwd, scope: options.scope, allowIgnored: options.allowIgnored, url: options.url, serve: options.serve, backend, github: true, browser: true });
  printChecks(result.checks);
  out();
  out(result.ok ? bold('Preflight: ready.') : bold('Preflight: not ready. Fix every ✗ above, then run it again.'));
  return result.ok ? 0 : 1;
};

export const cmdDryRun = async (options: Options, backend: Backend): Promise<number> => {
  banner(options.level);
  const root = repoRoot(options.cwd);
  if (!root) throw new Error(`${options.cwd} isn't inside a git repository`);
  const repo = repoSlugFor(root);
  const at = new Date().toISOString();
  const spec: RoleSpec = {
    role: 'dry-run',
    brief: readBrief('dry-run'),
    cwd: root,
    scratch: null,
    readOnly: true,
    noTools: true,
    deny: ALL_DENIES,
    offLimits: computeOffLimits({ repoRoot: root, runsRoot: stateRoot(), scratch: null, ignoredInRepo: [] }),
    model: options.model,
    effort: options.effort,
    maxTurns: 2,
    maxBudgetUsd: 1,
    timeoutMs: 3 * 60_000,
    transcriptPath: join(dryRunsDir(repo), `${at.replace(/[-:.]/g, '')}.jsonl`),
  };
  out(dim(`Starting a fresh ${backend.name} session with no tools, isolated the same way the finder will be...`));
  const session = await backend.start(spec);
  const problems = session.init ? session.errors : ['The session sent no init event, so there is no way to confirm what it loaded', ...session.errors];
  heading('What the session reports loading');
  if (session.init) {
    const init = session.init;
    out(`  model ${init.model}, ${backend.name} ${init.version}, permission mode ${init.permissionMode}`);
    out(`  tools: ${init.tools.length > 0 ? init.tools.join(', ') : 'none'}`);
    out(`  MCP servers: ${init.mcpServers.length > 0 ? init.mcpServers.join(', ') : 'none'}`);
    out(`  skills: ${init.skills.length > 0 ? init.skills.join(', ') : 'none'}`);
    out(`  plugins: ${init.plugins.length > 0 ? init.plugins.join(', ') : 'none'}`);
  }
  heading('Mechanical check');
  if (problems.length === 0) okLine('nothing loaded beyond what actua11y expects');
  for (const problem of problems) failLine(problem);
  const answer = session.finalTexts.at(-1)?.trim() ?? '';
  heading('What the session says, in its own words');
  out(answer === '' ? '  (no answer)' : answer.split('\n').map((line) => `  ${line}`).join('\n'));
  hintLine('Compare that with what you expect: no instruction files, memory, skills, plugins, MCP servers or hooks, and nothing about the repository beyond its path. If it names anything else, stop.');
  out();
  out(`Cost: ${formatUsage(session.usage)}. Transcript: ${spec.transcriptPath}`);
  saveDryRun(repo, { at, backend: backend.name, model: options.model, clean: problems.length === 0, problems, answer, usage: session.usage, transcriptPath: spec.transcriptPath });
  return problems.length === 0 ? 0 : 1;
};

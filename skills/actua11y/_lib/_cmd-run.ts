// Starts the finder: a fresh, read-only session with the brief filled from the shipped table and a scratch folder holding the browser kit.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { bold, dim, failLine, heading, hintLine, okLine, out } from './_ansi.ts';
import type { Options } from './_args.ts';
import type { Backend, RoleSpec } from './_backend.ts';
import { fillTemplate, readBrief } from './_brief.ts';
import { banner } from './_copy.ts';
import { axeTagsFor, criteriaAt, levelLabel, type Level } from './_criteria.ts';
import { repoSlugFor } from './_cmd-checks.ts';
import { currentBranch, headCommit, ignoredIn, trackedFiles, treeState } from './_git.ts';
import { printChecks, runPreflight } from './_preflight.ts';
import { formatUsage, plural } from './_render.ts';
import { REPORT_SHAPE, tallyOf, validateReport, type ValidationContext } from './_report.ts';
import { rulesInWords } from './_rules.ts';
import { latestDryRun, newRunId, reportHash, runDir, writeJson, type DryRunRecord, type RunMeta } from './_runs.ts';
import { onExit } from './_exec.ts';
import { installKit, makeScratch, probeBrowser, removeDir } from './_scratch.ts';
import { serveStatic, type StaticServer } from './_serve.ts';
import { aftermath, auditSpec, nextLine, printAftermath, runRole, strayLines } from './_session.ts';

const DRY_RUN_MAX_AGE_MS = 6 * 60 * 60 * 1000;

interface BriefInput {
  level: Level;
  scope: string[];
  repoRoot: string;
  baseUrl: string;
  pages: string[];
  scratch: string;
  browser: string;
  channel: string;
  spec: RoleSpec;
}

const tableCell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

export const criteriaTableFor = (level: Level): string =>
  ['| Criterion | Level | What it asks |', '|---|---|---|', ...criteriaAt(level).map((c) => `| ${c.num} ${tableCell(c.name)} | ${c.level} | ${tableCell([c.title, ...c.details].join(' '))} |`)].join('\n');

export const finderBrief = (input: BriefInput): string =>
  fillTemplate(readBrief('finder'), {
    LEVEL_LABEL: levelLabel(input.level),
    CRITERIA_COUNT: String(criteriaAt(input.level).length),
    REPO_ROOT: input.repoRoot,
    SCOPE: input.scope.map((path) => `\`${path}\``).join(', '),
    BASE_URL: input.baseUrl,
    PAGES: input.pages.length > 0 ? input.pages.map((page) => `\`${page}\``).join(', ') : 'not named, so find every page in scope yourself, starting from the base URL',
    SCRATCH: input.scratch,
    AXE_TAGS: axeTagsFor(input.level).join(','),
    BROWSER: input.browser,
    CHANNEL: input.channel,
    RULES: rulesInWords(input.spec).map((rule) => `- ${rule}`).join('\n'),
    REPORT_SCHEMA: REPORT_SHAPE,
    CRITERIA_TABLE: criteriaTableFor(input.level),
    CAPS: `${input.spec.maxTurns} turns, $${input.spec.maxBudgetUsd} and ${Math.round(input.spec.timeoutMs / 60_000)} minutes`,
  });

interface DryRunWanted {
  backend: string;
  model: string;
  effort: string;
}

// A role only starts after a clean dry run with the same backend, model and effort, recent enough that nothing about the setup has had time to change.
export const dryRunIsFresh = (dry: DryRunRecord | null, wanted: DryRunWanted, now: number): boolean =>
  dry !== null && dry.clean && dry.backend === wanted.backend && dry.model === wanted.model && dry.effort === wanted.effort && now - Date.parse(dry.at) < DRY_RUN_MAX_AGE_MS;

export const requireLevel = (options: Options): Level => {
  if (!options.level) throw new Error('Pass --level A, AA or AAA. Ask the user if the project names no standard.');
  return options.level;
};

export const finderSpec = (options: Options, root: string, scratch: string | null, transcriptPath: string, ignored: string[], agentPaths: string[]): RoleSpec =>
  auditSpec({ role: 'finder', root, scratch, transcriptPath, ignored, agentPaths, model: options.model, effort: options.effort, maxTurns: options.maxTurns, maxBudgetUsd: options.maxBudgetUsd, timeoutMs: options.timeoutMinutes * 60_000 });

export const cmdBrief = (options: Options, backend: Backend): number => {
  if (options.subject !== 'finder') throw new Error('Pass `brief finder`, `brief fixer --issue <n>` or `brief certifier --issue <n>`');
  const level = requireLevel(options);
  const root = options.cwd;
  const scratch = '<a fresh scratch folder per run>';
  const spec = finderSpec(options, root, null, '', [], backend.offLimits(root));
  spec.scratch = scratch;
  out(finderBrief({ level, scope: options.scope, repoRoot: root, baseUrl: options.url ?? '<served for the run>', pages: options.pages, scratch, browser: '<your installed Chrome or Edge>', channel: 'chrome', spec }));
  return 0;
};

// Refuses to start without a clean, recent dry run for this backend, model and effort.
export const requireDryRun = (repo: { owner: string; name: string }, options: Options, backend: Backend): DryRunRecord | null => {
  const dry = latestDryRun(repo);
  if (dryRunIsFresh(dry, { backend: backend.name, model: options.model, effort: options.effort }, Date.now())) return dry;
  failLine(`No clean dry run for ${repo.owner}/${repo.name} with ${options.model} at effort ${options.effort} in the last six hours.`);
  hintLine('Run `node runner.ts dry-run` first, with the same --model and --effort, and read what the session says it loaded.');
  return null;
};

export interface Prepared {
  scratch: string;
  server: StaticServer | null;
  baseUrl: string;
  browser: { channel: string; version: string; axeVersion: string };
  cleanup: () => Promise<void>;
}

// A fresh scratch folder with the browser kit, and the static server when the site is a folder. The caller always runs cleanup.
export const prepareRun = async (runId: string, root: string, site: { url: string | null; serve: string | null }): Promise<Prepared> => {
  const scratch = makeScratch(runId);
  const cleanScratch = onExit(() => removeDir(scratch));
  let server: StaticServer | null = null;
  const cleanup = async (): Promise<void> => {
    await server?.close();
    cleanScratch();
  };
  try {
    heading('Preparing');
    const kit = installKit(scratch);
    if (!kit.ok) throw new Error(`Couldn't install the browser kit: ${kit.detail}`);
    const probe = probeBrowser(scratch);
    if (!probe.ok) throw new Error(`No browser to drive: ${probe.detail}`);
    okLine(`browser kit installed in a fresh scratch folder, driving ${probe.channel} ${probe.version}`);
    if (site.serve) {
      server = await serveStatic(join(root, site.serve));
      okLine(`serving ${site.serve} at ${server.url} for this run`);
    }
    return { scratch, server, baseUrl: server?.url ?? site.url ?? '', browser: { channel: probe.channel, version: probe.version, axeVersion: probe.axeVersion }, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
};

export const cmdRunFinder = async (options: Options, backend: Backend): Promise<number> => {
  if (options.subject !== 'finder') throw new Error('Pass `run finder`, or `run certifier --issue <n>`');
  const level = requireLevel(options);
  banner(level);
  if (!options.url && !options.serve) throw new Error('Pass --url <the running site> or --serve <folder> for a static site');

  const pre = await runPreflight({ cwd: options.cwd, scope: options.scope, allowIgnored: options.allowIgnored, url: options.url, serve: options.serve, backend, github: true, browser: false });
  if (!pre.ok || !pre.root) {
    printChecks(pre.checks.filter((check) => check.status !== 'ok'));
    out(bold('\nNot starting: the preflight failed.'));
    return 1;
  }
  const root = pre.root;
  const repo = repoSlugFor(root);
  const dry = requireDryRun(repo, options, backend);
  if (!dry) return 1;

  const runId = newRunId();
  const dir = runDir(repo, runId);
  mkdirSync(dir, { recursive: true });
  const prepared = await prepareRun(runId, root, { url: options.url, serve: options.serve });

  try {
    const { scratch, server, baseUrl, browser } = prepared;
    const pages = options.pages;
    okLine(pages.length > 0 ? `pages: ${pages.join(', ')}` : 'pages: not named, so the finder finds them');
    const tags = axeTagsFor(level);

    const before = treeState(root);
    const ignored = ignoredIn(root, ['.']);
    const spec = finderSpec(options, root, scratch, join(dir, 'transcript.jsonl'), ignored, backend.offLimits(root));
    spec.brief = finderBrief({ level, scope: options.scope, repoRoot: root, baseUrl, pages, scratch, browser: `${browser.channel} ${browser.version} (headless)`, channel: browser.channel, spec });
    writeFileSync(join(dir, 'brief.md'), spec.brief);

    const meta: RunMeta = {
      runId,
      role: 'finder',
      createdAt: new Date().toISOString(),
      finishedAt: null,
      repoRoot: root,
      repo,
      commit: headCommit(root),
      branch: currentBranch(root),
      level,
      scope: options.scope,
      baseUrl: options.serve ? `served from \`${options.serve}\`` : baseUrl,
      site: { url: options.url, serve: options.serve },
      pages,
      served: null,
      browser: { channel: browser.channel, version: browser.version },
      axe: { version: browser.axeVersion, tags },
      backend: backend.name,
      model: options.model,
      effort: options.effort,
      maxTurns: options.maxTurns,
      maxBudgetUsd: options.maxBudgetUsd,
      dryRun: dry,
      session: null,
      pass: null,
    };
    writeJson(join(dir, 'meta.json'), meta);

    heading('The finder');
    out(dim(`A fresh, read-only ${backend.name} session (${options.model}, effort ${options.effort}), capped at ${options.maxTurns} turns, $${options.maxBudgetUsd} and ${options.timeoutMinutes} minutes. This usually takes a while.`));
    const context: ValidationContext = { criteria: criteriaAt(level), repoRoot: root, tracked: trackedFiles(root) };
    const run = await runRole(backend, spec, (raw) => validateReport(raw, context));
    const after = aftermath(run, spec, root, before, options.allowIgnored);
    meta.finishedAt = new Date().toISOString();
    meta.served = server ? server.served() : null;
    meta.session = after.record;
    writeJson(join(dir, 'meta.json'), meta);
    if (!printAftermath(run, after, spec, dir) || !run.checked.ok) return 1;

    const report = run.checked.report;
    writeJson(join(dir, 'report.json'), report);
    // `file` refuses a report that changed after this, so what reaches GitHub is what the finder reported and the runner checked.
    meta.session.reportSha256 = reportHash(readFileSync(join(dir, 'report.json'), 'utf8'));
    writeJson(join(dir, 'meta.json'), meta);
    const tally = tallyOf(report);
    const strays = strayLines(after);
    okLine(`a verdict for all ${report.criteria.length} criteria: ❌ ${tally.fail}, 🕵️ ${tally.check}, ✅ ${tally['found-no-fail']}, n/a ${tally.na}`);
    out(`  ${plural(tally.failItems, 'fail', 'fails')} for agents, ${plural(tally.checkItems, 'check', 'checks')} for a person`);
    out(`  Cost: ${formatUsage(run.usage)}${run.attempts > 1 ? ` over ${run.attempts} attempts` : ''}`);
    out(`  Run: ${runId}  (local record in ${dir})`);
    nextLine(strays, runId);
    return strays.length > 0 ? 1 : 0;
  } finally {
    await prepared.cleanup();
  }
};

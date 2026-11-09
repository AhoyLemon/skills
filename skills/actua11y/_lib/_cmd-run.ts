// Starts the finder: a fresh, read-only session with the brief filled from the shipped table, a scratch folder with the browser kit, and axe already run on every page.
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { bold, dim, failLine, heading, hintLine, okLine, out, warnLine } from './_ansi.ts';
import type { Options } from './_args.ts';
import { addUsage, type Backend, type RoleSpec, type SessionResult, type Usage } from './_backend.ts';
import { banner } from './_banner.ts';
import { fillTemplate, readBrief } from './_brief.ts';
import { axeTagsFor, criteriaAt, levelLabel, type Level } from './_criteria.ts';
import { repoSlugFor } from './_cmd-checks.ts';
import { exec } from './_exec.ts';
import { currentBranch, headCommit, ignoredIn, treeChanges, treeState } from './_git.ts';
import { discoverPages } from './_pages.ts';
import { printChecks, runPreflight } from './_preflight.ts';
import { formatUsage } from './_render.ts';
import { extractReportJson, REPORT_SHAPE, tallyOf, validateReport, type ValidationResult } from './_report.ts';
import { ALL_DENIES, computeOffLimits, rulesInWords } from './_rules.ts';
import { latestDryRun, newRunId, runDir, stateRoot, writeJson, type RunMeta } from './_runs.ts';
import { installKit, makeScratch, onExit, probeBrowser, removeDir } from './_scratch.ts';
import { serveStatic, type StaticServer } from './_serve.ts';

const DRY_RUN_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 3;

interface BriefInput {
  level: Level;
  scope: string[];
  repoRoot: string;
  baseUrl: string;
  pages: string[];
  scratch: string;
  axeDir: string;
  browser: string;
  channel: string;
  spec: RoleSpec;
}

const tableCell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ');

export const criteriaTableFor = (level: Level): string =>
  ['| Criterion | Level | What it asks |', '|---|---|---|', ...criteriaAt(level).map((c) => `| ${c.num} ${tableCell(c.name)} | ${c.level} | ${tableCell(c.title)} |`)].join('\n');

export const finderBrief = (input: BriefInput): string =>
  fillTemplate(readBrief('finder'), {
    LEVEL_LABEL: levelLabel(input.level),
    CRITERIA_COUNT: String(criteriaAt(input.level).length),
    REPO_ROOT: input.repoRoot,
    SCOPE: input.scope.map((path) => `\`${path}\``).join(', '),
    BASE_URL: input.baseUrl,
    PAGES: input.pages.map((page) => `\`${page}\``).join(', '),
    SCRATCH: input.scratch,
    AXE_DIR: input.axeDir,
    AXE_TAGS: axeTagsFor(input.level).join(','),
    BROWSER: input.browser,
    CHANNEL: input.channel,
    RULES: rulesInWords(input.spec).map((rule) => `- ${rule}`).join('\n'),
    REPORT_SCHEMA: REPORT_SHAPE,
    CRITERIA_TABLE: criteriaTableFor(input.level),
  });

const requireLevel = (options: Options): Level => {
  if (!options.level) throw new Error('Pass --level A, AA or AAA. Ask the user if the project names no standard.');
  return options.level;
};

const finderSpec = (options: Options, root: string, scratch: string | null, transcriptPath: string, ignored: string[]): RoleSpec => ({
  role: 'finder',
  brief: '',
  cwd: root,
  scratch,
  readOnly: true,
  noTools: false,
  deny: ALL_DENIES,
  offLimits: computeOffLimits({ repoRoot: root, runsRoot: stateRoot(), scratch, ignoredInRepo: ignored }),
  model: options.model,
  effort: options.effort,
  maxTurns: options.maxTurns,
  maxBudgetUsd: options.maxBudgetUsd,
  timeoutMs: options.timeoutMinutes * 60_000,
  transcriptPath,
});

export const cmdBrief = (options: Options): number => {
  if (options.subject !== 'finder') throw new Error('Only `brief finder` exists in this version');
  const level = requireLevel(options);
  const root = options.cwd;
  const scratch = '<a fresh scratch folder per run>';
  const spec = finderSpec(options, root, null, '', []);
  spec.scratch = scratch;
  out(finderBrief({ level, scope: options.scope, repoRoot: root, baseUrl: options.url ?? '<served for the run>', pages: options.pages.length > 0 ? options.pages : ['<found by a short crawl at run time>'], scratch, axeDir: `${scratch}/axe`, browser: '<your installed Chrome or Edge>', channel: 'chrome', spec }));
  return 0;
};

const fixMessage = (errors: string[]): string =>
  [
    "The runner can't accept your report yet. Fix every problem below, then send the complete corrected report as one ```json block (the whole report, not just the changes), with nothing after it.",
    '',
    ...errors.slice(0, 80).map((error) => `- ${error}`),
    errors.length > 80 ? `- ...and ${errors.length - 80} more like these` : '',
  ].join('\n');

const reportFrom = (session: SessionResult): unknown => {
  for (const text of [...session.finalTexts].reverse()) {
    const parsed = extractReportJson(text);
    if (typeof parsed === 'object' && parsed !== null) return parsed;
  }
  return undefined;
};

const pageFile = (page: string): string => (page.replace(/^\/+|\/+$/g, '').replace(/[^A-Za-z0-9._-]+/g, '_') || 'index');

export const cmdRunFinder = async (options: Options, backend: Backend): Promise<number> => {
  if (options.subject !== 'finder') throw new Error('Only `run finder` exists in this version');
  const level = requireLevel(options);
  banner(level);
  if (!options.url && !options.serve) throw new Error('Pass --url <the running site> or --serve <folder> for a static site');

  const pre = await runPreflight({ cwd: options.cwd, scope: options.scope, allowIgnored: options.allowIgnored, url: options.url, serve: options.serve, backend, github: false, browser: false });
  if (!pre.ok || !pre.root) {
    printChecks(pre.checks.filter((check) => check.status !== 'ok'));
    out(bold('\nNot starting: the preflight failed.'));
    return 1;
  }
  const root = pre.root;
  const repo = repoSlugFor(root);

  const dry = latestDryRun(repo);
  const fresh = dry && dry.clean && dry.backend === backend.name && dry.model === options.model && Date.now() - Date.parse(dry.at) < DRY_RUN_MAX_AGE_MS;
  if (!fresh) {
    failLine(`No clean dry run for ${repo.owner}/${repo.name} with ${options.model} in the last six hours.`);
    hintLine('Run `node runner.ts dry-run` first, and read what the session says it loaded.');
    return 1;
  }

  const runId = newRunId();
  const dir = runDir(repo, runId);
  mkdirSync(dir, { recursive: true });
  const scratch = makeScratch(runId);
  const cleanScratch = onExit(() => removeDir(scratch));
  let server: StaticServer | null = null;

  try {
    heading('Preparing');
    const kit = installKit(scratch);
    if (!kit.ok) throw new Error(`Couldn't install the browser kit: ${kit.detail}`);
    const probe = probeBrowser(scratch);
    if (!probe.ok) throw new Error(`No browser to drive: ${probe.detail}`);
    okLine(`browser kit installed in a fresh scratch folder, driving ${probe.channel} ${probe.version}`);

    if (options.serve) {
      server = await serveStatic(join(root, options.serve));
      okLine(`serving ${options.serve} at ${server.url} for this run`);
    }
    const baseUrl = server?.url ?? options.url ?? '';
    const pages = options.pages.length > 0 ? options.pages : await discoverPages(baseUrl);
    okLine(`pages: ${pages.join(', ')}`);

    const axeDir = join(scratch, 'axe');
    mkdirSync(axeDir, { recursive: true });
    const tags = axeTagsFor(level);
    for (const page of pages) {
      const scan = exec('node', [join(scratch, 'kit', 'scan.ts'), '--url', new URL(page, baseUrl).href, '--tags', tags.join(','), '--out', join(axeDir, `${pageFile(page)}.json`), '--channel', probe.channel], { cwd: scratch });
      if (scan.code === 0) okLine(`axe: ${scan.stdout.trim()}`);
      else warnLine(`axe couldn't scan ${page}: ${scan.stderr.trim().split('\n').at(-1) ?? ''}`);
    }

    const before = treeState(root);
    const ignored = ignoredIn(root, ['.']);
    const spec = finderSpec(options, root, scratch, join(dir, 'transcript.jsonl'), ignored);
    const browser = `${probe.channel} ${probe.version} (headless)`;
    spec.brief = finderBrief({ level, scope: options.scope, repoRoot: root, baseUrl, pages, scratch, axeDir, browser, channel: probe.channel, spec });
    writeFileSync(join(dir, 'brief.md'), spec.brief);

    const meta: RunMeta = {
      runId,
      createdAt: new Date().toISOString(),
      finishedAt: null,
      repoRoot: root,
      repo,
      commit: headCommit(root),
      branch: currentBranch(root),
      level,
      scope: options.scope,
      baseUrl: options.serve ? `served from \`${options.serve}\`` : baseUrl,
      pages,
      browser: { channel: probe.channel, version: probe.version },
      axe: { version: probe.axeVersion, tags },
      backend: backend.name,
      model: options.model,
      effort: options.effort,
      maxTurns: options.maxTurns,
      maxBudgetUsd: options.maxBudgetUsd,
      dryRun: dry,
      finder: null,
    };
    writeJson(join(dir, 'meta.json'), meta);

    heading('The finder');
    out(dim(`A fresh, read-only ${backend.name} session (${options.model}, effort ${options.effort}), capped at ${options.maxTurns} turns, $${options.maxBudgetUsd} and ${options.timeoutMinutes} minutes. This usually takes a while.`));
    let session = await backend.start(spec);
    let usage: Usage = session.usage;
    let attempts = 1;
    const errors = [...session.errors];
    let validation: ValidationResult = validateReport(reportFrom(session), { criteria: criteriaAt(level), repoRoot: root });
    const stoppedAtStart = session.errors.some((error) => error.startsWith('stopped at start'));
    while (!validation.ok && !stoppedAtStart && session.sessionId && attempts < MAX_ATTEMPTS && usage.costUsd < options.maxBudgetUsd) {
      warnLine(`the report has ${validation.errors.length} problem(s), so the runner is sending them back (attempt ${attempts + 1} of ${MAX_ATTEMPTS})`);
      const remaining = { ...spec, maxBudgetUsd: Math.max(1, options.maxBudgetUsd - usage.costUsd), maxTurns: Math.max(10, options.maxTurns - usage.turns) };
      session = await backend.resume(remaining, session.sessionId, fixMessage(validation.errors));
      usage = addUsage(usage, session.usage);
      errors.push(...session.errors);
      attempts += 1;
      validation = validateReport(reportFrom(session), { criteria: criteriaAt(level), repoRoot: root });
    }

    const strays = treeChanges(before, treeState(root));
    if (existsSync(axeDir)) cpSync(axeDir, join(dir, 'axe'), { recursive: true });
    meta.finishedAt = new Date().toISOString();
    meta.finder = { sessionId: session.sessionId, attempts, usage, transcriptPath: spec.transcriptPath, errors, strays, valid: validation.ok };
    writeJson(join(dir, 'meta.json'), meta);

    heading('Result');
    for (const error of errors) warnLine(error);
    if (strays.length > 0) {
      failLine('The finder changed the repository, which it must never do:');
      for (const stray of strays) hintLine(stray);
    }
    if (!validation.ok) {
      writeJson(join(dir, 'report-invalid.json'), { errors: validation.errors, raw: reportFrom(session) ?? session.finalTexts.at(-1) ?? null });
      failLine(`No usable report after ${attempts} attempt(s). Its problems are saved in ${join(dir, 'report-invalid.json')}.`);
      out(`Cost: ${formatUsage(usage)}`);
      return 1;
    }
    writeJson(join(dir, 'report.json'), validation.report);
    const tally = tallyOf(validation.report);
    okLine(`a verdict for all ${validation.report.criteria.length} criteria: ❌ ${tally.fail}, 🕵️ ${tally.check}, ✅ ${tally['found-no-fail']}, n/a ${tally.na}`);
    out(`  ${tally.failItems} fail(s) for agents, ${tally.checkItems} check(s) for a person`);
    out(`  Cost: ${formatUsage(usage)}${attempts > 1 ? ` over ${attempts} attempts` : ''}`);
    out(`  Run: ${runId}  (local record in ${dir})`);
    out();
    out(strays.length > 0 ? bold('Stop and show the user the changes above before filing anything.') : bold(`Next: node runner.ts file --run ${runId}`));
    return strays.length > 0 ? 1 : 0;
  } finally {
    await server?.close();
    cleanScratch();
  }
};

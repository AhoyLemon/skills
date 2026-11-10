// Starts the finder: a fresh, read-only session with the brief filled from the shipped table and a scratch folder holding the browser kit.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { bold, dim, failLine, heading, hintLine, okLine, out, warnLine } from './_ansi.ts';
import type { Options } from './_args.ts';
import { addUsage, type Backend, type RoleSpec, type SessionResult, type Usage } from './_backend.ts';
import { fillTemplate, readBrief } from './_brief.ts';
import { banner } from './_copy.ts';
import { axeTagsFor, criteriaAt, levelLabel, type Level } from './_criteria.ts';
import { repoSlugFor } from './_cmd-checks.ts';
import { currentBranch, headCommit, ignoredIn, trackedFiles, treeChanges, treeState } from './_git.ts';
import { printChecks, runPreflight } from './_preflight.ts';
import { formatUsage, plural } from './_render.ts';
import { extractReportJson, REPORT_SHAPE, tallyOf, validateReport, type ValidationContext, type ValidationResult } from './_report.ts';
import { ALL_DENIES, computeOffLimits, offLimitsMentions, rulesInWords } from './_rules.ts';
import { latestDryRun, newRunId, reportHash, runDir, stateRoot, writeJson, type DryRunRecord, type RunMeta } from './_runs.ts';
import { onExit } from './_exec.ts';
import { installKit, makeScratch, probeBrowser, removeDir } from './_scratch.ts';
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

// A finder only starts after a clean dry run with the same backend, model and effort, recent enough that nothing about the setup has had time to change.
export const dryRunIsFresh = (dry: DryRunRecord | null, wanted: DryRunWanted, now: number): boolean =>
  dry !== null && dry.clean && dry.backend === wanted.backend && dry.model === wanted.model && dry.effort === wanted.effort && now - Date.parse(dry.at) < DRY_RUN_MAX_AGE_MS;

// Without a result event a session reports no cost or turns, so its spend is unknown and a retry would be handed a budget that may already be gone.
const reportedUsage = (session: SessionResult): boolean => session.usage.turns > 0;

const requireLevel = (options: Options): Level => {
  if (!options.level) throw new Error('Pass --level A, AA or AAA. Ask the user if the project names no standard.');
  return options.level;
};

const finderSpec = (options: Options, root: string, scratch: string | null, transcriptPath: string, ignored: string[], agentPaths: string[]): RoleSpec => ({
  role: 'finder',
  brief: '',
  cwd: root,
  scratch,
  readOnly: true,
  noTools: false,
  deny: ALL_DENIES,
  offLimits: computeOffLimits({ repoRoot: root, runsRoot: stateRoot(), scratch, ignoredInRepo: ignored, agentPaths }),
  model: options.model,
  effort: options.effort,
  maxTurns: options.maxTurns,
  maxBudgetUsd: options.maxBudgetUsd,
  timeoutMs: options.timeoutMinutes * 60_000,
  transcriptPath,
});

export const cmdBrief = (options: Options, backend: Backend): number => {
  if (options.subject !== 'finder') throw new Error('Only `brief finder` exists in this version');
  const level = requireLevel(options);
  const root = options.cwd;
  const scratch = '<a fresh scratch folder per run>';
  const spec = finderSpec(options, root, null, '', [], backend.offLimits(root));
  spec.scratch = scratch;
  out(finderBrief({ level, scope: options.scope, repoRoot: root, baseUrl: options.url ?? '<served for the run>', pages: options.pages, scratch, browser: '<your installed Chrome or Edge>', channel: 'chrome', spec }));
  return 0;
};

const fixMessage = (errors: string[]): string =>
  [
    "The runner can't accept your report yet. Fix every problem below, then send the complete corrected report as one ```json block (the whole report, not just the changes), with nothing after it.",
    '',
    ...errors.slice(0, 80).map((error) => `- ${error}`),
    errors.length > 80 ? `- ...and ${errors.length - 80} more like these` : '',
  ].join('\n');

interface Attempt {
  validation: ValidationResult;
  raw: unknown;
}

// The last result holding a valid report wins. If none is valid, the last JSON object is the one whose problems go back to the session.
const reportFrom = (session: SessionResult, context: ValidationContext): Attempt => {
  const candidates = [...session.finalTexts].reverse().map(extractReportJson).filter((parsed) => typeof parsed === 'object' && parsed !== null);
  for (const raw of candidates) {
    const validation = validateReport(raw, context);
    if (validation.ok) return { validation, raw };
  }
  return { validation: validateReport(candidates[0], context), raw: candidates[0] };
};

export const cmdRunFinder = async (options: Options, backend: Backend): Promise<number> => {
  if (options.subject !== 'finder') throw new Error('Only `run finder` exists in this version');
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

  const dry = latestDryRun(repo);
  if (!dryRunIsFresh(dry, { backend: backend.name, model: options.model, effort: options.effort }, Date.now())) {
    failLine(`No clean dry run for ${repo.owner}/${repo.name} with ${options.model} at effort ${options.effort} in the last six hours.`);
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
    const pages = options.pages;
    okLine(pages.length > 0 ? `pages: ${pages.join(', ')}` : 'pages: not named, so the finder finds them');
    const tags = axeTagsFor(level);

    const before = treeState(root);
    const ignored = ignoredIn(root, ['.']);
    const spec = finderSpec(options, root, scratch, join(dir, 'transcript.jsonl'), ignored, backend.offLimits(root));
    const browser = `${probe.channel} ${probe.version} (headless)`;
    spec.brief = finderBrief({ level, scope: options.scope, repoRoot: root, baseUrl, pages, scratch, browser, channel: probe.channel, spec });
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
    const context: ValidationContext = { criteria: criteriaAt(level), repoRoot: root, tracked: trackedFiles(root) };
    const startedAt = Date.now();
    let session = await backend.start(spec);
    let usage: Usage = session.usage;
    let attempts = 1;
    let denials = session.permissionDenials;
    let unreported = !reportedUsage(session);
    const errors = [...session.errors];
    const toolInputs = [...session.toolInputs];
    let attempt = reportFrom(session, context);
    const stoppedAtStart = session.errors.some((error) => error.startsWith('stopped at start'));
    // Retries share the caps the user agreed to. Each one gets only what's left, and none starts without a useful amount left.
    const left = (): { usd: number; turns: number; ms: number } => ({ usd: options.maxBudgetUsd - usage.costUsd, turns: options.maxTurns - usage.turns, ms: options.timeoutMinutes * 60_000 - (Date.now() - startedAt) });
    while (!attempt.validation.ok && !stoppedAtStart && session.sessionId && reportedUsage(session) && attempts < MAX_ATTEMPTS) {
      const remaining = left();
      if (remaining.usd < 0.5 || remaining.turns < 5 || remaining.ms < 2 * 60_000) {
        warnLine('the report has problems, but too little of the budget, turns or time is left to send them back');
        break;
      }
      warnLine(`the report has ${attempt.validation.ok ? 0 : attempt.validation.errors.length} problem(s), so the runner is sending them back (attempt ${attempts + 1} of ${MAX_ATTEMPTS})`);
      const retry = { ...spec, maxBudgetUsd: Number(remaining.usd.toFixed(2)), maxTurns: Math.floor(remaining.turns), timeoutMs: remaining.ms };
      session = await backend.resume(retry, session.sessionId, fixMessage(attempt.validation.ok ? [] : attempt.validation.errors));
      usage = addUsage(usage, session.usage);
      denials += session.permissionDenials;
      unreported ||= !reportedUsage(session);
      errors.push(...session.errors);
      toolInputs.push(...session.toolInputs);
      attempts += 1;
      attempt = reportFrom(session, context);
    }
    // A session stopped at its first event, or one that never said what it loaded, isn't trusted, whatever it reported.
    const untrusted = errors.filter((error) => error.startsWith('stopped at start'));
    const validation: ValidationResult = untrusted.length > 0 ? { ok: false, errors: untrusted } : attempt.validation;

    const changes = treeChanges(before, treeState(root), options.allowIgnored);
    const mentions = offLimitsMentions(toolInputs, spec.offLimits, root);
    meta.finishedAt = new Date().toISOString();
    meta.finder = { sessionId: session.sessionId, attempts, usage, transcriptPath: spec.transcriptPath, errors, permissionDenials: denials, offLimitsMentions: mentions, strays: changes.tree, ignoredStrays: changes.ignored, valid: validation.ok, reportSha256: null };
    writeJson(join(dir, 'meta.json'), meta);
    const strays = [...changes.tree, ...changes.ignored.map((path) => `new or gone gitignored path: ${path}`)];

    heading('Result');
    for (const error of errors) warnLine(error);
    if (unreported) warnLine('a session ended without reporting its cost, so the cost below is too low');
    if (denials > 0) warnLine(`the finder tried ${plural(denials, 'thing', 'things')} its rules deny. The transcript shows what: ${spec.transcriptPath}`);
    if (mentions.length > 0) {
      failLine('Tool calls named paths the finder must never read. A shell can read past the rules, so show the user these and the transcript before filing:');
      for (const mention of mentions) hintLine(`${mention.path} (${plural(mention.count, 'tool call', 'tool calls')})`);
    }
    if (changes.tree.length > 0) {
      failLine('The finder changed tracked or untracked files in the repository, which it must never do:');
      for (const stray of changes.tree) hintLine(stray);
    }
    if (changes.ignored.length > 0) {
      failLine('Gitignored paths appeared or vanished while the finder ran:');
      for (const path of changes.ignored) hintLine(path);
      hintLine('If one came from your own dev server (a cache folder, say), file with --allow-ignored for it, and pass it at intake next time.');
    }
    if (!validation.ok) {
      writeJson(join(dir, 'report-invalid.json'), { errors: validation.errors, raw: attempt.raw ?? session.finalTexts.at(-1) ?? null });
      failLine(`No usable report after ${attempts} attempt(s). Its problems are saved in ${join(dir, 'report-invalid.json')}.`);
      out(`Cost: ${formatUsage(usage)}`);
      return 1;
    }
    writeJson(join(dir, 'report.json'), validation.report);
    // `file` refuses a report that changed after this, so what reaches GitHub is what the finder reported and the runner checked.
    meta.finder.reportSha256 = reportHash(readFileSync(join(dir, 'report.json'), 'utf8'));
    writeJson(join(dir, 'meta.json'), meta);
    const tally = tallyOf(validation.report);
    okLine(`a verdict for all ${validation.report.criteria.length} criteria: ❌ ${tally.fail}, 🕵️ ${tally.check}, ✅ ${tally['found-no-fail']}, n/a ${tally.na}`);
    out(`  ${plural(tally.failItems, 'fail', 'fails')} for agents, ${plural(tally.checkItems, 'check', 'checks')} for a person`);
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

// The blind certifier: a fresh, read-only session isolated exactly like the finder, handed the list of what was wrong and never anyone's account of the fixes. Filing a pass posts it on the PR, moves the record forward, and ends the AI rounds when it approves or the cap hits.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { bold, dim, failLine, heading, okLine, out, warnLine } from './_ansi.ts';
import type { Options } from './_args.ts';
import type { Backend, RoleSpec } from './_backend.ts';
import { fillTemplate, readBrief } from './_brief.ts';
import { CERTIFIER_SHAPE, passVerdict, validateCertifierReport, type CertifierReport } from './_certifier.ts';
import { openLoop, nextStep, printNext } from './_cmd-loop.ts';
import { criteriaTableFor, prepareRun, requireDryRun } from './_cmd-run.ts';
import { banner } from './_copy.ts';
import { axeTagsFor, criteriaAt, levelLabel } from './_criteria.ts';
import { commitsBetween, currentBranch, headCommit, ignoredIn, porcelain, switchBranch, trackedFiles, treeState } from './_git.ts';
import { applyPass, budgetLeft, carriedFor, humanPassesSinceApproval, ledgerHash, MAX_HUMAN_PASSES, MIN_PASS_USD, passes, passPlan, type LoopView } from './_ledger.ts';
import { ensurePr, loadLoop, postRun, runTarget, saveLoop, type LoopGh } from './_loop.ts';
import { printChecks, runPreflight } from './_preflight.ts';
import { formatUsage, plural } from './_render.ts';
import { carriedText, certifierItemsText, outOfScopeText, renderCertifierComments, renderReportBack, renderUnfiledComments, verdictText } from './_render-loop.ts';
import { rulesInWords } from './_rules.ts';
import { newRunId, reportHash, runDir, writeJson, type RunMeta } from './_runs.ts';
import { aftermath, auditSpec, nextLine, printAftermath, runRole, strayLines } from './_session.ts';

interface CertifierBriefInput {
  root: string;
  commit: string;
  baseUrl: string;
  scratch: string;
  browser: string;
  channel: string;
  spec: RoleSpec;
}

export const certifierBrief = (view: LoopView, input: CertifierBriefInput): string => {
  const { ledger } = view;
  const plan = passPlan(ledger);
  const pass = passes(ledger).length + 1;
  const carried = carriedText(view, plan);
  const level = ledger.facts.level;
  const stageNote = ledger.stage === 'human'
    ? `certifier pass ${pass}, guarding a human round. A person has worked their own issue and made fixes, or had an agent make them. Some items below are theirs, in their own words, and they decided each one should be fixed. Judge those just like the rest, and hunt hard for anything their fixes broke.`
    : `certifier pass ${pass}, checking the AI rounds. Every item below was proven failing when it was found. Judge whether it still fails now.`;
  return fillTemplate(readBrief('certifier'), {
    COMMIT: input.commit,
    LEVEL_LABEL: levelLabel(level),
    CRITERIA_COUNT: String(criteriaAt(level).length),
    REPO_ROOT: input.root,
    SCOPE: ledger.facts.scope.map((path) => `\`${path}\``).join(', '),
    BASE_URL: input.baseUrl,
    ROUND_NOTE: stageNote,
    SCRATCH: input.scratch,
    BROWSER: input.browser,
    AXE_TAGS: axeTagsFor(level).join(','),
    CHANNEL: input.channel,
    ITEM_COUNT: String(plan.items.length),
    ITEMS_INTRO: plan.items.length === 0 ? 'There are no items to judge on this pass, so `items` is an empty list. The re-walk still matters.' : 'Each item says what was wrong when it was found. Line numbers may have moved since, so find it in the code and in the running page.',
    ITEMS: certifierItemsText(view, plan),
    CARRIED_COUNT: String(carried.count),
    CARRIED: carried.text,
    OUT_OF_SCOPE: outOfScopeText(view, plan),
    CAPS: `${input.spec.maxTurns} turns, $${input.spec.maxBudgetUsd} and ${Math.round(input.spec.timeoutMs / 60_000)} minutes`,
    RULES: rulesInWords(input.spec).map((rule) => `- ${rule}`).join('\n'),
    REPORT_SCHEMA: CERTIFIER_SHAPE,
    CRITERIA_TABLE: criteriaTableFor(level),
  });
};

const certifierSpec = (options: Options, root: string, scratch: string | null, transcriptPath: string, ignored: string[], agentPaths: string[], maxBudgetUsd: number): RoleSpec =>
  auditSpec({ role: 'certifier', root, scratch, transcriptPath, ignored, agentPaths, model: options.model, effort: options.effort, maxTurns: options.maxTurns, maxBudgetUsd, timeoutMs: options.timeoutMinutes * 60_000 });

const requireCertifierTurn = (view: LoopView, agentUrl: string): void => {
  const { ledger } = view;
  if (ledger.stage === 'ai') {
    const lastAi = ledger.rounds.filter((round) => round.stage === 'ai').at(-1);
    if (lastAi?.kind !== 'fixer') throw new Error(`It isn't the certifier's turn: no fixer round has been recorded since the last pass. Next: ${nextStep(ledger, new Set(), agentUrl).command ?? 'nothing'}`);
    return;
  }
  if (ledger.stage !== 'human') throw new Error(`It isn't the certifier's turn. ${nextStep(ledger, new Set(), agentUrl).says}`);
  if (humanPassesSinceApproval(ledger) >= MAX_HUMAN_PASSES) throw new Error(`The human round already hit its cap of ${MAX_HUMAN_PASSES} certifier runs without one approving. Next: close-out --at-cap, which says so plainly`);
};

export const cmdBriefCertifier = (options: Options, client: LoopGh, backend: Backend): number => {
  const { root, state, agentUrl } = openLoop(options, client);
  requireCertifierTurn(state.view, agentUrl);
  if (state.view.ledger.facts.backend !== backend.name) throw new Error(`This loop uses ${state.view.ledger.facts.backend}; select the same backend for the certifier`);
  const spec = certifierSpec(options, root, '<a fresh scratch folder per run>', '', [], backend.offLimits(root), Math.min(options.maxBudgetUsd, budgetLeft(state.view.ledger)));
  const brief = certifierBrief(state.view, { root, commit: headCommit(root), baseUrl: options.url ?? state.view.ledger.site.url ?? '<served for the run>', scratch: '<a fresh scratch folder per run>', browser: '<your installed Chrome or Edge>', channel: 'chrome', spec });
  out(backend.costsMeasured === false ? brief.replace(`${spec.maxTurns} turns, $${spec.maxBudgetUsd} and ${Math.round(spec.timeoutMs / 60_000)} minutes`, `${Math.round(spec.timeoutMs / 60_000)} minutes; dollar cost is not measured`) : brief);
  return 0;
};

export const cmdRunCertifier = async (options: Options, backend: Backend, client: LoopGh): Promise<number> => {
  const context = openLoop(options, client);
  const { root, ledger, state, agentUrl } = context;
  if (ledger.facts.backend !== backend.name) throw new Error(`This loop uses ${ledger.facts.backend}; select the same backend for the certifier`);
  const level = ledger.facts.level;
  banner(level);
  requireCertifierTurn(state.view, agentUrl);
  const left = budgetLeft(ledger);
  if (left < MIN_PASS_USD) {
    failLine(`Only $${left.toFixed(2)} of the loop's budget is left, too little for a full re-walk.`);
    out(ledger.stage === 'ai' ? bold(`That ends the AI rounds. Next: node runner.ts loop stop --issue ${agentUrl.split('/').at(-1)}`) : bold('Ask the user whether to raise the budget. Until then, the human round can\'t be certified.'));
    return 1;
  }
  const loop = ledger.loop;
  if (!loop) throw new Error("The loop hasn't started");
  // The runner checks the commit out itself, so the certifier reads exactly what it judges. It only ever switches a clean tree.
  if (currentBranch(root) !== loop.branch) {
    if (porcelain(root).length > 0) throw new Error(`You're on ${currentBranch(root)} with uncommitted changes. The certifier runs on ${loop.branch}, so commit or stash them first`);
    switchBranch(root, loop.branch);
    okLine(`switched to ${loop.branch}, the loop's branch`);
  }
  const site = { url: options.url ?? (options.serve ? null : ledger.site.url), serve: options.serve ?? (options.url ? null : ledger.site.serve) };
  const pre = await runPreflight({ cwd: root, scope: ledger.facts.scope, allowIgnored: options.allowIgnored, url: site.url, serve: site.serve, backend, github: true, browser: false });
  if (!pre.ok) {
    printChecks(pre.checks.filter((check) => check.status !== 'ok'));
    out(bold('\nNot starting: the preflight failed.'));
    return 1;
  }
  const head = headCommit(root);
  const prHead = state.pr?.headSha ?? null;
  if (prHead !== null && prHead !== head) throw new Error(`HEAD is ${head.slice(0, 12)}, but the PR's head is ${prHead.slice(0, 12)}. Push or pull until they match, so the certifier judges what the PR holds`);
  const dry = requireDryRun(ledger.facts.repo, options, backend);
  if (!dry) return 1;

  const runId = newRunId();
  const dir = runDir(ledger.facts.repo, runId);
  mkdirSync(dir, { recursive: true });
  const prepared = await prepareRun(runId, root, site, backend);
  try {
    const { scratch, server, baseUrl, browser } = prepared;
    const plan = passPlan(ledger);
    const carried = plan.items.flatMap((id) => carriedFor(state.view, id)).map(({ id, from, steps }) => ({ id, from, steps }));
    const pass = passes(ledger).length + 1;
    const before = treeState(root);
    const ignored = ignoredIn(root, ['.']);
    const budget = Number(Math.min(options.maxBudgetUsd, left).toFixed(2));
    const spec = certifierSpec(options, root, scratch, join(dir, 'transcript.jsonl'), ignored, backend.offLimits(root), budget);
    spec.browserEndpoint = prepared.browserEndpoint;
    spec.brief = certifierBrief(state.view, { root, commit: head, baseUrl, scratch, browser: `${browser.channel} ${browser.version} (headless)`, channel: browser.channel, spec });
    if (backend.costsMeasured === false) spec.brief = spec.brief.replace(`${spec.maxTurns} turns, $${spec.maxBudgetUsd} and ${Math.round(spec.timeoutMs / 60_000)} minutes`, `${Math.round(spec.timeoutMs / 60_000)} minutes; dollar cost is not measured`);
    if (spec.browserEndpoint) spec.brief = spec.brief.replace(`chromium.launch({ channel: '${browser.channel}', headless: true })`, 'chromium.connect(process.env.ACTUA11Y_BROWSER_WS)').concat('\nThe browser is already running; the kit connects automatically.\n');
    writeFileSync(join(dir, 'brief.md'), spec.brief);
    const meta: RunMeta = {
      runId,
      role: 'certifier',
      createdAt: new Date().toISOString(),
      finishedAt: null,
      repoRoot: root,
      repo: ledger.facts.repo,
      commit: head,
      branch: loop.branch,
      level,
      scope: ledger.facts.scope,
      baseUrl: site.serve ? `served from \`${site.serve}\`` : baseUrl,
      site,
      pages: [],
      served: null,
      browser: { channel: browser.channel, version: browser.version },
      axe: { version: browser.axeVersion, tags: axeTagsFor(level) },
      backend: backend.name,
      model: options.model,
      effort: options.effort,
      maxTurns: options.maxTurns,
      maxBudgetUsd: budget,
      dryRun: dry,
      session: null,
      pass: { issueUrl: agentUrl, pass, stage: ledger.stage === 'human' ? 'human' : 'ai', sha: head, items: plan.items, blocking: plan.blocking, carried, ledgerSha256: ledgerHash(ledger) },
    };
    writeJson(join(dir, 'meta.json'), meta);

    heading(`Certifier pass ${pass}`);
    out(dim(`A fresh, read-only ${backend.name} session (${options.model}, effort ${options.effort}), isolated exactly like the finder, judging ${plural(plan.items.length, 'item', 'items')} and ${plural(carried.length, 'carried repro', 'carried repros')} at ${head.slice(0, 12)}, then re-walking the whole target. ${backend.costsMeasured === false ? `Capped at ${options.timeoutMinutes} minutes; dollar cost is not measured.` : `Capped at ${options.maxTurns} turns, $${budget} and ${options.timeoutMinutes} minutes.`}`));
    const run = await runRole(backend, spec, (raw) => validateCertifierReport(raw, { criteria: criteriaAt(level), repoRoot: root, tracked: trackedFiles(root), items: plan.items, carried }));
    const after = aftermath(run, spec, root, before, options.allowIgnored);
    meta.finishedAt = new Date().toISOString();
    meta.served = server ? server.served() : null;
    meta.session = after.record;
    writeJson(join(dir, 'meta.json'), meta);
    if (!printAftermath(run, after, spec, dir) || !run.checked.ok) {
      postRun(client, runTarget(state, ledger), renderUnfiledComments(state.view, { runId, usage: run.usage, why: `It ended without a usable report, after ${plural(run.attempts, 'attempt', 'attempts')}.`, transcriptPath: spec.transcriptPath }));
      out(dim(run.usage.costUsd === null ? 'The run is posted on the record; its dollar cost is not measured.' : 'Its cost is posted on the record, so it counts against the loop\'s budget.'));
      return 1;
    }

    const report = run.checked.report;
    meta.pages = report.used.pages;
    writeJson(join(dir, 'report.json'), report);
    meta.session.reportSha256 = reportHash(readFileSync(join(dir, 'report.json'), 'utf8'));
    writeJson(join(dir, 'meta.json'), meta);
    const verdict = passVerdict(report, new Set(plan.blocking));
    okLine(`${verdict.fixed.length} with no fail found, ${verdict.notFixed.length} still failing, ${verdict.needsPerson.length} for a person, ${plural(verdict.newFails, 'new fail', 'new fails')} and ${plural(verdict.newChecks, 'new check', 'new checks')} from the re-walk`);
    out(`  Verdict, computed: ${verdictText(verdict)}`);
    out(`  Cost: ${formatUsage(run.usage)}${run.attempts > 1 ? ` over ${run.attempts} attempts` : ''}`);
    out(`  Run: ${runId}  (local record in ${dir})`);
    const strays = strayLines(after);
    nextLine(strays, runId);
    return strays.length > 0 ? 1 : 0;
  } finally {
    await prepared.cleanup();
  }
};

export interface FileCertifierInput {
  options: Options;
  meta: RunMeta;
  dir: string;
  reportText: string;
  client: LoopGh;
}

export const fileCertifierRun = (input: FileCertifierInput): number => {
  const { meta, client, dir } = input;
  const info = meta.pass;
  const session = meta.session;
  if (!info || !session) throw new Error(`Run ${meta.runId} isn't a certifier pass with a session record`);
  const state = loadLoop(client, info.issueUrl);
  const ledger = state.view.ledger;
  if (ledger.rounds.some((round) => round.runId === meta.runId)) {
    okLine(`Pass ${info.pass} (run ${meta.runId}) is already on the record.`);
    return 0;
  }
  // Filing a pass against a loop that moved on since it started would judge the wrong list, so the runner refuses rather than guess.
  if (ledgerHash(ledger) !== info.ledgerSha256) {
    postRun(client, runTarget(state, ledger), renderUnfiledComments(state.view, { runId: meta.runId, usage: session.usage, why: `The loop moved on after pass ${info.pass} started, so its report no longer matches the list it was given.`, transcriptPath: session.transcriptPath }));
    throw new Error(`The loop moved on after pass ${info.pass} started, so its report no longer matches the list it was given. Its cost is posted on the record. Run the certifier again`);
  }
  const report = JSON.parse(input.reportText) as CertifierReport;
  const verdict = passVerdict(report, new Set(info.blocking));
  const outcome = applyPass(ledger, report, verdict, {
    pass: info.pass,
    sha: info.sha,
    at: meta.finishedAt ?? new Date().toISOString(),
    runId: meta.runId,
    model: meta.model,
    effort: meta.effort,
    browser: meta.browser,
    usage: session.usage,
    dryRun: meta.dryRun ? { at: meta.dryRun.at, costUsd: meta.dryRun.usage.costUsd } : null,
    commentUrls: [],
  });
  const passesNow = new Map([...state.view.passes, [info.pass, report]]);
  const view: LoopView = { ledger: outcome.ledger, finder: state.view.finder, passes: passesNow };
  const fences = { denials: session.permissionDenials, mentions: session.offLimitsMentions.reduce((sum, mention) => sum + mention.count, 0) };
  const comments = renderCertifierComments(view, report, verdict, { pass: info.pass, runId: meta.runId, stage: info.stage, sha: info.sha, model: meta.model, effort: meta.effort, usage: session.usage, transcriptPath: session.transcriptPath, browser: meta.browser, served: meta.served, fences, newItems: outcome.newItems, newChecks: outcome.rewalkChecks });
  const reportBack = outcome.ended ? renderReportBack(view, { agentUrl: info.issueUrl }) : null;

  if (input.options.preview) {
    const preview = join(dir, 'preview');
    mkdirSync(preview, { recursive: true });
    comments.forEach((comment, i) => writeFileSync(join(preview, `pr-comment-${i + 1}.md`), comment));
    if (reportBack) writeFileSync(join(preview, 'report-back.md'), reportBack);
    okLine(`Preview written to ${preview}. Nothing was posted.`);
    return 0;
  }

  heading(`Filing certifier pass ${info.pass}`);
  const hasCommits = commitsBetween(meta.repoRoot, ledger.facts.commit, info.sha).length > 0;
  const pr = ensurePr(client, outcome.ledger, view, info.issueUrl, hasCommits);
  if (pr && !ledger.loop?.pr) okLine(`opened the draft PR: ${pr}`);
  const next = outcome.ledger.loop ? { ...outcome.ledger, loop: { ...outcome.ledger.loop, pr } } : outcome.ledger;
  const target = runTarget(state, next);
  const urls = postRun(client, target, comments);
  const round = next.rounds.at(-1);
  if (round) round.commentUrls = urls;
  okLine(`posted pass ${info.pass}: ${urls[0] ?? ''}`);
  if (reportBack) {
    postRun(client, target, [renderReportBack({ ...view, ledger: next }, { agentUrl: info.issueUrl })]);
    okLine('posted the report back: the AI rounds are over');
  }
  saveLoop(client, state, { ledger: next, passes: passesNow });
  okLine(`updated both issues: ${plural(outcome.newItems.length, 'new fail', 'new fails')}, ${plural(outcome.newChecks.length, 'new check', 'new checks')}, ${plural(outcome.moved.length, 'move', 'moves')} to the person`);

  out();
  out(`Verdict, computed: ${verdictText(verdict)}.`);
  if (outcome.ended?.why === 'cap' || outcome.ended?.why === 'budget') {
    warnLine(`${outcome.ended.why === 'cap' ? 'The loop hit its cap of 3 fixer rounds' : "The loop's budget ran out"} without an approving pass. ${plural(outcome.moved.length, 'fail', 'fails')} still failing moved to the person's issue, each with its repro steps. Say so plainly.`);
  }
  printNext(next, state.kept?.ticked ?? new Set(), info.issueUrl);
  return 0;
};

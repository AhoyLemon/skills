// Runs one audit role's session the same way for the finder and the certifier: start it, send back a report the runner can't accept while the shared caps allow, then check what the fences caught and whether the repository changed.
import { join } from 'node:path';

import { bold, failLine, heading, hintLine, out, warnLine } from './_ansi.ts';
import { addUsage, type Backend, type Role, type RoleSpec, type SessionResult, type Usage } from './_backend.ts';
import { treeChanges, treeState, type TreeChanges, type TreeState } from './_git.ts';
import { formatUsage, plural } from './_render.ts';
import { extractReportJson } from './_report.ts';
import { ALL_DENIES, computeOffLimits, offLimitsMentions, type PathMention } from './_rules.ts';
import { stateRoot, writeJson, type SessionRecord } from './_runs.ts';

export const MAX_ATTEMPTS = 3;

export type Checked<R> = { ok: true; report: R } | { ok: false; errors: string[] };

export interface AuditSpecInput {
  role: Extract<Role, 'finder' | 'certifier'>;
  root: string;
  scratch: string | null;
  transcriptPath: string;
  ignored: string[];
  agentPaths: string[];
  model: string;
  effort: string;
  maxTurns: number;
  maxBudgetUsd: number;
  timeoutMs: number;
}

// The finder and the certifier are isolated identically: read-only, every deny, the same off-limits list worked out from disk. Only the brief differs, so one dry run proves what both load.
export const auditSpec = (input: AuditSpecInput): RoleSpec => ({
  role: input.role,
  brief: '',
  cwd: input.root,
  scratch: input.scratch,
  readOnly: true,
  noTools: false,
  deny: ALL_DENIES,
  offLimits: computeOffLimits({ repoRoot: input.root, runsRoot: stateRoot(), scratch: input.scratch, ignoredInRepo: input.ignored, agentPaths: input.agentPaths }),
  model: input.model,
  effort: input.effort,
  maxTurns: input.maxTurns,
  maxBudgetUsd: input.maxBudgetUsd,
  timeoutMs: input.timeoutMs,
  transcriptPath: input.transcriptPath,
});

export interface RoleRun<R> {
  sessionId: string;
  attempts: number;
  usage: Usage;
  denials: number;
  unreported: boolean;
  errors: string[];
  toolInputs: string[];
  finalTexts: string[];
  checked: Checked<R>;
  raw: unknown;
}

const fixMessage = (errors: string[]): string =>
  [
    "The runner can't accept your report yet. Fix every problem below, then send the complete corrected report as one ```json block (the whole report, not just the changes), with nothing after it.",
    '',
    ...errors.slice(0, 80).map((error) => `- ${error}`),
    errors.length > 80 ? `- ...and ${errors.length - 80} more like these` : '',
  ].join('\n');

// The last result holding a valid report wins. If none is valid, the last JSON object is the one whose problems go back to the session.
const reportFrom = <R>(session: SessionResult, validate: (raw: unknown) => Checked<R>): { checked: Checked<R>; raw: unknown } => {
  const candidates = [...session.finalTexts].reverse().map(extractReportJson).filter((parsed) => typeof parsed === 'object' && parsed !== null);
  for (const raw of candidates) {
    const checked = validate(raw);
    if (checked.ok) return { checked, raw };
  }
  return { checked: validate(candidates[0]), raw: candidates[0] };
};

// Without a result event a session reports no cost or turns, so its spend is unknown and a retry would be handed a budget that may already be gone.
const reportedUsage = (session: SessionResult): boolean => session.usage.turns > 0;

export const runRole = async <R>(backend: Backend, spec: RoleSpec, validate: (raw: unknown) => Checked<R>): Promise<RoleRun<R>> => {
  const startedAt = Date.now();
  let session = await backend.start(spec);
  try {
    let usage: Usage = session.usage;
    let attempts = 1;
    let denials = session.permissionDenials;
    let unreported = !reportedUsage(session);
    const errors = [...session.errors];
    const toolInputs = [...session.toolInputs];
    let attempt = reportFrom(session, validate);
    const stoppedAtStart = session.errors.some((error) => error.startsWith('stopped at start'));
    // Retries share the caps the user agreed to. Each one gets only what's left, and none starts without a useful amount left.
    while (!attempt.checked.ok && !stoppedAtStart && session.sessionId && reportedUsage(session) && attempts < MAX_ATTEMPTS) {
      const left = { usd: spec.maxBudgetUsd - (usage.costUsd ?? 0), turns: spec.maxTurns - usage.turns, ms: spec.timeoutMs - (Date.now() - startedAt) };
      if ((usage.costUsd !== null && (left.usd < 0.5 || left.turns < 5)) || left.ms < 2 * 60_000) {
        warnLine('the report has problems, but too little of the budget, turns or time is left to send them back');
        break;
      }
      warnLine(`the report has ${attempt.checked.ok ? 0 : attempt.checked.errors.length} problem(s), so the runner is sending them back (attempt ${attempts + 1} of ${MAX_ATTEMPTS})`);
      const retry = { ...spec, maxBudgetUsd: Number(left.usd.toFixed(2)), maxTurns: Math.floor(left.turns), timeoutMs: left.ms };
      session = await backend.resume(retry, session.sessionId, fixMessage(attempt.checked.ok ? [] : attempt.checked.errors));
      usage = addUsage(usage, session.usage);
      denials += session.permissionDenials;
      unreported ||= !reportedUsage(session);
      errors.push(...session.errors);
      toolInputs.push(...session.toolInputs);
      attempts += 1;
      attempt = reportFrom(session, validate);
    }
    // A session stopped at its first event, or one that never said what it loaded, isn't trusted, whatever it reported.
    const untrusted = errors.filter((error) => error.startsWith('stopped at start'));
    const checked: Checked<R> = untrusted.length > 0 ? { ok: false, errors: untrusted } : attempt.checked;
    return { sessionId: session.sessionId, attempts, usage, denials, unreported, errors, toolInputs, finalTexts: session.finalTexts, checked, raw: attempt.raw };
  } finally {
    backend.finish?.(session.sessionId);
  }
};

export interface Aftermath {
  changes: TreeChanges;
  mentions: PathMention[];
  record: SessionRecord;
}

// What the run left behind: tree changes against the snapshot taken before it, and every tool call checked against the off-limits paths, since a shell can read past the rules.
export const aftermath = <R>(run: RoleRun<R>, spec: RoleSpec, root: string, before: TreeState, allowIgnored: string[]): Aftermath => {
  const changes = treeChanges(before, treeState(root), allowIgnored);
  const mentions = offLimitsMentions(run.toolInputs, spec.offLimits, root);
  const record: SessionRecord = { sessionId: run.sessionId, attempts: run.attempts, usage: run.usage, transcriptPath: spec.transcriptPath, errors: run.errors, permissionDenials: run.denials, offLimitsMentions: mentions, strays: changes.tree, ignoredStrays: changes.ignored, valid: run.checked.ok, reportSha256: null };
  return { changes, mentions, record };
};

// Prints what the fences caught, and saves an unusable report's problems. Returns false when there's no report to go on with.
export const printAftermath = <R>(run: RoleRun<R>, after: Aftermath, spec: RoleSpec, dir: string): boolean => {
  const who = spec.role;
  heading('Result');
  for (const error of run.errors) warnLine(error);
  if (run.unreported) warnLine('a session ended without reporting its cost, so the cost below is too low');
  if (run.denials > 0) warnLine(`the ${who} tried ${plural(run.denials, 'thing', 'things')} its rules deny. The transcript shows what: ${spec.transcriptPath}`);
  if (after.mentions.length > 0) {
    failLine(`Tool calls named paths the ${who} must never read. A shell can read past the rules, so show the user these and the transcript before filing:`);
    for (const mention of after.mentions) hintLine(`${mention.path} (${plural(mention.count, 'tool call', 'tool calls')})`);
  }
  if (after.changes.tree.length > 0) {
    failLine(`The ${who} changed tracked or untracked files in the repository, which it must never do:`);
    for (const stray of after.changes.tree) hintLine(stray);
  }
  if (after.changes.ignored.length > 0) {
    failLine(`Gitignored paths appeared or vanished while the ${who} ran:`);
    for (const path of after.changes.ignored) hintLine(path);
    hintLine('If one came from your own dev server (a cache folder, say), file with --allow-ignored for it, and pass it at intake next time.');
  }
  if (!run.checked.ok) {
    writeJson(join(dir, 'report-invalid.json'), { errors: run.checked.errors, raw: run.raw ?? run.finalTexts.at(-1) ?? null });
    failLine(`No usable report after ${run.attempts} attempt(s). Its problems are saved in ${join(dir, 'report-invalid.json')}.`);
    out(`Cost: ${formatUsage(run.usage)}`);
    return false;
  }
  return true;
};

export const strayLines = (after: Aftermath): string[] => [...after.changes.tree, ...after.changes.ignored.map((path) => `new or gone gitignored path: ${path}`)];

export const nextLine = (strays: string[], runId: string): void => {
  out();
  out(strays.length > 0 ? bold('Stop and show the user the changes above before filing anything.') : bold(`Next: node runner.ts file --run ${runId}`));
};

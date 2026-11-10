// Files a validated run as two cross-linked GitHub issues, or writes them locally with --preview.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { bold, failLine, heading, okLine, out } from './_ansi.ts';
import type { Options } from './_args.ts';
import { addUsage } from './_backend.ts';
import { banner } from './_copy.ts';
import { fileIssues, type GhClient } from './_filing.ts';
import { commentOn, createIssue, editIssueBody, ensureLabel, ghSignedIn, repoInfo } from './_gh.ts';
import { slugText } from './_git.ts';
import { formatUsage, plural, renderAgentIssue, renderPersonIssue, renderRawComments, type RunFacts } from './_render.ts';
import { tallyOf, type FinderReport } from './_report.ts';
import { emptyFiled, findRunDir, readJson, reportHash, writeJson, type FiledRecord, type RunMeta } from './_runs.ts';

const realGh: GhClient = { ensureLabel, createIssue, editIssueBody, commentOn };

const factsFrom = (meta: RunMeta): RunFacts => {
  if (!meta.finder) throw new Error('This run has no finder record');
  return {
    runId: meta.runId,
    level: meta.level,
    scope: meta.scope,
    repo: meta.repo,
    commit: meta.commit,
    branch: meta.branch,
    baseUrl: meta.baseUrl,
    browser: meta.browser,
    axe: meta.axe,
    backend: meta.backend,
    model: meta.model,
    effort: meta.effort,
    usage: meta.finder.usage,
    dryRunUsage: meta.dryRun?.usage ?? null,
    finishedAt: meta.finishedAt ?? meta.createdAt,
  };
};

const writePreview = (dir: string, report: FinderReport, facts: RunFacts): void => {
  const preview = join(dir, 'preview');
  mkdirSync(preview, { recursive: true });
  const agent = renderAgentIssue(report, facts, { personUrl: '#preview-person-issue' });
  const person = renderPersonIssue(report, facts, { agentUrl: '#preview-agent-issue' });
  writeFileSync(join(preview, 'agent-issue.md'), `# ${agent.title}\n\n${agent.body}`);
  agent.comments.forEach((comment, i) => writeFileSync(join(preview, `agent-issue-comment-${i + 1}.md`), comment));
  writeFileSync(join(preview, 'person-issue.md'), `# ${person.title}\n\n${person.body}`);
  person.comments.forEach((comment, i) => writeFileSync(join(preview, `person-issue-comment-${i + 1}.md`), comment));
  renderRawComments(report, facts).forEach((comment, i) => writeFileSync(join(preview, `raw-report-comment-${i + 1}.md`), comment));
  okLine(`Preview written to ${preview}. Nothing was filed.`);
};

// Every reason not to file a run, checked before anything reaches GitHub.
export const fileRefusal = (meta: RunMeta, reportText: string | null, allowIgnored: string[]): string | null => {
  const finder = meta.finder;
  if (!finder?.valid || reportText === null) return `Run ${meta.runId} has no validated report to file`;
  if (finder.errors.some((error) => error.startsWith('stopped at start'))) return `Run ${meta.runId}'s session was stopped at its first event (${finder.errors.join('. ')}), so nothing it reported can be filed. Show the user, and run the dry run and the finder again`;
  if (!finder.reportSha256 || reportHash(reportText) !== finder.reportSha256) return `The report for run ${meta.runId} changed after the finder ran. actua11y files only what the finder reported and the runner checked, so run the finder again rather than editing its report`;
  if (finder.strays.length > 0) return `Run ${meta.runId} changed tracked or untracked files in the repository while it ran. Show the user, and run the finder again on a clean tree`;
  const unexplained = finder.ignoredStrays.filter((path) => !allowIgnored.includes(path.replace(/\/$/, '')));
  if (unexplained.length > 0) return `Gitignored paths appeared or vanished while the finder ran: ${unexplained.join(', ')}. Show the user. If they confirm a path came from their own dev server (a cache folder, say), file with --allow-ignored for each one`;
  return null;
};

export const cmdFile = (options: Options): number => {
  if (!options.run) throw new Error('Pass --run <run-id>, the id `run finder` printed');
  const dir = findRunDir(options.run);
  if (!dir) throw new Error(`No local record of run ${options.run}`);
  const meta = readJson<RunMeta>(join(dir, 'meta.json'));
  banner(meta.level);
  const reportPath = join(dir, 'report.json');
  const reportText = existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : null;
  const refusal = fileRefusal(meta, reportText, options.allowIgnored);
  if (refusal !== null || reportText === null || meta.finder === null) throw new Error(refusal ?? `Run ${meta.runId} has no report`);
  const report = JSON.parse(reportText) as FinderReport;
  const facts = factsFrom(meta);
  const slug = slugText(meta.repo);

  if (options.preview) {
    writePreview(dir, report, facts);
    return 0;
  }

  if (!ghSignedIn()) throw new Error('gh is not signed in. Run `gh auth login`');
  const info = repoInfo(slug);
  if (!info?.hasIssuesEnabled) throw new Error(`Can't file on ${slug}: it's unreachable with gh, or its issues are off`);

  const filedPath = join(dir, 'filed.json');
  const filed: FiledRecord = existsSync(filedPath) ? { ...emptyFiled(), ...readJson<Partial<FiledRecord>>(filedPath) } : emptyFiled();
  heading(`Filing on ${slug}`);
  try {
    fileIssues({ report, facts, slug, filed, gh: realGh, save: () => writeJson(filedPath, filed), progress: okLine });
  } catch (error) {
    failLine(`Filing stopped partway: ${error instanceof Error ? error.message : String(error)}`);
    out(`Run the same command again to pick up where it stopped. Progress is in ${filedPath}.`);
    return 1;
  }

  const tally = tallyOf(report);
  const total = meta.dryRun ? addUsage(meta.finder.usage, meta.dryRun.usage) : meta.finder.usage;
  heading('Assess-only: done');
  out(`  For agents: ${filed.agentUrl} (${plural(tally.failItems, 'fail', 'fails')} in ${plural(tally.fail, 'criterion', 'criteria')})`);
  out(`  For you:    ${filed.personUrl} (${plural(tally.checkItems, 'check', 'checks')})`);
  out(`  Cost, dry run and finder together: ${formatUsage(total)}`);
  out();
  out(bold("That's the whole assess-only run. None of it is a certificate: the person's issue is the part only you can do."));
  return 0;
};

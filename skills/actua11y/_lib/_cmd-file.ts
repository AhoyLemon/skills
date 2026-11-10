// Files a validated run: a finder run as two cross-linked GitHub issues (or locally with --preview), a certifier run as a PR comment plus updates to both issues.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { bold, failLine, heading, okLine, out } from './_ansi.ts';
import type { Options } from './_args.ts';
import { addUsage } from './_backend.ts';
import { fileCertifierRun } from './_cmd-certifier.ts';
import { banner } from './_copy.ts';
import { fileIssues, type GhClient } from './_filing.ts';
import { commentOn, createIssue, editIssueBody, ensureLabel, ghSignedIn, repoInfo } from './_gh.ts';
import { slugText } from './_git.ts';
import { initialLedger, type LoopView } from './_ledger.ts';
import { realLoopGh } from './_loop.ts';
import { formatUsage, freshKept, plural, renderAgentIssue, renderPersonIssue, renderRawComments, type RunFacts } from './_render.ts';
import { tallyOf, type FinderReport } from './_report.ts';
import { emptyFiled, findRunDir, readJson, reportHash, writeJson, type FiledRecord, type RunMeta } from './_runs.ts';

const realGh: GhClient = { ensureLabel, createIssue, editIssueBody, commentOn };

export const factsFrom = (meta: RunMeta): RunFacts => {
  if (!meta.session) throw new Error(`Run ${meta.runId} has no session record`);
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
    usage: meta.session.usage,
    dryRunUsage: meta.dryRun?.usage ?? null,
    fences: { denials: meta.session.permissionDenials ?? 0, mentions: (meta.session.offLimitsMentions ?? []).reduce((sum, mention) => sum + mention.count, 0) },
    served: meta.served ?? null,
    finishedAt: meta.finishedAt ?? meta.createdAt,
  };
};

const writePreview = (dir: string, report: FinderReport, facts: RunFacts, site: RunMeta['site']): void => {
  const preview = join(dir, 'preview');
  mkdirSync(preview, { recursive: true });
  const view: LoopView = { ledger: { ...initialLedger(report, facts, site), personUrl: '#preview-person-issue' }, finder: report, passes: new Map() };
  const agent = renderAgentIssue(view, { personUrl: '#preview-person-issue' });
  const person = renderPersonIssue(view, { agentUrl: '#preview-agent-issue' }, freshKept());
  writeFileSync(join(preview, 'agent-issue.md'), `# ${agent.title}\n\n${agent.body}`);
  agent.comments.forEach((comment, i) => writeFileSync(join(preview, `agent-issue-comment-${i + 1}.md`), comment.body));
  writeFileSync(join(preview, 'person-issue.md'), `# ${person.title}\n\n${person.body}`);
  person.comments.forEach((comment, i) => writeFileSync(join(preview, `person-issue-comment-${i + 1}.md`), comment.body));
  renderRawComments(report, facts).forEach((comment, i) => writeFileSync(join(preview, `raw-report-comment-${i + 1}.md`), comment));
  okLine(`Preview written to ${preview}. Nothing was filed.`);
};

// Every reason not to file a run, checked before anything reaches GitHub.
export const fileRefusal = (meta: RunMeta, reportText: string | null, allowIgnored: string[]): string | null => {
  const session = meta.session;
  const who = meta.role;
  if (!session?.valid || reportText === null) return `Run ${meta.runId} has no validated report to file`;
  if (session.errors.some((error) => error.startsWith('stopped at start'))) return `Run ${meta.runId}'s session was stopped at its first event (${session.errors.join('. ')}), so nothing it reported can be filed. Show the user, and run the dry run and the ${who} again`;
  if (!session.reportSha256 || reportHash(reportText) !== session.reportSha256) return `The report for run ${meta.runId} changed after the ${who} ran. actua11y files only what the ${who} reported and the runner checked, so run the ${who} again rather than editing its report`;
  if (session.strays.length > 0) return `Run ${meta.runId} changed tracked or untracked files in the repository while it ran. Show the user, and run the ${who} again on a clean tree`;
  const unexplained = session.ignoredStrays.filter((path) => !allowIgnored.includes(path.replace(/\/$/, '')));
  if (unexplained.length > 0) return `Gitignored paths appeared or vanished while the ${who} ran: ${unexplained.join(', ')}. Show the user. If they confirm a path came from their own dev server (a cache folder, say), file with --allow-ignored for each one`;
  return null;
};

const fileFinderRun = (options: Options, meta: RunMeta, dir: string, reportText: string): number => {
  if (!meta.session) throw new Error(`Run ${meta.runId} has no session record`);
  const report = JSON.parse(reportText) as FinderReport;
  const facts = factsFrom(meta);
  const slug = slugText(meta.repo);

  if (options.preview) {
    writePreview(dir, report, facts, meta.site);
    return 0;
  }

  if (!ghSignedIn()) throw new Error('gh is not signed in. Run `gh auth login`');
  const info = repoInfo(slug);
  if (!info?.hasIssuesEnabled) throw new Error(`Can't file on ${slug}: it's unreachable with gh, or its issues are off`);

  const filedPath = join(dir, 'filed.json');
  const filed: FiledRecord = existsSync(filedPath) ? { ...emptyFiled(), ...readJson<Partial<FiledRecord>>(filedPath) } : emptyFiled();
  heading(`Filing on ${slug}`);
  try {
    fileIssues({ report, facts, site: meta.site, slug, filed, gh: realGh, save: () => writeJson(filedPath, filed), progress: okLine });
  } catch (error) {
    failLine(`Filing stopped partway: ${error instanceof Error ? error.message : String(error)}`);
    out(`Run the same command again to pick up where it stopped. Progress is in ${filedPath}.`);
    return 1;
  }

  const tally = tallyOf(report);
  const total = meta.dryRun ? addUsage(meta.session.usage, meta.dryRun.usage) : meta.session.usage;
  const number = filed.agentUrl?.split('/').at(-1) ?? '<n>';
  heading('Filed');
  out(`  For agents: ${filed.agentUrl} (${plural(tally.failItems, 'fail', 'fails')} in ${plural(tally.fail, 'criterion', 'criteria')})`);
  out(`  For you:    ${filed.personUrl} (${plural(tally.checkItems, 'check', 'checks')})`);
  out(`  Cost, dry run and finder together: ${formatUsage(total)}`);
  out();
  out(bold("Assess-only stops here. None of it is a certificate: the person's issue is the part only you can do."));
  out(`For the fix-and-certify loop: node runner.ts loop start --issue ${number}`);
  return 0;
};

export const cmdFile = async (options: Options): Promise<number> => {
  if (!options.run) throw new Error('Pass --run <run-id>, the id `run finder` or `run certifier` printed');
  const dir = findRunDir(options.run);
  if (!dir) throw new Error(`No local record of run ${options.run}`);
  const meta = readJson<RunMeta>(join(dir, 'meta.json'));
  banner(meta.level);
  const reportPath = join(dir, 'report.json');
  const reportText = existsSync(reportPath) ? readFileSync(reportPath, 'utf8') : null;
  const refusal = fileRefusal(meta, reportText, options.allowIgnored);
  if (refusal !== null || reportText === null) throw new Error(refusal ?? `Run ${meta.runId} has no report`);
  if (meta.role === 'certifier') return fileCertifierRun({ options, meta, dir, reportText, client: realLoopGh });
  return fileFinderRun(options, meta, dir, reportText);
};

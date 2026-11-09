// Files a validated run as two cross-linked GitHub issues. Every step is recorded as it lands, so a rerun picks up where a failure left off instead of filing twice.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { bold, failLine, heading, okLine, out } from './_ansi.ts';
import type { Options } from './_args.ts';
import { addUsage } from './_backend.ts';
import { banner } from './_copy.ts';
import { commentOn, createIssue, editIssueBody, ensureLabel, ghSignedIn, repoInfo } from './_gh.ts';
import { slugText } from './_git.ts';
import { formatUsage, renderAgentIssue, renderPersonIssue, renderRawComments, type RunFacts } from './_render.ts';
import { tallyOf, type FinderReport } from './_report.ts';
import { emptyFiled, findRunDir, readJson, writeJson, type FiledRecord, type RunMeta } from './_runs.ts';

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

export const cmdFile = (options: Options): number => {
  if (!options.run) throw new Error('Pass --run <run-id>, the id `run finder` printed');
  const dir = findRunDir(options.run);
  if (!dir) throw new Error(`No local record of run ${options.run}`);
  const meta = readJson<RunMeta>(join(dir, 'meta.json'));
  banner(meta.level);
  if (!meta.finder?.valid || !existsSync(join(dir, 'report.json'))) throw new Error(`Run ${meta.runId} has no validated report to file`);
  if (meta.finder.strays.length > 0) throw new Error(`Run ${meta.runId} changed the repository while it ran. Show the user, and run the finder again on a clean tree`);
  const report = readJson<FinderReport>(join(dir, 'report.json'));
  const facts = factsFrom(meta);
  const slug = slugText(meta.repo);

  if (options.preview) {
    const preview = join(dir, 'preview');
    mkdirSync(preview, { recursive: true });
    const agent = renderAgentIssue(report, facts, { personUrl: '#preview-person-issue' });
    const person = renderPersonIssue(report, facts, { agentUrl: '#preview-agent-issue' });
    writeFileSync(join(preview, 'agent-issue.md'), `# ${agent.title}\n\n${agent.body}`);
    if (agent.evidenceComment) writeFileSync(join(preview, 'agent-issue-first-comment.md'), agent.evidenceComment);
    writeFileSync(join(preview, 'person-issue.md'), `# ${person.title}\n\n${person.body}`);
    renderRawComments(report, facts).forEach((comment, i) => writeFileSync(join(preview, `raw-report-comment-${i + 1}.md`), comment));
    okLine(`Preview written to ${preview}. Nothing was filed.`);
    return 0;
  }

  if (!ghSignedIn()) throw new Error('gh is not signed in. Run `gh auth login`');
  const info = repoInfo(slug);
  if (!info?.hasIssuesEnabled) throw new Error(`Can't file on ${slug}: it's unreachable with gh, or its issues are off`);

  const filedPath = join(dir, 'filed.json');
  const filed: FiledRecord = existsSync(filedPath) ? readJson<FiledRecord>(filedPath) : emptyFiled();
  const save = (): void => writeJson(filedPath, filed);

  heading(`Filing on ${slug}`);
  ensureLabel(slug);
  try {
    if (!filed.agentUrl) {
      const agent = renderAgentIssue(report, facts, { personUrl: null });
      filed.agentUrl = createIssue({ slug, title: agent.title, body: agent.body, assignToMe: false });
      save();
      okLine(`agent issue: ${filed.agentUrl}`);
      if (agent.evidenceComment) {
        filed.evidenceCommentUrl = commentOn(filed.agentUrl, agent.evidenceComment);
        save();
      }
    }
    if (!filed.personUrl) {
      const person = renderPersonIssue(report, facts, { agentUrl: filed.agentUrl });
      filed.personUrl = createIssue({ slug, title: person.title, body: person.body, assignToMe: true });
      save();
      okLine(`person's issue (assigned to you): ${filed.personUrl}`);
    }
    if (!filed.agentLinked) {
      editIssueBody(filed.agentUrl, renderAgentIssue(report, facts, { personUrl: filed.personUrl }).body);
      filed.agentLinked = true;
      save();
      okLine('cross-linked the two');
    }
    const raw = renderRawComments(report, facts);
    for (let i = filed.rawCommentUrls.length; i < raw.length; i += 1) {
      filed.rawCommentUrls.push(commentOn(filed.agentUrl, raw[i] ?? ''));
      save();
    }
    okLine('attached the finder\'s raw report, collapsed');
  } catch (error) {
    failLine(`Filing stopped partway: ${error instanceof Error ? error.message : String(error)}`);
    out(`Run the same command again to pick up where it stopped. Progress is in ${filedPath}.`);
    return 1;
  }

  const tally = tallyOf(report);
  const total = meta.dryRun ? addUsage(meta.finder.usage, meta.dryRun.usage) : meta.finder.usage;
  heading('Assess-only: done');
  out(`  For agents: ${filed.agentUrl} (${tally.failItems} fail(s) in ${tally.fail} criteria)`);
  out(`  For you:    ${filed.personUrl} (${tally.checkItems} check(s))`);
  out(`  Cost, dry run and finder together: ${formatUsage(total)}`);
  out();
  out(bold("That's the whole assess-only run. None of it is a certificate: the person's issue is the part only you can do."));
  return 0;
};

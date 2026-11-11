// The human round's commands: record what the person found and decided, in their own words, close out once a pass approves, and serve a static site so they have a URL to test.
import { join } from 'node:path';

import { bold, heading, hintLine, okLine, out } from './_ansi.ts';
import type { Options } from './_args.ts';
import { openLoop, nextStep } from './_cmd-loop.ts';
import { banner } from './_copy.ts';
import { criterionByNum } from './_criteria.ts';
import { onExit } from './_exec.ts';
import { commitsBetween, commitSubject, currentBranch, headCommit, repoRoot, upstreamState } from './_git.ts';
import { closeOutCheck, foundVerbatim, personSources } from './_human.ts';
import { addHuman, decide, insideTarget, type Decision, type Ledger } from './_ledger.ts';
import { saveLoop, type LoopGh } from './_loop.ts';
import { plural } from './_render.ts';
import { renderCloseOutBody } from './_render-loop.ts';
import { serveStatic } from './_serve.ts';

// Every refusal ends the same way: the words have to be the person's, in their issue, before anything records them.
const NOT_FOUND = "in the person's issue, word for word. Ask them to write it in the section for their own notes (or in a comment on their issue), then record it exactly as they wrote it";

const decisionFrom = (options: Options, sources: string[]): Decision => {
  if (!options.decision) throw new Error('Pass --decision fix, accept or na. It\'s the person\'s call, so ask them');
  if (options.decision === 'fix') {
    if (options.reason) throw new Error('A fix takes --how, the person\'s words on how they want it solved, not --reason');
    if (options.how && !foundVerbatim(options.how, sources)) throw new Error(`How they want it solved isn't ${NOT_FOUND}`);
    return { choice: 'fix', reason: null, how: options.how?.trim() ?? null };
  }
  if (options.how) throw new Error('--how is only for a fix. Accepting as is, or calling it not applicable, takes --reason');
  if (!options.reason) throw new Error(`Accepting as is, or calling it not applicable, needs the person's reason. Pass --reason with their words`);
  if (!foundVerbatim(options.reason, sources)) throw new Error(`The reason isn't ${NOT_FOUND}`);
  return { choice: options.decision, reason: options.reason, how: null };
};

const requireLoop = (ledger: Ledger): void => {
  if (ledger.stage === 'filed') throw new Error('The loop hasn\'t started. Run `loop start` first');
  if (ledger.stage === 'closed') throw new Error('This loop is already closed out');
};

export const cmdRecordFinding = (options: Options, client: LoopGh): number => {
  const { ledger, state, agentUrl } = openLoop(options, client);
  banner(ledger.facts.level);
  requireLoop(ledger);
  if (!options.words) throw new Error('Pass --words with what the person wrote, exactly');
  const sources = personSources(state.person);
  if (!foundVerbatim(options.words, sources)) throw new Error(`Those words aren't ${NOT_FOUND}`);
  if (!options.criterion && !options.ux) throw new Error('Pass --criterion <num> for a WCAG finding, or --ux for a UX one. Ask the person if it isn\'t clear');
  if (options.criterion && !criterionByNum(options.criterion)) throw new Error(`${options.criterion} isn't a WCAG 2.2 criterion`);
  const tag = options.criterion ? { kind: 'wcag' as const, num: options.criterion } : { kind: 'ux' as const };
  const check = options.check?.toUpperCase() ?? null;
  const { ledger: next, id } = addHuman(ledger, { words: options.words.trim(), tag, decision: decisionFrom(options, sources), check });
  saveLoop(client, state, { ledger: next, passes: state.view.passes });
  const where = tag.kind === 'ux' ? 'UX, outside WCAG' : `WCAG ${tag.num}, ${insideTarget(tag.num, ledger.facts.level) ? 'inside' : 'outside'} the target`;
  okLine(`recorded ${id} (${where}) on the person's issue, in their words${check ? `, settling check ${check}` : ''}`);
  out(nextStep(next, state.kept?.ticked ?? new Set(), agentUrl).says);
  return 0;
};

export const cmdRecordDecision = (options: Options, client: LoopGh): number => {
  const { ledger, state, agentUrl } = openLoop(options, client);
  banner(ledger.facts.level);
  requireLoop(ledger);
  if (!options.item) throw new Error('Pass --item with the id it\'s about, like A7 or H2');
  const next = decide(ledger, options.item.toUpperCase(), decisionFrom(options, personSources(state.person)));
  saveLoop(client, state, { ledger: next, passes: state.view.passes });
  okLine(`recorded the person's decision on ${options.item.toUpperCase()}`);
  out(nextStep(next, state.kept?.ticked ?? new Set(), agentUrl).says);
  return 0;
};

const daysBetween = (from: string, to: Date): number => Math.max(0, Math.round((to.getTime() - Date.parse(from)) / 86_400_000));

export const cmdCloseOut = (options: Options, client: LoopGh): number => {
  const { root, ledger, state, agentUrl } = openLoop(options, client);
  banner(ledger.facts.level);
  const pr = state.pr;
  if (!pr || !ledger.loop?.pr) throw new Error("There's no PR, so there's nothing to merge. If nothing needed fixing, the person can close the two issues themselves once they're satisfied");
  const ticked = state.kept?.ticked ?? new Set<string>();
  const check = closeOutCheck(ledger, ticked, options.atCap);
  if (check.refusals.length > 0 || !check.latest) {
    out(bold('Not closing out yet:'));
    for (const refusal of check.refusals) hintLine(refusal);
    return 1;
  }
  if (currentBranch(root) !== ledger.loop.branch) throw new Error(`Switch to ${ledger.loop.branch} first, so the runner can see what landed after the last pass`);
  const upstream = upstreamState(root);
  if (upstream.ahead > 0 || upstream.behind > 0 || headCommit(root) !== pr.headSha) throw new Error("The local branch doesn't match the PR's head. Push or pull until it does");
  const uncertified = commitsBetween(root, check.latest.sha, pr.headSha).map((sha) => ({ sha, subject: commitSubject(root, sha) }));
  if (uncertified.length > 0 && !options.uncertifiedOk) {
    out(bold(`${plural(uncertified.length, 'commit', 'commits')} landed after the last pass, and no blind certifier has seen them:`));
    for (const commit of uncertified) hintLine(`${commit.sha.slice(0, 12)} ${commit.subject}`);
    out('Run the certifier again (recommended), or pass --uncertified-ok to list them as uncertified in the PR.');
    return 1;
  }
  const agentNumber = Number(agentUrl.split('/').at(-1));
  const personNumber = Number(ledger.personUrl?.split('/').at(-1));
  const body = renderCloseOutBody(state.view, { agentNumber, personNumber, prNumber: pr.number, sha: check.latest.sha, pass: check.latest.n, approved: check.approved, uncertified, stillFailing: check.stillFailing, neverJudged: check.neverJudged, ticked, days: daysBetween(ledger.facts.finishedAt, new Date()), headSha: pr.headSha });

  heading('Closing out');
  client.editPrBody(pr.url, body);
  okLine('wrote the PR body: the summary, the commit to merge, and the closing lines last');
  if (pr.isDraft) client.markReady(pr.url);
  okLine('the PR is out of draft');
  const next: Ledger = { ...ledger, stage: 'closed', closed: { sha: check.latest.sha, at: new Date().toISOString(), uncertified: uncertified.map((commit) => commit.sha), atCap: check.atCap } };
  saveLoop(client, state, { ledger: next, passes: state.view.passes });
  out();
  out(bold(`Suggest this, and leave the merge to the person: gh pr merge ${pr.number} --match-head-commit ${uncertified.length > 0 ? pr.headSha : check.latest.sha}`));
  if (uncertified.length > 0) out(`  That pins the merge to the PR's head, which includes ${plural(uncertified.length, 'uncertified commit', 'uncertified commits')}, as the PR body says.`);
  return 0;
};

export const cmdServe = async (options: Options): Promise<number> => {
  const root = repoRoot(options.cwd);
  if (!root || !options.serve) throw new Error('Pass --serve <folder>, from inside the repository');
  const server = await serveStatic(join(root, options.serve));
  onExit(() => void server.close());
  out(`Serving ${options.serve} at ${server.url} until you stop this (Ctrl-C).`);
  await new Promise<never>(() => undefined);
  return 0;
};

// The fix-and-certify loop's own commands: start it, brief and record the fixer, stop the AI rounds early, and say where it stands. Every one rebuilds the loop from GitHub, so none depends on anything kept locally.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { bold, dim, failLine, heading, hintLine, okLine, out, warnLine } from './_ansi.ts';
import type { Options } from './_args.ts';
import { fillTemplate, readBrief } from './_brief.ts';
import { banner } from './_copy.ts';
import { levelLabel } from './_criteria.ts';
import { FIXER_SHAPE, validateFixerReport } from './_fixer.ts';
import { branchExists, commitsBetween, commitSubject, createBranch, currentBranch, headCommit, isAncestor, originSlug, parseGithubSlug, porcelain, pushBranch, repoRoot, slugText } from './_git.ts';
import { agentItems, applyFixer, budgetLeft, fixerRounds, fixerTargets, humanPassesSinceApproval, latestPass, MAX_FIXER_ROUNDS, MAX_HUMAN_PASSES, MIN_PASS_USD, passPlan, roundBase, startLoop, stopAi, waitingOnPerson, type Ledger, type LoopView } from './_ledger.ts';
import { ensurePr, loadLoop, postRun, resolveAgentUrl, runTarget, saveLoop, type LoopGh, type LoopState } from './_loop.ts';
import { formatUsage, plural } from './_render.ts';
import { fixerItemsText, renderFixerComments, renderReportBack } from './_render-loop.ts';
import { extractReportJson, isRecord } from './_report.ts';

export interface LoopContext {
  root: string;
  slug: string;
  agentUrl: string;
  state: LoopState;
  ledger: Ledger;
}

export const openLoop = (options: Options, client: LoopGh): LoopContext => {
  const root = repoRoot(options.cwd);
  if (!root) throw new Error(`${options.cwd} isn't inside a git repository`);
  // A full issue URL names the repository itself. Only a bare number, or nothing, needs origin to say which one.
  const fromUrl = options.issue ? parseGithubSlug(options.issue.replace(/\/issues\/\d+$/, '')) : null;
  const origin = fromUrl ?? originSlug(root);
  if (!origin) throw new Error("origin isn't a GitHub repository, so pass --issue with the agent issue's full URL");
  const slug = slugText(origin);
  const agentUrl = resolveAgentUrl(client, slug, options.issue);
  const state = loadLoop(client, agentUrl);
  return { root, slug, agentUrl, state, ledger: state.view.ledger };
};

const issueNumber = (url: string): string => url.split('/').at(-1) ?? '<n>';

export interface NextStep {
  says: string;
  command: string | null;
}

// What happens next, worked out from the ledger and the person's ticks alone.
export const nextStep = (ledger: Ledger, ticked: ReadonlySet<string>, agentUrl: string): NextStep => {
  const issue = `--issue ${issueNumber(agentUrl)}`;
  if (ledger.stage === 'filed') return { says: 'Filed, and assess-only stops here. The fix-and-certify loop starts when the user wants it.', command: `node runner.ts loop start ${issue}` };
  if (ledger.stage === 'closed') return { says: 'Closed out. The merge is the person\'s.', command: null };
  if (ledger.stage === 'ai') {
    const lastAi = ledger.rounds.filter((round) => round.stage === 'ai').at(-1);
    if (lastAi?.kind === 'fixer') return { says: `Fixer round ${lastAi.n} is recorded, so a blind certifier checks it next.`, command: `node runner.ts run certifier ${issue}` };
    if (budgetLeft(ledger) < MIN_PASS_USD) return { says: "The loop's budget is spent, so the AI rounds end here.", command: `node runner.ts loop stop ${issue}` };
    return { says: `Fixer round ${fixerRounds(ledger) + 1} of ${MAX_FIXER_ROUNDS}: hand a subagent the brief, unchanged.`, command: `node runner.ts brief fixer ${issue}` };
  }
  const waiting = waitingOnPerson(ledger, ticked);
  const latest = latestPass(ledger);
  const plan = passPlan(ledger);
  const unjudged = plan.items.filter((id) => {
    const judged = ledger.items.find((item) => item.id === id)?.judged ?? ledger.human.find((item) => item.id === id)?.judged ?? null;
    return judged === null || judged.pass !== latest?.n;
  });
  const lastHuman = ledger.rounds.filter((round) => round.stage === 'human').at(-1);
  const capped = humanPassesSinceApproval(ledger) >= MAX_HUMAN_PASSES;
  if (capped) return { says: `The human round hit its cap of ${MAX_HUMAN_PASSES} certifier runs without an approving pass. Close-out can still happen, and says so plainly.`, command: `node runner.ts close-out ${issue} --at-cap` };
  if (lastHuman?.kind === 'fixer') return { says: `Fixer round ${lastHuman.n} is recorded, so a blind certifier guards it next.`, command: `node runner.ts run certifier ${issue}` };
  const person: string[] = [];
  if (waiting.unticked.length > 0) person.push(`${plural(waiting.unticked.length, 'check', 'checks')} to tick or turn into a finding (${waiting.unticked.join(', ')})`);
  if (waiting.undecided.length > 0) person.push(`${plural(waiting.undecided.length, 'fail', 'fails')} to decide (${waiting.undecided.join(', ')})`);
  const waitingText = person.length > 0 ? ` Still waiting on the person: ${person.join(', and ')}.` : '';
  const toFix = fixerTargets(ledger);
  if (toFix.length > 0) return { says: `The human round. ${plural(toFix.length, 'thing', 'things')} to fix (${toFix.join(', ')}). Hand a subagent the fixer brief, or the person fixes things by hand and pushes, then a blind certifier guards the work.${waitingText}`, command: `node runner.ts brief fixer ${issue}` };
  // A pass can't settle a fail nobody has decided on yet, so the person decides before another one runs.
  if (waiting.undecided.length > 0) return { says: `The human round. Waiting on the person to decide ${waiting.undecided.join(', ')}: fix it (and how), accept it as it is, or not applicable (and why), in their own words in their issue.${waiting.unticked.length > 0 ? ` Also ${person[0] ?? ''}.` : ''}`, command: null };
  if (unjudged.length > 0 || latest?.approved !== true) return { says: `The human round. Once the fixes are pushed to the branch, a blind certifier guards them${unjudged.length > 0 ? ` (${unjudged.join(', ')} not yet judged at the latest commit)` : ''}.${waitingText}`, command: `node runner.ts run certifier ${issue}` };
  if (person.length > 0) return { says: `The latest pass approved.${waitingText}`, command: null };
  return { says: 'The latest pass approved, and the person has ticked, decided or turned into a finding everything.', command: `node runner.ts close-out ${issue}` };
};

const printNext = (step: NextStep): void => {
  out();
  out(step.says);
  if (step.command) out(bold(`Next: ${step.command}`));
};

export const cmdLoopStart = (options: Options, client: LoopGh): number => {
  const context = openLoop(options, client);
  const { root, ledger, state, agentUrl } = context;
  banner(ledger.facts.level);
  if (ledger.loop) throw new Error(`The loop for ${agentUrl} already started, on ${ledger.loop.branch}. Run \`node runner.ts status --issue ${issueNumber(agentUrl)}\``);
  if (porcelain(root).length > 0) throw new Error('The working tree has uncommitted or untracked changes. Commit, stash or remove them first: the loop cuts a branch from the audited commit');
  if (options.budgetUsd < ledger.spentUsd + MIN_PASS_USD) throw new Error(`A $${options.budgetUsd} budget leaves no room: $${ledger.spentUsd.toFixed(2)} is already spent on the dry run and the finder. Pass a bigger --budget-usd`);
  const branch = options.branch ?? `actua11y-${ledger.facts.level.toLowerCase()}-${issueNumber(agentUrl)}`;
  if (branchExists(root, branch)) throw new Error(`A branch called ${branch} already exists. Pass --branch with another name, in this project's own style if it has one`);

  heading('Starting the loop');
  createBranch(root, branch, ledger.facts.commit);
  pushBranch(root, branch);
  okLine(`cut ${branch} from the audited commit ${ledger.facts.commit.slice(0, 12)} and pushed it`);
  const next = startLoop(ledger, { branch, pr: null, budgetUsd: options.budgetUsd });
  const view: LoopView = { ...state.view, ledger: next };
  if (next.stage === 'human') {
    // No fails means nothing for a fixer, so the report back goes out now, on the agent issue, since there's no PR without a commit.
    postRun(client, runTarget(state, next), [renderReportBack(view, { agentUrl })]);
    okLine('the finder proved no fails, so the AI rounds are skipped and the human round starts');
  }
  saveLoop(client, state, { ledger: next, passes: state.view.passes });
  okLine(`budget for everything the runner starts: $${options.budgetUsd.toFixed(2)}, of which $${ledger.spentUsd.toFixed(2)} is already spent`);
  out(dim('The fixer runs as a subagent in this session, so its cost lands here and is reported as tokens and minutes, never counted against that budget.'));
  printNext(nextStep(next, state.kept?.ticked ?? new Set(), agentUrl));
  return 0;
};

export interface FixerBrief {
  text: string;
  id: string;
  items: string[];
  round: number;
}

// The brief names the commit its round starts at, so its id proves both what the fixer was told and where its own commits begin.
export const fixerBrief = (view: LoopView, root: string, base: string): FixerBrief => {
  const { ledger } = view;
  const items = fixerTargets(ledger);
  const round = fixerRounds(ledger) + 1;
  const human = ledger.stage === 'human';
  const aiRound = ledger.rounds.filter((entry) => entry.kind === 'fixer' && entry.stage === 'ai').length + 1;
  const body = fillTemplate(readBrief('fixer'), {
    REPO_ROOT: root,
    BRANCH: ledger.loop?.branch ?? '',
    LEVEL_LABEL: levelLabel(ledger.facts.level),
    INTRO: human
      ? 'Each item is either a fail a blind finder or certifier proved, with the file and line and, for behaviour, exact repro steps, or a problem a person found by using the site, in their own words.'
      : 'A blind finder or certifier proved each one, with the file and line, who it hurts and, for behaviour, exact repro steps.',
    ROUND_LINE: human
      ? "This is a fixer round in the human round. A person has used the site themselves, and every item here is theirs: something they found, or a proven fail they decided to fix, often with how they want it solved, in their own words. They're in the session with you."
      : `This is fixer round ${aiRound} of at most ${MAX_FIXER_ROUNDS}. ${aiRound === 1 ? 'Nothing on this list has been tried yet.' : "Earlier rounds already tried. Anything still failing carries the certifier's exact steps, so start from those."}`,
    BASE: base,
    NEEDS_PERSON: human
      ? "There's no `needsPerson` in this round: everything here is already the person's. If you can't do one, say partial or couldnt, and why, and they'll decide."
      : "`needsPerson` moves a finding to the person's issue with your reason, instead of sending it round the loop again. Use it when only a person can settle the rest: a design decision, or wording only the site's owner can choose.",
    COUNT: String(items.length),
    ITEMS: fixerItemsText(view, items),
    REPORT_SCHEMA: FIXER_SHAPE,
  });
  const id = createHash('sha256').update(body).digest('hex').slice(0, 12);
  return { text: `${body}\nBrief id: \`${id}\`. Put it in your report's \`brief\` field.\n`, id, items, round };
};

const requireFixerTurn = (ledger: Ledger, agentUrl: string): void => {
  const step = nextStep(ledger, new Set(), agentUrl);
  if (!step.command?.includes('brief fixer')) throw new Error(`It isn't the fixer's turn. ${step.says}${step.command ? ` Next: ${step.command}` : ''}`);
};

// Where a fixer round may start. In the AI rounds, only where the last pass left off, since nobody else commits then. In the human round, anywhere after it, since the person may have fixed some things by hand first.
const baseCandidates = (ledger: Ledger, root: string, head: string): string[] => {
  const from = roundBase(ledger);
  return ledger.stage === 'human' ? [from, ...commitsBetween(root, from, head)] : [from];
};

export const cmdBriefFixer = (options: Options, client: LoopGh): number => {
  const { root, ledger, state, agentUrl } = openLoop(options, client);
  requireFixerTurn(ledger, agentUrl);
  if (ledger.loop && currentBranch(root) !== ledger.loop.branch) throw new Error(`Switch to the loop's branch, ${ledger.loop.branch}, first. The fixer commits there`);
  const head = headCommit(root);
  if (!baseCandidates(ledger, root, head).includes(head)) throw new Error(ledger.stage === 'human' ? `HEAD isn't on the loop's branch past the last pass (${roundBase(ledger).slice(0, 12)}). Pull or switch until it is` : `Commits landed on ${ledger.loop?.branch ?? 'the branch'} since the last pass that no fixer round made. In the AI rounds only the fixer commits, so show the user`);
  out(fixerBrief(state.view, root, head).text);
  return 0;
};

const readStdin = (): string => {
  if (process.stdin.isTTY) throw new Error("Pipe the fixer's final message in on stdin, unchanged");
  return readFileSync(0, 'utf8');
};

export const cmdRecordFixer = (options: Options, client: LoopGh, input: string | null = null): number => {
  const { root, ledger, state, agentUrl } = openLoop(options, client);
  banner(ledger.facts.level);
  requireFixerTurn(ledger, agentUrl);
  const loop = ledger.loop;
  if (!loop) throw new Error('The loop hasn\'t started');
  if (currentBranch(root) !== loop.branch) throw new Error(`You're on ${currentBranch(root)}, not the loop's branch ${loop.branch}. Switch to it, with the fixer's commits on it`);
  const dirty = porcelain(root);
  if (dirty.length > 0) throw new Error(`The working tree isn't clean (${dirty.slice(0, 3).map((line) => line.slice(3)).join(', ')}). The fixer commits every change, so send it back to finish, or show the user`);
  const from = roundBase(ledger);
  const head = headCommit(root);
  if (!isAncestor(root, from, head)) throw new Error(`The branch no longer contains ${from.slice(0, 12)}, where this round began. Earlier commits were rewritten, which the fixer must never do`);
  const raw = extractReportJson(input ?? readStdin());
  // The report's brief id says which commit the round started at: the one whose brief hashes to it. Anything before that is the person's own.
  const claimed = isRecord(raw) && typeof raw['brief'] === 'string' ? raw['brief'] : '';
  const base = baseCandidates(ledger, root, head).find((candidate) => fixerBrief(state.view, root, candidate).id === claimed) ?? from;
  const brief = fixerBrief(state.view, root, base);
  const commits = commitsBetween(root, base, head);
  const before = commitsBetween(root, from, base);
  const checked = validateFixerReport(raw, { briefId: brief.id, items: brief.items, commits, allowNeedsPerson: ledger.stage !== 'human' });
  if (!checked.ok) {
    failLine(`The fixer's report has ${plural(checked.errors.length, 'problem', 'problems')}:`);
    for (const error of checked.errors) hintLine(error);
    out();
    out(bold('Send these back to the fixer (the same subagent, if you can), then record its whole corrected report again.'));
    return 1;
  }
  const report = checked.report;

  heading(`Recording fixer round ${brief.round}`);
  if (commits.length + before.length > 0) {
    pushBranch(root, loop.branch);
    okLine(`pushed ${plural(commits.length, 'commit', 'commits')} from the fixer${before.length > 0 ? ` and ${plural(before.length, 'commit', 'commits')} the person made first` : ''} to ${loop.branch}`);
  }
  const pr = ensurePr(client, ledger, state.view, agentUrl, commitsBetween(root, ledger.facts.commit, head).length > 0);
  if (pr && !ledger.loop?.pr) okLine(`opened the draft PR: ${pr}`);
  const withPr: Ledger = { ...ledger, loop: { ...loop, pr } };
  const reported = { tokens: options.tokens, minutes: options.minutes };
  const subjects = (shas: string[]): { sha: string; subject: string }[] => shas.map((sha) => ({ sha, subject: commitSubject(root, sha) }));
  const comments = renderFixerComments(state.view, report, { round: brief.round, reportId: createHash('sha256').update(JSON.stringify(report)).digest('hex').slice(0, 12), stage: ledger.stage === 'human' ? 'human' : 'ai', sha: head, base, commits: subjects(commits), before: subjects(before), reported });
  const urls = postRun(client, runTarget(state, withPr), comments);
  okLine(`posted the fixer's report: ${urls[0] ?? ''}`);
  const next = applyFixer(withPr, report, { round: brief.round, sha: head, base, at: new Date().toISOString(), reported, commentUrls: urls });
  saveLoop(client, state, { ledger: next, passes: state.view.passes });
  const moved = report.findings.filter((finding) => finding.needsPerson).length;
  const count = (outcome: string): number => report.findings.filter((finding) => finding.outcome === outcome).length;
  okLine(`claimed: ${count('fixed')} fixed, ${count('partial')} in part. Couldn't: ${count('couldnt')}.${ledger.stage === 'human' ? '' : ` Moved to the person: ${moved}`}`);
  if (options.tokens === null || options.minutes === null) warnLine('the fixer\'s tokens or minutes weren\'t passed, so the record says "unreported". Pass --tokens and --minutes from the subagent\'s result next time');
  printNext(nextStep(next, state.kept?.ticked ?? new Set(), agentUrl));
  return 0;
};

export const cmdLoopStop = (options: Options, client: LoopGh): number => {
  const { ledger, state, agentUrl } = openLoop(options, client);
  banner(ledger.facts.level);
  if (ledger.stage !== 'ai') throw new Error('The AI rounds are already over');
  const spent = budgetLeft(ledger) < MIN_PASS_USD;
  const { ledger: next, moved } = stopAi(ledger, { why: spent ? 'budget' : 'asked', pass: latestPass(ledger)?.n ?? 0 });
  postRun(client, runTarget(state, next), [renderReportBack({ ...state.view, ledger: next }, { agentUrl })]);
  saveLoop(client, state, { ledger: next, passes: state.view.passes });
  heading('The AI rounds are over');
  okLine(`${plural(moved.length, 'fail', 'fails')} still open moved to the person's issue, each with its repro steps`);
  printNext(nextStep(next, state.kept?.ticked ?? new Set(), agentUrl));
  return 0;
};

export const cmdStatus = (options: Options, client: LoopGh): number => {
  const { ledger, state, agentUrl } = openLoop(options, client);
  banner(ledger.facts.level);
  const ticked = state.kept?.ticked ?? new Set<string>();
  const count = (status: string): number => ledger.items.filter((item) => item.status === status).length;
  heading(`The loop for ${agentUrl}`);
  out(`  Stage: ${ledger.stage === 'filed' ? 'filed (assess-only so far)' : ledger.stage === 'ai' ? 'the AI rounds' : ledger.stage === 'human' ? 'the human round' : 'closed'}`);
  if (ledger.loop) out(`  Branch: ${ledger.loop.branch}${ledger.loop.pr ? `  PR: ${ledger.loop.pr}` : ''}`);
  out(`  Agent fails: ${count('open')} open, ${count('claimed')} claimed, ${count('certified')} certified, ${count('moved')} moved to the person (${agentItems(ledger).length} still with the agents)`);
  out(`  Person: ${ticked.size} of ${plural(ledger.checks.length, 'check', 'checks')} ticked, ${plural(ledger.human.length, 'finding', 'findings')} of their own`);
  out(`  Rounds: ${plural(fixerRounds(ledger), 'fixer round', 'fixer rounds')}, ${plural(ledger.rounds.filter((round) => round.kind === 'certifier').length, 'certifier run', 'certifier runs')}${latestPass(ledger) ? `, the latest ${latestPass(ledger)?.approved ? 'approved' : 'not approved'} at ${latestPass(ledger)?.sha.slice(0, 12)}` : ''}`);
  if (ledger.loop) out(`  Spent by what the runner starts: $${ledger.spentUsd.toFixed(2)} of $${ledger.loop.budgetUsd.toFixed(2)}`);
  if (state.kept === null) warnLine("the markers around the person's own notes are gone from their issue, so actua11y won't rewrite it until they're back");
  const latest = latestPass(ledger);
  if (latest?.usage) out(dim(`  Latest certifier run: ${formatUsage(latest.usage)}`));
  printNext(nextStep(ledger, ticked, agentUrl));
  return 0;
};

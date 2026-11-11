// The loop's state: ids, statuses and decisions, kept in the agent issue's body so any session can resume from GitHub alone. It holds no findings: their content always comes from the raw reports the runner posted, which keeps it small and keeps one source for every word.
import { createHash } from 'node:crypto';

import type { Usage } from './_backend.ts';
import type { CertifierReport, PassVerdict } from './_certifier.ts';
import { criterionByNum, levelsUpTo, type Level } from './_criteria.ts';
import { fence, readFence } from './_fence.ts';
import type { FixerReport } from './_fixer.ts';
import type { RunFacts } from './_render.ts';
import type { Fail, FinderReport, HumanCheck } from './_report.ts';
import type { CarriedRef } from './_runs.ts';

export const LEDGER_SCHEMA = 'actua11y.ledger/1';
export const MAX_FIXER_ROUNDS = 3;
export const MAX_HUMAN_PASSES = 3;
// Below this, a certifier pass can't do a full re-walk, so the loop treats the budget as spent.
export const MIN_PASS_USD = 2;

export type Stage = 'filed' | 'ai' | 'human' | 'closed';

export type FailSource = { kind: 'finder'; num: string; index: number } | { kind: 'rewalk'; pass: number; index: number };

export type CheckSource = { kind: 'finder'; num: string; index: number } | { kind: 'rewalk'; pass: number; index: number } | { kind: 'item'; pass: number; item: string };

export type Choice = 'fix' | 'accept' | 'na';

export interface Decision {
  choice: Choice;
  // The person's own words, found verbatim in their issue. Required for accept and n/a.
  reason: string | null;
  // For a fix, how the person wants it solved, in their own words. The fixer follows it and the certifier sees it.
  how: string | null;
}

// The commit a pass judged lives on its round, so a judgement only names the pass.
export interface Judged {
  pass: number;
  result: 'fixed' | 'notFixed' | 'needsPerson';
}

export interface Claim {
  round: number;
  outcome: 'fixed' | 'partial' | 'couldnt';
  commit: string | null;
}

export interface Moved {
  by: 'fixer' | 'certifier' | 'cap';
  // The fixer round, or the certifier pass, that moved it.
  at: number;
  // The fixer's or certifier's reason, in its words. At the cap it's the stop's code instead (cap, budget or asked), which renders as a sentence.
  why: string;
  // Set when a certifier's 🕵️ turned it into a check for a person, rather than a fail that needs a decision.
  check: string | null;
}

export interface AgentItem {
  id: string;
  source: FailSource;
  status: 'open' | 'claimed' | 'certified' | 'moved';
  claim: Claim | null;
  judged: Judged | null;
  // Passes whose ❌ on this item every later pass has to run again exactly.
  carried: number[];
  moved: Moved | null;
  decision: Decision | null;
}

export interface CheckItem {
  id: string;
  source: CheckSource;
}

export type HumanTag = { kind: 'wcag'; num: string } | { kind: 'ux' };

export interface HumanItem {
  id: string;
  words: string;
  tag: HumanTag;
  decision: Decision;
  // The check this finding settles, when the person checked something and found a problem rather than ticking it.
  check: string | null;
  claim: Claim | null;
  judged: Judged | null;
  carried: number[];
}

export interface Round {
  kind: 'fixer' | 'certifier';
  // The fixer round, or the certifier pass. Passes count across both stages.
  n: number;
  stage: 'ai' | 'human';
  sha: string;
  base: string | null;
  at: string;
  runId: string | null;
  model: string | null;
  effort: string | null;
  browser: { channel: string; version: string } | null;
  // Measured by the runner. Null for a fixer, which runs inside the user's own session.
  usage: Usage | null;
  // A fixer's usage as the orchestrating session reported it. Never measured, never dollars.
  reported: { tokens: number | null; minutes: number | null } | null;
  approved: boolean | null;
  commentUrls: string[];
  dryRunAt: string | null;
}

export interface LoopInfo {
  branch: string;
  pr: string | null;
  budgetUsd: number;
}

export interface Ledger {
  schema: typeof LEDGER_SCHEMA;
  facts: RunFacts;
  site: { url: string | null; serve: string | null };
  personUrl: string | null;
  loop: LoopInfo | null;
  stage: Stage;
  stopped: { why: 'approved' | 'cap' | 'budget' | 'asked'; pass: number } | null;
  spentUsd: number;
  rounds: Round[];
  items: AgentItem[];
  checks: CheckItem[];
  human: HumanItem[];
  closed: { sha: string; at: string; uncertified: string[]; atCap: boolean } | null;
}

// Everything a renderer or a brief needs: the ledger, plus the raw reports its ids point into.
export interface LoopView {
  ledger: Ledger;
  finder: FinderReport;
  passes: ReadonlyMap<number, CertifierReport>;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const nextId = (prefix: string, taken: { id: string }[]): string => `${prefix}${taken.filter((item) => item.id.startsWith(prefix)).length + 1}`;

const newItem = (id: string, source: FailSource): AgentItem => ({ id, source, status: 'open', claim: null, judged: null, carried: [], moved: null, decision: null });

// Ids follow the finder's report order (criterion, then fail), so the same report always gets the same ids.
export const initialLedger = (report: FinderReport, facts: RunFacts, site: { url: string | null; serve: string | null }): Ledger => {
  const items: AgentItem[] = [];
  const checks: CheckItem[] = [];
  for (const result of report.criteria) {
    result.fails.forEach((_, index) => items.push(newItem(`A${items.length + 1}`, { kind: 'finder', num: result.num, index })));
    result.checks.forEach((_, index) => checks.push({ id: `P${checks.length + 1}`, source: { kind: 'finder', num: result.num, index } }));
  }
  const spent = facts.usage.costUsd + (facts.dryRunUsage?.costUsd ?? 0);
  return { schema: LEDGER_SCHEMA, facts, site, personUrl: null, loop: null, stage: 'filed', stopped: null, spentUsd: spent, rounds: [], items, checks, human: [], closed: null };
};

// ---- Reading and writing it ----

const START = '<!-- actua11y:ledger v1 -->';

// Empty fields are left out of the stored copy, so a site with hundreds of fails still fits its ledger in one issue body.
const lean = <T extends object>(value: T): Partial<T> => Object.fromEntries(Object.entries(value).filter(([, field]) => field !== null && !(Array.isArray(field) && field.length === 0))) as Partial<T>;

export const ledgerBlock = (ledger: Ledger): string => {
  const stored = { ...ledger, items: ledger.items.map(lean), human: ledger.human.map(lean), rounds: ledger.rounds.map(lean) };
  return ['<details>', "<summary>The loop's state, which the runner reads to resume. Nothing here is for people, and nobody should edit it</summary>", '', START, fence(JSON.stringify(stored)), '', '</details>'].join('\n');
};

// Puts back what `lean` left out, in one fixed key order, so every loaded copy of a ledger hashes the same.
const fullDecision = (decision: Partial<Decision> & Pick<Decision, 'choice'>): Decision => ({ choice: decision.choice, reason: decision.reason ?? null, how: decision.how ?? null });

const fullItem = (item: Partial<AgentItem> & Pick<AgentItem, 'id' | 'source' | 'status'>): AgentItem => ({ id: item.id, source: item.source, status: item.status, claim: item.claim ?? null, judged: item.judged ?? null, carried: item.carried ?? [], moved: item.moved ?? null, decision: item.decision ? fullDecision(item.decision) : null });

const fullHuman = (item: Partial<HumanItem> & Pick<HumanItem, 'id' | 'words' | 'tag' | 'decision'>): HumanItem => ({ id: item.id, words: item.words, tag: item.tag, decision: fullDecision(item.decision), check: item.check ?? null, claim: item.claim ?? null, judged: item.judged ?? null, carried: item.carried ?? [] });

const fullRound = (round: Partial<Round> & Pick<Round, 'kind' | 'n' | 'stage' | 'sha' | 'at'>): Round => ({ kind: round.kind, n: round.n, stage: round.stage, sha: round.sha, base: round.base ?? null, at: round.at, runId: round.runId ?? null, model: round.model ?? null, effort: round.effort ?? null, browser: round.browser ?? null, usage: round.usage ?? null, reported: round.reported ?? null, approved: round.approved ?? null, commentUrls: round.commentUrls ?? [], dryRunAt: round.dryRunAt ?? null });

export const parseLedger = (body: string): Ledger | null => {
  const at = body.indexOf(START);
  if (at < 0) return null;
  const json = readFence(body, at + START.length);
  if (json === null) return null;
  try {
    const parsed = JSON.parse(json) as Ledger;
    if (parsed.schema !== LEDGER_SCHEMA) return null;
    return { ...parsed, items: parsed.items.map(fullItem), human: parsed.human.map(fullHuman), rounds: parsed.rounds.map(fullRound) };
  } catch {
    return null;
  }
};

export const ledgerHash = (ledger: Ledger): string => createHash('sha256').update(JSON.stringify(ledger)).digest('hex');

// ---- What its ids point at ----

export interface FailContent {
  num: string;
  fail: Fail;
  // The commit its file and line belong to, so the link resolves.
  commit: string;
  origin: string;
}

export const failOf = (view: LoopView, item: AgentItem): FailContent => {
  if (item.source.kind === 'finder') {
    const { num, index } = item.source;
    const fail = view.finder.criteria.find((result) => result.num === num)?.fails[index];
    if (!fail) throw new Error(`${item.id} points at a fail the finder's report doesn't have`);
    return { num, fail, commit: view.ledger.facts.commit, origin: 'the finder' };
  }
  const { pass, index } = item.source;
  const found = view.passes.get(pass)?.rewalk.newFails[index];
  if (!found) throw new Error(`${item.id} points at certifier pass ${pass}, whose raw report isn't on the PR`);
  const { num, ...fail } = found;
  return { num, fail, commit: roundOf(view.ledger, 'certifier', pass)?.sha ?? view.ledger.facts.commit, origin: `certifier pass ${pass}` };
};

export interface CheckContent {
  num: string;
  check: HumanCheck;
  origin: string;
}

export const checkOf = (view: LoopView, item: CheckItem): CheckContent => {
  const source = item.source;
  if (source.kind === 'finder') {
    const check = view.finder.criteria.find((result) => result.num === source.num)?.checks[source.index];
    if (!check) throw new Error(`${item.id} points at a check the finder's report doesn't have`);
    return { num: source.num, check, origin: 'the finder' };
  }
  const report = view.passes.get(source.pass);
  if (!report) throw new Error(`${item.id} points at certifier pass ${source.pass}, whose raw report isn't on the PR`);
  if (source.kind === 'rewalk') {
    const found = report.rewalk.newChecks[source.index];
    if (!found) throw new Error(`${item.id} points at a check pass ${source.pass} doesn't have`);
    const { num, ...check } = found;
    return { num, check, origin: `certifier pass ${source.pass}` };
  }
  const check = report.items.find((entry) => entry.id === source.item)?.needsPerson;
  if (!check) throw new Error(`${item.id} points at a check pass ${source.pass} doesn't have`);
  return { num: numOf(view, source.item), check, origin: `certifier pass ${source.pass}, on ${source.item}` };
};

// The criterion an item is about: a fail's, or the one a person tagged their finding with. UX findings have none.
export const numOf = (view: LoopView, id: string): string => {
  const agent = view.ledger.items.find((item) => item.id === id);
  if (agent) return failOf(view, agent).num;
  const human = view.ledger.human.find((item) => item.id === id);
  return human?.tag.kind === 'wcag' ? human.tag.num : 'UX';
};

export interface CarriedRepro extends CarriedRef {
  file: string | null;
  line: number | null;
  what: string;
  engine: string | null;
}

const engineOf = (browser: { channel: string; version: string } | null): string | null => (browser ? `${browser.channel} ${browser.version}` : null);

// Every repro an item carries: the finder's own steps for a behaviour fail, then each pass's ❌ on it. A later pass runs every one of them again, word for word.
export const carriedFor = (view: LoopView, id: string): CarriedRepro[] => {
  const repros: CarriedRepro[] = [];
  const agent = view.ledger.items.find((item) => item.id === id);
  // A behaviour fail carries the steps that proved it, whoever found it: the finder (from 0), or a certifier's re-walk (from the pass that found it, which never judged it, so it can't clash with a later ❌).
  if (agent) {
    const { fail } = failOf(view, agent);
    const from = agent.source.kind === 'finder' ? 0 : agent.source.pass;
    const engine = agent.source.kind === 'finder' ? engineOf(view.ledger.facts.browser) : engineOf(roundOf(view.ledger, 'certifier', from)?.browser ?? null);
    if (fail.behaviour && fail.repro && fail.repro.length > 0) repros.push({ id, from, steps: fail.repro, file: fail.file, line: fail.line, what: fail.what, engine });
  }
  const carried = agent?.carried ?? view.ledger.human.find((item) => item.id === id)?.carried ?? [];
  for (const pass of carried) {
    const notFixed = view.passes.get(pass)?.items.find((entry) => entry.id === id)?.notFixed;
    if (notFixed) repros.push({ id, from: pass, steps: notFixed.steps, file: notFixed.file, line: notFixed.line, what: notFixed.what, engine: engineOf(roundOf(view.ledger, 'certifier', pass)?.browser ?? null) });
  }
  return repros;
};

// ---- Questions about where it stands ----

export const roundOf = (ledger: Ledger, kind: Round['kind'], n: number): Round | undefined => ledger.rounds.find((round) => round.kind === kind && round.n === n);

// The commit a pass judged.
export const passSha = (ledger: Ledger, pass: number): string => roundOf(ledger, 'certifier', pass)?.sha ?? '';

export const fixerRounds = (ledger: Ledger): number => ledger.rounds.filter((round) => round.kind === 'fixer').length;

export const passes = (ledger: Ledger): Round[] => ledger.rounds.filter((round) => round.kind === 'certifier');

export const latestPass = (ledger: Ledger): Round | undefined => passes(ledger).at(-1);

// The human round's cap counts the certifier runs since the last one that approved, so a pass that approved never uses up the turns a later fix decision needs.
export const humanPassesSinceApproval = (ledger: Ledger): number => {
  const human = passes(ledger).filter((round) => round.stage === 'human');
  return human.length - (human.map((round) => round.approved).lastIndexOf(true) + 1);
};

export const insideTarget = (num: string, level: Level): boolean => {
  const criterion = criterionByNum(num);
  return criterion !== undefined && levelsUpTo(level).includes(criterion.level);
};

// Where the next fixer round's commits start: the commit the last pass checked, or the audited commit before any pass.
export const roundBase = (ledger: Ledger): string => latestPass(ledger)?.sha ?? ledger.facts.commit;

// The ❌ still with the agents. Every pass judges all of them, not just the claimed ones, so a later fix can't quietly break an earlier one.
export const agentItems = (ledger: Ledger): AgentItem[] => ledger.items.filter((item) => item.status !== 'moved');

// Whether a fix the person decided on still needs work: never judged yet, or judged still failing. A certifier's 🕵️ is a check for the person now, not work for a fixer.
const stillToFix = (item: { judged: Judged | null }): boolean => item.judged === null || item.judged.result === 'notFixed';

// What the fixer works. In the AI rounds, every ❌ still with the agents. In the human round, every fix the person decided on that isn't settled yet, and any agent fail a later fix broke again.
export const fixerTargets = (ledger: Ledger): string[] => {
  if (ledger.stage !== 'human') return ledger.items.filter((item) => item.status === 'open' || item.status === 'claimed').map((item) => item.id);
  return [
    ...ledger.items.filter((item) => item.status === 'open' || (item.status === 'moved' && item.decision?.choice === 'fix' && stillToFix(item))).map((item) => item.id),
    ...ledger.human.filter((item) => item.decision.choice === 'fix' && stillToFix(item)).map((item) => item.id),
  ];
};

export interface PassPlan {
  items: string[];
  blocking: string[];
}

// What the next pass judges. In the human round that adds the person's "fix" decisions, in their words. A fail outside the target, or a UX finding, is judged but never blocks.
export const passPlan = (ledger: Ledger): PassPlan => {
  const items = agentItems(ledger).map((item) => item.id);
  const blocking = [...items];
  if (ledger.stage === 'human') {
    for (const item of ledger.items) {
      if (item.status === 'moved' && item.decision?.choice === 'fix') {
        items.push(item.id);
        blocking.push(item.id);
      }
    }
    for (const item of ledger.human) {
      if (item.decision.choice !== 'fix') continue;
      items.push(item.id);
      if (item.tag.kind === 'wcag' && insideTarget(item.tag.num, ledger.facts.level)) blocking.push(item.id);
    }
  }
  return { items, blocking };
};

export const budgetLeft = (ledger: Ledger): number => (ledger.loop ? ledger.loop.budgetUsd - ledger.spentUsd : 0);

// ---- Moving it forward. Each returns a new ledger and leaves the old one alone. ----

export const startLoop = (ledger: Ledger, loop: LoopInfo): Ledger => {
  const next = clone(ledger);
  next.loop = loop;
  next.stage = fixerTargets(next).length > 0 ? 'ai' : 'human';
  return next;
};

export interface FixerRoundInput {
  round: number;
  sha: string;
  base: string;
  at: string;
  reported: { tokens: number | null; minutes: number | null };
  commentUrls: string[];
}

export const applyFixer = (ledger: Ledger, report: FixerReport, input: FixerRoundInput): Ledger => {
  const next = clone(ledger);
  const stage = next.stage === 'human' ? 'human' : 'ai';
  for (const finding of report.findings) {
    const claim: Claim = { round: input.round, outcome: finding.outcome, commit: finding.commit ?? null };
    const human = next.human.find((entry) => entry.id === finding.id);
    if (human) human.claim = claim;
    const item = next.items.find((entry) => entry.id === finding.id);
    if (!item) continue;
    item.claim = claim;
    // In the human round a fail the person decided to fix stays with them, claimed or not. Only an open agent fail becomes claimed.
    if (finding.outcome !== 'couldnt' && item.status === 'open') item.status = 'claimed';
    // Anything the fixer says needs a person goes to the person's issue with its reason, rather than round the loop again.
    if (finding.needsPerson) {
      item.status = 'moved';
      item.moved = { by: 'fixer', at: input.round, why: finding.needsPerson, check: null };
    }
  }
  next.rounds.push({ kind: 'fixer', n: input.round, stage, sha: input.sha, base: input.base, at: input.at, runId: null, model: null, effort: null, browser: null, usage: null, reported: input.reported, approved: null, commentUrls: input.commentUrls, dryRunAt: null });
  return next;
};

export interface PassInput {
  pass: number;
  sha: string;
  at: string;
  runId: string;
  model: string;
  effort: string;
  browser: { channel: string; version: string } | null;
  usage: Usage;
  dryRun: { at: string; costUsd: number } | null;
  commentUrls: string[];
}

export interface PassOutcome {
  ledger: Ledger;
  newItems: string[];
  newChecks: string[];
  // The checks its re-walk added, in its order, apart from the ones it raised on items.
  rewalkChecks: string[];
  moved: string[];
  // Set when this pass ended the AI rounds.
  ended: Ledger['stopped'];
}

const judge = (target: { judged: Judged | null; carried: number[] }, pass: number, result: Judged['result']): void => {
  target.judged = { pass, result };
  if (result === 'notFixed' && !target.carried.includes(pass)) target.carried.push(pass);
};

export const applyPass = (ledger: Ledger, report: CertifierReport, verdict: PassVerdict, input: PassInput): PassOutcome => {
  const next = clone(ledger);
  const newChecks: string[] = [];
  const moved: string[] = [];
  const stage = next.stage === 'human' ? 'human' : 'ai';
  for (const entry of report.items) {
    const result: Judged['result'] = entry.fixed ? 'fixed' : entry.notFixed ? 'notFixed' : 'needsPerson';
    const target = next.items.find((item) => item.id === entry.id) ?? next.human.find((item) => item.id === entry.id);
    if (!target) continue;
    judge(target, input.pass, result);
    if (result === 'needsPerson') {
      const check: CheckItem = { id: nextId('P', next.checks), source: { kind: 'item', pass: input.pass, item: entry.id } };
      next.checks.push(check);
      newChecks.push(check.id);
    }
    if (!('source' in target)) continue;
    const item = target;
    if (item.status === 'moved') continue;
    if (result === 'fixed') item.status = 'certified';
    else if (result === 'notFixed') item.status = 'open';
    else {
      item.status = 'moved';
      item.moved = { by: 'certifier', at: input.pass, why: entry.needsPerson?.whyNotAMachine ?? '', check: newChecks.at(-1) ?? null };
      moved.push(item.id);
    }
  }
  // New ❌ go on the agent issue. During the human round there's no fixer left to send them to, so they wait on the person's decision instead.
  const newItems = report.rewalk.newFails.map((_, index) => {
    const item = newItem(nextId('A', next.items), { kind: 'rewalk', pass: input.pass, index });
    if (stage === 'human') {
      item.status = 'moved';
      item.moved = { by: 'certifier', at: input.pass, why: 'found during the human round, so it needs your decision', check: null };
    }
    next.items.push(item);
    return item.id;
  });
  const rewalkChecks = report.rewalk.newChecks.map((_, index) => {
    const check: CheckItem = { id: nextId('P', next.checks), source: { kind: 'rewalk', pass: input.pass, index } };
    next.checks.push(check);
    newChecks.push(check.id);
    return check.id;
  });
  const countDryRun = input.dryRun !== null && !next.rounds.some((round) => round.dryRunAt === input.dryRun?.at);
  next.spentUsd += input.usage.costUsd + (countDryRun ? (input.dryRun?.costUsd ?? 0) : 0);
  next.rounds.push({ kind: 'certifier', n: input.pass, stage, sha: input.sha, base: null, at: input.at, runId: input.runId, model: input.model, effort: input.effort, browser: input.browser, usage: input.usage, reported: null, approved: verdict.approved, commentUrls: input.commentUrls, dryRunAt: input.dryRun?.at ?? null });

  let ended: Ledger['stopped'] = null;
  if (stage === 'ai') {
    if (verdict.approved) ended = { why: 'approved', pass: input.pass };
    else if (fixerRounds(next) >= MAX_FIXER_ROUNDS) ended = { why: 'cap', pass: input.pass };
    else if (budgetLeft(next) < MIN_PASS_USD) ended = { why: 'budget', pass: input.pass };
  }
  const result = ended ? stopAi(next, ended) : { ledger: next, moved: [] };
  return { ledger: result.ledger, newItems, newChecks, rewalkChecks, moved: [...moved, ...result.moved], ended };
};

export const STOP_WHY: Record<'cap' | 'budget' | 'asked', string> = {
  cap: `the loop hit its cap of ${MAX_FIXER_ROUNDS} fixer rounds with this still failing`,
  budget: "the loop's budget ran out with this still failing",
  asked: 'the AI rounds were stopped at your call with this still failing',
};

// Ends the AI rounds. At the cap, every open ❌ moves to the person's issue with its repro steps, and the loop says so plainly.
export const stopAi = (ledger: Ledger, stopped: NonNullable<Ledger['stopped']>): { ledger: Ledger; moved: string[] } => {
  const next = clone(ledger);
  const moved: string[] = [];
  if (stopped.why !== 'approved') {
    for (const item of next.items) {
      if (item.status !== 'open' && item.status !== 'claimed') continue;
      item.status = 'moved';
      item.moved = { by: 'cap', at: stopped.pass, why: stopped.why, check: null };
      moved.push(item.id);
    }
  }
  next.stage = 'human';
  next.stopped = stopped;
  return { ledger: next, moved };
};

export interface HumanInput {
  words: string;
  tag: HumanTag;
  decision: Decision;
  // The check it settles, when the person checked something and found a problem.
  check?: string | null;
}

export const addHuman = (ledger: Ledger, input: HumanInput): { ledger: Ledger; id: string } => {
  const next = clone(ledger);
  const check = input.check ?? null;
  if (check !== null && !next.checks.some((entry) => entry.id === check)) throw new Error(`${check} isn't a check on the person's issue`);
  const id = nextId('H', next.human);
  next.human.push({ id, words: input.words, tag: input.tag, decision: input.decision, check, claim: null, judged: null, carried: [] });
  return { ledger: next, id };
};

export const decide = (ledger: Ledger, id: string, decision: Decision): Ledger => {
  const next = clone(ledger);
  const human = next.human.find((item) => item.id === id);
  const agent = next.items.find((item) => item.id === id);
  if (human) human.decision = decision;
  else if (agent?.status === 'moved' && agent.moved?.check === null) agent.decision = decision;
  else throw new Error(`${id} isn't a finding of yours or a fail moved to your issue, so there's nothing to decide on it`);
  return next;
};

// The checks the person settled by finding a problem, each with the finding that settled it.
export const checksWithFindings = (ledger: Ledger): Map<string, string[]> => {
  const found = new Map<string, string[]>();
  for (const item of ledger.human) if (item.check) found.set(item.check, [...(found.get(item.check) ?? []), item.id]);
  return found;
};

// What still needs the person before close-out: checks neither ticked nor turned into a finding, and moved fails without a decision.
export const waitingOnPerson = (ledger: Ledger, ticked: ReadonlySet<string>): { unticked: string[]; undecided: string[] } => ({
  unticked: ledger.checks.map((check) => check.id).filter((id) => !ticked.has(id) && !checksWithFindings(ledger).has(id)),
  undecided: ledger.items.filter((item) => item.status === 'moved' && item.moved?.check === null && item.decision === null).map((item) => item.id),
});

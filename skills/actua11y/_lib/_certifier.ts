// The certifier's report: one outcome per item it was handed, every carried repro run again exactly, and a full re-walk at the target. The runner computes the verdict from it, so no model ever writes "approved".
import type { Criterion } from './_criteria.ts';
import { checkCheck, checkEvidence, checkFail, checkKeys, checkLocation, checkUsed, isRecord, listOf, makeChecker, nonEmpty, type Checker, type Evidence, type Fail, type HumanCheck, type Used, type ValidationContext } from './_report.ts';
import type { CarriedRef } from './_runs.ts';

export const CERTIFIER_SCHEMA = 'actua11y.certifier/1';

export interface NotFixed {
  file: string;
  line: number;
  what: string;
  steps: string[];
}

export interface CertifierItem {
  id: string;
  fixed?: Evidence[];
  notFixed?: NotFixed;
  needsPerson?: HumanCheck;
}

export interface Rerun {
  id: string;
  from: number;
  steps: string[];
  saw: string;
  reproduced: boolean;
}

export interface Walked {
  num: string;
  did: string;
}

export interface NewFail extends Fail {
  num: string;
}

export interface NewCheck extends HumanCheck {
  num: string;
}

export interface Rewalk {
  criteria: Walked[];
  newFails: NewFail[];
  newChecks: NewCheck[];
}

export interface CertifierReport {
  schema: typeof CERTIFIER_SCHEMA;
  used: Used;
  items: CertifierItem[];
  reran: Rerun[];
  rewalk: Rewalk;
}

export interface CertifierContext {
  criteria: Criterion[];
  repoRoot: string;
  tracked: Set<string>;
  items: string[];
  carried: CarriedRef[];
}

export type CertifierCheck = { ok: true; report: CertifierReport } | { ok: false; errors: string[] };

const TOP_KEYS = new Set(['schema', 'used', 'items', 'reran', 'rewalk']);
const ITEM_KEYS = new Set(['id', 'fixed', 'notFixed', 'needsPerson']);
const NOT_FIXED_KEYS = new Set(['file', 'line', 'what', 'steps']);
const RERUN_KEYS = new Set(['id', 'from', 'steps', 'saw', 'reproduced']);
const REWALK_KEYS = new Set(['criteria', 'newFails', 'newChecks']);
const WALKED_KEYS = new Set(['num', 'did']);

const steps = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.every(nonEmpty);

const checkNotFixed = (checker: Checker, where: string, value: unknown, context: ValidationContext): NotFixed | undefined => {
  if (!isRecord(value)) {
    checker.errors.push(`${where}: must be an object ({ file, line, what, steps })`);
    return undefined;
  }
  checkKeys(checker, where, value, NOT_FIXED_KEYS);
  const { file, line, what } = value;
  if (!nonEmpty(file)) checker.errors.push(`${where}.file: required (a path relative to the repository root)`);
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) checker.errors.push(`${where}.line: required (a line number, 1 or more)`);
  if (!nonEmpty(what)) checker.errors.push(`${where}.what: required (what still fails)`);
  if (!steps(value['steps'])) checker.errors.push(`${where}.steps: required (the exact steps that show it still failing, which the next pass will run again word for word)`);
  if (nonEmpty(file) && typeof line === 'number' && Number.isInteger(line) && line >= 1) checkLocation(checker, where, file, line, context);
  if (nonEmpty(what)) checker.strings(`${where}.what`, what);
  if (steps(value['steps'])) value['steps'].forEach((step, i) => checker.strings(`${where}.steps[${i}]`, step));
  return nonEmpty(file) && typeof line === 'number' && nonEmpty(what) && steps(value['steps']) ? { file, line, what, steps: value['steps'] } : undefined;
};

const checkItem = (checker: Checker, where: string, value: Record<string, unknown>, context: ValidationContext): CertifierItem => {
  checkKeys(checker, where, value, ITEM_KEYS);
  const id = String(value['id']);
  const given = ['fixed', 'notFixed', 'needsPerson'].filter((key) => value[key] !== undefined);
  if (given.length !== 1) checker.errors.push(`${where}: give exactly one of fixed, notFixed or needsPerson, not ${given.length === 0 ? 'none' : given.join(' and ')}`);
  const item: CertifierItem = { id };
  if (value['fixed'] !== undefined) {
    const evidence = listOf(checker, `${where}.fixed`, value['fixed'], (w, entry) => checkEvidence(checker, w, entry));
    if (evidence.length === 0) checker.errors.push(`${where}.fixed: needs at least one piece of evidence (what you did, and what you saw)`);
    item.fixed = evidence;
  }
  if (value['notFixed'] !== undefined) {
    const notFixed = checkNotFixed(checker, `${where}.notFixed`, value['notFixed'], context);
    if (notFixed) item.notFixed = notFixed;
  }
  if (value['needsPerson'] !== undefined) {
    const check = checkCheck(checker, `${where}.needsPerson`, value['needsPerson']);
    if (check) item.needsPerson = check;
  }
  return item;
};

const sameSteps = (a: string[], b: string[]): boolean => a.length === b.length && a.every((step, i) => step === b[i]);

const checkReruns = (checker: Checker, value: unknown, context: CertifierContext, items: Map<string, CertifierItem>): Rerun[] => {
  const reran = listOf(checker, 'report.reran', value, (where, entry) => {
    if (!isRecord(entry)) {
      checker.errors.push(`${where}: must be an object`);
      return undefined;
    }
    checkKeys(checker, where, entry, RERUN_KEYS);
    const { id, from, saw, reproduced } = entry;
    if (!nonEmpty(id) || typeof from !== 'number' || !steps(entry['steps']) || !nonEmpty(saw) || typeof reproduced !== 'boolean') {
      checker.errors.push(`${where}: needs id, from, steps, saw and reproduced`);
      return undefined;
    }
    checker.strings(`${where}.saw`, saw);
    return { id, from, steps: entry['steps'], saw, reproduced };
  });
  const seen = new Set<string>();
  for (const [i, rerun] of reran.entries()) {
    const key = `${rerun.id} from ${rerun.from}`;
    const carried = context.carried.find((ref) => ref.id === rerun.id && ref.from === rerun.from);
    if (!carried) {
      checker.errors.push(`report.reran[${i}]: ${key} isn't a carried repro in your brief`);
      continue;
    }
    if (seen.has(key)) checker.errors.push(`report.reran[${i}]: ${key} appears more than once`);
    seen.add(key);
    // One certifier pressed Escape three times, the next pressed it twice, and the same commit got two verdicts. The steps have to be the carried ones, word for word.
    if (!sameSteps(rerun.steps, carried.steps)) checker.errors.push(`report.reran[${i}]: the steps for ${key} must be exactly the carried steps, in order, word for word. Run them again exactly as written`);
    if (rerun.reproduced && items.get(rerun.id)?.notFixed === undefined) checker.errors.push(`report.reran[${i}]: ${key} still reproduced, so ${rerun.id} can't be fixed or handed to a person. It's notFixed, with these steps`);
  }
  for (const ref of context.carried) if (!seen.has(`${ref.id} from ${ref.from}`)) checker.errors.push(`report.reran: missing the carried repro ${ref.id} from ${ref.from === 0 ? 'the finder' : `pass ${ref.from}`}. Run every carried repro again, exactly`);
  return reran;
};

const checkRewalk = (checker: Checker, value: unknown, context: CertifierContext): Rewalk => {
  const rewalk: Rewalk = { criteria: [], newFails: [], newChecks: [] };
  if (!isRecord(value)) {
    checker.errors.push('report.rewalk: required ({ criteria, newFails, newChecks })');
    return rewalk;
  }
  checkKeys(checker, 'report.rewalk', value, REWALK_KEYS);
  // A list entry that isn't an object would otherwise vanish without a word, and a fail the re-walk found would never reach the verdict.
  const objectNeeded = (where: string): undefined => {
    checker.errors.push(`${where}: must be an object`);
    return undefined;
  };
  const nums = new Set(context.criteria.map((criterion) => criterion.num));
  const atTarget = (where: string, num: unknown): num is string => {
    if (typeof num === 'string' && nums.has(num)) return true;
    checker.errors.push(`${where}.num: "${String(num)}" isn't a criterion at this target. Levels come from the table in your brief`);
    return false;
  };
  rewalk.criteria = listOf(checker, 'report.rewalk.criteria', value['criteria'], (where, entry) => {
    if (!isRecord(entry)) return objectNeeded(where);
    checkKeys(checker, where, entry, WALKED_KEYS);
    if (!atTarget(where, entry['num'])) return undefined;
    if (!nonEmpty(entry['did'])) {
      checker.errors.push(`${where}.did: required (what you did for this criterion on this pass)`);
      return undefined;
    }
    checker.strings(`${where}.did`, entry['did']);
    return { num: entry['num'], did: entry['did'] };
  });
  const walked = new Set(rewalk.criteria.map((entry) => entry.num));
  const missing = [...nums].filter((num) => !walked.has(num));
  if (missing.length > 0) checker.errors.push(`report.rewalk.criteria: missing ${missing.length} criteria at the target: ${missing.join(', ')}. The re-walk covers every one`);
  if (walked.size !== rewalk.criteria.length) checker.errors.push('report.rewalk.criteria: each criterion appears once');
  rewalk.newFails = listOf(checker, 'report.rewalk.newFails', value['newFails'], (where, entry) => {
    if (!isRecord(entry)) return objectNeeded(where);
    const { num, ...rest } = entry;
    if (!atTarget(where, num)) return undefined;
    const fail = checkFail(checker, where, rest, context);
    return fail ? { ...fail, num } : undefined;
  });
  rewalk.newChecks = listOf(checker, 'report.rewalk.newChecks', value['newChecks'], (where, entry) => {
    if (!isRecord(entry)) return objectNeeded(where);
    const { num, ...rest } = entry;
    if (!atTarget(where, num)) return undefined;
    const check = checkCheck(checker, where, rest);
    return check ? { ...check, num } : undefined;
  });
  return rewalk;
};

export const validateCertifierReport = (input: unknown, context: CertifierContext): CertifierCheck => {
  const checker = makeChecker();
  if (!isRecord(input)) return { ok: false, errors: ['The report must be one JSON object in a ```json block at the end of your final message'] };
  checkKeys(checker, 'report', input, TOP_KEYS);
  if (input['schema'] !== CERTIFIER_SCHEMA) checker.errors.push(`report.schema: must be "${CERTIFIER_SCHEMA}"`);
  const used = checkUsed(checker, input['used']);

  const expected = new Set(context.items);
  const items = new Map<string, CertifierItem>();
  const rawItems = input['items'];
  if (!Array.isArray(rawItems)) checker.errors.push('report.items: required (one entry per item in your brief)');
  else {
    rawItems.forEach((entry, i) => {
      if (!isRecord(entry) || !nonEmpty(entry['id'])) {
        checker.errors.push(`report.items[${i}]: needs an id, like "A3"`);
        return;
      }
      const id = entry['id'];
      const where = `items[${i}] (${id})`;
      if (!expected.has(id)) checker.errors.push(`${where}: not an item in your brief`);
      else if (items.has(id)) checker.errors.push(`${where}: appears more than once. Each item gets exactly one entry`);
      else items.set(id, checkItem(checker, where, entry, context));
    });
    const missing = context.items.filter((id) => !items.has(id));
    if (missing.length > 0) checker.errors.push(`report.items: missing ${missing.join(', ')}. Every item in your brief gets an outcome`);
  }
  const reran = checkReruns(checker, input['reran'] ?? [], context, items);
  const rewalk = checkRewalk(checker, input['rewalk'], context);

  if (checker.errors.length > 0) return { ok: false, errors: checker.errors };
  const ordered = context.items.map((id) => items.get(id)).filter((item): item is CertifierItem => item !== undefined);
  return { ok: true, report: { schema: CERTIFIER_SCHEMA, used, items: ordered, reran, rewalk } };
};

export interface PassVerdict {
  approved: boolean;
  fixed: string[];
  notFixed: string[];
  needsPerson: string[];
  blockers: string[];
  newFails: number;
  newChecks: number;
}

// Approved only when nothing that blocks is still failing and the re-walk found nothing new. A 🕵️ moves to a person instead of blocking, and a fail outside the target is shown but never holds up close-out.
export const passVerdict = (report: CertifierReport, blocking: ReadonlySet<string>): PassVerdict => {
  const fixed = report.items.filter((item) => item.fixed !== undefined).map((item) => item.id);
  const notFixed = report.items.filter((item) => item.notFixed !== undefined).map((item) => item.id);
  const needsPerson = report.items.filter((item) => item.needsPerson !== undefined).map((item) => item.id);
  const blockers = notFixed.filter((id) => blocking.has(id));
  return { approved: blockers.length === 0 && report.rewalk.newFails.length === 0, fixed, notFixed, needsPerson, blockers, newFails: report.rewalk.newFails.length, newChecks: report.rewalk.newChecks.length };
};

export const CERTIFIER_SHAPE = `interface CertifierReport {
  schema: "${CERTIFIER_SCHEMA}";
  used: { tools: string[]; pages: string[] };
  items: {                       // one per item in your brief, no others
    id: string;                  // "A3", "H1"
    // exactly one of these three:
    fixed?: { did: string; saw: string }[];                             // ✅ you found no fail now, and how
    notFixed?: { file: string; line: number; what: string; steps: string[] };   // ❌ still fails, with exact steps
    needsPerson?: { what: string; how: string; whyNotAMachine: string; group?: string };   // 🕵️ only a person can settle it
  }[];
  reran: {                       // one per carried repro in your brief, no others
    id: string;
    from: number;                // as the brief gives it
    steps: string[];             // exactly the carried steps, word for word
    saw: string;
    reproduced: boolean;         // true if it still fails, which makes the item notFixed
  }[];
  rewalk: {
    criteria: { num: string; did: string }[];   // every criterion in the table, once each
    newFails: {                  // ❌ fails nobody had found, inside the target
      num: string; file: string; line: number; what: string; whoItHurts: string;
      behaviour: boolean; repro?: string[];     // repro required when behaviour is true
    }[];
    newChecks: { num: string; what: string; how: string; whyNotAMachine: string; group?: string }[];   // 🕵️ new things for a person
  };
}`;

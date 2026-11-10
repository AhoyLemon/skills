// The finder's report: its shape, the checks that keep it honest, and the verdicts the runner computes from it (a model never writes a verdict).
import { existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

import type { Criterion } from './_criteria.ts';

export const FINDER_SCHEMA = 'actua11y.finder/1';

export interface Fail {
  file: string;
  line: number;
  what: string;
  whoItHurts: string;
  behaviour: boolean;
  repro?: string[];
}

export interface HumanCheck {
  what: string;
  how: string;
  whyNotAMachine: string;
}

export interface Evidence {
  did: string;
  saw: string;
}

export interface CriterionResult {
  num: string;
  fails: Fail[];
  checks: HumanCheck[];
  evidence: Evidence[];
  na?: string;
}

export interface Used {
  tools: string[];
  pages: string[];
}

export interface FinderReport {
  schema: typeof FINDER_SCHEMA;
  used: Used;
  criteria: CriterionResult[];
}

export type Verdict = 'fail' | 'check' | 'found-no-fail' | 'na';

export const VERDICT_MARK: Record<Verdict, string> = { fail: '❌', check: '🕵️', 'found-no-fail': '✅', na: 'n/a' };

export interface ValidationContext {
  criteria: Criterion[];
  repoRoot: string;
  tracked: Set<string>;
}

export type ValidationResult = { ok: true; report: FinderReport } | { ok: false; errors: string[] };

// Code spans are stripped first, so UI text quoted in backticks (a button labelled `Pass`) doesn't count.
// Every form of the four words that would claim a pass. "Certificate" stays allowed, since "not a certificate" is what actua11y says of itself.
const CLAIM_WORDS = /\b(pass(es|ed|ing)?|compl(y|ies|ied|ying|iant|iance)|conform(s|ed|ing|ant|ance|ity)?|certif(y|ies|ied|ying))\b/i;

const TOP_KEYS = new Set(['schema', 'used', 'criteria']);
const USED_KEYS = new Set(['tools', 'pages']);
const CRITERION_KEYS = new Set(['num', 'fails', 'checks', 'evidence', 'na']);
const FAIL_KEYS = new Set(['file', 'line', 'what', 'whoItHurts', 'behaviour', 'repro']);
const CHECK_KEYS = new Set(['what', 'how', 'whyNotAMachine']);
const EVIDENCE_KEYS = new Set(['did', 'saw']);

// The verdict follows from the items: a proven fail outranks an open question, which outranks evidence. Nothing is measured and then left off the books.
export const verdictOf = (result: CriterionResult): Verdict => {
  if (result.fails.length > 0) return 'fail';
  if (result.checks.length > 0) return 'check';
  if (result.evidence.length > 0) return 'found-no-fail';
  return 'na';
};

export interface Tally {
  fail: number;
  check: number;
  'found-no-fail': number;
  na: number;
  failItems: number;
  checkItems: number;
}

export const tallyOf = (report: FinderReport): Tally => {
  const tally: Tally = { fail: 0, check: 0, 'found-no-fail': 0, na: 0, failItems: 0, checkItems: 0 };
  for (const result of report.criteria) {
    tally[verdictOf(result)] += 1;
    tally.failItems += result.fails.length;
    tally.checkItems += result.checks.length;
  }
  return tally;
};

// Takes the last fenced json block in a session's final message, or the whole message if it is bare JSON.
export const extractReportJson = (text: string): unknown => {
  const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)\n```/g)];
  const candidate = blocks.length > 0 ? (blocks.at(-1)?.[1] ?? '') : text.trim();
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
};

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export const nonEmpty = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

const extraKeys = (value: Record<string, unknown>, allowed: Set<string>): string[] => Object.keys(value).filter((key) => !allowed.has(key));

const stripCode = (text: string): string => text.replace(/`[^`]*`/g, '');

export interface Checker {
  errors: string[];
  strings: (where: string, value: string) => void;
}

export const makeChecker = (): Checker => {
  const errors: string[] = [];
  return {
    errors,
    strings: (where, value) => {
      const match = stripCode(value).match(CLAIM_WORDS);
      if (match) errors.push(`${where}: uses "${match[0]}". actua11y never claims a pass or compliance, so say what was done and what was found instead (put quoted UI text in backticks)`);
    },
  };
};

export const checkKeys = (checker: Checker, where: string, value: Record<string, unknown>, allowed: Set<string>): void => {
  const extra = extraKeys(value, allowed);
  if (extra.length > 0) checker.errors.push(`${where}: unknown field(s) ${extra.join(', ')}. There's no notes field: anything a machine can't settle is a check with its own entry`);
};

// A final newline ends the last line rather than starting another one.
const lineCount = (path: string): number => {
  const text = readFileSync(path, 'utf8');
  const lines = text.split('\n').length;
  return text.endsWith('\n') ? lines - 1 : lines;
};

export const checkLocation = (checker: Checker, where: string, file: string, line: number, context: ValidationContext): void => {
  const absolute = resolve(context.repoRoot, file);
  const inside = relative(context.repoRoot, absolute);
  if (isAbsolute(file) || inside.startsWith('..')) {
    checker.errors.push(`${where}.file: "${file}" must be a path relative to the repository root`);
    return;
  }
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    checker.errors.push(`${where}.file: "${file}" doesn't exist in the repository`);
    return;
  }
  // The issues link each fail to the audited commit, so a gitignored or generated file would be a dead link. Cite the tracked source instead.
  if (!context.tracked.has(inside.split('\\').join('/'))) {
    checker.errors.push(`${where}.file: "${file}" isn't tracked by git, so a link to it wouldn't resolve. Cite the tracked source file that produces it`);
    return;
  }
  const lines = lineCount(absolute);
  if (line > lines) checker.errors.push(`${where}.line: ${line} is past the end of ${file} (${lines} lines)`);
};

export const checkFail = (checker: Checker, where: string, value: unknown, context: ValidationContext): Fail | undefined => {
  if (!isRecord(value)) {
    checker.errors.push(`${where}: must be an object`);
    return undefined;
  }
  checkKeys(checker, where, value, FAIL_KEYS);
  const { file, line, what, whoItHurts, behaviour, repro } = value;
  if (!nonEmpty(file)) checker.errors.push(`${where}.file: required (a path relative to the repository root)`);
  if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) checker.errors.push(`${where}.line: required (a line number, 1 or more)`);
  if (!nonEmpty(what)) checker.errors.push(`${where}.what: required (what's wrong)`);
  if (!nonEmpty(whoItHurts)) checker.errors.push(`${where}.whoItHurts: required (who this hurts)`);
  if (typeof behaviour !== 'boolean') checker.errors.push(`${where}.behaviour: required (true when the fail only shows up by doing something)`);
  if (repro !== undefined && (!Array.isArray(repro) || !repro.every(nonEmpty))) checker.errors.push(`${where}.repro: must be a list of non-empty steps`);
  if (behaviour === true && (!Array.isArray(repro) || repro.length === 0)) checker.errors.push(`${where}.repro: required for a behaviour fail (exact steps a person can follow)`);
  if (nonEmpty(file) && typeof line === 'number' && Number.isInteger(line) && line >= 1) checkLocation(checker, where, file, line, context);
  for (const [key, text] of [['what', what], ['whoItHurts', whoItHurts]] as const) if (nonEmpty(text)) checker.strings(`${where}.${key}`, text);
  if (Array.isArray(repro)) repro.forEach((step, i) => nonEmpty(step) && checker.strings(`${where}.repro[${i}]`, step));
  if (!nonEmpty(file) || typeof line !== 'number' || !nonEmpty(what) || !nonEmpty(whoItHurts) || typeof behaviour !== 'boolean') return undefined;
  return Array.isArray(repro) ? { file, line, what, whoItHurts, behaviour, repro: repro.filter(nonEmpty) } : { file, line, what, whoItHurts, behaviour };
};

export const checkCheck = (checker: Checker, where: string, value: unknown): HumanCheck | undefined => {
  if (!isRecord(value)) {
    checker.errors.push(`${where}: must be an object`);
    return undefined;
  }
  checkKeys(checker, where, value, CHECK_KEYS);
  const { what, how, whyNotAMachine } = value;
  if (!nonEmpty(what)) checker.errors.push(`${where}.what: required (what a person should check)`);
  if (!nonEmpty(how)) checker.errors.push(`${where}.how: required (how to check it)`);
  if (!nonEmpty(whyNotAMachine)) checker.errors.push(`${where}.whyNotAMachine: required (why a machine can't settle it)`);
  for (const [key, text] of [['what', what], ['how', how], ['whyNotAMachine', whyNotAMachine]] as const) if (nonEmpty(text)) checker.strings(`${where}.${key}`, text);
  return nonEmpty(what) && nonEmpty(how) && nonEmpty(whyNotAMachine) ? { what, how, whyNotAMachine } : undefined;
};

export const checkEvidence = (checker: Checker, where: string, value: unknown): Evidence | undefined => {
  if (!isRecord(value)) {
    checker.errors.push(`${where}: must be an object`);
    return undefined;
  }
  checkKeys(checker, where, value, EVIDENCE_KEYS);
  const { did, saw } = value;
  if (!nonEmpty(did)) checker.errors.push(`${where}.did: required (the specific thing a machine did)`);
  if (!nonEmpty(saw)) checker.errors.push(`${where}.saw: required (what it found)`);
  for (const [key, text] of [['did', did], ['saw', saw]] as const) if (nonEmpty(text)) checker.strings(`${where}.${key}`, text);
  return nonEmpty(did) && nonEmpty(saw) ? { did, saw } : undefined;
};

export const listOf = <T>(checker: Checker, where: string, value: unknown, each: (where: string, item: unknown) => T | undefined): T[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    checker.errors.push(`${where}: must be a list`);
    return [];
  }
  return value.map((item, i) => each(`${where}[${i}]`, item)).filter((item): item is T => item !== undefined);
};

const checkCriterion = (checker: Checker, where: string, value: Record<string, unknown>, context: ValidationContext): CriterionResult => {
  checkKeys(checker, where, value, CRITERION_KEYS);
  const num = String(value['num']);
  const fails = listOf(checker, `${where}.fails`, value['fails'], (w, item) => checkFail(checker, w, item, context));
  const checks = listOf(checker, `${where}.checks`, value['checks'], (w, item) => checkCheck(checker, w, item));
  const evidence = listOf(checker, `${where}.evidence`, value['evidence'], (w, item) => checkEvidence(checker, w, item));
  const na = value['na'];
  const result: CriterionResult = { num, fails, checks, evidence };
  if (na !== undefined) {
    if (!nonEmpty(na)) checker.errors.push(`${where}.na: must be a one-line reason`);
    else {
      checker.strings(`${where}.na`, na);
      result.na = na;
    }
  }
  const raw = ['fails', 'checks', 'evidence'].reduce((sum, key) => sum + (Array.isArray(value[key]) ? (value[key] as unknown[]).length : 0), 0);
  if (na !== undefined && raw > 0) checker.errors.push(`${where}: n/a can't sit alongside fails, checks or evidence. Pick one`);
  if (na === undefined && raw === 0) checker.errors.push(`${where}: no verdict. Give fails, checks, evidence, or an n/a reason`);
  return result;
};

export const checkUsed = (checker: Checker, used: unknown): Used => {
  let tools: string[] = [];
  let pages: string[] = [];
  if (!isRecord(used)) checker.errors.push('report.used: required ({ tools, pages })');
  else {
    checkKeys(checker, 'report.used', used, USED_KEYS);
    if (!Array.isArray(used['tools']) || used['tools'].length === 0 || !used['tools'].every(nonEmpty)) checker.errors.push('report.used.tools: required (every tool, script and check you used)');
    else {
      tools = used['tools'];
      tools.forEach((tool, i) => checker.strings(`report.used.tools[${i}]`, tool));
    }
    // A run that never loaded a page never drove the browser, so none of its behaviour evidence can stand.
    if (!Array.isArray(used['pages']) || used['pages'].length === 0 || !used['pages'].every(nonEmpty)) checker.errors.push('report.used.pages: required (every page you loaded in the browser, at least one)');
    else pages = used['pages'];
  }
  return { tools, pages };
};

export const validateReport = (input: unknown, context: ValidationContext): ValidationResult => {
  const checker = makeChecker();
  if (!isRecord(input)) return { ok: false, errors: ['The report must be one JSON object in a ```json block at the end of your final message'] };
  checkKeys(checker, 'report', input, TOP_KEYS);
  if (input['schema'] !== FINDER_SCHEMA) checker.errors.push(`report.schema: must be "${FINDER_SCHEMA}"`);
  const { tools, pages } = checkUsed(checker, input['used']);

  const expected = new Map(context.criteria.map((criterion) => [criterion.num, criterion]));
  const seen = new Set<string>();
  const criteria: CriterionResult[] = [];
  const rawCriteria = input['criteria'];
  if (!Array.isArray(rawCriteria)) checker.errors.push('report.criteria: required (one entry per criterion at the target)');
  else {
    rawCriteria.forEach((item, i) => {
      if (!isRecord(item) || !nonEmpty(item['num'])) {
        checker.errors.push(`report.criteria[${i}]: needs a num, like "1.4.3"`);
        return;
      }
      const num = item['num'];
      const where = `criteria[${i}] (${num})`;
      if (!expected.has(num)) {
        checker.errors.push(`${where}: not a criterion at this target. Levels come from the table in your brief`);
        return;
      }
      if (seen.has(num)) {
        checker.errors.push(`${where}: appears more than once. Each criterion gets exactly one entry`);
        return;
      }
      seen.add(num);
      criteria.push(checkCriterion(checker, where, item, context));
    });
    const missing = [...expected.keys()].filter((num) => !seen.has(num));
    if (missing.length > 0) checker.errors.push(`report.criteria: missing ${missing.length} criteria at the target: ${missing.join(', ')}`);
  }

  if (checker.errors.length > 0) return { ok: false, errors: checker.errors };
  const order = [...expected.keys()];
  criteria.sort((a, b) => order.indexOf(a.num) - order.indexOf(b.num));
  return { ok: true, report: { schema: FINDER_SCHEMA, used: { tools, pages }, criteria } };
};

// The same shape as the types above, as the finder's brief shows it.
export const REPORT_SHAPE = `interface FinderReport {
  schema: "${FINDER_SCHEMA}";
  used: { tools: string[]; pages: string[] };
  criteria: {
    num: string;                 // "1.4.3", one entry per criterion in the table, no others
    fails?: {                    // ❌ proven
      file: string;              // relative to the repository root
      line: number;
      what: string;
      whoItHurts: string;
      behaviour: boolean;        // true if it only shows up by doing something
      repro?: string[];          // exact steps, required when behaviour is true
    }[];
    checks?: { what: string; how: string; whyNotAMachine: string }[];   // 🕵️ for a person
    evidence?: { did: string; saw: string }[];                          // ✅ a machine found no fail
    na?: string;                 // one-line reason, and nothing else alongside it
  }[];
}`;

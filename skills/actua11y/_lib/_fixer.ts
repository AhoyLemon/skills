// The fixer's report: an outcome for every ❌ it was handed, with partial and couldn't as first-class answers, checked against the commits actually on the branch. Its honesty comes from these required fields, not from isolation.
import { checkKeys, isRecord, makeChecker, nonEmpty, type Checker } from './_report.ts';

export const FIXER_SCHEMA = 'actua11y.fixer/1';

export type Outcome = 'fixed' | 'partial' | 'couldnt';

export const OUTCOMES: readonly Outcome[] = ['fixed', 'partial', 'couldnt'];

export interface FixerFinding {
  id: string;
  outcome: Outcome;
  commit?: string;
  how?: string;
  left?: string;
  why?: string;
  needsPerson?: string;
}

export interface FixerReport {
  schema: typeof FIXER_SCHEMA;
  brief: string;
  findings: FixerFinding[];
}

export interface FixerContext {
  briefId: string;
  items: string[];
  // Full shas in base..HEAD, oldest first.
  commits: string[];
  // False in the human round, where everything is already the person's and they're right there to decide.
  allowNeedsPerson: boolean;
}

export type FixerCheck = { ok: true; report: FixerReport } | { ok: false; errors: string[] };

const TOP_KEYS = new Set(['schema', 'brief', 'findings']);
const FINDING_KEYS = new Set(['id', 'outcome', 'commit', 'how', 'left', 'why', 'needsPerson']);

// A short sha is fine as long as it names exactly one of this round's commits.
const resolveCommit = (commit: string, commits: string[]): string | null => {
  if (!/^[0-9a-f]{7,40}$/i.test(commit)) return null;
  const matches = commits.filter((sha) => sha.startsWith(commit.toLowerCase()));
  return matches.length === 1 ? (matches[0] ?? null) : null;
};

const text = (checker: Checker, where: string, value: unknown, need: boolean, what: string): string | undefined => {
  if (value === undefined) {
    if (need) checker.errors.push(`${where}: required (${what})`);
    return undefined;
  }
  if (!nonEmpty(value)) {
    checker.errors.push(`${where}: must be non-empty text (${what})`);
    return undefined;
  }
  checker.strings(where, value);
  return value;
};

const checkFinding = (checker: Checker, where: string, value: Record<string, unknown>, context: FixerContext): FixerFinding | undefined => {
  checkKeys(checker, where, value, FINDING_KEYS);
  const id = String(value['id']);
  const raw = value['outcome'];
  const outcome = OUTCOMES.find((entry) => entry === raw);
  if (outcome === undefined) {
    checker.errors.push(`${where}.outcome: must be fixed, partial or couldnt`);
    return undefined;
  }
  const committed = outcome !== 'couldnt';
  let commit: string | undefined;
  if (committed) {
    if (!nonEmpty(value['commit'])) checker.errors.push(`${where}.commit: required for ${outcome} (the commit that holds this change)`);
    else {
      const resolved = resolveCommit(value['commit'], context.commits);
      if (resolved === null) checker.errors.push(`${where}.commit: "${value['commit']}" isn't one of this round's commits on the branch`);
      else commit = resolved;
    }
  } else if (value['commit'] !== undefined) checker.errors.push(`${where}.commit: a finding you couldn't fix has no commit`);
  const how = text(checker, `${where}.how`, value['how'], committed, 'what you changed, and why that fixes it for people');
  const left = text(checker, `${where}.left`, value['left'], outcome === 'partial', "what's still not fixed");
  const why = text(checker, `${where}.why`, value['why'], outcome === 'couldnt', "why you couldn't fix it");
  const needsPerson = text(checker, `${where}.needsPerson`, value['needsPerson'], false, 'why only a person can settle the rest');
  if (outcome !== 'partial' && left !== undefined) checker.errors.push(`${where}.left: only a partial fix leaves something`);
  if (outcome !== 'couldnt' && why !== undefined) checker.errors.push(`${where}.why: only a finding you couldn't fix needs a why`);
  if (needsPerson !== undefined && !context.allowNeedsPerson) checker.errors.push(`${where}.needsPerson: not in the human round. Everything here is already the person's, so say partial or couldnt, and why, and they'll decide`);
  else if (outcome === 'fixed' && needsPerson !== undefined) checker.errors.push(`${where}.needsPerson: a fixed finding doesn't need a person. Say partial or couldnt if part of it does`);
  const finding: FixerFinding = { id, outcome };
  if (commit) finding.commit = commit;
  if (how) finding.how = how;
  if (left) finding.left = left;
  if (why) finding.why = why;
  if (needsPerson) finding.needsPerson = needsPerson;
  return finding;
};

export const validateFixerReport = (input: unknown, context: FixerContext): FixerCheck => {
  const checker = makeChecker();
  if (!isRecord(input)) return { ok: false, errors: ['The report must be one JSON object in a ```json block at the end of your final message'] };
  checkKeys(checker, 'report', input, TOP_KEYS);
  if (input['schema'] !== FIXER_SCHEMA) checker.errors.push(`report.schema: must be "${FIXER_SCHEMA}"`);
  // The brief id proves the fixer was handed the runner's own brief for this round, not a paraphrase or an older one.
  if (input['brief'] !== context.briefId) checker.errors.push(`report.brief: "${String(input['brief'])}" isn't this round's brief (${context.briefId}). Run \`brief fixer\` again and hand the fixer the whole new brief`);

  const expected = new Set(context.items);
  const findings = new Map<string, FixerFinding>();
  const raw = input['findings'];
  if (!Array.isArray(raw)) checker.errors.push('report.findings: required (one entry per finding in your brief)');
  else {
    raw.forEach((entry, i) => {
      if (!isRecord(entry) || !nonEmpty(entry['id'])) {
        checker.errors.push(`report.findings[${i}]: needs an id, like "A3"`);
        return;
      }
      const id = entry['id'];
      const where = `findings[${i}] (${id})`;
      if (!expected.has(id)) checker.errors.push(`${where}: not a finding in your brief`);
      else if (findings.has(id)) checker.errors.push(`${where}: appears more than once`);
      else {
        const finding = checkFinding(checker, where, entry, context);
        if (finding) findings.set(id, finding);
      }
    });
    const missing = context.items.filter((id) => !findings.has(id) && !raw.some((entry) => isRecord(entry) && entry['id'] === id));
    if (missing.length > 0) checker.errors.push(`report.findings: missing ${missing.join(', ')}. Every finding gets fixed, partial or couldnt, never silence`);
  }
  // Every commit on the branch since the round started has to be accounted for, so nothing lands that no finding explains.
  const cited = new Set([...findings.values()].map((finding) => finding.commit).filter((sha): sha is string => sha !== undefined));
  const uncited = context.commits.filter((sha) => !cited.has(sha));
  if (uncited.length > 0) checker.errors.push(`commits on the branch that no finding cites: ${uncited.map((sha) => sha.slice(0, 12)).join(', ')}. Name each one in the finding it fixes`);

  if (checker.errors.length > 0) return { ok: false, errors: checker.errors };
  return { ok: true, report: { schema: FIXER_SCHEMA, brief: context.briefId, findings: context.items.map((id) => findings.get(id)).filter((finding): finding is FixerFinding => finding !== undefined) } };
};

export const FIXER_SHAPE = `interface FixerReport {
  schema: "${FIXER_SCHEMA}";
  brief: string;                 // the Brief id at the end of your brief
  findings: {                    // one per finding in your brief, no others
    id: string;                  // "A3"
    outcome: "fixed" | "partial" | "couldnt";
    commit?: string;             // required for fixed and partial: the commit that holds the change
    how?: string;                // required for fixed and partial: what you changed
    left?: string;               // required for partial: what's still not fixed
    why?: string;                // required for couldnt: why not
    needsPerson?: string;        // optional, never with fixed: why only a person can settle the rest. It moves to the person's issue
  }[];
}`;

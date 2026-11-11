import assert from 'node:assert/strict';
import { test } from 'node:test';

import { FIXER_SCHEMA, validateFixerReport, type FixerContext } from '../skills/actua11y/_lib/_fixer.ts';

const ONE = 'a'.repeat(40);
const TWO = 'b'.repeat(40);
const context: FixerContext = { briefId: '0123456789ab', items: ['A1', 'A2', 'A3'], commits: [ONE, TWO], allowNeedsPerson: true };

type Finding = Record<string, unknown>;

const errorsOf = (findings: Finding[], brief = context.briefId): string[] => {
  const result = validateFixerReport({ schema: FIXER_SCHEMA, brief, findings }, context);
  return result.ok ? [] : result.errors;
};

const good: Finding[] = [
  { id: 'A1', outcome: 'fixed', commit: ONE.slice(0, 7), how: 'Gave the photo alt text that says what it shows' },
  { id: 'A2', outcome: 'partial', commit: TWO, how: 'Join is a real button now', left: 'Its focus ring is still hidden' },
  { id: 'A3', outcome: 'couldnt', why: 'The brand colour is a design call', needsPerson: 'Only the owner can pick a new brand colour' },
];

test('fixed, partial and couldnt are all real answers, with short shas resolved', () => {
  const result = validateFixerReport({ schema: FIXER_SCHEMA, brief: context.briefId, findings: good }, context);
  assert.ok(result.ok, result.ok ? '' : result.errors.join('\n'));
  if (result.ok) assert.equal(result.report.findings[0]?.commit, ONE);
});

test('every finding gets an outcome, and each outcome owes what it owes', () => {
  assert.ok(errorsOf(good.slice(0, 2)).some((error) => /missing A3/.test(error)), 'silence is not an answer');
  assert.ok(errorsOf([good[0] ?? {}, { id: 'A2', outcome: 'partial', commit: TWO, how: 'Some of it' }, good[2] ?? {}]).some((error) => /\.left: required/.test(error)), 'a half fix says what is left');
  assert.ok(errorsOf([good[0] ?? {}, good[1] ?? {}, { id: 'A3', outcome: 'couldnt' }]).some((error) => /\.why: required/.test(error)), 'a no says why');
  assert.ok(errorsOf([good[0] ?? {}, good[1] ?? {}, { id: 'A3', outcome: 'couldnt', why: 'No', commit: TWO }]).some((error) => /has no commit/.test(error)));
  assert.ok(errorsOf([{ ...good[0], needsPerson: 'A person' }, good[1] ?? {}, good[2] ?? {}]).some((error) => /doesn't need a person/.test(error)));
  assert.ok(errorsOf([{ ...good[0], outcome: 'mostly' }, good[1] ?? {}, good[2] ?? {}]).some((error) => /must be fixed, partial or couldnt/.test(error)));
  assert.ok(errorsOf([{ ...good[0], how: 'It passes axe now' }, good[1] ?? {}, good[2] ?? {}]).some((error) => /uses "passes"/.test(error)));
});

test('the commits have to be this round\'s, and every one of them accounted for', () => {
  assert.ok(errorsOf([{ ...good[0], commit: 'c'.repeat(40) }, good[1] ?? {}, good[2] ?? {}]).some((error) => /isn't one of this round's commits/.test(error)));
  assert.ok(errorsOf([good[0] ?? {}, { ...good[1], commit: ONE }, good[2] ?? {}]).some((error) => /no finding cites: bbbbbbbbbbbb/.test(error)), 'a commit nothing explains');
});

test('a report that answers another brief is refused', () => {
  assert.ok(errorsOf(good, 'ffffffffffff').some((error) => /isn't this round's brief/.test(error)));
});

test("in the human round nothing moves to the person, since it's all theirs already", () => {
  const human = validateFixerReport({ schema: FIXER_SCHEMA, brief: context.briefId, findings: good }, { ...context, allowNeedsPerson: false });
  assert.ok(!human.ok && human.errors.some((error) => /needsPerson: not in the human round/.test(error)));
});

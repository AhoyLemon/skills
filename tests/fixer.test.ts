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
  if (result.ok) assert.deepEqual(result.report.findings[0]?.commits, [ONE]);
});

test('every finding gets an outcome, and each outcome owes what it owes', () => {
  assert.ok(errorsOf(good.slice(0, 2)).some((error) => /missing A3/.test(error)), 'silence is not an answer');
  assert.ok(errorsOf([good[0] ?? {}, { id: 'A2', outcome: 'partial', commit: TWO, how: 'Some of it' }, good[2] ?? {}]).some((error) => /\.left: required/.test(error)), 'a half fix says what is left');
  assert.ok(errorsOf([good[0] ?? {}, good[1] ?? {}, { id: 'A3', outcome: 'couldnt' }]).some((error) => /\.why: required/.test(error)), 'a no says why');
  assert.ok(errorsOf([good[0] ?? {}, { id: 'A2', outcome: 'partial', how: 'Some of it', left: 'The rest' }, good[2] ?? {}]).some((error) => /.commit: required for partial/.test(error)), 'a partial fix names the commits that hold it');
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

test('a fix that took a follow-up cites both commits, and an attempt that was reverted is accounted for under its finding', () => {
  const report = (findings: Finding[]) => validateFixerReport({ schema: FIXER_SCHEMA, brief: context.briefId, findings }, { ...context, items: ['A1', 'A2'] });
  const followUp = report([{ id: 'A1', outcome: 'fixed', commits: [ONE, TWO.slice(0, 9)], how: 'Alt text, then a follow-up for the second photo' }, { id: 'A2', outcome: 'couldnt', why: 'A design call' }]);
  assert.ok(followUp.ok, followUp.ok ? '' : followUp.errors.join('\n'));
  if (followUp.ok) assert.deepEqual(followUp.report.findings[0]?.commits, [ONE, TWO]);
  const reverted = report([{ id: 'A1', outcome: 'fixed', commit: ONE, how: 'Alt text' }, { id: 'A2', outcome: 'couldnt', commits: [TWO], why: 'Tried a role on the div, reverted it, since only a real button would do and that needs a design call' }]);
  assert.ok(reverted.ok, reverted.ok ? '' : reverted.errors.join('\n'));
  const both = report([{ id: 'A1', outcome: 'fixed', commit: ONE, commits: [ONE], how: 'x' }, { id: 'A2', outcome: 'couldnt', commits: [TWO], why: 'y' }]);
  assert.ok(!both.ok && both.errors.some((error) => /give commit or commits, not both/.test(error)));
});

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { criteriaAt } from '../skills/actua11y/_lib/_criteria.ts';
import { extractReportJson, tallyOf, validateReport, verdictOf, type FinderReport } from '../skills/actua11y/_lib/_report.ts';
import { makeReport, makeSite } from './_fixtures.ts';

const repoRoot = makeSite();
const context = { criteria: criteriaAt('A'), repoRoot };

type Raw = Record<string, unknown> & { criteria: Record<string, unknown>[] };

const report = (): Raw => makeReport('A') as Raw;

const entry = (raw: Raw, num: string): Record<string, unknown> => {
  const found = raw.criteria.find((item) => item['num'] === num);
  if (!found) throw new Error(`no ${num} in fixture`);
  return found;
};

const errorsFor = (raw: unknown): string[] => {
  const result = validateReport(raw, context);
  return result.ok ? [] : result.errors;
};

test('a good report validates, and the verdicts are computed from its items', () => {
  const result = validateReport(report(), context);
  assert.ok(result.ok, result.ok ? '' : result.errors.join('\n'));
  const valid = result.report as FinderReport;
  const byNum = new Map(valid.criteria.map((item) => [item.num, verdictOf(item)]));
  assert.equal(byNum.get('1.1.1'), 'fail');
  assert.equal(byNum.get('1.3.1'), 'check');
  assert.equal(byNum.get('2.4.2'), 'found-no-fail');
  assert.equal(byNum.get('1.2.1'), 'na');
  const tally = tallyOf(valid);
  assert.deepEqual([tally.fail, tally.check, tally['found-no-fail'], tally.failItems, tally.checkItems], [2, 1, 1, 2, 2]);
});

test('every criterion at the target, exactly once, and nothing from outside it', () => {
  const missing = report();
  missing.criteria = missing.criteria.filter((item) => item['num'] !== '2.1.1');
  assert.match(errorsFor(missing).join('\n'), /missing 1 criteria at the target: 2\.1\.1/);

  const doubled = report();
  doubled.criteria.push({ num: '1.2.1', na: 'again' });
  assert.match(errorsFor(doubled).join('\n'), /more than once/);

  const outside = report();
  outside.criteria.push({ num: '2.4.7', na: 'Focus Visible is AA, not A' });
  assert.match(errorsFor(outside).join('\n'), /2\.4\.7.*not a criterion at this target/);
});

test('there is no fourth state: no notes field, no empty verdict, no n/a mixed with findings', () => {
  const notes = report();
  entry(notes, '1.4.1')['notes'] = 'Measured something, leaving it to a person';
  assert.match(errorsFor(notes).join('\n'), /unknown field\(s\) notes/);

  const empty = report();
  delete entry(empty, '1.4.1')['na'];
  assert.match(errorsFor(empty).join('\n'), /1\.4\.1.*no verdict/);

  const mixed = report();
  entry(mixed, '2.4.2')['na'] = 'Also n/a somehow';
  assert.match(errorsFor(mixed).join('\n'), /n\/a can't sit alongside/);
});

test('each verdict owes what the spec says it owes', () => {
  const bare = report();
  entry(bare, '2.4.2')['evidence'] = [{ did: 'Looked', saw: '' }];
  assert.match(errorsFor(bare).join('\n'), /evidence\[0\]\.saw: required/);

  const noHurt = report();
  const fail = (entry(noHurt, '1.1.1')['fails'] as Record<string, unknown>[])[0] ?? {};
  delete fail['whoItHurts'];
  assert.match(errorsFor(noHurt).join('\n'), /whoItHurts: required/);

  const noRepro = report();
  const behaviour = (entry(noRepro, '2.1.1')['fails'] as Record<string, unknown>[])[0] ?? {};
  delete behaviour['repro'];
  assert.match(errorsFor(noRepro).join('\n'), /repro: required for a behaviour fail/);

  const noHow = report();
  const check = (entry(noHow, '1.3.1')['checks'] as Record<string, unknown>[])[0] ?? {};
  delete check['how'];
  assert.match(errorsFor(noHow).join('\n'), /checks\[0\]\.how: required/);
});

test('file:line has to exist on disk', () => {
  const ghost = report();
  const fail = (entry(ghost, '1.1.1')['fails'] as Record<string, unknown>[])[0] ?? {};
  fail['file'] = 'pages/missing.html';
  assert.match(errorsFor(ghost).join('\n'), /doesn't exist in the repository/);

  const pastEnd = report();
  const late = (entry(pastEnd, '1.1.1')['fails'] as Record<string, unknown>[])[0] ?? {};
  late['line'] = 999;
  assert.match(errorsFor(pastEnd).join('\n'), /past the end of index\.html/);

  const escape = report();
  const outside = (entry(escape, '1.1.1')['fails'] as Record<string, unknown>[])[0] ?? {};
  outside['file'] = '../../etc/hosts';
  assert.match(errorsFor(escape).join('\n'), /relative to the repository root/);
});

test('no claims of a pass or compliance, except quoted UI text in backticks', () => {
  const claims = report();
  entry(claims, '2.4.2')['evidence'] = [{ did: 'Checked titles', saw: 'Every page passes' }];
  assert.match(errorsFor(claims).join('\n'), /uses "passes"/);

  const compliant = report();
  entry(compliant, '1.2.1')['na'] = 'Compliant by design';
  assert.match(errorsFor(compliant).join('\n'), /uses "Compliant"/);

  const quoted = report();
  entry(quoted, '2.4.2')['evidence'] = [{ did: 'Read the button labelled `Pass the moth`', saw: 'It has a name' }];
  assert.deepEqual(errorsFor(quoted), []);
});

test('the report comes out of the last json block in a final message', () => {
  const text = 'Some thinking.\n```json\n{"draft": true}\n```\nThen the real one:\n```json\n{"schema": "actua11y.finder/1"}\n```\n';
  assert.deepEqual(extractReportJson(text), { schema: 'actua11y.finder/1' });
  assert.equal(extractReportJson('no json here'), undefined);
  assert.deepEqual(extractReportJson('{"bare": 1}'), { bare: 1 });
});

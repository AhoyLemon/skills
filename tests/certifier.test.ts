import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CERTIFIER_SCHEMA, passVerdict, validateCertifierReport, type CertifierContext } from '../skills/actua11y/_lib/_certifier.ts';
import { criteriaAt } from '../skills/actua11y/_lib/_criteria.ts';
import { makeSite } from './_fixtures.ts';

const ESCAPE_THREE = ['Load /', 'Open the menu', 'Press Escape', 'Press Escape', 'Press Escape', 'The menu is still open'];

const context = (): CertifierContext => ({ criteria: criteriaAt('A'), repoRoot: makeSite(), tracked: new Set(['index.html', 'css/site.css']), items: ['A1', 'A2'], carried: [{ id: 'A2', from: 1, steps: ESCAPE_THREE }] });

type Draft = Record<string, unknown>;

const good = (): Draft => ({
  schema: CERTIFIER_SCHEMA,
  used: { tools: ['Read', 'own script: Escape on the menu'], pages: ['/'] },
  items: [
    { id: 'A1', fixed: [{ did: 'Read the img on / in the running page', saw: 'alt is `A moth`' }] },
    { id: 'A2', notFixed: { file: 'index.html', line: 6, what: 'The menu ignores Escape', steps: ESCAPE_THREE } },
  ],
  reran: [{ id: 'A2', from: 1, steps: ESCAPE_THREE, saw: 'Still open after three presses', reproduced: true }],
  rewalk: { criteria: criteriaAt('A').map((criterion) => ({ num: criterion.num, did: 'Walked it again on /' })), newFails: [], newChecks: [] },
});

const errorsOf = (draft: Draft): string[] => {
  const result = validateCertifierReport(draft, context());
  return result.ok ? [] : result.errors;
};

test('a good certifier report validates', () => {
  assert.deepEqual(errorsOf(good()), []);
});

test('a carried repro has to be run again word for word: Escape pressed twice is not the carried three', () => {
  const twice = good();
  twice['reran'] = [{ id: 'A2', from: 1, steps: ['Load /', 'Open the menu', 'Press Escape', 'Press Escape', 'The menu is still open'], saw: 'It closed', reproduced: false }];
  twice['items'] = [(good()['items'] as Draft[])[0], { id: 'A2', fixed: [{ did: 'Pressed Escape twice', saw: 'It closed' }] }];
  assert.ok(errorsOf(twice).some((error) => /must be exactly the carried steps/.test(error)));
});

test('a carried repro that still reproduces makes its item notFixed, and none can be skipped', () => {
  const contradicts = good();
  contradicts['items'] = [(good()['items'] as Draft[])[0], { id: 'A2', fixed: [{ did: 'Looked at the menu', saw: 'Looks fine' }] }];
  assert.ok(errorsOf(contradicts).some((error) => /still reproduced, so A2 can't be fixed/.test(error)));
  const skipped = good();
  skipped['reran'] = [];
  assert.ok(errorsOf(skipped).some((error) => /missing the carried repro A2 from pass 1/.test(error)));
});

test('the re-walk covers every criterion at the target', () => {
  const short = good();
  short['rewalk'] = { criteria: [{ num: '1.1.1', did: 'Looked' }], newFails: [], newChecks: [] };
  assert.ok(errorsOf(short).some((error) => /re-walk covers every one/.test(error)));
  const outside = good();
  (outside['rewalk'] as Draft)['newFails'] = [{ num: '1.4.3', file: 'index.html', line: 1, what: 'Low contrast', whoItHurts: 'Low vision', behaviour: false }];
  assert.ok(errorsOf(outside).some((error) => /isn't a criterion at this target/.test(error)), '1.4.3 is AA, so not in an A re-walk');
});

test('every item gets exactly one outcome, and only items from the brief', () => {
  const both = good();
  both['items'] = [{ id: 'A1', fixed: [{ did: 'd', saw: 's' }], notFixed: { file: 'index.html', line: 5, what: 'w', steps: ['s'] } }, (good()['items'] as Draft[])[1]];
  assert.ok(errorsOf(both).some((error) => /exactly one of fixed, notFixed or needsPerson/.test(error)));
  const extra = good();
  extra['items'] = [...(good()['items'] as Draft[]), { id: 'A9', fixed: [{ did: 'd', saw: 's' }] }];
  assert.ok(errorsOf(extra).some((error) => /A9\): not an item in your brief/.test(error)));
  const missing = good();
  missing['items'] = [(good()['items'] as Draft[])[1]];
  assert.ok(errorsOf(missing).some((error) => /missing A1/.test(error)));
  const claim = good();
  claim['items'] = [{ id: 'A1', fixed: [{ did: 'Checked it', saw: 'It passes now' }] }, (good()['items'] as Draft[])[1]];
  assert.ok(errorsOf(claim).some((error) => /uses "passes"/.test(error)));
});

test('the verdict is computed: a 🕵️ moves instead of blocking, a fail outside the target never blocks, a new fail always does', () => {
  const result = validateCertifierReport(good(), context());
  if (!result.ok) throw new Error(result.errors.join('\n'));
  const report = result.report;
  assert.equal(passVerdict(report, new Set(['A1', 'A2'])).approved, false, 'A2 still fails');
  assert.deepEqual(passVerdict(report, new Set(['A1', 'A2'])).blockers, ['A2']);
  assert.equal(passVerdict(report, new Set(['A1'])).approved, true, 'a fail outside the target is shown, never blocking');
  const handedOver = { ...report, items: [report.items[0] ?? { id: 'A1' }, { id: 'A2', needsPerson: { what: 'Whether the menu announces itself', how: 'VoiceOver', whyNotAMachine: 'Speech output needs a person' } }] };
  assert.equal(passVerdict(handedOver, new Set(['A1', 'A2'])).approved, true);
  const newFail = { ...handedOver, rewalk: { ...report.rewalk, newFails: [{ num: '2.1.1', file: 'index.html', line: 6, what: 'Trap', whoItHurts: 'Keyboard users', behaviour: false }] } };
  assert.equal(passVerdict(newFail, new Set(['A1', 'A2'])).approved, false);
});

test("a re-walk entry that isn't an object is refused, never dropped, so a new fail can't slip past the verdict", () => {
  for (const list of ['newFails', 'newChecks', 'criteria'] as const) {
    const draft = good();
    const rewalk = draft['rewalk'] as Record<string, unknown[]>;
    rewalk[list] = [...(rewalk[list] ?? []), 'Escape leaves the menu open'];
    assert.ok(errorsOf(draft).some((error) => new RegExp(`rewalk\\.${list}\\[\\d+\\]: must be an object`).test(error)), list);
  }
});

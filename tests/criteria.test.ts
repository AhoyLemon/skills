import assert from 'node:assert/strict';
import { test } from 'node:test';

import { criteriaTableFor } from '../skills/actua11y/_lib/_cmd-run.ts';
import { axeTagsFor, criteriaAt, criteriaTable, criterionByNum } from '../skills/actua11y/_lib/_criteria.ts';

test('the table holds exactly WCAG 2.2: 86 criteria, 31 A, 24 AA, 31 AAA', () => {
  const { criteria } = criteriaTable();
  assert.equal(criteria.length, 86);
  assert.equal(criteria.filter((c) => c.level === 'A').length, 31);
  assert.equal(criteria.filter((c) => c.level === 'AA').length, 24);
  assert.equal(criteria.filter((c) => c.level === 'AAA').length, 31);
});

test('4.1.1 Parsing is gone, and no number repeats', () => {
  assert.equal(criterionByNum('4.1.1'), undefined);
  const nums = criteriaTable().criteria.map((c) => c.num);
  assert.equal(new Set(nums).size, nums.length);
});

test('levels are cumulative', () => {
  assert.equal(criteriaAt('A').length, 31);
  assert.equal(criteriaAt('AA').length, 55);
  assert.equal(criteriaAt('AAA').length, 86);
});

test('the levels models have got wrong before come from the table', () => {
  assert.equal(criterionByNum('2.4.7')?.level, 'AA');
  assert.equal(criterionByNum('1.3.4')?.level, 'AA');
  assert.equal(criteriaAt('A').some((c) => c.num === '2.4.7' || c.num === '1.3.4'), false);
});

test('a criterion whose title ends "except for the following:" keeps the exceptions, in the table and in the brief', () => {
  const contrast = criterionByNum('1.4.3');
  assert.match(contrast?.title ?? '', /except for the following:$/);
  assert.ok(contrast?.details.some((detail) => /^Large Text: .*at least 3:1/.test(detail)), 'the 3:1 exception for large text');
  assert.ok(criterionByNum('2.5.8')?.details.some((detail) => detail.startsWith('Spacing:')), 'the spacing exception for target size');
  const row = criteriaTableFor('AA').split('\n').find((line) => line.startsWith('| 1.4.3 '));
  assert.match(row ?? '', /Large Text: .*at least 3:1/);
  assert.match(row ?? '', /Logotypes:/);
});

test('axe tags accumulate with the level', () => {
  assert.deepEqual(axeTagsFor('A'), ['wcag2a', 'wcag21a']);
  assert.deepEqual(axeTagsFor('AA'), ['wcag2a', 'wcag21a', 'wcag2aa', 'wcag21aa', 'wcag22aa']);
  assert.deepEqual(axeTagsFor('AAA').at(-1), 'wcag2aaa');
});

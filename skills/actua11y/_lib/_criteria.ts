// The WCAG 2.2 criteria actua11y audits against, read from the shipped table so levels never come from a model's memory.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type Level = 'A' | 'AA' | 'AAA';

export const LEVELS: readonly Level[] = ['A', 'AA', 'AAA'];

export interface Criterion {
  num: string;
  name: string;
  level: Level;
  id: string;
  url: string;
  understanding: string;
  title: string;
}

interface CriteriaTable {
  source: string;
  sourceModified: string;
  copyright: string;
  license: string;
  criteria: Criterion[];
}

let cached: CriteriaTable | undefined;

export const criteriaTable = (): CriteriaTable => {
  cached ??= JSON.parse(readFileSync(join(import.meta.dirname, '..', 'data', 'wcag22.json'), 'utf8')) as CriteriaTable;
  return cached;
};

export const isLevel = (value: string): value is Level => (LEVELS as readonly string[]).includes(value);

// Levels are cumulative: AA means A and AA.
export const levelsUpTo = (target: Level): Level[] => LEVELS.slice(0, LEVELS.indexOf(target) + 1);

export const criteriaAt = (target: Level): Criterion[] => {
  const levels = new Set(levelsUpTo(target));
  return criteriaTable().criteria.filter((criterion) => levels.has(criterion.level));
};

export const criterionByNum = (num: string): Criterion | undefined => criteriaTable().criteria.find((criterion) => criterion.num === num);

// axe-core has no wcag22a, wcag21aaa or wcag22aaa tag, so every AAA rule sits under wcag2aaa.
const AXE_TAGS: Record<Level, string[]> = {
  A: ['wcag2a', 'wcag21a'],
  AA: ['wcag2aa', 'wcag21aa', 'wcag22aa'],
  AAA: ['wcag2aaa'],
};

export const axeTagsFor = (target: Level): string[] => levelsUpTo(target).flatMap((level) => AXE_TAGS[level]);

export const levelLabel = (target: Level): string => (target === 'A' ? 'Level A' : `Level ${target} (${levelsUpTo(target).join(' + ')})`);

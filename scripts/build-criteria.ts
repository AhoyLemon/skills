// Regenerates skills/actua11y/data/wcag22.json from W3C's published WCAG 2.2 data, so no criterion or level is ever typed from memory.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

interface W3cDetailItem {
  handle?: string;
  text: string;
}

interface W3cDetail {
  type: string;
  handle?: string;
  text?: string;
  items?: W3cDetailItem[];
}

interface W3cCriterion {
  id: string;
  num: string;
  handle: string;
  title: string;
  level: string;
  versions: string[];
  details?: W3cDetail[];
}

interface W3cData {
  principles: { guidelines: { successcriteria: W3cCriterion[] }[] }[];
}

interface CriterionRow {
  num: string;
  name: string;
  level: 'A' | 'AA' | 'AAA';
  id: string;
  url: string;
  understanding: string;
  title: string;
  details: string[];
}

const SOURCE = 'https://www.w3.org/WAI/WCAG22/wcag.json';
const OUT = join(import.meta.dirname, '..', 'skills', 'actua11y', 'data', 'wcag22.json');
const LEVELS = new Set(['A', 'AA', 'AAA']);

const response = await fetch(SOURCE);
if (!response.ok) throw new Error(`Couldn't fetch ${SOURCE}: HTTP ${response.status}`);
const sourceModified = response.headers.get('last-modified') ?? 'unknown';
const data = (await response.json()) as W3cData;

const byNumber = (a: CriterionRow, b: CriterionRow): number => {
  const pa = a.num.split('.').map(Number);
  const pb = b.num.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

const labelled = (handle: string | undefined, text: string): string => (handle ? `${handle}: ${text}` : text);

// W3C keeps exceptions (1.4.3's large text, say), conditions and notes in details, apart from the title. Each list item and note keeps its own handle in front of its text.
const detailsOf = (sc: W3cCriterion): string[] =>
  (sc.details ?? []).flatMap((detail) => (detail.items ? detail.items.map((item) => labelled(item.handle, item.text)) : detail.text ? [labelled(detail.handle, detail.text)] : []));

const criteria: CriterionRow[] = data.principles
  .flatMap((principle) => principle.guidelines.flatMap((guideline) => guideline.successcriteria))
  .filter((sc) => sc.versions.includes('2.2') && LEVELS.has(sc.level))
  .map((sc) => ({
    num: sc.num,
    name: sc.handle,
    level: sc.level as CriterionRow['level'],
    id: sc.id,
    url: `https://www.w3.org/TR/WCAG22/#${sc.id}`,
    understanding: `https://www.w3.org/WAI/WCAG22/Understanding/${sc.id}.html`,
    title: sc.title,
    details: detailsOf(sc),
  }))
  .sort(byNumber);

const table = {
  generatedBy: 'scripts/build-criteria.ts in AhoyLemon/skills. Regenerate it, never edit it by hand.',
  source: SOURCE,
  sourceModified,
  copyright: 'Copyright © W3C® (MIT, ERCIM, Keio, Beihang). Criterion numbers, names, levels, titles and details are W3C content, unchanged apart from each detail item or note being prefixed with its own handle.',
  license: 'W3C Document License, https://www.w3.org/copyright/document-license/',
  addedHere: 'The url and understanding links are built from each criterion id by this script, not taken from the source.',
  criteria,
};

writeFileSync(OUT, `${JSON.stringify(table, null, 2)}\n`);
const count = (level: string): number => criteria.filter((c) => c.level === level).length;
process.stdout.write(`Wrote ${criteria.length} criteria (${count('A')} A, ${count('AA')} AA, ${count('AAA')} AAA) to ${OUT}\n`);

// Synthetic fixtures for the tests: a made-up two-file site and a report about it. Never derived from any real or seeded app.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

import { emptyUsage } from '../skills/actua11y/_lib/_backend.ts';
import { BEST_FAITH } from '../skills/actua11y/_lib/_copy.ts';
import { criteriaAt, type Level } from '../skills/actua11y/_lib/_criteria.ts';
import { initialLedger, type LoopView } from '../skills/actua11y/_lib/_ledger.ts';
import type { RunFacts } from '../skills/actua11y/_lib/_render.ts';
import { FINDER_SCHEMA, type FinderReport } from '../skills/actua11y/_lib/_report.ts';

const made: string[] = [];

// Each test file removes its temp folders when it finishes, so none pile up for the runner's off-limits list to name.
after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

export const tempDir = (label: string): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `actua11y-test-${label}-`)));
  made.push(dir);
  return dir;
};

export const makeSite = (): string => {
  const root = tempDir('site');
  mkdirSync(join(root, 'css'));
  writeFileSync(join(root, 'index.html'), ['<!doctype html>', '<html>', '<head><title>Moth Club</title></head>', '<body>', '<img src="moth.png">', '<div onclick="go()">Join</div>', '</body>', '</html>'].join('\n'));
  writeFileSync(join(root, 'css', 'site.css'), ['body { color: #777; }', 'a:focus { outline: none; }'].join('\n'));
  return root;
};

// One entry per criterion at the level: a few with real content, the rest n/a.
export const makeReport = (level: Level = 'A'): Record<string, unknown> => ({
  schema: FINDER_SCHEMA,
  used: { tools: ['Read', 'Grep', 'kit/scan.ts'], pages: ['/'] },
  criteria: criteriaAt(level).map((criterion) => {
    if (criterion.num === '1.1.1') {
      return {
        num: '1.1.1',
        fails: [{ file: 'index.html', line: 5, what: 'The `<img>` has no alt attribute at all', whoItHurts: 'Screen reader users hear the file name', behaviour: false }],
        checks: [{ what: 'Whether the moth photo is decorative or carries meaning', how: 'Look at the page and decide what the image is for', whyNotAMachine: 'Purpose is a human judgement' }],
      };
    }
    if (criterion.num === '2.1.1') {
      return {
        num: '2.1.1',
        fails: [{ file: 'index.html', line: 6, what: 'Join is a div with a click handler, unreachable by keyboard', whoItHurts: 'Keyboard and switch users can never join', behaviour: true, repro: ['Load /', 'Press Tab until focus leaves the page', 'Focus never lands on Join'] }],
      };
    }
    if (criterion.num === '2.4.2') return { num: '2.4.2', evidence: [{ did: 'Read the <title> of every page in scope', saw: '`Moth Club` on /, which describes the page' }] };
    if (criterion.num === '1.3.1') return { num: '1.3.1', checks: [{ what: 'Whether visual groupings match the markup', how: 'Turn off CSS and compare the reading order', whyNotAMachine: 'Meaning of a visual grouping needs a person' }] };
    return { num: criterion.num, na: 'Nothing on this page uses it' };
  }),
});

export const makeFacts = (level: Level = 'A'): RunFacts => ({
  runId: '20261109-120000-abcd',
  level,
  scope: ['.'],
  repo: { owner: 'AhoyLemon', name: 'skills' },
  commit: '0123456789abcdef0123456789abcdef01234567',
  branch: 'main',
  baseUrl: 'http://127.0.0.1:4173/',
  browser: { channel: 'chrome', version: '157.0.0.0' },
  axe: { version: '4.14.0', tags: ['wcag2a', 'wcag21a'] },
  backend: 'Claude Code',
  model: 'claude-opus-5-5',
  effort: 'high',
  usage: { ...emptyUsage(), costUsd: 3.21, turns: 42, durationMs: 1_098_000, inputTokens: 1000, outputTokens: 20_000, cacheReadTokens: 900_000 },
  dryRunUsage: { ...emptyUsage(), costUsd: 0.06, turns: 1, durationMs: 6000 },
  fences: { denials: 0, mentions: 0 },
  served: null,
  finishedAt: '2026-11-09T12:30:00Z',
});

// A fresh loop's view of a report: ids assigned, nothing moved yet.
export const viewOf = (report: FinderReport, facts: RunFacts = makeFacts('A')): LoopView => ({ ledger: { ...initialLedger(report, facts, { url: facts.baseUrl, serve: null }), personUrl: 'https://github.com/AhoyLemon/skills/issues/2' }, finder: report, passes: new Map() });

// Nothing actua11y renders may claim a pass. Deliberately broader than the validator's list (whole word families), so a form the validator misses still fails here. HTML comments and fenced JSON are machine records (the validator already holds the model-written strings inside them to the same rule), the best-faith line is the one place the rule itself is stated, and the loop's agreed vocabulary (the certifier, pass N, certified at a commit, the certified commit) is the only exception.
export const CLAIM = /\b(pass\w*|compl[iy]\w*|conform\w*|certif\w*)\b/i;

export const claimFree = (text: string): string =>
  text
    .split(BEST_FAITH)
    .join('')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(`{3,})json\n[\s\S]*?\n\1/g, '')
    .replace(/\bcertifier\b/gi, '')
    .replace(/\bcertified at\b/gi, '')
    .replace(/\bthe certified commit\b/gi, '')
    .replace(/\bpass \d+\b/gi, '');

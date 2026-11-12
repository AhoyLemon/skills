// Command-line options for the runner, parsed with Node's own parser so the runner stays dependency-free.
import { parseArgs } from 'node:util';

import type { Backend } from './_backend.ts';
import { isLevel, type Level } from './_criteria.ts';
import type { Choice } from './_ledger.ts';

export interface Options {
  command: string;
  subject: string;
  cwd: string;
  level: Level | null;
  scope: string[];
  url: string | null;
  serve: string | null;
  pages: string[];
  allowIgnored: string[];
  model: string;
  effort: string;
  maxTurns: number;
  maxBudgetUsd: number;
  timeoutMinutes: number;
  run: string | null;
  preview: boolean;
  help: boolean;
  issue: string | null;
  branch: string | null;
  budgetUsd: number;
  words: string | null;
  criterion: string | null;
  ux: boolean;
  decision: Choice | null;
  reason: string | null;
  how: string | null;
  check: string | null;
  item: string | null;
  tokens: number | null;
  minutes: number | null;
  uncertifiedOk: boolean;
  atCap: boolean;
}

// The model and effort defaults belong to the backend. These caps don't. The budget covers everything the runner starts across the whole loop.
export const DEFAULTS = {
  maxTurns: 300,
  maxBudgetUsd: 20,
  timeoutMinutes: 60,
  budgetUsd: 60,
};

const positiveNumber = (name: string, text: string | undefined, fallback: number): number => {
  if (text === undefined) return fallback;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} needs a positive number, not "${text}"`);
  return value;
};

const optionalNumber = (name: string, text: string | undefined): number | null => (text === undefined ? null : positiveNumber(name, text, 0));

const CHOICES: Record<string, Choice> = { fix: 'fix', accept: 'accept', na: 'na', 'n/a': 'na' };

export const parseOptions = (argv: string[], backend: Backend): Options => {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      cwd: { type: 'string' },
      level: { type: 'string' },
      scope: { type: 'string', multiple: true },
      url: { type: 'string' },
      serve: { type: 'string' },
      page: { type: 'string', multiple: true },
      'allow-ignored': { type: 'string', multiple: true },
      model: { type: 'string' },
      effort: { type: 'string' },
      'max-turns': { type: 'string' },
      'max-budget-usd': { type: 'string' },
      'timeout-minutes': { type: 'string' },
      run: { type: 'string' },
      preview: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      issue: { type: 'string' },
      branch: { type: 'string' },
      'budget-usd': { type: 'string' },
      words: { type: 'string' },
      criterion: { type: 'string' },
      ux: { type: 'boolean', default: false },
      decision: { type: 'string' },
      reason: { type: 'string' },
      how: { type: 'string' },
      check: { type: 'string' },
      item: { type: 'string' },
      tokens: { type: 'string' },
      minutes: { type: 'string' },
      'uncertified-ok': { type: 'boolean', default: false },
      'at-cap': { type: 'boolean', default: false },
    },
  });
  const level = values.level?.toUpperCase() ?? null;
  if (level !== null && !isLevel(level)) throw new Error(`--level must be A, AA or AAA, not "${values.level}"`);
  const effort = values.effort ?? backend.defaults.effort;
  if (!backend.efforts.includes(effort)) throw new Error(`--effort must be one of ${backend.efforts.join(', ')}`);
  if (values.url && values.serve) throw new Error('Pass --url or --serve, not both');
  const decision = values.decision === undefined ? null : (CHOICES[values.decision.toLowerCase()] ?? null);
  if (values.decision !== undefined && decision === null) throw new Error(`--decision must be fix, accept or na, not "${values.decision}"`);
  if (values.criterion && values.ux) throw new Error('Pass --criterion or --ux, not both');
  return {
    command: positionals[0] ?? '',
    subject: positionals[1] ?? '',
    cwd: values.cwd ?? process.cwd(),
    level,
    scope: values.scope && values.scope.length > 0 ? values.scope : ['.'],
    url: values.url ?? null,
    serve: values.serve ?? null,
    pages: values.page ?? [],
    allowIgnored: (values['allow-ignored'] ?? []).map((path) => path.replace(/\/$/, '')),
    model: values.model ?? backend.defaults.model,
    effort,
    maxTurns: positiveNumber('max-turns', values['max-turns'], DEFAULTS.maxTurns),
    maxBudgetUsd: positiveNumber('max-budget-usd', values['max-budget-usd'], DEFAULTS.maxBudgetUsd),
    timeoutMinutes: positiveNumber('timeout-minutes', values['timeout-minutes'], DEFAULTS.timeoutMinutes),
    run: values.run ?? null,
    preview: values.preview,
    help: values.help,
    issue: values.issue ?? null,
    branch: values.branch ?? null,
    budgetUsd: positiveNumber('budget-usd', values['budget-usd'], DEFAULTS.budgetUsd),
    words: values.words ?? null,
    criterion: values.criterion ?? null,
    ux: values.ux,
    decision,
    reason: values.reason ?? null,
    how: values.how ?? null,
    check: values.check ?? null,
    item: values.item ?? null,
    tokens: optionalNumber('tokens', values.tokens),
    minutes: optionalNumber('minutes', values.minutes),
    uncertifiedOk: values['uncertified-ok'],
    atCap: values['at-cap'],
  };
};

export const usage = (backend: Backend): string => `actua11y runner

Assess:
  node runner.ts preflight       --level AA [--scope <path>...] [--url <url> | --serve <dir>] [--allow-ignored <path>...]
  node runner.ts dry-run         [--model <id>] [--effort <level>]
  node runner.ts brief finder    --level AA [--scope <path>...] [--url <url> | --serve <dir>] [--page <path>...]
  node runner.ts run finder      --level AA [--scope <path>...] (--url <url> | --serve <dir>) [--page <path>...] [--allow-ignored <path>...]
  node runner.ts file            --run <run-id> [--preview] [--allow-ignored <path>...]

Fix and certify (every one takes --issue <the agent issue's number>, or finds the one open agent issue):
  node runner.ts loop start      [--branch <name>] [--budget-usd ${DEFAULTS.budgetUsd}]
  node runner.ts brief fixer     prints the brief to hand a subagent, unchanged
  node runner.ts record fixer    [--tokens <n>] [--minutes <n>] < the subagent's final message
  node runner.ts brief certifier prints what the next certifier pass will be told
  node runner.ts run certifier   [--url <url> | --serve <dir>] [--allow-ignored <path>...], then file --run <run-id>
  node runner.ts loop stop       ends the AI rounds now, as if the cap hit
  node runner.ts record finding  --words "<their words>" (--criterion <num> | --ux) [--check <P id>] --decision fix|accept|na [--how "<their words>" | --reason "<their words>"]
  node runner.ts record decision --item <id> --decision fix|accept|na [--how "<their words>" | --reason "<their words>"]
  node runner.ts close-out       [--uncertified-ok] [--at-cap]
  node runner.ts status          where the loop stands, rebuilt from GitHub alone, and what to run next
  node runner.ts serve           --serve <dir>   serves a static site on localhost until stopped

Sessions the runner starts take [--model ${backend.defaults.model}] [--effort ${backend.defaults.effort}] [--max-turns ${DEFAULTS.maxTurns}] [--max-budget-usd ${DEFAULTS.maxBudgetUsd}] [--timeout-minutes ${DEFAULTS.timeoutMinutes}].
Run it from inside the repository you're auditing (or pass --cwd).`;

// Command-line options for the runner, parsed with Node's own parser so the runner stays dependency-free.
import { parseArgs } from 'node:util';

import { EFFORTS, type Effort } from './_backend.ts';
import { isLevel, type Level } from './_criteria.ts';

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
  effort: Effort;
  maxTurns: number;
  maxBudgetUsd: number;
  timeoutMinutes: number;
  run: string | null;
  preview: boolean;
  help: boolean;
}

export const DEFAULTS = {
  model: 'claude-opus-5-5',
  effort: 'high' as Effort,
  maxTurns: 300,
  maxBudgetUsd: 20,
  timeoutMinutes: 60,
};

const positiveNumber = (name: string, text: string | undefined, fallback: number): number => {
  if (text === undefined) return fallback;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} needs a positive number, not "${text}"`);
  return value;
};

export const parseOptions = (argv: string[]): Options => {
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
    },
  });
  const level = values.level?.toUpperCase() ?? null;
  if (level !== null && !isLevel(level)) throw new Error(`--level must be A, AA or AAA, not "${values.level}"`);
  const effort = values.effort ?? DEFAULTS.effort;
  if (!(EFFORTS as readonly string[]).includes(effort)) throw new Error(`--effort must be one of ${EFFORTS.join(', ')}`);
  if (values.url && values.serve) throw new Error('Pass --url or --serve, not both');
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
    model: values.model ?? DEFAULTS.model,
    effort: effort as Effort,
    maxTurns: positiveNumber('max-turns', values['max-turns'], DEFAULTS.maxTurns),
    maxBudgetUsd: positiveNumber('max-budget-usd', values['max-budget-usd'], DEFAULTS.maxBudgetUsd),
    timeoutMinutes: positiveNumber('timeout-minutes', values['timeout-minutes'], DEFAULTS.timeoutMinutes),
    run: values.run ?? null,
    preview: values.preview,
    help: values.help,
  };
};

export const USAGE = `actua11y runner

  node runner.ts preflight   --level AA [--scope <path>...] [--url <url> | --serve <dir>] [--allow-ignored <path>...]
  node runner.ts dry-run     [--model <id>] [--effort <level>]
  node runner.ts brief finder --level AA [--scope <path>...] [--url <url> | --serve <dir>] [--page <path>...]
  node runner.ts run finder  --level AA [--scope <path>...] (--url <url> | --serve <dir>) [--page <path>...] [--allow-ignored <path>...]
                             [--model ${DEFAULTS.model}] [--effort ${DEFAULTS.effort}] [--max-turns ${DEFAULTS.maxTurns}] [--max-budget-usd ${DEFAULTS.maxBudgetUsd}] [--timeout-minutes ${DEFAULTS.timeoutMinutes}]
  node runner.ts file        --run <run-id> [--preview]

Run it from inside the repository you're auditing (or pass --cwd).`;

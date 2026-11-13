// actua11y's runner: everything except starting a session is agent-neutral and lives here, and the orchestrator calls it instead of improvising. Run it with plain node 22.18+.
import { err, red } from './_lib/_ansi.ts';
import { parseOptions, usage, type Options } from './_lib/_args.ts';
import type { Backend } from './_lib/_backend.ts';
import { cmdBriefCertifier, cmdRunCertifier } from './_lib/_cmd-certifier.ts';
import { cmdDryRun, cmdPreflight } from './_lib/_cmd-checks.ts';
import { cmdFile } from './_lib/_cmd-file.ts';
import { cmdCloseOut, cmdRecordDecision, cmdRecordFinding, cmdServe } from './_lib/_cmd-human.ts';
import { cmdBriefFixer, cmdLoopStart, cmdLoopStop, cmdRecordFixer, cmdStatus } from './_lib/_cmd-loop.ts';
import { cmdBrief, cmdRunFinder } from './_lib/_cmd-run.ts';
import { realLoopGh } from './_lib/_loop.ts';
import { nodeIsNewEnough } from './_lib/_preflight.ts';
import { claudeCode } from './_backends/_claude-code.ts';
import { codex } from './_backends/_codex.ts';

const selectBackend = (args: string[]): Backend => {
  const value = args.flatMap((arg, i) => arg === '--backend' ? [args[i + 1] ?? ''] : arg.startsWith('--backend=') ? [arg.slice('--backend='.length)] : []);
  if (value.length > 1) throw new Error('Pass --backend only once');
  if (value.length === 0 || value[0] === 'claude-code') return claudeCode;
  if (value[0] === 'codex') return codex;
  throw new Error('--backend must be claude-code or codex');
};

const subjectOf = (options: Options, allowed: string[]): string => {
  if (!allowed.includes(options.subject)) throw new Error(`\`${options.command}\` takes ${allowed.map((subject) => `\`${subject}\``).join(', ')}, not "${options.subject}"`);
  return options.subject;
};

const main = async (): Promise<number> => {
  const backend = selectBackend(process.argv.slice(2));
  if (!nodeIsNewEnough(process.version)) {
    err(`actua11y needs Node 22.18 or later to run TypeScript directly. This is ${process.version}.`);
    return 1;
  }
  const options = parseOptions(process.argv.slice(2), backend);
  if (options.help || options.command === '') {
    err(usage(backend));
    return options.help ? 0 : 1;
  }
  switch (options.command) {
    case 'preflight':
      return cmdPreflight(options, backend);
    case 'dry-run':
      return cmdDryRun(options, backend);
    case 'brief': {
      const subject = subjectOf(options, ['finder', 'fixer', 'certifier']);
      if (subject === 'fixer') return cmdBriefFixer(options, realLoopGh);
      if (subject === 'certifier') return cmdBriefCertifier(options, realLoopGh, backend);
      return cmdBrief(options, backend);
    }
    case 'run':
      return subjectOf(options, ['finder', 'certifier']) === 'certifier' ? cmdRunCertifier(options, backend, realLoopGh) : cmdRunFinder(options, backend);
    case 'file':
      return cmdFile(options);
    case 'loop':
      return subjectOf(options, ['start', 'stop']) === 'start' ? cmdLoopStart(options, realLoopGh) : cmdLoopStop(options, realLoopGh);
    case 'record': {
      const subject = subjectOf(options, ['fixer', 'finding', 'decision']);
      if (subject === 'fixer') return cmdRecordFixer(options, realLoopGh);
      if (subject === 'finding') return cmdRecordFinding(options, realLoopGh);
      return cmdRecordDecision(options, realLoopGh);
    }
    case 'status':
      return cmdStatus(options, realLoopGh);
    case 'close-out':
      return cmdCloseOut(options, realLoopGh);
    case 'serve':
      return cmdServe(options);
    default:
      err(`Unknown command "${options.command}".\n\n${usage(backend)}`);
      return 1;
  }
};

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    err(red(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  },
);

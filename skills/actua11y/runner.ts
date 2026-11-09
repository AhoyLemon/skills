// actua11y's runner: everything except starting a session is agent-neutral and lives here, and the orchestrator calls it instead of improvising. Run it with plain node 22.18+.
import { err, red } from './_lib/_ansi.ts';
import { parseOptions, USAGE } from './_lib/_args.ts';
import type { Backend } from './_lib/_backend.ts';
import { cmdDryRun, cmdPreflight } from './_lib/_cmd-checks.ts';
import { cmdFile } from './_lib/_cmd-file.ts';
import { cmdBrief, cmdRunFinder } from './_lib/_cmd-run.ts';
import { nodeIsNewEnough } from './_lib/_preflight.ts';
import { claudeCode } from './_backends/_claude-code.ts';

const backend: Backend = claudeCode;

const main = async (): Promise<number> => {
  if (!nodeIsNewEnough(process.version)) {
    err(`actua11y needs Node 22.18 or later to run TypeScript directly. This is ${process.version}.`);
    return 1;
  }
  const options = parseOptions(process.argv.slice(2));
  if (options.help || options.command === '') {
    err(USAGE);
    return options.help ? 0 : 1;
  }
  switch (options.command) {
    case 'preflight':
      return cmdPreflight(options, backend);
    case 'dry-run':
      return cmdDryRun(options, backend);
    case 'brief':
      return cmdBrief(options);
    case 'run':
      return cmdRunFinder(options, backend);
    case 'file':
      return cmdFile(options);
    default:
      err(`Unknown command "${options.command}".\n\n${USAGE}`);
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

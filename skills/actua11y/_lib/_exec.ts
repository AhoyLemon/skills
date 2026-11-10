// Small wrappers for running git, gh, npm and node without a shell, so nothing in a path or title gets interpreted.
import { spawnSync, type SpawnSyncOptions } from 'node:child_process';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export const exec = (command: string, args: string[], options: SpawnSyncOptions = {}): ExecResult => {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
  if (result.error) return { code: 127, stdout: '', stderr: result.error.message };
  return { code: result.status ?? 1, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };
};

export const execOrThrow = (command: string, args: string[], options: SpawnSyncOptions = {}): string => {
  const result = exec(command, args, options);
  if (result.code !== 0) throw new Error(`${command} ${args.join(' ')} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
  return result.stdout.trim();
};

export const onPath = (command: string): boolean => exec(command, ['--version']).code === 0;


const cleanups = new Set<() => void>();
let hooked = false;

const runCleanups = (): void => {
  for (const cleanup of cleanups) {
    try {
      cleanup();
    } catch {
      // Best effort: one failed cleanup shouldn't stop the others.
    }
  }
  cleanups.clear();
};

// Registers a cleanup that runs however the process ends, Ctrl-C and kill included. Call the returned function to run it now, or with false to drop it unrun.
export const onExit = (cleanup: () => void): ((run?: boolean) => void) => {
  if (!hooked) {
    hooked = true;
    process.on('exit', runCleanups);
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      process.on(signal, () => {
        runCleanups();
        process.exit(130);
      });
    }
  }
  cleanups.add(cleanup);
  return (run = true) => {
    if (!cleanups.delete(cleanup)) return;
    if (run) cleanup();
  };
};

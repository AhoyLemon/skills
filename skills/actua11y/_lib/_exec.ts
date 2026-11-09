// Small wrappers for running git, gh, npm and node without a shell, so nothing in a path or title gets interpreted.
import { spawn, spawnSync, type SpawnSyncOptions } from 'node:child_process';

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

// The async twin, for anything that runs while the runner's own static server has to keep answering requests. A sync spawn would block the event loop and starve the server.
export const execAsync = (command: string, args: string[], options: { cwd?: string } = {}): Promise<ExecResult> =>
  new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => resolve({ code: 127, stdout, stderr: error.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

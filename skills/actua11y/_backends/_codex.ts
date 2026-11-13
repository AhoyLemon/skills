// Starts isolated Codex sessions and translates their JSON events into the runner's backend interface.
import { spawn } from 'node:child_process';
import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { emptyUsage, type Backend, type BackendCheck, type InitInfo, type RoleSpec, type SessionResult } from '../_lib/_backend.ts';
import { exec, onExit } from '../_lib/_exec.ts';

interface Invocation {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  stdin: string;
}

type Json = Record<string, unknown>;
const record = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : 0;
const quote = (value: string): string => JSON.stringify(value);

export const configFor = (spec: RoleSpec): string[] => {
  const paths = new Map<string, string>([[':minimal', 'read'], ['/', 'deny'], ['/System', 'read'], ['/usr', 'read'], ['/bin', 'read'], ['/opt', 'read'], [spec.cwd, 'read']]);
  if (spec.scratch) paths.set(spec.scratch, 'write');
  for (const path of spec.offLimits) if (path.startsWith(`${spec.cwd}/`)) paths.set(path.replace(/\/$/, ''), 'deny');
  const filesystem = [...paths].map(([path, access]) => `${quote(path)}=${quote(access)}`).join(', ');
  return ['-c', 'project_doc_max_bytes=0', '-c', 'skills.bundled.enabled=false', '-c', 'features.apps=false', '-c', 'features.plugins=false', '-c', 'web_search="disabled"', '-c', 'approval_policy="never"', '-c', 'default_permissions="actua11y"', '-c', `permissions.actua11y.filesystem={${filesystem}}`, '-c', 'permissions.actua11y.network.enabled=true', '-c', `model=${quote(spec.model)}`, '-c', `model_reasoning_effort=${quote(spec.effort)}`];
};

export const buildInvocation = (spec: RoleSpec, home: string, parent: NodeJS.ProcessEnv, sessionId?: string, message?: string): Invocation => {
  const env: Record<string, string> = { HOME: home, CODEX_HOME: home };
  for (const key of ['PATH', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'TMPDIR', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'NODE_EXTRA_CA_CERTS', 'OPENAI_API_KEY']) {
    const value = parent[key];
    if (value) env[key] = value;
  }
  if (spec.browserEndpoint) env['ACTUA11Y_BROWSER_WS'] = spec.browserEndpoint;
  const args = ['exec', '--json', '--ignore-user-config', '--skip-git-repo-check', ...configFor(spec), '-m', spec.model];
  if (sessionId) args.push('resume', sessionId, '-');
  else args.push('-');
  return { command: 'codex', args, env, cwd: spec.cwd, stdin: message ?? spec.brief };
};

export interface CodexSummary {
  sessionId: string;
  finalTexts: string[];
  toolInputs: string[];
  errors: string[];
  usage: ReturnType<typeof emptyUsage>;
}

export const parseStream = (lines: string[], elapsed: number): CodexSummary => {
  const usage = emptyUsage();
  usage.costUsd = null;
  usage.durationMs = elapsed;
  const result: CodexSummary = { sessionId: '', finalTexts: [], toolInputs: [], errors: [], usage };
  const seen = new Set<string>();
  for (const line of lines) {
    let event: unknown;
    try { event = JSON.parse(line); } catch { continue; }
    if (!record(event)) continue;
    if (event['type'] === 'thread.started') result.sessionId = String(event['thread_id'] ?? '');
    if (event['type'] === 'turn.completed' && record(event['usage'])) {
      const data = event['usage'];
      const cached = number(data['cached_input_tokens']);
      usage.inputTokens += Math.max(0, number(data['input_tokens']) - cached);
      usage.cacheReadTokens += cached;
      usage.cacheWriteTokens += number(data['cache_write_input_tokens']);
      usage.outputTokens += number(data['output_tokens']);
      usage.turns += 1;
    }
    if (event['type'] === 'turn.failed' || event['type'] === 'error') result.errors.push(JSON.stringify(event['error'] ?? event));
    const item = event['item'];
    if (!record(item)) continue;
    const isTool = ['command_execution', 'mcp_tool_call', 'collab_tool_call', 'web_search', 'file_change'].includes(String(item['type']));
    const id = String(item['id'] ?? `${line}`);
    if (isTool && (event['type'] === 'item.started' || event['type'] === 'item.completed') && !seen.has(id)) {
      seen.add(id);
      result.toolInputs.push(item['type'] === 'command_execution' ? String(item['command'] ?? '') : JSON.stringify(item));
    }
    if (event['type'] === 'item.completed' && item['type'] === 'agent_message' && typeof item['text'] === 'string') result.finalTexts.push(item['text']);
  }
  return result;
};

const inspectPrompt = (spec: RoleSpec, home: string, env: Record<string, string>): string[] => {
  const check = exec('codex', ['debug', 'prompt-input', ...configFor(spec), 'actua11y isolation check'], { cwd: spec.cwd, env });
  if (check.code !== 0) return [`prompt inspection failed: ${check.stderr.trim() || check.stdout.trim()}`];
  let prompt: unknown;
  try { prompt = JSON.parse(check.stdout); } catch { return ['prompt inspection returned invalid JSON']; }
  if (!Array.isArray(prompt)) return ['prompt inspection returned an unexpected shape'];
  const problems: string[] = [];
  for (const entry of prompt) {
    if (!record(entry)) continue;
    if (entry['type'] === 'additional_tools' && Array.isArray(entry['tools'])) {
      const extra = entry['tools'].filter(record).map((tool) => String(tool['name'] ?? '')).filter((name) => !['functions', 'clock', 'collaboration'].includes(name));
      if (extra.length) problems.push(`unexpected tool namespaces: ${extra.join(', ')}`);
    }
    if (entry['role'] !== 'developer' || !Array.isArray(entry['content'])) continue;
    const text = entry['content'].filter(record).map((item) => String(item['text'] ?? '')).join('\n');
    if (text.includes('<skills_instructions>') || text.includes('<app-context>') || text.includes('<user_instructions>') || text.includes('# AGENTS.md instructions')) problems.push('unexpected skills, app or user instructions in the prompt');
  }
  return problems;
};

const homes = new Map<string, { home: string; release: (run?: boolean) => void }>();

const run = async (spec: RoleSpec, resume?: { sessionId: string; message: string }): Promise<SessionResult> => {
  const prior = resume ? homes.get(resume.sessionId) : undefined;
  const home = prior?.home ?? mkdtempSync(join(tmpdir(), 'actua11y-codex-'));
  const release = prior?.release ?? onExit(() => rmSync(home, { recursive: true, force: true }));
  if (!prior) {
    const commands = [...(spec.deny.includes('git') ? ['git'] : []), ...(spec.deny.includes('github') ? ['gh'] : []), ...(spec.deny.includes('installs') ? ['npm', 'npx', 'pnpm', 'yarn', 'bun', 'pip', 'pip3', 'brew', 'corepack'] : [])];
    mkdirSync(join(home, 'rules'));
    writeFileSync(join(home, 'rules', 'default.rules'), commands.map((command) => `prefix_rule(pattern = [${quote(command)}], decision = "forbidden")`).join('\n'));
    const auth = join(process.env['CODEX_HOME'] ?? join(homedir(), '.codex'), 'auth.json');
    if (existsSync(auth)) {
      copyFileSync(auth, join(home, 'auth.json'));
      chmodSync(join(home, 'auth.json'), 0o600);
    }
  }
  const invocation = buildInvocation(spec, home, process.env, resume?.sessionId, resume?.message);
  const problems = inspectPrompt(spec, home, invocation.env);
  const init: InitInfo = { sessionId: resume?.sessionId ?? '', model: spec.model, version: exec('codex', ['--version']).stdout.trim(), cwd: spec.cwd, permissionMode: 'actua11y', login: 'Codex sign-in or API key', tools: ['functions', 'clock', 'collaboration'], mcpServers: [], plugins: [], skills: [], agents: [] };
  const empty = emptyUsage();
  empty.costUsd = null;
  if (problems.length) {
    if (resume) homes.delete(resume.sessionId);
    release();
    return { sessionId: '', finalTexts: [], init: null, usage: empty, exitCode: 1, timedOut: false, errors: problems.map((problem) => `stopped at start: ${problem}`), permissionDenials: 0, toolInputs: [], transcriptPath: spec.transcriptPath };
  }
  mkdirSync(dirname(spec.transcriptPath), { recursive: true });
  return await new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(invocation.command, invocation.args, { cwd: invocation.cwd, env: invocation.env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const errors: string[] = [];
    const kill = (): void => { child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000).unref(); };
    const stop = onExit(() => child.kill('SIGKILL'));
    const timer = setTimeout(() => { timedOut = true; kill(); }, spec.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => { const text = chunk.toString(); stdout += text; appendFileSync(spec.transcriptPath, text); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.on('error', (error) => errors.push(`couldn't start codex: ${error.message}`));
    child.on('close', (code) => {
      clearTimeout(timer);
      stop(false);
      const summary = parseStream(stdout.split('\n'), Date.now() - started);
      const id = summary.sessionId || resume?.sessionId || '';
      if (prior && resume && id !== resume.sessionId) homes.delete(resume.sessionId);
      if (id) homes.set(id, { home, release });
      else release();
      init.sessionId = id;
      if (timedOut) errors.push(`timed out after ${Math.round(spec.timeoutMs / 60_000)} minutes`);
      if (code !== 0 && code !== null && !errors.length && !summary.errors.length) errors.push(`codex exited with code ${code}: ${stderr.trim().split('\n').slice(-3).join(' ')}`);
      const permissionDenials = (stderr.match(/Rejected\(/g) ?? []).length;
      if (spec.noTools && (summary.toolInputs.length || permissionDenials)) errors.push('stopped at start: dry run used or attempted a tool');
      resolve({ sessionId: id, finalTexts: summary.finalTexts, init, usage: summary.usage, exitCode: code, timedOut, errors: [...errors, ...summary.errors], permissionDenials, toolInputs: summary.toolInputs, transcriptPath: spec.transcriptPath });
    });
    child.stdin.on('error', () => undefined);
    child.stdin.end(invocation.stdin);
  });
};

const preflight = (): BackendCheck[] => {
  const version = exec('codex', ['--version']);
  return version.code === 0 ? [{ name: 'Codex', status: 'ok', detail: version.stdout.trim() }] : [{ name: 'Codex', status: 'fail', detail: '`codex` is not on PATH', hint: 'Install Codex and sign in.' }];
};

export const codex: Backend = {
  name: 'Codex', selector: 'codex', browserServer: true, costsMeasured: false, dryRunNoTools: false,
  defaults: { model: 'gpt-6.1-sol', effort: 'high' }, efforts: ['low', 'medium', 'high', 'xhigh'],
  preflight,
  start: (spec) => run(spec),
  resume: (spec, sessionId, message) => run(spec, { sessionId, message }),
  finish: (id) => { const entry = homes.get(id); if (entry) { homes.delete(id); entry.release(); } },
  initProblems: (init) => init ? [] : ['Prompt inspection did not succeed'],
  offLimits: () => [],
};

// Starts actua11y's sessions as headless Claude Code runs: an emptied environment, none of the user's settings, memory, skills, plugins, MCP servers or hooks, and deny rules backing every word of the brief.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join } from 'node:path';

import type { Backend, BackendCheck, DenyCategory, InitInfo, RoleSpec, SessionResult } from '../_lib/_backend.ts';
import { exec, onExit } from '../_lib/_exec.ts';
import { parseStream } from './_claude-stream.ts';

export const BACKEND_NAME = 'Claude Code';

// The version these flags were last verified against. Older versions may lack a flag, which fails loudly rather than silently.
export const VERIFIED_VERSION = '2.1.319';

// Enough for the subscription login, git and a shell. A shell inside an agent session carries dozens more (effort, entrypoint, a child-session flag), and any of them could change a run.
export const ENV_KEEP = ['HOME', 'PATH', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'LANG', 'TMPDIR'];

// Sign-in and network settings pass through, so API-key, Bedrock, Vertex and proxied setups still reach the model. None of them change what the session knows or may do.
export const ENV_PASS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_BASE_URL',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'AWS_REGION',
  'AWS_PROFILE',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'ANTHROPIC_VERTEX_PROJECT_ID',
  'CLOUD_ML_REGION',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
];

export const ENV_SET: Record<string, string> = {
  CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1',
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1',
  CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
};

// Git instructions would put a status snapshot, recent commit messages included, into context. The built-in AGENTS.md plugin is switched off so no project instructions can ride in.
export const SESSION_SETTINGS = {
  includeGitInstructions: false,
  autoMemoryEnabled: false,
  disableAllHooks: true,
  enabledPlugins: { 'cc-plugin-agents-md@builtin': false },
};

export const FINDER_TOOLS = ['Read', 'Glob', 'Grep', 'Bash', 'Write', 'Edit'];

const DENY_RULES: Record<DenyCategory, string[]> = {
  git: ['Bash(git *)'],
  github: ['Bash(gh *)'],
  web: ['WebSearch', 'WebFetch'],
  subagents: ['Agent', 'Task'],
  installs: ['Bash(npm *)', 'Bash(npx *)', 'Bash(pnpm *)', 'Bash(yarn *)', 'Bash(bun *)', 'Bash(pip *)', 'Bash(pip3 *)', 'Bash(brew *)', 'Bash(corepack *)'],
};

export interface Invocation {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
  stdin: string;
}

// Absolute paths in permission rules start with a double slash.
const rulePath = (path: string): string => `/${path}`;

export const toolsFor = (spec: RoleSpec): string[] => (spec.noTools ? [] : FINDER_TOOLS);

// Claude Code keeps each session's task output and scratch files in /tmp/claude-<uid>/<project>/<session>/, the project named after its folder with every character but letters and digits turned into a dash.
const claudeTempRoot = (): string | null => {
  const { uid } = userInfo();
  if (uid < 0) return null;
  const root = join('/tmp', `claude-${uid}`);
  return existsSync(root) ? realpathSync(root) : root;
};

export const projectSlug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, '-');

// Every other project's folder, and the sessions already in this one (the orchestrator's among them), but never the project folder the finder's own session is about to be created in.
export const claudeTempOffLimits = (root: string, cwd: string): string[] => {
  if (!existsSync(root)) return [];
  const own = projectSlug(cwd);
  return readdirSync(root).flatMap((entry) => {
    const path = join(root, entry);
    return entry === own && statSync(path).isDirectory() ? readdirSync(path).map((session) => join(path, session)) : [path];
  });
};

export const allowRulesFor = (spec: RoleSpec): string[] => {
  if (spec.noTools) return [];
  // Read rules govern Glob and Grep too, so these are what keep all three inside the repository, the scratch folder and the session's own task folder. A bare Read, Glob or Grep would let one search cover the whole disk. Bash isn't fenced this way.
  const root = claudeTempRoot();
  const readable = [spec.cwd, ...(spec.scratch ? [spec.scratch] : []), ...(root ? [join(root, projectSlug(spec.cwd))] : [])];
  const rules = [...readable.map((path) => `Read(${rulePath(path)}/**)`), 'Bash'];
  if (spec.scratch) rules.push(`Edit(${rulePath(spec.scratch)}/**)`);
  return rules;
};

export const denyRulesFor = (spec: RoleSpec): string[] => {
  if (spec.noTools) return [];
  const rules = spec.deny.flatMap((category) => DENY_RULES[category]);
  if (spec.readOnly) rules.push(`Edit(${rulePath(spec.cwd)}/**)`, 'NotebookEdit');
  for (const path of spec.offLimits) rules.push(path.endsWith('/') ? `Read(${rulePath(path.slice(0, -1))}/**)` : `Read(${rulePath(path)})`);
  return rules;
};

export const buildInvocation = (spec: RoleSpec, parentEnv: NodeJS.ProcessEnv, resume?: { sessionId: string; message: string }): Invocation => {
  const env: Record<string, string> = {};
  for (const key of [...ENV_KEEP, ...ENV_PASS]) {
    const value = parentEnv[key];
    if (value !== undefined && value !== '') env[key] = value;
  }
  Object.assign(env, ENV_SET);

  const args = ['-p', '--output-format', 'stream-json', '--verbose'];
  args.push('--safe-mode', '--setting-sources', '', '--strict-mcp-config', '--disable-slash-commands');
  args.push('--permission-mode', 'dontAsk', '--permission-prompts', 'none');
  args.push('--model', spec.model, '--effort', spec.effort, '--max-turns', String(spec.maxTurns), '--max-budget-usd', String(spec.maxBudgetUsd));
  args.push('--settings', JSON.stringify(SESSION_SETTINGS));
  args.push('--tools', toolsFor(spec).join(','));
  if (spec.scratch) args.push('--add-dir', spec.scratch);
  if (resume) args.push('--resume', resume.sessionId);
  const allow = allowRulesFor(spec);
  const deny = denyRulesFor(spec);
  if (allow.length > 0) args.push('--allowedTools', ...allow);
  if (deny.length > 0) args.push('--disallowedTools', ...deny);
  // The variadic rule lists would swallow anything after them, so close them off. The brief arrives on stdin, never in argv.
  args.push('--');
  return { command: 'claude', args, env, cwd: spec.cwd, stdin: resume ? resume.message : spec.brief };
};

const isBuiltinAllowed = (plugin: string): boolean => plugin.endsWith('@builtin') && !plugin.startsWith('cc-plugin-agents-md@');

export const initProblems = (init: InitInfo | null, spec: RoleSpec): string[] => {
  if (!init) return ["The session sent no init event, so there's no way to confirm what it loaded"];
  const problems: string[] = [];
  if (init.mcpServers.length > 0) problems.push(`MCP servers loaded: ${init.mcpServers.join(', ')}`);
  const plugins = init.plugins.filter((plugin) => !isBuiltinAllowed(plugin));
  if (plugins.length > 0) problems.push(`plugins loaded: ${plugins.join(', ')}`);
  if (init.skills.length > 0) problems.push(`skills loaded: ${init.skills.join(', ')}`);
  const expected = [...toolsFor(spec)].sort();
  const actual = [...init.tools].sort();
  if (expected.join(',') !== actual.join(',')) problems.push(`tools are [${actual.join(', ')}], expected [${expected.join(', ')}]`);
  if (init.permissionMode !== 'dontAsk') problems.push(`permission mode is ${init.permissionMode}, expected dontAsk`);
  if (init.model !== spec.model) problems.push(`model is ${init.model}, expected ${spec.model}`);
  return problems;
};

const runInvocation = (invocation: Invocation, spec: RoleSpec): Promise<SessionResult> =>
  new Promise((resolve) => {
    mkdirSync(dirname(spec.transcriptPath), { recursive: true });
    const child = spawn(invocation.command, invocation.args, { cwd: invocation.cwd, env: invocation.env, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines: string[] = [];
    let pending = '';
    let stderr = '';
    let timedOut = false;
    let checkedInit = false;
    const aborts: string[] = [];

    const kill = (): void => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5000).unref();
    };
    // If the runner itself is stopped, the session goes with it rather than running on unattended.
    const release = onExit(() => child.kill('SIGKILL'));
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, spec.timeoutMs);

    const takeLine = (line: string): void => {
      lines.push(line);
      appendFileSync(spec.transcriptPath, `${line}\n`);
      if (checkedInit) return;
      // Parsed, not matched as text, so a change in how the JSON is spaced can't let a session skip the check.
      const init = parseStream([line]).init;
      if (!init) return;
      checkedInit = true;
      const problems = initProblems(init, spec);
      if (problems.length > 0) {
        aborts.push(...problems.map((problem) => `stopped at start: ${problem}`));
        kill();
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8');
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        takeLine(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
      }
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4000);
    });
    child.on('error', (error) => aborts.push(`couldn't start claude: ${error.message}`));
    child.on('close', (code) => {
      clearTimeout(timer);
      release(false);
      if (pending.trim() !== '') takeLine(pending);
      // A session that never announced what it loaded can't be trusted with a retry either.
      if (!checkedInit) aborts.push(...initProblems(null, spec).map((problem) => `stopped at start: ${problem}`));
      const summary = parseStream(lines);
      const errors = [...aborts, ...summary.errors];
      if (timedOut) errors.push(`timed out after ${Math.round(spec.timeoutMs / 60_000)} minutes`);
      if (code !== 0 && code !== null && errors.length === 0) errors.push(`claude exited with code ${code}${stderr.trim() ? `: ${stderr.trim().split('\n').slice(-3).join(' ')}` : ''}`);
      resolve({ sessionId: summary.sessionId, finalTexts: summary.finalTexts, init: summary.init, usage: summary.usage, exitCode: code, timedOut, errors, permissionDenials: summary.permissionDenials, toolInputs: summary.toolInputs, transcriptPath: spec.transcriptPath });
    });
    // A session that exits before reading its brief closes the pipe. Its exit code and stderr already say why, so the pipe error adds nothing and mustn't crash the runner.
    child.stdin.on('error', () => undefined);
    child.stdin.end(invocation.stdin);
  });

const compareVersions = (a: string, b: string): number => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
};

const PROJECT_CONFIG = ['.claude/settings.json', '.claude/settings.local.json', '.claude/hooks', '.claude/agents', '.claude/skills', '.mcp.json', 'CLAUDE.md', 'CLAUDE.local.md', 'AGENTS.md'];

const preflight = (repoRoot: string): BackendCheck[] => {
  const checks: BackendCheck[] = [];
  const version = exec('claude', ['--version']);
  if (version.code !== 0) {
    checks.push({ name: 'Claude Code', status: 'fail', detail: '`claude` is not on PATH', hint: 'Install Claude Code, then run this again.' });
  } else {
    const found = version.stdout.match(/\d+\.\d+\.\d+/)?.[0] ?? 'unknown';
    const old = found !== 'unknown' && compareVersions(found, VERIFIED_VERSION) < 0;
    checks.push(old
      ? { name: 'Claude Code', status: 'warn', detail: `version ${found}, older than ${VERIFIED_VERSION}, which actua11y's isolation flags were verified against`, hint: 'Run `claude update`. An older version may refuse a flag, which stops the run rather than weakening it.' }
      : { name: 'Claude Code', status: 'ok', detail: `version ${found}` });
  }
  const present = PROJECT_CONFIG.filter((path) => existsSync(join(repoRoot, path)));
  checks.push(present.length > 0
    ? { name: 'Project agent config', status: 'warn', detail: `found ${present.join(', ')}. The finder runs with project settings, instructions, hooks, skills and MCP servers turned off, so none of these reach it`, hint: 'Nothing to do. The dry run is what proves it.' }
    : { name: 'Project agent config', status: 'ok', detail: 'none found' });
  return checks;
};

export const claudeCode: Backend = {
  name: BACKEND_NAME,
  defaults: { model: 'claude-opus-5-5', effort: 'high' },
  efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
  preflight,
  start: (spec) => runInvocation(buildInvocation(spec, process.env), spec),
  resume: (spec, sessionId, message) => runInvocation(buildInvocation(spec, process.env, { sessionId, message }), spec),
  initProblems,
  offLimits: (cwd) => {
    const root = claudeTempRoot();
    return root ? claudeTempOffLimits(root, cwd) : [];
  },
};

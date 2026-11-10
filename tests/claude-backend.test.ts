import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildInvocation, initProblems } from '../skills/actua11y/_backends/_claude-code.ts';
import { parseStream } from '../skills/actua11y/_backends/_claude-stream.ts';
import type { InitInfo, RoleSpec } from '../skills/actua11y/_lib/_backend.ts';
import { ALL_DENIES } from '../skills/actua11y/_lib/_rules.ts';

const finder = (): RoleSpec => ({
  role: 'finder',
  brief: 'THE BRIEF',
  cwd: '/work/moth-club',
  scratch: '/tmp/actua11y-run-abc',
  readOnly: true,
  noTools: false,
  deny: ALL_DENIES,
  offLimits: ['/work/moth-club/.git/', '/work/other-project/', '/home/me/.npmrc'],
  model: 'claude-opus-5-5',
  effort: 'high',
  maxTurns: 300,
  maxBudgetUsd: 20,
  timeoutMs: 60_000,
  transcriptPath: '/tmp/t.jsonl',
});

const parentEnv = { HOME: '/home/me', PATH: '/usr/bin', TERM: 'xterm', CLAUDECODE: '1', CLAUDE_CODE_EFFORT_LEVEL: 'max', ANTHROPIC_MODEL: 'fable', GITHUB_TOKEN: 'secret', ANTHROPIC_API_KEY: 'sk-test', HTTPS_PROXY: 'http://proxy:8080' };

const valueAfter = (args: string[], flag: string): string | undefined => args[args.indexOf(flag) + 1];

test('the environment is emptied down to the login and shell basics', () => {
  const { env } = buildInvocation(finder(), parentEnv);
  assert.deepEqual(Object.keys(env).sort(), ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_DISABLE_AUTO_MEMORY', 'CLAUDE_CODE_DISABLE_CLAUDE_MDS', 'CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS', 'HOME', 'HTTPS_PROXY', 'PATH', 'TERM']);
  assert.equal(env['ANTHROPIC_MODEL'], undefined, 'the model is pinned by flag, never inherited');
  assert.equal(env['CLAUDECODE'], undefined);
  assert.equal(env['CLAUDE_CODE_EFFORT_LEVEL'], undefined);
  assert.equal(env['GITHUB_TOKEN'], undefined);
});

test('none of the user\'s settings, memory, skills, plugins, MCP servers or hooks load', () => {
  const { args } = buildInvocation(finder(), parentEnv);
  for (const flag of ['-p', '--safe-mode', '--strict-mcp-config', '--disable-slash-commands', '--verbose']) assert.ok(args.includes(flag), flag);
  assert.equal(valueAfter(args, '--setting-sources'), '');
  assert.equal(valueAfter(args, '--output-format'), 'stream-json');
  assert.equal(valueAfter(args, '--permission-mode'), 'dontAsk');
  assert.equal(valueAfter(args, '--permission-prompts'), 'none');
  const settings = JSON.parse(valueAfter(args, '--settings') ?? '{}') as Record<string, unknown>;
  assert.equal(settings['includeGitInstructions'], false);
  assert.equal(settings['autoMemoryEnabled'], false);
  assert.equal(settings['disableAllHooks'], true);
});

test('model, effort and caps are pinned, and the brief goes over stdin, never argv', () => {
  const invocation = buildInvocation(finder(), parentEnv);
  assert.equal(valueAfter(invocation.args, '--model'), 'claude-opus-5-5');
  assert.equal(valueAfter(invocation.args, '--effort'), 'high');
  assert.equal(valueAfter(invocation.args, '--max-turns'), '300');
  assert.equal(valueAfter(invocation.args, '--max-budget-usd'), '20');
  assert.equal(invocation.stdin, 'THE BRIEF');
  assert.ok(!invocation.args.includes('THE BRIEF'));
  assert.equal(invocation.args.at(-1), '--');
});

test('a read-only finder can write only in its scratch folder, and the deny rules back the brief', () => {
  const { args } = buildInvocation(finder(), parentEnv);
  const deny = args.slice(args.indexOf('--disallowedTools') + 1, args.lastIndexOf('--'));
  const allow = args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--disallowedTools'));
  assert.deepEqual(allow, ['Read', 'Glob', 'Grep', 'Bash', 'Edit(//tmp/actua11y-run-abc/**)']);
  for (const rule of ['Bash(git *)', 'Bash(gh *)', 'Bash(npm *)', 'Bash(npx *)', 'WebSearch', 'WebFetch', 'Agent', 'NotebookEdit', 'Edit(//work/moth-club/**)']) assert.ok(deny.includes(rule), rule);
  assert.ok(deny.includes('Read(//work/moth-club/.git/**)'));
  assert.ok(deny.includes('Read(//work/other-project/**)'));
  assert.ok(deny.includes('Read(//home/me/.npmrc)'));
  assert.equal(valueAfter(args, '--add-dir'), '/tmp/actua11y-run-abc');
});

test('the dry run gets no tools at all', () => {
  const { args } = buildInvocation({ ...finder(), role: 'dry-run', noTools: true, scratch: null }, parentEnv);
  assert.equal(valueAfter(args, '--tools'), '');
  assert.ok(!args.includes('--allowedTools'));
  assert.ok(!args.includes('--add-dir'));
});

test('resuming keeps every isolation flag and sends only the message', () => {
  const invocation = buildInvocation(finder(), parentEnv, { sessionId: 'abc-123', message: 'fix these' });
  assert.equal(valueAfter(invocation.args, '--resume'), 'abc-123');
  assert.ok(invocation.args.includes('--safe-mode'));
  assert.equal(invocation.stdin, 'fix these');
});

const cleanInit = (): InitInfo => ({
  sessionId: 's',
  model: 'claude-opus-5-5',
  version: '2.1.319',
  cwd: '/work/moth-club',
  permissionMode: 'dontAsk',
  tools: ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'Write'],
  mcpServers: [],
  plugins: ['cc-plugin-telemetry@builtin'],
  skills: [],
  agents: ['Explore'],
});

test('a session that loaded anything unexpected is stopped at its first event', () => {
  assert.deepEqual(initProblems(cleanInit(), finder()), []);
  assert.match(initProblems({ ...cleanInit(), mcpServers: ['slack'] }, finder()).join(), /MCP servers loaded: slack/);
  assert.match(initProblems({ ...cleanInit(), plugins: ['someones-plugin@/home/me/.claude/plugins/x'] }, finder()).join(), /plugins loaded/);
  assert.match(initProblems({ ...cleanInit(), plugins: ['cc-plugin-agents-md@builtin'] }, finder()).join(), /plugins loaded/);
  assert.match(initProblems({ ...cleanInit(), skills: ['deploy'] }, finder()).join(), /skills loaded: deploy/);
  assert.match(initProblems({ ...cleanInit(), tools: [...cleanInit().tools, 'WebFetch'] }, finder()).join(), /tools are/);
  assert.match(initProblems({ ...cleanInit(), model: 'claude-fable-5-2' }, finder()).join(), /model is claude-fable-5-2/);
  assert.match(initProblems(null, finder()).join(), /no init event/);
});

test('every result event counts, and junk lines are skipped', () => {
  const lines = [
    JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-opus-5-5', tools: ['Read'], mcp_servers: [], plugins: [{ name: 'cc-plugin-telemetry', path: 'builtin' }], skills: [], permissionMode: 'dontAsk' }),
    'not json at all',
    JSON.stringify({ type: 'result', subtype: 'success', session_id: 's1', result: 'first answer', total_cost_usd: 1.5, num_turns: 10, duration_ms: 60_000, modelUsage: { 'claude-opus-5-5': { inputTokens: 100, outputTokens: 50, cacheReadInputTokens: 1000, cacheCreationInputTokens: 10 } } }),
    JSON.stringify({ type: 'result', subtype: 'success', session_id: 's1', result: 'woke up again', total_cost_usd: 1.6, num_turns: 11, duration_ms: 70_000, permission_denials: [{}, {}], modelUsage: { 'claude-opus-5-5': { inputTokens: 120, outputTokens: 60, cacheReadInputTokens: 1100, cacheCreationInputTokens: 10 } } }),
  ];
  const summary = parseStream(lines);
  assert.deepEqual(summary.finalTexts, ['first answer', 'woke up again']);
  assert.equal(summary.usage.costUsd, 1.6);
  assert.equal(summary.usage.turns, 11);
  assert.equal(summary.usage.outputTokens, 60);
  assert.equal(summary.permissionDenials, 2);
  assert.deepEqual(summary.init?.plugins, ['cc-plugin-telemetry@builtin']);
  assert.deepEqual(summary.errors, []);
  const failed = parseStream([JSON.stringify({ type: 'result', subtype: 'error_max_budget_usd', is_error: true, errors: ['over budget'] })]);
  assert.match(failed.errors.join(), /error_max_budget_usd: over budget/);
});

test('a session that failed reports why as an error, never as its answer', () => {
  // The shape Claude Code 2.1.319 sends when its sign-in has expired: subtype success, but is_error, with the reason in result.
  const expired = parseStream([JSON.stringify({ type: 'result', subtype: 'success', is_error: true, terminal_reason: 'api_error', num_turns: 1, total_cost_usd: 0, result: 'Failed to authenticate: this login reached its time limit' })]);
  assert.deepEqual(expired.finalTexts, []);
  assert.deepEqual(expired.errors, ['api_error: Failed to authenticate: this login reached its time limit']);
});

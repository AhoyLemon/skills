import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildInvocation, parseStream } from '../skills/actua11y/_backends/_codex.ts';
import { addUsage, emptyUsage, type RoleSpec } from '../skills/actua11y/_lib/_backend.ts';

const spec: RoleSpec = {
  role: 'finder', brief: 'PRIVATE BRIEF', cwd: '/work/app', scratch: '/tmp/audit', readOnly: true, noTools: false,
  deny: ['git', 'github', 'web', 'subagents', 'installs'], offLimits: ['/work/app/.git/', '/work/app/node_modules/', '/home/person/.ssh/'],
  model: 'model', effort: 'high', maxTurns: 300, maxBudgetUsd: 20, timeoutMs: 60000, transcriptPath: '/tmp/log', browserEndpoint: 'ws://127.0.0.1:1234/secret',
};

test('Codex starts with a separate home, isolated configuration and a confined filesystem', () => {
  const invocation = buildInvocation(spec, '/tmp/home', { HOME: '/home/person', PATH: '/bin', GITHUB_TOKEN: 'secret' });
  assert.equal(invocation.env['HOME'], '/tmp/home');
  assert.equal(invocation.env['CODEX_HOME'], '/tmp/home');
  assert.equal(invocation.env['GITHUB_TOKEN'], undefined);
  assert.equal(invocation.env['ACTUA11Y_BROWSER_WS'], spec.browserEndpoint);
  for (const flag of ['--json', '--ignore-user-config']) assert.ok(invocation.args.includes(flag));
  assert.ok(!invocation.args.includes('--ignore-rules'));
  const settings = invocation.args.filter((arg) => arg.includes('='));
  for (const setting of ['project_doc_max_bytes=0', 'skills.bundled.enabled=false', 'features.apps=false', 'features.plugins=false', 'web_search="disabled"', 'approval_policy="never"']) assert.ok(settings.includes(setting), setting);
  const filesystem = settings.find((setting) => setting.startsWith('permissions.actua11y.filesystem=')) ?? '';
  for (const rule of ['"/"="deny"', '"/work/app"="read"', '"/tmp/audit"="write"', '"/work/app/.git"="deny"', '"/work/app/node_modules"="deny"']) assert.ok(filesystem.includes(rule), rule);
  assert.equal(invocation.stdin, spec.brief);
  assert.ok(!invocation.args.includes(spec.brief));
  const resumed = buildInvocation(spec, '/tmp/home', {}, 'session-id', 'FIX THE REPORT');
  assert.ok(resumed.args.includes('resume'));
  assert.ok(resumed.args.includes('session-id'));
  assert.equal(resumed.stdin, 'FIX THE REPORT');
});

test('Codex records tokens and tool inputs without inventing a dollar cost', () => {
  const events = [
    { type: 'thread.started', thread_id: 's' },
    { type: 'item.started', item: { id: 'item-1', type: 'command_execution', command: 'cat /work/app/file' } },
    { type: 'item.completed', item: { id: 'item-1', type: 'command_execution', command: 'cat /work/app/file' } },
    { type: 'item.completed', item: { type: 'agent_message', text: 'report' } },
    { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 } },
  ].map((event) => JSON.stringify(event));
  const parsed = parseStream(events, 1000);
  assert.equal(parsed.sessionId, 's');
  assert.deepEqual(parsed.toolInputs, ['cat /work/app/file']);
  assert.deepEqual(parsed.finalTexts, ['report']);
  assert.equal(parsed.usage.costUsd, null);
  assert.equal(parsed.usage.inputTokens, 20);
  assert.equal(parsed.usage.cacheReadTokens, 80);
  assert.equal(parsed.usage.outputTokens, 10);
  assert.equal(addUsage(parsed.usage, { ...parsed.usage, costUsd: 1 }).costUsd, null);
});

test('unmeasured Codex spend does not consume or display a dollar budget', async () => {
  const { makeFacts, makeReport, makeSite, viewOf } = await import('./_fixtures.ts');
  const { startLoop, budgetLeft } = await import('../skills/actua11y/_lib/_ledger.ts');
  const { costRows, costTable } = await import('../skills/actua11y/_lib/_render.ts');
  const { renderUnfiledComments } = await import('../skills/actua11y/_lib/_render-loop.ts');
  const { validateReport } = await import('../skills/actua11y/_lib/_report.ts');
  const { criteriaAt } = await import('../skills/actua11y/_lib/_criteria.ts');
  const facts = makeFacts('A');
  facts.backend = 'Codex';
  facts.usage.costUsd = null;
  if (facts.dryRunUsage) facts.dryRunUsage.costUsd = null;
  const validated = validateReport(makeReport('A'), { criteria: criteriaAt('A'), repoRoot: makeSite(), tracked: new Set(['index.html', 'css/site.css']) });
  assert.ok(validated.ok);
  const view = viewOf(validated.report, facts);
  const ledger = startLoop(view.ledger, { branch: 'audit', pr: null, budgetUsd: 1 });
  ledger.spentUsd = 50;
  assert.equal(budgetLeft(ledger), Infinity);
  const rows = costRows(ledger);
  assert.equal(rows[0]?.spendUsd, null);
  assert.equal(rows[0]?.leftUsd, null);
  const table = costTable(rows, ledger, true).join('\n');
  assert.match(table, /not measured/);
  assert.doesNotMatch(table, /of \$1\.00/);
  ledger.spentUsd = 0;
  assert.doesNotMatch(costTable(costRows(ledger), ledger, true).join('\n'), /\$0\.00/);
  const unfiled = renderUnfiledComments(view, { runId: 'unfinished', usage: { ...emptyUsage(), costUsd: null, durationMs: 60_000 }, why: 'No usable report.', transcriptPath: '/tmp/transcript' }).join('\n');
  assert.match(unfiled, /tokens unreported/);
  assert.doesNotMatch(unfiled, /0k tokens/);
});

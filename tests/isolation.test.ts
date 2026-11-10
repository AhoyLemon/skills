import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import type { Backend } from '../skills/actua11y/_lib/_backend.ts';
import { treeChanges, treeState } from '../skills/actua11y/_lib/_git.ts';
import { nodeIsNewEnough, runPreflight } from '../skills/actua11y/_lib/_preflight.ts';
import { computeOffLimits, offLimitsMentions } from '../skills/actua11y/_lib/_rules.ts';
import { tempDir } from './_fixtures.ts';

const git = (cwd: string, ...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// A throwaway repo with a bare local remote, committed and pushed, so the preflight sees a clean tree that matches its upstream.
const makeRepo = (): { parent: string; root: string } => {
  const parent = tempDir('repo');
  const remote = join(parent, 'remote.git');
  const root = join(parent, 'moth-club');
  git(parent, 'init', '-q', '--bare', remote);
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  writeFileSync(join(root, 'index.html'), '<title>Moth Club</title>\n');
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n.cache/\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'Moth Club');
  git(root, 'remote', 'add', 'origin', remote);
  git(root, 'push', '-q', '-u', 'origin', 'main');
  return { parent, root };
};

const stubBackend: Backend = {
  name: 'Stub',
  defaults: { model: 'stub', effort: 'high' },
  efforts: ['high'],
  preflight: () => [],
  start: () => Promise.reject(new Error('not used')),
  resume: () => Promise.reject(new Error('not used')),
  initProblems: () => [],
  offLimits: () => [],
};

const failures = async (root: string, extra: { scope?: string[]; allowIgnored?: string[] } = {}): Promise<string[]> => {
  const result = await runPreflight({ cwd: root, scope: extra.scope ?? ['.'], allowIgnored: extra.allowIgnored ?? [], url: null, serve: null, backend: stubBackend, github: false, browser: false });
  return result.checks.filter((check) => check.status === 'fail').map((check) => check.name);
};

test('the preflight is clean on a clean, pushed repository', async () => {
  assert.deepEqual(await failures(makeRepo().root), []);
});

test('the preflight refuses a dirty tree, an unpushed commit, a missing upstream, a missing scope and a gitignored stray', async () => {
  const dirty = makeRepo().root;
  writeFileSync(join(dirty, 'index.html'), '<title>Changed</title>\n');
  assert.deepEqual(await failures(dirty), ['Clean tree']);

  const ahead = makeRepo().root;
  writeFileSync(join(ahead, 'about.html'), '<title>About</title>\n');
  git(ahead, 'add', '-A');
  git(ahead, 'commit', '-q', '-m', 'About');
  assert.deepEqual(await failures(ahead), ['Matches its remote']);

  const noUpstream = makeRepo().root;
  git(noUpstream, 'switch', '-q', '-c', 'side');
  assert.deepEqual(await failures(noUpstream), ['Matches its remote']);

  assert.deepEqual(await failures(makeRepo().root, { scope: ['src'] }), ['Scope exists']);

  const stray = makeRepo().root;
  mkdirSync(join(stray, 'node_modules'));
  writeFileSync(join(stray, 'node_modules', 'left-pad.js'), 'x');
  assert.deepEqual(await failures(stray), ['No gitignored strays in scope']);
  assert.deepEqual(await failures(stray, { allowIgnored: ['node_modules'] }), [], 'an acknowledged path is allowed');
});

test('Node 22.18 is the floor', () => {
  assert.equal(nodeIsNewEnough('v22.17.1'), false);
  assert.equal(nodeIsNewEnough('v22.18.0'), true);
  assert.equal(nodeIsNewEnough('v24.1.0'), true);
  assert.equal(nodeIsNewEnough('v21.9.0'), false);
});

test('a dev server rewriting its own ignored cache is not a stray, but the finder writing to the app is', () => {
  const { root } = makeRepo();
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'node_modules', 'a.js'), 'a');
  const before = treeState(root);

  writeFileSync(join(root, 'node_modules', 'b.js'), 'b');
  assert.deepEqual(treeChanges(before, treeState(root)), { tree: [], ignored: [] }, 'new files inside an existing ignored folder');

  mkdirSync(join(root, '.cache'));
  writeFileSync(join(root, '.cache', 'build.json'), '{}');
  assert.deepEqual(treeChanges(before, treeState(root)).ignored, ['.cache/']);
  assert.deepEqual(treeChanges(before, treeState(root), ['.cache']).ignored, [], 'acknowledged with --allow-ignored');

  writeFileSync(join(root, 'package.json'), '{}');
  writeFileSync(join(root, 'index.html'), '<title>Edited</title>\n');
  const tree = treeChanges(before, treeState(root)).tree;
  assert.ok(tree.some((line) => line.includes('package.json')));
  assert.ok(tree.some((line) => line.includes('index.html')));
});

test('off-limits paths come from disk, but never bar the run from its own scratch folder', () => {
  const { parent, root } = makeRepo();
  mkdirSync(join(parent, 'answers'));
  mkdirSync(join(parent, 'scratch-run'));
  const scratch = join(parent, 'scratch-run');
  // Nested, so neither the sibling rule nor the actua11y temp-folder rule could be what bars it.
  const agentTemp = join(tempDir('agent'), 'claude-501');
  mkdirSync(agentTemp);
  const offLimits = computeOffLimits({ repoRoot: root, runsRoot: join(parent, 'no-such-runs'), scratch, ignoredInRepo: ['node_modules/'], agentPaths: [agentTemp, join(agentTemp, 'no-such-agent-folder')] });
  assert.ok(offLimits.includes(`${join(root, '.git')}/`));
  assert.ok(offLimits.includes(`${agentTemp}/`), 'a folder the backend names as its own');
  assert.ok(!offLimits.some((path) => path.includes('no-such-agent-folder')), 'only paths that exist');
  assert.ok(offLimits.includes(`${join(parent, 'answers')}/`), 'a sibling folder');
  assert.ok(offLimits.includes(`${join(parent, 'remote.git')}/`), 'the bare remote, which holds history');
  assert.ok(!offLimits.some((path) => path.startsWith(scratch)), 'the scratch folder stays readable');
  // The scratch folder lives elsewhere here, so only the repository can be the reason the folder is spared.
  const holdsRepo = computeOffLimits({ repoRoot: root, runsRoot: join(parent, 'no-such-runs'), scratch: tempDir('elsewhere'), ignoredInRepo: [], agentPaths: [parent] });
  assert.ok(!holdsRepo.some((path) => root.startsWith(path.replace(/\/$/, ''))), 'never the folder the audited repository lives in');
});

test('a tool call that names an off-limits path is counted, in any form it could name it, and only at a path boundary', () => {
  const home = homedir();
  const repo = '/work/projects/moth-club';
  const offLimits = ['/work/projects/answers/', '/private/tmp/claude-501/-work-other/', `${home}/.ssh/`, '/work/projects/moth-club/.git/', '/work/projects/moth-club/node_modules/'];
  const inputs = [
    JSON.stringify({ command: 'cat /work/projects/answers/key.md' }),
    JSON.stringify({ command: 'ls ../answers' }),
    JSON.stringify({ command: 'ls /tmp/claude-501/-work-other' }),
    JSON.stringify({ command: 'cat ~/.ssh/id_ed25519' }),
    JSON.stringify({ command: 'cat /work/projects/answers-public/readme.md' }),
    JSON.stringify({ command: 'grep -r --exclude-dir=node_modules --exclude-dir=.git alt .' }),
    JSON.stringify({ file_path: '/work/projects/moth-club/.git/config' }),
  ];
  assert.deepEqual(offLimitsMentions(inputs, offLimits, repo), [
    { path: '/work/projects/answers/', count: 2 },
    { path: '/private/tmp/claude-501/-work-other/', count: 1 },
    { path: `${home}/.ssh/`, count: 1 },
    { path: '/work/projects/moth-club/.git/', count: 1 },
  ]);
});

test('a barred folder that holds the repository still bars everything in it but the way down', () => {
  // An agent's temp folder with the app cloned two levels inside it, beside another session's files.
  const agentRoot = tempDir('agent-root');
  const app = join(agentRoot, 'session-a', 'scratchpad', 'app');
  for (const dir of [app, join(agentRoot, 'session-a', 'tasks'), join(agentRoot, 'session-b')]) mkdirSync(dir, { recursive: true });
  const offLimits = computeOffLimits({ repoRoot: app, runsRoot: join(agentRoot, 'no-such-runs'), scratch: tempDir('elsewhere'), ignoredInRepo: [], agentPaths: [agentRoot] });
  assert.ok(offLimits.includes(`${join(agentRoot, 'session-b')}/`), 'another session beside the way down');
  assert.ok(offLimits.includes(`${join(agentRoot, 'session-a', 'tasks')}/`), 'a cousin of the repository, which no sibling rule covers');
  for (const open of [agentRoot, join(agentRoot, 'session-a'), join(agentRoot, 'session-a', 'scratchpad'), app]) assert.ok(!offLimits.includes(`${open}/`), `the way down stays open: ${open}`);
});

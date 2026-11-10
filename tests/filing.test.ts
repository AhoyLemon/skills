import assert from 'node:assert/strict';
import { test } from 'node:test';

import { criteriaAt } from '../skills/actua11y/_lib/_criteria.ts';
import { fileIssues, type GhClient } from '../skills/actua11y/_lib/_filing.ts';
import { validateReport, type FinderReport } from '../skills/actua11y/_lib/_report.ts';
import { emptyFiled, type FiledRecord } from '../skills/actua11y/_lib/_runs.ts';
import { makeFacts, makeReport, makeSite } from './_fixtures.ts';

const report = (): FinderReport => {
  const result = validateReport(makeReport('A'), { criteria: criteriaAt('A'), repoRoot: makeSite(), tracked: new Set(['index.html', 'css/site.css']) });
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.report;
};

interface FakeGh extends GhClient {
  calls: string[];
}

// A fake gh that records every call, and can be told to fail on the nth one.
const fakeGh = (failOn = -1): FakeGh => {
  const calls: string[] = [];
  let issues = 0;
  let comments = 0;
  const record = (call: string): void => {
    if (calls.length === failOn) throw new Error(`network went away during ${call}`);
    calls.push(call);
  };
  return {
    calls,
    ensureLabel: () => record('label'),
    createIssue: (issue) => {
      record(`create ${issue.assignToMe ? 'person' : 'agent'}`);
      issues += 1;
      return `https://github.com/AhoyLemon/skills/issues/${issues}`;
    },
    editIssueBody: (url) => record(`edit ${url.split('/').at(-1)}`),
    commentOn: (url) => {
      record(`comment on ${url.split('/').at(-1)}`);
      comments += 1;
      return `${url}#issuecomment-${comments}`;
    },
  };
};

const file = (gh: GhClient, filed: FiledRecord): void => fileIssues({ report: report(), facts: makeFacts('A'), site: { url: null, serve: 'site' }, slug: 'AhoyLemon/skills', filed, gh, save: () => undefined, progress: () => undefined });

test('filing creates the agent issue, then the person\'s, cross-links them, then attaches the raw report', () => {
  const gh = fakeGh();
  const filed = emptyFiled();
  file(gh, filed);
  assert.deepEqual(gh.calls, ['label', 'create agent', 'create person', 'edit 1', 'comment on 1']);
  assert.equal(filed.agentUrl, 'https://github.com/AhoyLemon/skills/issues/1');
  assert.equal(filed.personUrl, 'https://github.com/AhoyLemon/skills/issues/2');
  assert.equal(filed.agentLinked, true);
  assert.equal(filed.rawCommentUrls.length, 1);
});

// Long enough that the ✅ evidence can't fit in the agent issue's body and moves into comments of its own.
const bigReport = (): FinderReport => {
  const raw = makeReport('A') as { criteria: Record<string, unknown>[] };
  const did = 'Loaded every page in the browser and looked at each element that could carry this. '.repeat(45);
  raw.criteria = raw.criteria.map((item) => ('na' in item ? { num: item['num'], evidence: [{ did, saw: 'Nothing on any page fails it' }] } : item));
  const result = validateReport(raw, { criteria: criteriaAt('A'), repoRoot: makeSite(), tracked: new Set(['index.html', 'css/site.css']) });
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.report;
};

const fileWith = (big: FinderReport, gh: GhClient, filed: FiledRecord): void => fileIssues({ report: big, facts: makeFacts('A'), site: { url: null, serve: 'site' }, slug: 'AhoyLemon/skills', filed, gh, save: () => undefined, progress: () => undefined });

test('a rerun that stopped partway through the agent issue\'s comments posts only the ones still missing', () => {
  const big = bigReport();
  const clean = fakeGh();
  fileWith(big, clean, emptyFiled());
  const evidenceComments = clean.calls.indexOf('create person') - clean.calls.indexOf('create agent') - 1;
  assert.ok(evidenceComments >= 1, 'the evidence moved into comments');

  const filed = emptyFiled();
  assert.throws(() => fileWith(big, fakeGh(3), filed), /network went away/);
  assert.equal(filed.agentCommentUrls.length, 1, 'one evidence comment landed before the failure');

  const retry = fakeGh();
  fileWith(big, retry, filed);
  assert.deepEqual(retry.calls.slice(0, evidenceComments + 1), ['label', ...Array<string>(evidenceComments - 1).fill('comment on 1'), 'create person']);
  assert.equal(filed.agentCommentUrls.length, evidenceComments);
  assert.equal(filed.agentLinked, true);
});

test('a rerun after a failure picks up where it stopped and files nothing twice', () => {
  const filed = emptyFiled();
  assert.throws(() => file(fakeGh(2), filed), /network went away during create person/);
  assert.ok(filed.agentUrl);
  assert.equal(filed.personUrl, null);

  const retry = fakeGh();
  file(retry, filed);
  assert.deepEqual(retry.calls, ['label', 'create person', 'edit 1', 'comment on 1']);
  assert.equal(filed.agentLinked, true);
});

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

const file = (gh: GhClient, filed: FiledRecord): void => fileIssues({ report: report(), facts: makeFacts('A'), slug: 'AhoyLemon/skills', filed, gh, save: () => undefined, progress: () => undefined });

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

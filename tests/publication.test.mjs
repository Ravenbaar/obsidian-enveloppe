import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_PUBLISHING, deriveState, findPublishedArticle, matchesRecord, publicSite, singlePublishingTarget } from '../src/publishing/model.ts';

const record = { owner: 'owner', repo: 'blog', base: 'main', branch: 'Notes-9-11-2026',
  head: 'b'.repeat(40), number: 3, slug: 'blog-AI-260524', title: 'Synthetic public article' };

test('a one-element repository array is a single publication, not a multi-repository upload', () => {
  const target = { owner: 'owner', repo: 'blog', branch: 'main' };
  assert.equal(singlePublishingTarget(target), target);
  assert.equal(singlePublishingTarget([target]), target);
  assert.equal(singlePublishingTarget([target, { ...target }]), target);
  assert.equal(singlePublishingTarget([target, { ...target, repo: 'other' }]), undefined);
  assert.equal(singlePublishingTarget([]), undefined);
});
const pr = { number: 3, state: 'open', merged: false, merge_commit_sha: 'c'.repeat(40),
  head: { sha: record.head, ref: record.branch, repo: { full_name: 'owner/blog' } }, base: { ref: 'main' } };
const checks = DEFAULT_PUBLISHING.checkWorkflows.map((workflow, index) => ({ id: index + 1,
  path: `.github/workflows/${workflow}`, event: 'pull_request', head_sha: record.head,
  head_branch: record.branch, status: 'completed', conclusion: 'success', pull_requests: [{ number: 3, head: { sha: record.head } }] }));
const derive = (changes = {}) => deriveState(changes.pr || pr, changes.record || record,
  changes.checks || checks, changes.automatic || [], changes.deployments || [], DEFAULT_PUBLISHING);

test('an uploaded PR remains checking until both exact-head PR workflows succeed', () => {
  assert.equal(derive({ checks: [] }).stage, 'checking');
  assert.equal(derive({ checks: [checks[0]] }).stage, 'checking');
  assert.equal(derive().stage, 'merging');
  for (const change of [item => item.head_sha = 'a'.repeat(40), item => item.event = 'push',
    item => item.pull_requests[0].number = 8, item => item.status = 'in_progress']) {
    const runs = structuredClone(checks);
    change(runs[0]);
    assert.equal(derive({ checks: runs }).stage, 'checking');
  }
});

test('latest failed checks expose only their own retry target', () => {
  const newer = { ...checks[0], id: 20, conclusion: 'failure' };
  const result = derive({ checks: [...checks, newer] });
  assert.equal(result.stage, 'failed');
  assert.equal(result.failedRun, 20);
  assert.equal(result.retry, 'check');
  assert.equal(derive({ checks: [...checks, { ...newer, status: 'in_progress', conclusion: null }] }).stage, 'checking');
});

test('newer heads and foreign repositories are stale, never live or retried', () => {
  for (const mutate of [value => value.head.sha = 'a'.repeat(40), value => value.number = 4,
    value => value.head.repo.full_name = 'foreign/blog', value => value.base.ref = 'other']) {
    const changed = structuredClone(pr);
    mutate(changed);
    assert(!matchesRecord(changed, record));
    const result = derive({ pr: changed });
    assert.equal(result.stage, 'stale');
    assert.equal(result.retry, undefined);
  }
});

test('automatic gate failures match PR number, workflow and current upload time', () => {
  const run = { id: 10, display_title: 'Publish PR #3', path: '.github/workflows/auto-publish-articles.yml',
    status: 'completed', conclusion: 'failure', created_at: '2026-09-11T02:00:00Z' };
  assert.equal(derive({ automatic: [run] }).retry, 'publish');
  assert.equal(derive({ automatic: [{ ...run, display_title: 'Publish PR #4' }] }).stage, 'merging');
  assert.equal(derive({ automatic: [run], record: { ...record, startedAt: '2026-09-11T03:00:00Z' } }).stage, 'merging');
});

test('merge and successful deployment do not by themselves claim publicly live', () => {
  const merged = { ...pr, merged: true, state: 'closed' };
  assert.equal(derive({ pr: merged }).stage, 'deploying');
  const run = { id: 12, path: '.github/workflows/astro-deploy.yml', head_sha: pr.merge_commit_sha,
    head_branch: 'main', status: 'completed', conclusion: 'success' };
  assert.equal(derive({ pr: merged, deployments: [run] }).stage, 'verifying');
  assert.equal(derive({ pr: merged, deployments: [{ ...run, head_sha: 'd'.repeat(40) }] }).stage, 'deploying');
  assert.equal(derive({ pr: merged, deployments: [{ ...run, conclusion: 'failure' }] }).retry, 'deploy');
});

test('closed unmerged requests have no retry action', () => {
  const state = derive({ pr: { ...pr, state: 'closed' } });
  assert.equal(state.stage, 'failed');
  assert.equal(state.retry, undefined);
});

test('website verification accepts mixed-case article slugs and refuses foreign links', () => {
  const site = publicSite('https://example.com');
  assert.equal(findPublishedArticle([{ url: '/posts/blog-ai-260524/' }], record.slug, site), 'https://example.com/posts/blog-ai-260524/');
  for (const url of ['https://foreign.example/posts/blog-AI-260524/', '//foreign.example/posts/blog-AI-260524/', 'javascript:alert(1)', '/posts/other/']) {
    assert.equal(findPublishedArticle([{ url }], record.slug, site), undefined);
  }
  assert.equal(findPublishedArticle([{ url: '/prefix/posts/blog-AI-260524/' }], record.slug, publicSite('https://example.com/prefix/')),
    'https://example.com/prefix/posts/blog-AI-260524/');
});

test('public verification never accepts credentials, insecure protocols or query-bearing origins', () => {
  for (const value of ['http://example.com', 'https://user:password@example.com', 'javascript:alert(1)', 'https://example.com/?token=secret']) {
    assert.throws(() => publicSite(value));
  }
});

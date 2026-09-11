import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { buildSync } from 'esbuild';

const bundle = buildSync({ entryPoints: ['src/publishing/center.ts'], bundle: true,
  write: false, platform: 'node', format: 'cjs', external: ['obsidian'] }).outputFiles[0].text;

function fixture() {
  const record = { owner: 'owner', repo: 'blog', base: 'main', branch: 'Notes-9-11-2026',
    head: 'b'.repeat(40), number: 3, slug: 'article', title: 'Synthetic public article' };
  const pr = { number: 3, merged: true, state: 'closed', merge_commit_sha: 'c'.repeat(40),
    head: { sha: record.head, ref: record.branch, repo: { full_name: 'owner/blog' } }, base: { ref: 'main', sha: 'c'.repeat(40) } };
  const calls = [], publicCalls = [];
  const state = { record, pr, calls, publicCalls, failure: undefined, release: pr.merge_commit_sha,
    runs: [{ id: 12, path: '.github/workflows/astro-deploy.yml', head_sha: pr.merge_commit_sha,
      head_branch: 'main', status: 'completed', conclusion: 'success' }] };
  const module = { exports: {} };
  class Modal { constructor() {} }
  vm.runInNewContext(bundle, { module, exports: module.exports, URL, Date, console, Buffer,
    window: {}, require: name => {
      assert.equal(name, 'obsidian');
      return { Modal, Setting: class {}, requestUrl: async options => {
        publicCalls.push(options);
        if (options.url.includes('/posts/')) return { status: state.pageStatus ?? 404 };
        return { status: 200, json: options.url.includes('release.json')
          ? { source_sha: state.release } : (state.hidden ? [] : [{ url: '/posts/article/' }]) };
      } };
    } });
  const plugin = { app: {}, settings: { publishing: { enabled: false, siteUrl: 'https://example.com/', last: record } },
    addCommand() {}, register() {}, saveSettings: async () => {}, reloadOctokit: async () => ({ octokit: {
      request: async (route, params) => {
        calls.push({ route, params });
        if (route.endsWith('/update-branch')) { if (state.writeFailure) throw { status: state.writeFailure }; return { data: {} }; }
        if (route.startsWith('POST ')) { if (state.writeFailure) throw { status: state.writeFailure }; return { data: {} }; }
        if (route.endsWith('/pulls/3')) return { data: structuredClone(pr) };
        if (state.failure) throw { status: state.failure };
        if (route.includes('/actions/runs/')) return { data: state.retryRun };
        if (route.endsWith('/actions/runs')) return { data: { workflow_runs: state.runs } };
        if (route.includes('/actions/workflows/')) return { data: { workflow_runs: [] } };
        if (route.includes('/git/ref/')) return { data: { object: { sha: state.release } } };
        if (route.includes('/git/commits/')) return { data: { parents: state.syncParents.map(sha => ({ sha })) } };
        if (route.includes('/compare/')) return { data: { merge_base_commit: { sha: state.ancestor || pr.merge_commit_sha } } };
        throw new Error(route);
      },
    } }) };
  state.center = new module.exports.PublicationCenter(plugin);
  return state;
}

test('complete refresh verifies deployed source and article without sending any token to the public website', async () => {
  const f = fixture();
  await f.center.refresh();
  assert.equal(f.center.state.stage, 'live');
  assert.equal(f.center.state.articleUrl, 'https://example.com/posts/article/');
  assert.equal(f.publicCalls.length, 2);
  for (const request of f.publicCalls) assert.equal(request.headers, undefined);
  assert(!f.calls.some(call => call.route.startsWith('POST ')));
  for (const call of f.calls) {
    assert.equal(call.params.headers, undefined);
    assert.equal(typeof call.params.publication_refresh, 'number');
  }
});

test('hide and delete require the deployed version, absent index entry and a missing direct page', async () => {
  for (const action of ['hide', 'delete']) {
    const f = fixture(); f.record.action = action; f.hidden = true;
    f.pageStatus = 200;
    await f.center.refresh();
    assert.equal(f.center.state.stage, 'verifying');
    f.pageStatus = 404;
    await f.center.refresh();
    assert.equal(f.center.state.stage, action === 'hide' ? 'hidden' : 'deleted');
    f.hidden = false;
    await f.center.refresh();
    assert.equal(f.center.state.stage, 'verifying');
  }
});

test('missing Actions permission is shown explicitly without falsely reporting failed publication', async () => {
  const f = fixture();
  f.failure = 403;
  await f.center.refresh();
  assert.equal(f.center.state.stage, 'permission');
  assert.match(f.center.state.detail, /Actions/);
  assert.equal(f.publicCalls.length, 0);
});

test('transient API failures are unknown state, never success or a confirmed publish failure', async () => {
  const f = fixture();
  f.failure = 503;
  await f.center.refresh();
  assert.equal(f.center.state.stage, 'network');
});

test('a later public deployment is accepted only when the article merge is its ancestor', async () => {
  for (const sameHistory of [true, false]) {
    const f = fixture();
    f.release = 'd'.repeat(40);
    f.ancestor = sameHistory ? f.pr.merge_commit_sha : 'a'.repeat(40);
    await f.center.refresh();
    assert.equal(f.center.state.stage, sameHistory ? 'live' : 'verifying');
  }
});

test('successful newer deployment clears an older deployment failure only after public verification', async () => {
  const f = fixture();
  f.runs[0].conclusion = 'failure';
  f.release = 'd'.repeat(40);
  await f.center.refresh();
  assert.equal(f.center.state.stage, 'live');
  f.ancestor = 'a'.repeat(40);
  await f.center.refresh();
  assert.equal(f.center.state.stage, 'failed');
});

test('retry checks pins the current PR and head and targets only its failed run', async () => {
  const f = fixture();
  f.pr.merged = false;
  f.pr.state = 'open';
  f.retryRun = { id: 21, head_sha: f.record.head, pull_requests: [{ number: 3 }] };
  f.center.state = { stage: 'failed', detail: '', retry: 'check', failedRun: 21 };
  await f.center.retry();
  const writes = f.calls.filter(call => call.route.startsWith('POST '));
  assert.equal(writes.length, 1);
  assert(writes[0].route.endsWith('/actions/runs/21/rerun-failed-jobs'));
  assert.equal(f.center.state.stage, 'checking');
  await f.center.retry();
  assert.equal(f.calls.filter(call => call.route.startsWith('POST ')).length, 1);
});

test('retry refuses a newer article head or an unrelated failed run', async () => {
  for (const changedHead of [true, false]) {
    const f = fixture();
    f.pr.merged = false;
    f.pr.state = 'open';
    if (changedHead) f.pr.head.sha = 'a'.repeat(40);
    f.retryRun = { id: 21, head_sha: 'a'.repeat(40), pull_requests: [{ number: 9 }] };
    f.center.state = { stage: 'failed', detail: '', retry: 'check', failedRun: 21 };
    await f.center.retry();
    assert.equal(f.calls.filter(call => call.route.startsWith('POST ')).length, 0);
    assert.notEqual(f.center.state.stage, 'live');
  }
});

test('deployment retry dispatches the verified current main and leaves the upload unchanged', async () => {
  const f = fixture();
  f.center.state = { stage: 'failed', detail: '', retry: 'deploy', failedRun: 12 };
  await f.center.retry();
  const writes = f.calls.filter(call => call.route.startsWith('POST '));
  assert.equal(writes.length, 1);
  assert(writes[0].route.endsWith('/actions/workflows/astro-deploy.yml/dispatches'));
  assert.equal(writes[0].params.ref, 'main');
  assert.equal(writes[0].params.inputs.expected_sha, f.pr.merge_commit_sha);
});

test('Actions read without write does not misreport a retry as accepted', async () => {
  const f = fixture();
  f.pr.merged = false;
  f.pr.state = 'open';
  f.center.state = { stage: 'failed', detail: '', retry: 'publish' };
  f.writeFailure = 403;
  await f.center.retry();
  assert.equal(f.center.state.stage, 'permission');
});

test('retry synchronizes an outdated open request with its exact head before restarting checks', async () => {
  const f = fixture();
  f.pr.merged = false;
  f.pr.state = 'open';
  f.pr.base.sha = 'a'.repeat(40);
  f.center.state = { stage: 'failed', detail: '', retry: 'publish' };
  await f.center.retry();
  const writes = f.calls.filter(call => /^(PUT|POST) /.test(call.route));
  assert.equal(writes.length, 1);
  assert(writes[0].route.endsWith('/pulls/3/update-branch'));
  assert.equal(writes[0].params.expected_head_sha, f.record.head);
  assert.equal(f.record.syncBase, f.release);
  assert.equal(f.center.state.stage, 'checking');
});

test('refresh adopts only the exact requested synchronization merge and never an unrelated upload', async () => {
  for (const exact of [true, false]) {
    const f = fixture();
    const oldHead = f.record.head;
    f.record.syncBase = 'a'.repeat(40);
    f.pr.head.sha = 'd'.repeat(40);
    f.syncParents = [oldHead, exact ? f.record.syncBase : 'e'.repeat(40)];
    await f.center.refresh();
    assert.equal(f.record.head, exact ? f.pr.head.sha : oldHead);
    assert.equal(f.center.state.stage, exact ? 'live' : 'network');
  }
});

test('a rejected branch synchronization is cleared and cannot adopt a later unrelated head', async () => {
  const f = fixture();
  f.pr.merged = false;
  f.pr.state = 'open';
  f.pr.base.sha = 'a'.repeat(40);
  f.writeFailure = 422;
  f.center.state = { stage: 'failed', detail: '', retry: 'publish' };
  await f.center.retry();
  assert.equal(f.record.syncBase, undefined);
  assert.equal(f.calls.filter(call => call.route.startsWith('POST ')).length, 0);
});

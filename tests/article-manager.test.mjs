import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { buildSync } from 'esbuild';
import { nextArticleState, parseArticleState } from '../src/publishing/management-model.ts';
const code = buildSync({ entryPoints: ['src/publishing/manager.ts'], bundle: true, write: false,
  platform: 'node', format: 'cjs', external: ['obsidian'] }).outputFiles[0].text;
const sha = letter => letter.repeat(40);
const article = { slug: 'test-Article', title: 'Synthetic article', blob: sha('a'), exists: true, draft: false,
  desired: 'published', status: '已发布' };

function fixture() {
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, URL, Date, Buffer, Uint8Array, crypto,
    require: name => { assert.equal(name, 'obsidian'); return { Modal: class {}, Setting: class {} }; } });
  const calls = [];
  const f = { calls, snapshot: { head: sha('b'), tree: sha('c'), state: { version: 1, articles: {} }, rows: [structuredClone(article)] },
    refs: new Map(), prs: [], failOnce: false };
  const center = { config: {}, plugin: { settings: { github: { user: 'owner', repo: 'blog', branch: 'main' } },
    addCommand() {}, register() {}, saveSettings: async () => {} }, setState() {}, open() {},
    watch: async record => { center.config.last = record; },
    api: async (context, method, path, params = {}) => {
      calls.push({ context, method, path, params });
      if (method === 'POST' && path === 'git/blobs') return { sha: sha('d') };
      if (method === 'POST' && path === 'git/trees') return { sha: sha('e') };
      if (method === 'POST' && path === 'git/commits') return { sha: sha('f') };
      if (method === 'GET' && path.startsWith('git/ref/heads/')) {
        const ref = f.refs.get(path.slice('git/ref/heads/'.length));
        if (!ref) throw { status: 404 }; return { object: { sha: ref } };
      }
      if (method === 'POST' && path === 'git/refs') { f.refs.set(params.ref.slice(11), params.sha); return {}; }
      if (method === 'GET' && path === 'pulls') return f.prs;
      if (method === 'POST' && path === 'pulls') {
        const pr = { number: 8, state: 'open', merged: false, head: { sha: sha('f'), ref: params.head, repo: { full_name: 'owner/blog' } }, base: { ref: 'main' } };
        f.prs.push(pr);
        if (f.failOnce) { f.failOnce = false; throw { status: 503 }; }
        return pr;
      }
      throw new Error(path);
    } };
  f.center = center;
  f.manager = new module.exports.ArticleManager(center);
  f.manager.snapshot = async () => structuredClone(f.snapshot);
  return f;
}

test('hide preserves article bytes and changes only the selected state entry', async () => {
  const f = fixture(); await f.manager.submit(article, 'hide');
  const tree = f.calls.find(call => call.path === 'git/trees').params;
  assert.equal(tree.tree.length, 1);
  assert.equal(tree.tree[0].path, '.publishing/article-state.json');
  assert.equal(tree.base_tree, f.snapshot.tree);
  const pr = f.calls.find(call => call.method === 'POST' && call.path === 'pulls').params;
  assert.equal(pr.title, 'Enveloppe: hide test-Article');
  assert.deepEqual(JSON.parse(pr.body), { enveloppe: 1, action: 'hide', slug: article.slug, source: article.blob });
  assert.equal(f.center.config.last.action, 'hide');
});

test('delete creates a one-article removal without touching attachments, vaults or other files', async () => {
  const f = fixture(); await f.manager.submit(article, 'delete');
  const tree = f.calls.find(call => call.path === 'git/trees').params.tree;
  assert.equal(tree.length, 2);
  assert.equal(tree[1].path, 'src/content/posts/test-Article.md');
  assert.equal(tree[1].sha, null);
  assert.equal(f.center.config.last.action, 'delete');
});

test('deleted article recovery uses the exact retained blob and removes the exclusion entry', async () => {
  const f = fixture();
  const deleted = { ...article, exists: false, desired: 'deleted' };
  f.snapshot.rows = [deleted];
  f.snapshot.state.articles[article.slug] = { state: 'deleted', title: article.title, blob: article.blob };
  await f.manager.submit(deleted, 'restore');
  const tree = f.calls.find(call => call.path === 'git/trees').params.tree;
  assert.equal(tree[1].sha, article.blob);
  const state = JSON.parse(f.calls.find(call => call.path === 'git/blobs').params.content);
  assert.deepEqual(state.articles, {});
});

test('new article versions stop a queued selection before any write', async () => {
  const f = fixture(); f.snapshot.rows[0].blob = sha('c');
  await f.manager.submit(article, 'delete');
  assert.equal(f.calls.length, 0);
  assert.match(f.manager.message, /已变化/);
});

test('uncertain PR response is resumed idempotently with the saved branch', async () => {
  const f = fixture(); f.failOnce = true;
  await f.manager.submit(article, 'hide');
  assert(f.center.config.managementPending);
  await f.manager.resume();
  assert.equal(f.center.config.managementPending, undefined);
  assert.equal(f.calls.filter(call => call.path === 'pulls' && call.method === 'POST').length, 1);
  assert.equal(f.calls.filter(call => call.path === 'git/refs' && call.method === 'POST').length, 1);
});

test('metadata cannot invent states or restore a still-marked draft', () => {
  const hidden = { version: 1, articles: { [article.slug]: { state: 'hidden', title: article.title, blob: article.blob } } };
  assert.throws(() => nextArticleState(hidden, { ...article, draft: true }, 'restore'));
  const bad = structuredClone(hidden); bad.articles[article.slug].blob = '../bad';
  assert.throws(() => parseArticleState(JSON.stringify(bad)));
  assert.equal(nextArticleState(hidden, article, 'restore').articles[article.slug], undefined);
});

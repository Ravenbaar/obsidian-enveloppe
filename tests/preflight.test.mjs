import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { buildSync } from 'esbuild';

function load(entry, mocks = {}) {
  const code = buildSync({ entryPoints: [entry], bundle: true, write: false,
    platform: 'node', format: 'cjs', packages: 'external', external: Object.keys(mocks) }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, console, require: name => {
    if (!(name in mocks)) throw new Error(`Unexpected import: ${name}`);
    return mocks[name];
  } });
  return module.exports;
}

// Obsidian supplies the YAML parser in production; fixture values are JSON
// scalars so these tests do not need a second YAML implementation/dependency.
const parseYaml = text => Object.fromEntries(text.split('\n').filter(Boolean).map(line => {
  const colon = line.indexOf(':');
  if (colon < 0) throw new Error('PRIVATE_PARSER_CANARY');
  const key = line.slice(0, colon).replace(/^['"]|['"]$/g, '');
  const value = line.slice(colon + 1).trim();
  try { return [key, JSON.parse(value)]; } catch { return [key, value]; }
}));
const p = load('src/publishing/preflight.ts');
const note = (body, attrs = 'passwordKey: fixture', eol = '\n') =>
  `---\ntitle: Synthetic article\n${attrs}\n---\n${body}`.replaceAll('\n', eol);
const valid = '<!-- encrypt -->\nPRIVATE_BODY_CANARY\n<!-- /encrypt -->';
const inspect = source => p.inspectPublicationSource(source, parseYaml);
function rejectsAt(source, line, text) {
  assert.throws(() => inspect(source), error => {
    assert.equal(error.line, line);
    assert.match(error.message, text);
    assert(!error.message.includes('PRIVATE_'));
    return true;
  });
}

test('preflight counts original lines including YAML, blank lines, BOM and CRLF', () => {
  rejectsAt('\uFEFF' + note('\n\n<!-- encrypt -->\nPRIVATE_BODY_CANARY', undefined, '\r\n'), 7, /缺少结束标记/);
  assert.equal(inspect(note(valid, undefined, '\r\n')).protectedLine, 5);
});

test('standalone regions and whole encryption pass without reading a password', () => {
  const result = inspect(note(valid));
  assert.equal(result.encrypted, false);
  assert.deepEqual(Array.from(result.markers), ['open:', 'close']);
  assert.doesNotThrow(() => inspect(note('Public\n' + valid + '\n<!-- encrypt:second -->\nprivate\n<!-- /encrypt -->')));
  assert.doesNotThrow(() => inspect(note(valid, 'encrypted: true\npasswordKey: fixture')));
});

test('named partial region still requires a frontmatter key', () => {
  rejectsAt(note('<!-- encrypt:named -->\nprivate\n<!-- /encrypt -->', ''), 5, /局部加密也需要/);
});

test('nested and unmatched markers report their original positions', () => {
  rejectsAt(note('<!-- /encrypt -->'), 5, /没有对应/);
  rejectsAt(note('<!-- encrypt -->\n<!-- encrypt:second -->'), 6, /不能嵌套/);
});

test('malformed markers are reserved even inside code, comments, quotes or raw HTML', () => {
  for (const bad of [' <!-- encrypt -->', '> <!-- encrypt -->', 'public <!-- encrypt -->',
    '<!-- ENCRYPT -->', '<!-- encrypt:bad key -->', '<!-- encrypt friends -->']) {
    rejectsAt(note('```md\n' + bad), 6, /格式无效/);
  }
  rejectsAt(note('<!--\nencrypt:fixture -->'), 5, /不能跨行/);
  rejectsAt(note('<!-- encrypt -->\nprivate\n<!--\n/encrypt -->'), 7, /不能跨行/);
  assert.doesNotThrow(() => inspect(note('`&lt;!-- encrypt -->`', '')));
});

test('metadata errors never include the submitted password or parser diagnostics', () => {
  rejectsAt(note('public', 'password: PRIVATE_PASSWORD_CANARY'), 3, /明文密码/);
  rejectsAt(note('public', 'passphrase: PRIVATE_PASSWORD_CANARY'), 3, /明文密码/);
  rejectsAt(note('public', 'encrypted: "true"'), 3, /不能加引号/);
  rejectsAt(note('public', 'encrypted: true'), 3, /整篇加密需要/);
  rejectsAt(note(valid, 'passwordKey: PRIVATE_INVALID_KEY_CANARY!'), 3, /1–64/);
  rejectsAt(note('public'), 3, /至少一个加密区块/);
  rejectsAt(note('public', 'PRIVATE_INVALID_YAML_CANARY'), 1, /YAML 属性格式无效/);
});

test('encrypted MDX is rejected and scope excludes unrelated repository paths', () => {
  assert.throws(() => p.inspectPublicationSource(note(valid), parseYaml, 'src/content/posts/test.mdx'), /仅支持 .md/);
  assert(p.isPublishingArticle(true, 'src/content/posts/folder/example.md'));
  for (const path of ['notes/a.md', 'src/content/spec/a.md', 'src/content/posts/../private/a.md', 'src/content/posts/a.png']) {
    assert.equal(p.isPublishingArticle(true, path), false);
  }
  assert.equal(p.isPublishingArticle(false, 'src/content/posts/a.md'), false);
});

test('conversion cannot silently remove protection, rename keys or add malformed markers', () => {
  const source = note(valid);
  const original = inspect(source);
  p.assertProtectionPreserved(original, note(valid.replaceAll('\n', '  \n')), parseYaml, 'post.md');
  for (const changed of [note('PRIVATE_BODY_CANARY', ''), source.replace('fixture', 'different'), source.replace('<!-- /encrypt -->', '')]) {
    assert.throws(() => p.assertProtectionPreserved(original, changed, parseYaml, 'post.md'), error => {
      assert.equal(error.line, 5);
      assert(!error.message.includes('PRIVATE_BODY_CANARY'));
      return true;
    });
  }
});

function fixture(source = note('<!-- encrypt -->\nPRIVATE_BODY_CANARY')) {
  const writes = [], notices = [], states = [];
  const file = { path: 'Synthetic.md', basename: 'Synthetic', name: 'Synthetic.md', extension: 'md' };
  const prop = { owner: 'fixture', repo: 'blog', branch: 'main', automaticallyMergePR: false };
  const plugin = { settings: { publishing: { enabled: true }, github: { dryRun: { enable: false } }, plugin: { shareKey: 'share' } },
    app: { vault: { read: async () => source, cachedRead: () => { throw new Error('Must read fresh source'); } } },
    console: { noticeMobile() {} }, publicationCenter: { enabled: true, begin() {}, failUpload() {}, setState: state => states.push(state), failPreflight: detail => states.push({ stage: 'failed', detail }) } };
  const obsidian = { parseYaml, Notice: class { constructor(text) { notices.push(text); } }, Platform: {} };
  const helpers = load('src/publishing/preflight-source.ts', { obsidian,
    'src/conversion/file_path': { getReceiptFolder: () => 'src/content/posts/article.md' } });
  const command = load('src/commands/share/unique_note.ts', { obsidian, i18next: { t: key => key },
    'src/publishing/model': {}, 'src/publishing/preflight-source': helpers,
    'src/settings/modals/list_changed': {}, 'src/utils': {},
    'src/utils/data_validation_test': { checkRepositoryValidityWithProperties: async () => true },
    'src/utils/parse_frontmatter': { frontmatterFromFile: () => ({ share: true }), mergeFrontmatter: value => value, getProperties: () => prop } });
  const manager = { plugin, settings: plugin.settings, newBranch: async () => writes.push('branch'),
    publish: async () => { writes.push('publish'); return false; } };
  return { command, manager, file, writes, notices, states, plugin, helpers };
}

test('single-note command rejects original source before branch creation or upload', async () => {
  const f = fixture();
  assert.equal(await f.command.shareOneNote(f.manager, f.file, null, {}), false);
  assert.equal(f.writes.length, 0);
  assert.equal(f.states.at(-1).stage, 'failed');
  assert.match(f.notices[0], /原稿第 5 行/);
  assert(!JSON.stringify(f.notices).includes('PRIVATE_BODY_CANARY'));
});

test('preflight allows valid source and leaves disabled publication behavior unchanged', async () => {
  const validFile = fixture(note(valid));
  await validFile.command.shareOneNote(validFile.manager, validFile.file, null, {});
  assert.deepEqual(validFile.writes, ['branch', 'publish']);
  const disabled = fixture(); disabled.plugin.settings.publishing.enabled = false;
  await disabled.command.shareOneNote(disabled.manager, disabled.file, null, {});
  assert.deepEqual(disabled.writes, ['branch', 'publish']);
});

test('batch preflight reports local errors and stops before its caller creates a branch', async () => {
  const f = fixture();
  assert.equal(await f.helpers.checkPublicationBatch(f.plugin, [f.file], null, {}), false);
  assert.equal(f.writes.length, 0);
});

test('core Publisher.publish guards direct/deep uploads and validates final transformed protection', async () => {
  for (const mode of ['invalid-source', 'stripped-markers', 'valid']) {
    const f = fixture(mode === 'invalid-source' ? note('<!-- encrypt -->\nPRIVATE_BODY_CANARY') : note(valid));
    const writes = [], conversions = [];
    const prop = { owner: 'fixture', repo: 'blog', branch: 'main' };
    const source = note(valid);
    f.plugin.console.trace = () => {};
    const common = { obsidian: { parseYaml, Notice: class {} }, i18next: {}, 'js-base64': {},
      'src/conversion': { mainConverting: async text => {
        conversions.push(text);
        return mode === 'stripped-markers' ? note('PRIVATE_BODY_CANARY', '') : text;
      } },
      'src/conversion/compiler/excalidraw': {},
      'src/conversion/file_path': { getReceiptFolder: () => 'src/content/posts/article.md' },
      'src/GitHub/delete': {},
      'src/GitHub/files': { FilesManagement: class {
        async wasEditedSinceLastSync() { return true; }
        getSharedEmbed() { return []; }
        async getMetadataLinks() { return []; }
        getLinkedByEmbedding() { return []; }
      } },
      'src/publishing/preflight': p, 'src/publishing/preflight-source': f.helpers,
      'src/utils/data_validation_test': { isShared: () => true, checkIfRepoIsInAnother: () => true, checkEmptyConfiguration: async () => true },
      'src/utils/parse_frontmatter': { frontmatterFromFile: () => ({ share: true }), mergeFrontmatter: value => value,
        getProperties: () => prop, getFrontmatterSettings: () => ({}), frontmatterSettingsRepository: () => ({}) },
      'src/utils/status_bar': {}, 'ts-deepmerge': { merge: { withOptions: (options, ...values) => Object.assign({}, ...values) } },
      '../utils/logs': {},
    };
    const Publisher = load('src/GitHub/upload.ts', common).default;
    const publisher = new Publisher({}, f.plugin);
    publisher.uploadOnMultipleRepo = async () => { writes.push('upload'); return { deleted: {}, uploaded: [], error: [] }; };
    const invoke = () => publisher.publish(f.file, false, { repository: null, frontmatter: prop }, [], true, undefined);
    if (mode === 'valid') {
      await invoke();
      assert.deepEqual(writes, ['upload']);
      assert.equal(conversions[0], source);
    } else {
      await assert.rejects(invoke, /发布前检查未通过/);
      assert.equal(writes.length, 0);
      assert.equal(conversions.length, mode === 'invalid-source' ? 0 : 1);
    }
  }
});

test('batch failure identifies only the failing filename, original line and safe reason', async () => {
  const f = fixture();
  const first = { ...f.file, name: 'First.md', path: 'PrivateFolder/First.md' };
  const second = { ...f.file, name: 'Second.md', path: 'PrivateFolder/Second.md' };
  f.plugin.app.vault.read = async file => file === first ? note(valid) : note('<!-- encrypt -->\nPRIVATE_BODY_CANARY');
  await f.helpers.checkPublicationBatch(f.plugin, [first, second], null, {});
  assert.match(f.notices[0], /Second.md/);
  assert.match(f.notices[0], /原稿第 5 行/);
  assert(!f.notices[0].includes('PrivateFolder'));
  assert(!f.notices[0].includes('PRIVATE_BODY_CANARY'));
});


test('conversion errors preserve the offending filename through nested handlers and report once', async () => {
  const f = fixture(note(valid));
  f.manager.publish = async () => {
    try { await f.helpers.checkPublicationSource({ ...f.plugin,
      app: { vault: { read: async () => note('<!-- encrypt -->\nPRIVATE_BODY_CANARY') } } },
      { ...f.file, name: 'Embedded.md' }, null, {}); }
    catch (error) {
      f.helpers.showPublicationPreflightError(f.plugin, error, 'Embedded.md');
      throw error;
    }
  };
  assert.equal(await f.command.shareOneNote(f.manager, f.file, null, {}), false);
  assert.equal(f.notices.length, 1);
  assert.match(f.states.at(-1).detail, /Embedded.md/);
  assert.match(f.notices[0], /原稿第 5 行/);
});

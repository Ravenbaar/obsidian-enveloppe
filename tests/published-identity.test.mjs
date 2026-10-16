import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { buildSync } from 'esbuild';

function load(entry, mocks = {}) {
  const code = buildSync({ entryPoints: [entry], bundle: true, write: false,
    platform: 'node', format: 'cjs', packages: 'external', external: Object.keys(mocks) }).outputFiles[0].text;
  const module = { exports: {} };
  vm.runInNewContext(code, { module, exports: module.exports, URL, console, require: name => {
    if (!(name in mocks)) throw new Error(`Unexpected import: ${name}`);
    return mocks[name];
  } });
  return module.exports;
}

function commandFixture(identity = { slug: 'public-folder/renamed-中文', title: 'Converted public title' }) {
  const calls = [], states = [];
  const prop = { owner: 'fixture', repo: 'blog', branch: 'main' };
  const settings = { github: { dryRun: { enable: false } }, upload: { metadataExtractorPath: '' },
    plugin: { shareKey: 'share', displayModalRepoEditing: false } };
  const plugin = { settings, app: {}, console: { noticeMobile() {}, publisherNotification: async () => {} },
    publicationCenter: { enabled: true, begin() {}, failUpload() {}, setState: state => states.push(state),
      track: async (...args) => calls.push(args) } };
  const manager = { plugin, settings, newBranch: async () => {},
    publish: async () => ({ deleted: {}, uploaded: [], error: [], publicationIdentity: identity }),
    updateRepository: async () => true };
  const command = load('src/commands/share/unique_note.ts', {
    obsidian: { Platform: {} }, i18next: { t: key => key },
    'src/publishing/preflight-source': { checkPublicationSource: async () => {}, showPublicationPreflightError: () => false },
    'src/settings/modals/list_changed': {}, 'src/utils': { createLink: async () => {} },
    'src/utils/data_validation_test': { checkRepositoryValidityWithProperties: async () => true },
    'src/utils/parse_frontmatter': { frontmatterFromFile: () => ({ title: 'Display title', slug: 'old-slug' }),
      mergeFrontmatter: value => value, getProperties: () => prop },
  });
  const file = { path: 'PRIVATE_VAULT_CANARY/Original name.md', basename: 'Original name', name: 'Original name.md' };
  return { command, manager, file, calls, states, plugin };
}

test('single-note status tracks the actual converted upload identity instead of metadata or display title', async () => {
  const f = commandFixture();
  await f.command.shareOneNote(f.manager, f.file, null, {}, 'Command display label');
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0][2], 'public-folder/renamed-中文');
  assert.equal(f.calls[0][3], 'Converted public title');
  assert(!JSON.stringify(f.calls.map(call => call.slice(2))).includes('PRIVATE_VAULT_CANARY'));
});

test('native explicit-slug links use the stable public source destination, never a raw pre-conversion slug', () => {
  const source = '[[Target]]';
  const target = { path: 'PRIVATE_VAULT_CANARY/Target.md', basename: 'Target', name: 'Target.md', extension: 'md' };
  const plugin = { settings: {}, app: { metadataCache: {
    getFileCache: () => ({ links: [{ original: source, position: { start: { offset: 0 }, end: { offset: source.length } } }] }),
    getFirstLinkpathDest: () => target,
  } } };
  const adapter = load('src/publishing/native-source.ts', {
    obsidian: {},
    'src/conversion/file_path': { getReceiptFolder: () => 'src/content/posts/Public Folder/Renamed 中文.md' },
    'src/utils/data_validation_test': { isShared: () => true, checkIfRepoIsInAnother: () => true },
    'src/utils/parse_frontmatter': { frontmatterFromFile: () => ({ slug: 'raw-slug-before-output-replacement' }), getProperties: () => ({}) },
  });
  const result = adapter.prepareNativeWikilinks(source, { path: 'PRIVATE_VAULT_CANARY/Source.md' },
    { plugin, repository: null, frontmatter: { prop: {} } });
  assert.equal(result.restore(result.text), '[[Public Folder/Renamed 中文.md\\|Target]]');
});

const identity = load('src/publishing/published-identity.ts');
const { publicSite, findPublishedArticle } = load('src/publishing/model.ts');
const yamlNote = metadata => `---\n${JSON.stringify(metadata)}\n---\nPublic body`;

test('actual public destination uses Astro glob normalization, not the title or original basename', () => {
  // Golden values verified against Astro 5 getContentEntryIdAndSlug + github-slugger 2.0.0.
  for (const [path, expected] of [
    ['Public Folder/Renamed 中文.md', 'public-folder/renamed-中文'],
    ['Hello, World!.md', 'hello-world'],
    ['Café Déjà_vu.md', 'café-déjà_vu'],
    ['研究/中文 标题.md', '研究/中文-标题'],
    ['Research & Development/[Draft] File.md', 'research--development/draft-file'],
    ['Guides/index.md', 'guides'],
    ['Guides/INDEX.mdx', 'guides'],
    ['index.md', 'index'],
    ['Dots.v2.md', 'dotsv2'],
    ['Emoji 😀 Note.md', 'emoji--note'],
    ['100% Done.md', '100-done'],
    ['Notes #1.md', 'notes-'],
    ['What? Now.md', 'what'],
    ['Folder/File.txt#Version.md', 'folder/file'],
    ['A/B/index.md', 'a/b'],
    ['Folder/index/#Heading.md', 'folder'],
    ['Folder/index/?Question.md', 'folder'],
  ]) {
    assert.equal(identity.publishedArticleId(`src/content/posts/${path}`), expected, path);
    const data = identity.publishedIdentityFromSource(yamlNote({ title: 'Unrelated title' }), `src/content/posts/${path}`, JSON.parse);
    assert.equal(data.slug, expected, path);
    assert.equal(data.title, 'Unrelated title');
  }
});

test('converted explicit slug wins verbatim and no new source metadata is required', () => {
  const destination = 'src/content/posts/Renamed File.md';
  const source = yamlNote({ title: 'Converted title', slug: 'Custom/中文 Slug', aliases: ['Existing alias'] });
  const result = identity.publishedIdentityFromSource(source, destination, JSON.parse);
  assert.equal(result.slug, 'Custom/中文 Slug');
  assert.equal(result.title, 'Converted title');
  assert.deepEqual(Object.keys(result).sort(), ['slug', 'title']);
  assert.deepEqual(JSON.parse(source.split('\n')[1]), { title: 'Converted title', slug: 'Custom/中文 Slug', aliases: ['Existing alias'] });
  for (const slug of [undefined, '', false, 0, null]) assert.equal(identity.publishedArticleId(destination, slug), 'renamed-file');
  assert.equal(identity.publishedArticleId('src/content/posts/Notes #1.md', 'Exact/#Slug'), 'Exact/#Slug');
  assert.equal(identity.publishedArticleId('src/content/posts/Protocol: Note.md'), undefined);
  for (const slug of [[], {}, 7, true]) assert.equal(identity.publishedArticleId(destination, slug), undefined);
  assert.equal(identity.publishedIdentityFromSource('\uFEFF' + source.replaceAll('\n', '\r\n'), destination, JSON.parse).slug, result.slug);
});

test('out-of-scope and malformed destinations never become a public identity or leak a vault path', () => {
  for (const path of ['PRIVATE_VAULT_CANARY/Note.md', 'docs/Note.md', 'src/content/spec/Note.md',
    'src/content/posts/../private/Note.md', 'src/content/posts/./Note.md', 'src/content/posts//Note.md',
    'src/content/posts/Note.png', 'src/content/posts/Folder\\Note.md']) {
    assert.equal(identity.publishedSourcePath(path), undefined, path);
    assert.equal(identity.publishedIdentityFromSource(yamlNote({ slug: 'explicit' }), path, JSON.parse), undefined, path);
  }
  assert.equal(identity.publishedIdentityFromSource(yamlNote({}), 'src/content/posts/Note.md', () => { throw new Error('PRIVATE_PARSER_CANARY'); }), undefined);
});

test('missing publication identity never falls back to an unrelated metadata slug', async () => {
  const f = commandFixture(null);
  await f.command.shareOneNote(f.manager, f.file, null, {});
  assert.equal(f.calls.length, 0);
  assert.equal(f.states.at(-1).stage, 'idle');
  assert.match(f.states.at(-1).detail, /实际上传路径/);
});

test('dry runs do not start tracking the returned public identity', async () => {
  const f = commandFixture();
  f.plugin.settings.github.dryRun.enable = true;
  await f.command.shareOneNote(f.manager, f.file, null, {});
  assert.equal(f.calls.length, 0);
});

test('verification accepts nested Unicode paths under a configured site prefix', () => {
  const site = publicSite('https://example.com/blog');
  for (const slug of ['public-folder/renamed-中文', 'Custom/中文 Slug', 'special/100%']) {
    const url = '/blog/posts/' + slug.split('/').map(encodeURIComponent).join('/') + '/';
    assert.equal(findPublishedArticle([{ url }], slug, site), new URL(url, site).href);
  }
});

test('verification skips malformed or unsafe index URLs without losing later valid entries', () => {
  const site = publicSite('https://example.com/blog/');
  const invalid = [
    'https://foreign.example/blog/posts/folder/article/', '//foreign.example/blog/posts/folder/article/',
    'https://name:secret@example.com/blog/posts/folder/article/',
    'http://example.com/blog/posts/folder/article/', 'javascript:alert(1)',
    '/blog/posts/folder/article/?token=PRIVATE_CANARY', '/blog/posts/folder/article/#anchor',
    '/blog/posts/folder%2Farticle/', '/blog/posts/folder%5Carticle/',
    '/blog/posts/%ZZ/', 'https://[invalid', '/blog-other/posts/folder/article/',
  ];
  for (const url of invalid) assert.equal(findPublishedArticle([{ url }], 'folder/article', site), undefined, url);
  assert.equal(findPublishedArticle(invalid.map(url => ({ url })).concat({ url: '/blog/posts/folder/article/' }),
    'folder/article', site), 'https://example.com/blog/posts/folder/article/');
});

test('verification prefers exact explicit slug case and rejects ambiguous legacy case fallback', () => {
  const site = publicSite('https://example.com/');
  const entries = [{ url: '/posts/article/' }, { url: '/posts/Article/' }];
  assert.equal(findPublishedArticle(entries, 'Article', site), 'https://example.com/posts/Article/');
  assert.equal(findPublishedArticle(entries, 'ARTICLE', site), undefined);
});

test('Publisher returns identity from the same renamed or overridden destination and converted bytes it uploads', async () => {
  for (const sample of [
    { name: 'Original Note', metadata: { title: 'Display-only title' }, expectedPath: 'Original Note.md', expected: 'original-note' },
    { name: 'Original Note', metadata: { publishName: 'Named Output!' }, rename: true,
      expectedPath: 'Named Renamed!.md', expected: 'named-renamed' },
    { name: 'Original Note', metadata: {}, override: 'Guides/中文',
      expectedPath: 'Guides/中文/Original Note.md', expected: 'guides/中文/original-note' },
    { name: 'Guides', metadata: { category: 'Guides' }, folderNote: true,
      expectedPath: 'Guides/index.md', expected: 'guides' },
    { name: 'Original Note', metadata: { slug: 'Raw/Old' }, convertedSlug: 'Custom/Converted 中文',
      expectedPath: 'Original Note.md', expected: 'Custom/Converted 中文' },
  ]) {
    const uploaded = [];
    const destination = `src/content/posts/${sample.expectedPath}`;
    const prop = { owner: 'fixture', repo: 'blog', branch: 'main', path: sample.override
      ? { override: `src/content/posts/${sample.override}` }
      : sample.folderNote ? { type: 'yaml', rootFolder: 'src/content/posts' }
        : { type: 'fixed', defaultName: 'src/content/posts' } };
    const file = { path: `PRIVATE_VAULT_CANARY/${sample.name}.md`, name: `${sample.name}.md`,
      basename: sample.name, extension: 'md' };
    const settings = { publishing: { enabled: true }, plugin: { shareKey: 'share' }, upload: {
      folderNote: { enable: !!sample.folderNote, rename: 'index.md' }, rootFolder: 'src/content/posts',
      frontmatterTitle: { enable: !!sample.rename, key: 'publishName' },
      replaceTitle: sample.rename ? [{ regex: 'Output', replacement: 'Renamed' }] : [],
      replacePath: [], behavior: sample.folderNote ? 'yaml' : 'fixed',
    } };
    const plugin = { settings, app: { vault: {}, metadataCache: {} }, console: { trace() {} } };
    const metadata = { share: true, ...sample.metadata };
    const parseHelpers = { frontmatterFromFile: () => metadata, getProperties: () => prop,
      mergeFrontmatter: value => value, getFrontmatterSettings: () => ({}), frontmatterSettingsRepository: () => ({}),
      getCategory: value => value.category || '' };
    const merge = { withOptions: (options, ...values) => Object.assign({}, ...values) };
    const paths = load('src/conversion/file_path.ts', {
      '@interfaces': { FolderSettings: { Yaml: 'yaml', Fixed: 'fixed', Obsidian: 'obsidian' }, FIND_REGEX: /^\/.*\/$/ },
      obsidian: { normalizePath: path => path.replace(/\/+/g, '/'), TFolder: class {} },
      'src/conversion/find_and_replace_text': { createRegexFromText: value => new RegExp(value.slice(1, -1)) },
      'src/utils/data_validation_test': { isShared: () => true },
      'src/utils/parse_frontmatter': parseHelpers, 'ts-deepmerge': { merge }, './links': { escapeRegex: value => value },
    });
    const converted = yamlNote({ title: 'Final converted title', ...(sample.convertedSlug ? { slug: sample.convertedSlug } : {}) });
    const Publisher = load('src/GitHub/upload.ts', {
      obsidian: { parseYaml: JSON.parse, Notice: class {} }, i18next: {}, 'js-base64': {},
      'src/conversion': { mainConverting: async () => converted },
      'src/conversion/compiler/excalidraw': {}, 'src/conversion/file_path': paths, 'src/GitHub/delete': {},
      'src/GitHub/files': { FilesManagement: class {
        async wasEditedSinceLastSync() { return true; }
        getSharedEmbed() { return []; }
        async getMetadataLinks() { return []; }
        getLinkedByEmbedding() { return []; }
      } },
      'src/publishing/preflight': { assertProtectionPreserved() {} },
      'src/publishing/preflight-source': { checkPublicationSource: async () => ({ source: yamlNote(metadata), protection: {} }) },
      'src/utils/data_validation_test': { isShared: () => true, checkIfRepoIsInAnother: () => true, checkEmptyConfiguration: async () => true },
      'src/utils/parse_frontmatter': parseHelpers, 'src/utils/status_bar': {}, 'ts-deepmerge': { merge }, '../utils/logs': {},
    }).default;
    const publisher = new Publisher({}, plugin);
    publisher.uploadOnMultipleRepo = async (file, text, path) => {
      uploaded.push({ text, path });
      return { deleted: {}, uploaded: [], error: [] };
    };
    const result = await publisher.publish(file, false, { repository: null, frontmatter: prop }, [], false, undefined);
    assert.equal(uploaded.length, 1);
    assert.equal(uploaded[0].path, destination);
    assert.equal(uploaded[0].text, converted);
    assert.equal(result.publicationIdentity.slug, sample.expected);
    assert.equal(result.publicationIdentity.title, 'Final converted title');
    assert(!JSON.stringify(result.publicationIdentity).includes('PRIVATE_VAULT_CANARY'));
  }
});

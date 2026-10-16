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
const { shieldNativeWikilinks } = load('src/publishing/native-wikilinks.ts');
function occurrences(source, selected) {
  return [...source.matchAll(/!?\[\[[^\]\r\n]*\]\]/g)].filter(match => !selected || selected.includes(match.index))
    .map(match => ({ original: match[0], start: match.index, end: match.index + match[0].length,
      kind: match[0].startsWith('!') ? 'embed' : 'link' }));
}
function convert(source, resolve, selected) {
  const shield = shieldNativeWikilinks(source, occurrences(source, selected), resolve, link => link.endsWith('.png'));
  // Deliberately destructive old converter proves note links and code survive.
  return shield.restore(shield.text.replace(/!?\[\[[^\]]*\]\]/g, '[legacy attachment](assets/image.png)'));
}

test('native links retain label aliases and exact Unicode headings while mapping published destinations', () => {
  const result = convert('[[Note]] [[Note|My alias]] [[Note#中文 标题|Read]] [[Note#中文 标题]]',
    () => ({ id: 'folder/published-file.md' }));
  assert.equal(result, '[[folder/published-file.md\\|Note]] [[folder/published-file.md\\|My alias]] [[folder/published-file.md#中文 标题\\|Read]] [[folder/published-file.md#中文 标题\\|Note > 中文 标题]]');
});

test('unpublished and missing links retain only their original spelling for later site resolution', () => {
  const source = '[[Unpublished]] [[Private/Note|Written alias]] [[Missing#Heading]]';
  assert.equal(convert(source, () => undefined), source);
});

test('locked public target keeps a password-page link without a private heading anchor', () => {
  assert.equal(convert('[[Protected#Written heading|Read]]', () => ({ id: 'protected', encrypted: true })), '[[protected\\|Read]]');
});

test('Obsidian cache locations preserve code, HTML, frontmatter and escaped examples byte for byte', () => {
  const source = '---\nexample: "[[Example]]"\n---\n```md\n[[Example]]\n```\n~~~\n[[Example]]\n~~~\n`[[Example]]`\n<div>[[Example]]</div>\n\\[[Example]]\n[[Real]]';
  const index = source.lastIndexOf('[[Real]]');
  const output = convert(source, () => ({ id: 'public.md' }), [index]);
  assert.equal(output, source.slice(0, index) + '[[public.md\\|Real]]');
});

test('note embeds remain literal and attachments stay on the legacy path pipeline', () => {
  assert.equal(convert('![[Note]] ![[image.png]] [[image.png]]', () => ({ id: 'public.md' })),
    '![[Note]] [legacy attachment](assets/image.png) [legacy attachment](assets/image.png)');
});

test('partial encryption markers and source line breaks survive native conversion', () => {
  const source = '<!-- encrypt:fixture -->\r\n[[Public|Private label]]\r\n<!-- /encrypt -->\r\n';
  assert.equal(convert(source, () => ({ id: 'public.md' })), '<!-- encrypt:fixture -->\r\n[[public.md\\|Private label]]\r\n<!-- /encrypt -->\r\n');
});

test('a table-escaped alias is read correctly and target metadata cannot inject wikilink syntax', () => {
  assert.equal(convert('[[Note\\|Alias]]', () => ({ id: 'public.md' })), '[[public.md\\|Alias]]');
  assert.equal(convert('[[Note]]', () => ({ id: 'bad|PRIVATE_METADATA_CANARY' })), '[[Note]]');
});

test('text replacements that destroy or duplicate a protected link stop the upload with original line', () => {
  const source = 'First\n\n[[Note]]';
  const shield = shieldNativeWikilinks(source, occurrences(source), () => ({ id: 'public.md' }), () => false);
  for (const text of ['', shield.text + shield.text]) assert.throws(() => shield.restore(text), error => error.line === 3);
});

test('stale cache offsets never rewrite a different source occurrence', () => {
  const source = 'prefix [[Note]]';
  const shield = shieldNativeWikilinks(source, [{ original: '[[Other]]', start: 7, end: 16, kind: 'link' }],
    () => { throw new Error('Must not use stale cache'); }, () => false);
  assert.equal(shield.restore(shield.text), source);
});

test('native adapter exports only shared same-repository public paths or explicit slugs', () => {
  const source = '[[Public]] [[Locked#Heading]] [[Private]] [[Draft]] [[OtherRepo]] [[Outside]]';
  const notes = Object.fromEntries(['Public', 'Locked', 'Private', 'Draft', 'OtherRepo', 'Outside'].map(name =>
    [name, { path: `PrivateVaultFolder/${name}.md`, name: name + '.md', extension: 'md', basename: name }]));
  const meta = { Public: { share: true }, Locked: { share: true, encrypted: true, slug: 'locked-id' },
    Private: { share: false, title: 'PRIVATE_METADATA_CANARY' }, Draft: { share: true, draft: true },
    OtherRepo: { share: true, other: true }, Outside: { share: true } };
  const cache = { links: occurrences(source).map(link => ({ original: link.original,
    position: { start: { offset: link.start }, end: { offset: link.end } } })) };
  const plugin = { settings: {}, app: { metadataCache: { getFileCache: () => cache,
    getFirstLinkpathDest: name => notes[name] } } };
  const { prepareNativeWikilinks } = load('src/publishing/native-source.ts', {
    obsidian: {},
    'src/conversion/file_path': { getReceiptFolder: file => file.basename === 'Outside' ? 'docs/Outside.md' : `src/content/posts/published/${file.basename}.md` },
    'src/utils/data_validation_test': { isShared: fm => fm.share, checkIfRepoIsInAnother: (source, target) => !target.other },
    'src/utils/parse_frontmatter': { frontmatterFromFile: file => meta[file.basename], getProperties: (plugin, repo, fm) => fm },
  });
  const shield = prepareNativeWikilinks(source, { path: 'Source.md' }, { plugin, repository: null, frontmatter: { prop: {} } });
  const output = shield.restore(shield.text);
  assert.equal(output, '[[published/Public.md\\|Public]] [[locked-id\\|Locked > Heading]] [[Private]] [[Draft]] [[OtherRepo]] [[Outside]]');
  assert(!output.includes('PRIVATE_METADATA_CANARY') && !output.includes('PrivateVaultFolder'));
});

const yaml = {
  parseYaml: JSON.parse,
  stringifyYaml: value => JSON.stringify(value) + '\n',
  getFrontMatterInfo: source => {
    const match = source.match(/^---\n([\s\S]*?)\n---\n/);
    return match ? { exists: true, frontmatter: match[1], contentStart: match[0].length, from: 4 }
      : { exists: false, frontmatter: '', contentStart: 0, from: 0 };
  },
};
const yamlNote = (data, body = 'Public body') => `---\n${JSON.stringify(data)}\n---\n${body}`;
const adapterMocks = {
  obsidian: yaml,
  'src/conversion/file_path': { getReceiptFolder: () => 'src/content/posts/renamed.md' },
  'src/utils/data_validation_test': { isShared: fm => fm.share, checkIfRepoIsInAnother: () => true },
  'src/utils/parse_frontmatter': { frontmatterFromFile: () => ({ share: true }), getProperties: () => ({}) },
};
const adapter = load('src/publishing/native-source.ts', adapterMocks);

test('published identity keeps existing aliases and adds only the selected note basename once', () => {
  for (const aliases of [undefined, 'An existing alias', ['One', 'Two']]) {
    const output = adapter.addPublishedIdentity(yamlNote({ title: 'Public title', aliases }), 'Original note name');
    const data = JSON.parse(yaml.getFrontMatterInfo(output).frontmatter);
    assert.deepEqual(data.aliases, [...(aliases === undefined ? [] : Array.isArray(aliases) ? aliases : [aliases]), 'Original note name']);
    assert.equal(adapter.addPublishedIdentity(output, 'Original note name'), output);
    assert.equal(output.slice(yaml.getFrontMatterInfo(output).contentStart), 'Public body');
  }
  assert.throws(() => adapter.addPublishedIdentity(yamlNote({ aliases: ['valid', 7] }), 'Note'), /aliases/);
});

test('full conversion shields native links before legacy conversion and restores them after hard breaks', async () => {
  const source = yamlNote({ title: 'Public title', passwordKey: 'fixture' },
    '[[Target|Shown]]\n\n<!-- encrypt:fixture -->\n[[Target#中文标题]]\n<!-- /encrypt -->\n~~~\n[[Target]]\n~~~\n![[Private note]]');
  const selected = occurrences(source).filter(item => !source.slice(0, item.start).endsWith('~~~\n'));
  const file = { path: 'Private folder/Source.md', basename: 'Source', name: 'Source.md', extension: 'md' };
  const target = { path: 'Private folder/Target.md', name: 'Target.md', basename: 'Target', extension: 'md' };
  let bakes = 0;
  let redact = false;
  const plugin = { settings: { publishing: { enabled: true }, conversion: { tags: { inline: false }, censorText: [] },
    upload: { folderNote: { addTitle: false } } }, app: { metadataCache: {
      getFileCache: () => ({ links: selected.filter(item => item.kind === 'link').map(item => ({ original: item.original,
        position: { start: { offset: item.start }, end: { offset: item.end } } })), embeds: [] }),
      getFirstLinkpathDest: name => name === 'Target' ? target : undefined,
    } }, console: { error: error => { throw error; } } };
  const legacy = text => text.replace(/!?\[\[[^\]]*\]\]/g, '[legacy](legacy.md)');
  const converter = load('src/conversion/index.ts', {
    obsidian: yaml, i18next: { t: key => key },
    'src/conversion/compiler/dataview': { convertDataviewQueries: async text => text },
    'src/conversion/compiler/embeds': { bakeEmbeds: async () => { bakes++; return source; }, convertInlineDataview: async text => text },
    'src/conversion/links': { convertToInternalGithub: async text => legacy(text), convertWikilinks: legacy },
    'src/utils/data_validation_test': { isFolderNote: () => false },
    'src/publishing/native-source': adapter,
    './find_and_replace_text': (text, plugin, after) => !redact ? text : after
      ? text.replaceAll('中文标题', 'SAFE_HEADING').replaceAll('Source', 'SAFE_NAME')
      : text.replaceAll('[[Target|Shown]]', 'SAFE_LABEL'),
  });
  const properties = { plugin, repository: null, filepath: 'src/content/posts/source.md',
    frontmatter: { prop: {}, general: { removeEmbed: 'bake', hardbreak: true } } };
  const output = await converter.mainConverting(source, file, {}, [], properties);
  assert.equal(bakes, 0, 'Blog conversion must not transclude another note body');
  assert(output.includes('[[renamed.md\\|Shown]]'));
  assert(output.includes('[[renamed.md#中文标题\\|Target > 中文标题]]'));
  assert(output.includes('<!-- encrypt:fixture -->  \n'));
  assert(output.includes('~~~  \n[[Target]]  \n~~~'));
  assert(output.includes('![[Private note]]'));
  assert(!output.includes('Private folder'));
  assert.deepEqual(JSON.parse(yaml.getFrontMatterInfo(output).frontmatter).aliases, ['Source']);

  redact = true;
  const redacted = await converter.mainConverting(source, file, {}, [], properties);
  assert(redacted.includes('SAFE_LABEL') && redacted.includes('SAFE_HEADING'));
  assert(!redacted.includes('Shown') && !redacted.includes('中文标题'));
  assert.deepEqual(JSON.parse(yaml.getFrontMatterInfo(redacted).frontmatter).aliases, ['SAFE_NAME']);
  redact = false;

  // Both independent scope switches preserve the established non-blog pipeline.
  for (const [enabled, path] of [[false, 'src/content/posts/source.md'], [true, 'docs/source.md']]) {
    plugin.settings.publishing.enabled = enabled; properties.filepath = path;
    const legacyOutput = await converter.mainConverting(source, file, {}, [], properties);
    assert(legacyOutput.includes('[legacy](legacy.md)'));
    assert.equal(JSON.parse(yaml.getFrontMatterInfo(legacyOutput).frontmatter).aliases, undefined);
  }
  assert.equal(bakes, 2);
});

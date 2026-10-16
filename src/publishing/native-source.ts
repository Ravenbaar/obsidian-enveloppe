import type { MultiProperties } from '@interfaces';
import { getFrontMatterInfo, parseYaml, stringifyYaml, type TFile } from 'obsidian';
import { getReceiptFolder } from 'src/conversion/file_path';
import { checkIfRepoIsInAnother, isShared } from 'src/utils/data_validation_test';
import { frontmatterFromFile, getProperties } from 'src/utils/parse_frontmatter';
import { isPublishingArticle, PublicationPreflightError } from './preflight';
import { shieldNativeWikilinks, type NativeOccurrence } from './native-wikilinks';

export function prepareNativeWikilinks(source: string, file: TFile, properties: MultiProperties) {
  const { plugin, repository } = properties;
  const metadata = plugin.app.metadataCache;
  const cache = metadata.getFileCache(file);
  const occurrences: NativeOccurrence[] = [
    ...(cache?.links || []).map(link => ({ original: link.original, start: link.position.start.offset,
      end: link.position.end.offset, kind: 'link' as const })),
    ...(cache?.embeds || []).map(link => ({ original: link.original, start: link.position.start.offset,
      end: link.position.end.offset, kind: 'embed' as const })),
  ];
  const destination = (linkpath: string) => linkpath ? metadata.getFirstLinkpathDest(linkpath, file.path) : file;
  return shieldNativeWikilinks(source, occurrences, linkpath => {
    const target = destination(linkpath);
    if (!target || target.extension !== 'md' || target.name.endsWith('.excalidraw.md')) return;
    const frontmatter = frontmatterFromFile(target, plugin, repository);
    if (!isShared(frontmatter, plugin.settings, target, repository) || frontmatter?.draft === true) return;
    const targetProperties = getProperties(plugin, repository, frontmatter);
    if (!checkIfRepoIsInAnother(properties.frontmatter.prop, targetProperties)) return;
    const publishedPath = getReceiptFolder(target, repository, plugin, targetProperties);
    if (!isPublishingArticle(true, publishedPath)) return;
    const id = typeof frontmatter?.slug === 'string' && frontmatter.slug
      ? frontmatter.slug : publishedPath.slice('src/content/posts/'.length);
    return { id, encrypted: frontmatter?.encrypted === true };
  }, linkpath => {
    const target = destination(linkpath);
    return !!target && (target.extension !== 'md' || target.name.endsWith('.excalidraw.md'));
  });
}

/** Only this selected public note's basename, never its vault folder or a vault map. */
export function addPublishedIdentity(source: string, basename: string): string {
  if (!basename.trim()) return source;
  const info = getFrontMatterInfo(source);
  let metadata: Record<string, unknown>;
  try {
    const parsed = info.exists ? (parseYaml(info.frontmatter) || {}) : {};
    if (typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    metadata = parsed as Record<string, unknown>;
  }
  catch { throw new PublicationPreflightError(1, '转换后的 YAML 属性格式无效，原稿未上传。'); }
  const current = metadata.aliases;
  const aliases = current === undefined ? [] : typeof current === 'string' ? [current] : current;
  if (!Array.isArray(aliases) || aliases.some(alias => typeof alias !== 'string')) {
    throw new PublicationPreflightError(1, 'aliases 必须填写文本或文本列表，原稿未上传。');
  }
  if (aliases.includes(basename)) return source;
  metadata.aliases = [...aliases, basename];
  return `---\n${stringifyYaml(metadata)}---\n${info.exists ? source.slice(info.contentStart) : source}`;
}

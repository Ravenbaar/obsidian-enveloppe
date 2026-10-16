import { regex as githubSlugCharacters } from './github-slugger-regex';

const ARTICLE_ROOT = 'src/content/posts/';

/** A repository destination only. Never pass a vault path as this value. */
export function publishedSourcePath(destination: string): string | undefined {
  if (!destination.startsWith(ARTICLE_ROOT) || !/\.mdx?$/.test(destination)
    || /[\\\u0000-\u001f\u007f]/.test(destination)) return;
  const relative = destination.slice(ARTICLE_ROOT.length);
  if (relative.split('/').some(segment => !segment || segment === '.' || segment === '..')) return;
  return relative;
}

/** Match Astro's glob() default ID: explicit slug, otherwise GitHub-slugged path. */
export function publishedArticleId(destination: string, explicitSlug?: unknown): string | undefined {
  const sourcePath = publishedSourcePath(destination);
  if (!sourcePath) return;
  if (explicitSlug) return typeof explicitSlug === 'string' && explicitSlug.trim() ? explicitSlug : undefined;
  // Astro first uses new URL(encodeURI(entry), base). Raw ? and # therefore
  // delimit the pathname before extension stripping; explicit slugs bypass it.
  if (/^[a-z][a-z\d+.-]*:/i.test(sourcePath)) return;
  let pathname = sourcePath.split(/[?#]/, 1)[0].replace(/\/+$/, '');
  const extension = pathname.lastIndexOf('.');
  if (extension > pathname.lastIndexOf('/') + 1) pathname = pathname.slice(0, extension);
  return pathname.split('/')
    .map(segment => segment.toLowerCase().replace(githubSlugCharacters, '').replace(/ /g, '-'))
    .join('/').replace(/\/index$/, '') || undefined;
}

export interface PublishedIdentity {
  slug: string;
  title: string;
}

/** Read only the final upload bytes, after all frontmatter/text conversions. */
export function publishedIdentityFromSource(source: string, destination: string,
  parseYaml: (text: string) => unknown): PublishedIdentity | undefined {
  const sourcePath = publishedSourcePath(destination);
  if (!sourcePath) return;
  const frontmatter = source.replace(/^\uFEFF/, '').match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  let metadata: Record<string, unknown> = {};
  if (frontmatter) {
    try {
      const parsed = parseYaml(frontmatter[1]) || {};
      if (typeof parsed !== 'object' || Array.isArray(parsed)) return;
      metadata = parsed as Record<string, unknown>;
    } catch { return; }
  }
  const slug = publishedArticleId(destination, metadata.slug);
  if (!slug) return;
  return { slug, title: typeof metadata.title === 'string' && metadata.title.trim()
    ? metadata.title : sourcePath.split('/').pop()!.replace(/\.mdx?$/, '') };
}

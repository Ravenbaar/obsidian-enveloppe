import { PublicationPreflightError } from './preflight';

export interface NativeOccurrence {
  original: string;
  start: number;
  end: number;
  kind: 'link' | 'embed';
}
export interface NativeTarget {
  /** A public ID or published path relative to src/content/posts. Never a vault path. */
  id: string;
  encrypted?: boolean;
}

/**
 * Use Obsidian's parsed link locations, rather than guessing Markdown contexts.
 * Every other wiki spelling (YAML, fenced/inline code, HTML, escaped examples and
 * note embeds) is shielded unchanged from the legacy regex converters as well.
 */
export function shieldNativeWikilinks(source: string, occurrences: NativeOccurrence[],
  resolve: (linkpath: string) => NativeTarget | undefined,
  isAttachment: (linkpath: string) => boolean) {
  let prefix = '\uE000ENVELOPPE_NATIVE_';
  while (source.includes(prefix)) prefix += '_';
  const saved: { token: string; replacement: string; line: number }[] = [];
  const byOffset = new Map(occurrences.map(item => [item.start, item]));
  const text = source.replace(/!?\[\[([^\]\r\n]*)\]\]/g, (original: string, inside: string, offset: number) => {
    const occurrence = byOffset.get(offset);
    const active = occurrence?.original === original && occurrence.end === offset + original.length;
    const divider = inside.search(/\\?\|/);
    const destination = (divider < 0 ? inside : inside.slice(0, divider)).trim();
    const alias = divider < 0 ? undefined : inside.slice(divider).replace(/^\\?\|/, '');
    const hash = destination.indexOf('#');
    const linkpath = hash < 0 ? destination : destination.slice(0, hash);
    const anchor = hash < 0 ? '' : destination.slice(hash);
    if (active && isAttachment(linkpath)) return original;
    let replacement = original;
    if (active && occurrence.kind === 'link' && !original.startsWith('!')) {
      const target = resolve(linkpath);
      const originalLabel = alias ?? (linkpath.split('/').pop()?.replace(/\.md$/i, '') || '')
        + (anchor ? `${linkpath ? ' > ' : ''}${anchor.slice(1)}` : '');
      if (target && target.id && !/[\[\]|#\r\n\u0000-\u001f]/.test(target.id)) {
        // Headings in a wholly locked article must never become public anchors.
        const heading = target.encrypted ? '' : anchor;
        const label = originalLabel.replace(/\|/g, '&#124;');
        // A raw pipe would split a GFM table cell before the blog wiki plugin.
        // Escaping works for newly introduced aliases in paragraphs and tables.
        replacement = `[[${target.id}${heading}\\|${label}]]`;
      }
      // Keep only the author-written spelling for an unpublished/missing target.
      // The website renders an unresolved label today and can resolve it after
      // that article is published, without re-uploading the source note.
    }
    const token = `${prefix}${saved.length}\uE001`;
    saved.push({ token, replacement, line: source.slice(0, offset).split('\n').length });
    return token;
  });
  return {
    text,
    restore(converted: string) {
      for (const { token, replacement, line } of saved) {
        if (converted.split(token).length !== 2) {
          throw new PublicationPreflightError(line, '文本转换改变了双链占位内容，请检查文本替换设置后再发布。');
        }
        converted = converted.replace(token, () => replacement);
      }
      return converted;
    },
  };
}

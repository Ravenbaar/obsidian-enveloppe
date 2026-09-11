export const STATE_PATH = '.publishing/article-state.json';
export const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/i;
export type ArticleAction = 'hide' | 'restore' | 'delete';
export interface ArticleEntry { state: 'hidden' | 'deleted'; title: string; blob: string }
export interface ArticleState { version: 1; articles: Record<string, ArticleEntry> }
export interface ManagedArticle {
  slug: string; title: string; blob: string; exists: boolean; draft: boolean;
  desired: 'published' | 'hidden' | 'deleted'; status: string; url?: string;
}
export interface PendingManagement {
  owner: string; repo: string; base: string; branch: string; head: string;
  action: ArticleAction; slug: string; source: string; title: string; startedAt: string;
}
export function parseArticleState(text: string): ArticleState {
  const value = JSON.parse(text);
  if (value?.version !== 1 || !value.articles || Array.isArray(value.articles)
    || Object.keys(value).sort().join() !== 'articles,version') throw new Error('文章管理格式不兼容。');
  const names = Object.keys(value.articles);
  if (new Set(names.map(name => name.toLowerCase())).size !== names.length) throw new Error('文章标识大小写冲突。');
  for (const [slug, entry] of Object.entries(value.articles) as [string, ArticleEntry][]) {
    if (!SLUG.test(slug) || !entry || !['hidden', 'deleted'].includes(entry.state)
      || typeof entry.title !== 'string' || !entry.title.trim() || entry.title.length > 300
      || !/^[a-f0-9]{40}$/.test(entry.blob) || Object.keys(entry).sort().join() !== 'blob,state,title') {
      throw new Error('文章管理记录无效。');
    }
  }
  return value;
}

export function nextArticleState(state: ArticleState, article: ManagedArticle, action: ArticleAction): ArticleState {
  if (!SLUG.test(article.slug) || !/^[a-f0-9]{40}$/.test(article.blob)) throw new Error('无效文章。');
  const next = parseArticleState(JSON.stringify(state));
  if (action === 'restore') {
    if (!next.articles[article.slug]) throw new Error('草稿请修改原稿 draft 属性后重新发布。');
    if (article.draft) throw new Error('请先把原稿 draft 改为 false 并上传，再恢复公开。');
    delete next.articles[article.slug];
  } else {
    if (!article.exists) throw new Error('文章已经删除。');
    next.articles[article.slug] = { state: action === 'hide' ? 'hidden' : 'deleted', title: article.title, blob: article.blob };
  }
  return parseArticleState(JSON.stringify(next));
}

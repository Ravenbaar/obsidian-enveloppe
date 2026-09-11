import { Modal, parseYaml, requestUrl, Setting } from 'obsidian';
import { Base64 } from 'js-base64';
import type { PublicationCenter } from './center';
import { findPublishedArticle, publicSite, type PullRequest } from './model';
import { nextArticleState, parseArticleState, SLUG, STATE_PATH,
  type ArticleAction, type ArticleState, type ManagedArticle } from './management-model';

type TreeEntry = { path: string; sha: string; type: string; mode: string };
interface Snapshot { head: string; tree: string; state: ArticleState; rows: ManagedArticle[] }
const labels = { hide: '隐藏', restore: '恢复公开', delete: '删除线上文章' };

export class ArticleManager {
  modal?: ArticleManagerModal;
  rows: ManagedArticle[] = [];
  busy = false;
  message = '读取网站仓库和公开状态，不扫描 Obsidian 笔记库。';
  constructor(readonly center: PublicationCenter) {
    center.plugin.addCommand({ id: 'article-manager', name: '文章管理：查看已发布、隐藏和删除', callback: () => this.open() });
    center.plugin.register(() => this.modal?.close());
  }
  get context() {
    const github = this.center.plugin.settings.github;
    return { owner: github.user, repo: github.repo, base: github.branch };
  }
  open() { if (!this.modal) { this.modal = new ArticleManagerModal(this); this.modal.open(); } }
  async api<T>(method: string, path: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.center.api(this.context, method, path, params);
  }
  async snapshot(): Promise<Snapshot> {
    const ref = await this.api<{ object: { sha: string } }>('GET', `git/ref/heads/${encodeURIComponent(this.context.base)}`);
    const head = ref.object.sha;
    const commit = await this.api<{ tree: { sha: string } }>('GET', `git/commits/${head}`);
    const tree = await this.api<{ truncated: boolean; tree: TreeEntry[] }>('GET', `git/trees/${commit.tree.sha}`, { recursive: '1' });
    if (tree.truncated) throw new Error('仓库列表不完整，已停止操作。');
    const stateFile = tree.tree.find(entry => entry.path === STATE_PATH);
    if (!stateFile || stateFile.type !== 'blob' || stateFile.mode !== '100644') throw new Error('网站尚未配置文章管理，请先更新网站工作流。');
    const readBlob = async (sha: string) => {
      const blob = await this.api<{ encoding: string; content: string; size: number }>('GET', `git/blobs/${sha}`);
      if (blob.encoding !== 'base64' || blob.size > 4 * 1024 * 1024) throw new Error('文章或管理文件过大，已停止读取。');
      return Base64.decode(blob.content);
    };
    const state = parseArticleState(await readBlob(stateFile.sha));
    const files = tree.tree.filter(entry => /^src\/content\/posts\/[^/]+\.md$/i.test(entry.path));
    if (files.length > 200) throw new Error('当前管理面板最多支持200篇文章，请拆分管理后再使用。');
    const rows: ManagedArticle[] = [];
    for (const file of files) {
      const slug = file.path.slice('src/content/posts/'.length, -3);
      if (!SLUG.test(slug) || file.mode !== '100644' || file.type !== 'blob') continue;
      const text = await readBlob(file.sha);
      const frontmatter = text.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1];
      const parsed = frontmatter ? parseYaml(frontmatter) : {};
      const metadata = (parsed && typeof parsed === 'object' ? parsed : {}) as Record<string, unknown>;
      const title = typeof metadata?.title === 'string' ? metadata.title : slug;
      const saved = state.articles[slug];
      rows.push({ slug, title, blob: file.sha, exists: true, draft: metadata?.draft === true,
        desired: saved?.state || (metadata?.draft === true ? 'hidden' : 'published'), status: '待核验' });
    }
    for (const [slug, entry] of Object.entries(state.articles)) {
      if (!rows.some(row => row.slug === slug)) rows.push({ slug, title: entry.title, blob: entry.blob,
        exists: false, draft: false, desired: entry.state, status: '待核验' });
    }
    return { head, tree: commit.tree.sha, state, rows };
  }
  async refresh() {
    if (this.busy) return;
    this.busy = true; this.modal?.render();
    try {
      const snapshot = await this.snapshot();
      this.rows = snapshot.rows;
      const site = publicSite(this.center.config.siteUrl);
      const release = await requestUrl({ url: new URL(`release.json?manage=${Date.now()}`, site).href });
      const deployedSha = release.json.source_sha;
      if (!/^[a-f0-9]{40}$/.test(deployedSha)) throw new Error('网站未返回可核验的发布版本。');
      const published = await requestUrl({ url: new URL(`search-index.json?manage=${Date.now()}`, site).href });
      let deployedState: ArticleState = { version: 1, articles: {} };
      try {
        const data = await this.api<{ content: string }>('GET', `contents/${STATE_PATH}`, { ref: deployedSha });
        deployedState = parseArticleState(Base64.decode(data.content));
      } catch (error) { if ((error as { status?: number }).status !== 404) throw error; }
      for (const row of this.rows) {
        const url = findPublishedArticle(published.json, row.slug, site);
        row.url = url;
        if (row.desired === 'published') row.status = url ? '已发布' : '处理中：等待上线';
        else if (url) row.status = '处理中：等待下架';
        else if (deployedState.articles[row.slug]?.state === row.desired || row.draft) {
          row.status = row.desired === 'deleted' ? '已删除' : row.draft ? '已隐藏（草稿）' : '已隐藏';
        } else row.status = '处理中：等待部署';
      }
      this.message = `共 ${this.rows.length} 篇。状态来自网站仓库和当前公开版本。`;
    } catch (error) { this.message = this.errorMessage(error); }
    finally { this.busy = false; this.modal?.render(); }
  }
  errorMessage(error: unknown): string {
    const status = (error as { status?: number }).status;
    if (status === 401 || status === 403) return '权限不足：请检查原Token的Contents、Pull requests和Actions读写权限。';
    // API error bodies can contain repository content. Never display them.
    return status ? `GitHub请求未完成（${status}），请刷新或重试；原稿不受影响。`
      : error instanceof Error && !error.message.includes('fetch') ? error.message : '暂时无法读取网站，请稍后重试。';
  }
  async submit(selected: ManagedArticle, action: ArticleAction) {
    if (this.busy || this.center.config.managementPending) return;
    this.busy = true; this.modal?.render();
    try {
      const snapshot = await this.snapshot();
      const current = snapshot.rows.find(row => row.slug === selected.slug);
      if (!current || current.blob !== selected.blob || current.desired !== selected.desired || current.exists !== selected.exists) {
        throw new Error('文章已变化，请刷新列表后重新选择。');
      }
      const next = nextArticleState(snapshot.state, current, action);
      const stateBlob = await this.api<{ sha: string }>('POST', 'git/blobs', { content: JSON.stringify(next, null, 2) + '\n', encoding: 'utf-8' });
      const entries: { path: string; mode: string; type: string; sha: string | null }[] = [
        { path: STATE_PATH, mode: '100644', type: 'blob', sha: stateBlob.sha },
      ];
      if (action === 'delete' || (action === 'restore' && !current.exists)) entries.push({
        path: `src/content/posts/${current.slug}.md`, mode: '100644', type: 'blob', sha: action === 'delete' ? null : current.blob,
      });
      const tree = await this.api<{ sha: string }>('POST', 'git/trees', { base_tree: snapshot.tree, tree: entries });
      const commit = await this.api<{ sha: string }>('POST', 'git/commits', {
        message: `feat(content): ${action} ${current.slug}`, tree: tree.sha, parents: [snapshot.head],
      });
      const suffix = Array.from(crypto.getRandomValues(new Uint8Array(8))).map(n => n.toString(16).padStart(2, '0')).join('');
      this.center.config.managementPending = { ...this.context, branch: `enveloppe-manage-${action}-${suffix}`,
        head: commit.sha, action, slug: current.slug, source: current.blob, title: current.title, startedAt: new Date().toISOString() };
      await this.center.plugin.saveSettings();
      await this.finishPending();
    } catch (error) { this.message = this.errorMessage(error); }
    finally { this.busy = false; this.modal?.render(); }
  }
  async resume() {
    if (this.busy) return;
    this.busy = true; this.modal?.render();
    try { await this.finishPending(); } catch (error) { this.message = this.errorMessage(error); }
    finally { this.busy = false; this.modal?.render(); }
  }
  private async finishPending() {
    const pending = this.center.config.managementPending;
    if (!pending) return;
    if (pending.owner !== this.context.owner || pending.repo !== this.context.repo || pending.base !== this.context.base) {
      throw new Error('未完成操作属于另一仓库，请恢复原仓库配置后重试。');
    }
    try {
      const ref = await this.api<{ object: { sha: string } }>('GET', `git/ref/heads/${pending.branch}`);
      if (ref.object.sha !== pending.head) throw new Error('管理分支已变化，请在GitHub核对。');
    } catch (error) {
      if ((error as { status?: number }).status !== 404) throw error;
      await this.api('POST', 'git/refs', { ref: `refs/heads/${pending.branch}`, sha: pending.head });
    }
    const existing = await this.api<PullRequest[]>('GET', 'pulls', { state: 'all', head: `${pending.owner}:${pending.branch}`, base: pending.base });
    let pr = existing.find(item => item.head.sha === pending.head && item.head.ref === pending.branch
      && item.head.repo?.full_name === `${pending.owner}/${pending.repo}` && item.base.ref === pending.base);
    if (!pr) pr = await this.api<PullRequest>('POST', 'pulls', { head: pending.branch, base: pending.base,
      title: `Enveloppe: ${pending.action} ${pending.slug}`,
      body: JSON.stringify({ enveloppe: 1, action: pending.action, slug: pending.slug, source: pending.source }) });
    delete this.center.config.managementPending;
    await this.center.watch({ ...pending, number: pr.number });
    this.message = `${labels[pending.action]}申请已提交，检查通过后自动部署。`;
    this.center.setState({ stage: 'checking', detail: this.message });
    this.center.open();
  }
}

class ArticleManagerModal extends Modal {
  private filter = 'all';
  private query = '';
  constructor(readonly manager: ArticleManager) { super(manager.center.plugin.app); }
  onOpen() { this.modalEl.addClass('enveloppe-article-manager'); this.render(); void this.manager.refresh(); }
  onClose() { this.manager.modal = undefined; this.contentEl.empty(); }
  render() {
    const { contentEl: el, manager: m } = this;
    el.empty(); el.createEl('h2', { text: '文章管理' });
    el.createEl('p', { text: m.message, attr: { role: 'status' } });
    new Setting(el).setName('筛选')
      .addDropdown(input => input.addOptions({ all: '全部', published: '已发布', hidden: '已隐藏', deleted: '已删除', pending: '处理中' })
        .setValue(this.filter).onChange(value => { this.filter = value; this.render(); }))
      .addButton(button => button.setButtonText(m.busy ? '处理中…' : '刷新列表').setDisabled(m.busy).onClick(() => m.refresh()));
    if (m.center.config.managementPending) new Setting(el).setName('上次操作尚未完成提交')
      .setDesc('重试将复用同一申请，不重复创建。')
      .addButton(button => button.setButtonText('继续提交').setDisabled(m.busy).onClick(() => m.resume()));
    const search = el.createEl('input', { type: 'search', placeholder: '搜索标题或 slug', cls: 'article-manager-search' });
    search.value = this.query;
    const list = el.createDiv({ cls: 'article-manager-list' });
    const renderRows = () => {
      list.empty();
      const rows = m.rows.filter(row => `${row.title} ${row.slug}`.toLowerCase().includes(this.query.toLowerCase())
        && (this.filter === 'all' || (this.filter === 'pending' ? row.status.startsWith('处理中')
          : !row.status.startsWith('处理中') && row.desired === this.filter)));
      for (const row of rows) {
        const item = new Setting(list).setName(row.title).setDesc(`${row.slug} · ${row.status}`);
        if (row.url) item.addButton(button => button.setButtonText('打开文章').onClick(() => window.open(row.url, '_blank', 'noopener,noreferrer')));
        const disabled = m.busy || !!m.center.config.managementPending;
        if (row.desired === 'published') item.addButton(button => button.setButtonText('隐藏').setDisabled(disabled).onClick(() => m.submit(row, 'hide')));
        else if (!row.draft) item.addButton(button => button.setButtonText('恢复公开').setDisabled(disabled).onClick(() => m.submit(row, 'restore')));
        if (row.exists && row.desired !== 'deleted') item.addButton(button => button.setButtonText('删除线上文章').setDisabled(disabled)
          .onClick(() => new DeleteArticleModal(m, row).open()));
      }
      if (!rows.length) list.createEl('p', { text: '没有符合条件的文章。' });
    };
    search.oninput = () => { this.query = search.value; renderRows(); };
    renderRows();
    el.createEl('p', { text: '隐藏和删除都保留 Obsidian 原稿。隐藏后直接链接也不可访问；恢复公开会重新上线。修改正文后再次上传不会取消隐藏。' });
  }
}
class DeleteArticleModal extends Modal {
  constructor(readonly manager: ArticleManager, readonly article: ManagedArticle) { super(manager.center.plugin.app); }
  onOpen() {
    this.contentEl.createEl('h2', { text: '删除这篇线上文章？' });
    this.contentEl.createEl('p', { text: `${this.article.title}（${this.article.slug}）` });
    this.contentEl.createEl('p', { text: '只删除这篇网站文章，保留 Obsidian 原稿和共用附件。检查通过后自动部署，线上链接将无法访问。' });
    new Setting(this.contentEl).addButton(button => button.setButtonText('取消').onClick(() => this.close()))
      .addButton(button => button.setButtonText('确认删除线上文章').setWarning().onClick(() => { this.close(); void this.manager.submit(this.article, 'delete'); }));
  }
  onClose() { this.contentEl.empty(); }
}

import { Modal, requestUrl, Setting } from "obsidian";
import { Base64 } from 'js-base64';
import { ArticleManager } from './manager';
import { parseArticleState, STATE_PATH } from './management-model';
import type Enveloppe from "src/main";
import type { Properties } from "src/interfaces/main";
import type { GithubBranch } from "src/GitHub/branch";
import {
  DEFAULT_PUBLISHING, deriveState, findPublishedArticle, matchesRecord, publicSite, STAGE_LABELS,
  type ActionRun, type PublicationRecord, type PublicationState, type PublishingSettings, type PullRequest,
} from "./model";

export class PublicationCenter {
  state: PublicationState = { stage: "idle", detail: "公开文章准备好后，右键选择发布。" };
  modal?: PublicationModal;
  private busy = false;
  private epoch = 0;
  private retryUntil = 0;
  private startedAt?: string;
  private status?: HTMLElement;
  readonly articleManager: ArticleManager;

  constructor(readonly plugin: Enveloppe) {
    plugin.settings.publishing = { ...DEFAULT_PUBLISHING, ...plugin.settings.publishing };
    this.articleManager = new ArticleManager(this);
    plugin.addCommand({ id: "publication-center", name: "发布中心：查看进度与重试", callback: () => this.open() });
    plugin.addCommand({ id: "publication-settings", name: "发布中心：设置", callback: () => new PublicationSettingsModal(this).open() });
    plugin.register(() => this.modal?.close());
  }

  get config(): PublishingSettings { return this.plugin.settings.publishing!; }
  get enabled(): boolean { return this.config.enabled; }

  open() {
    if (this.modal) { this.modal.render(); return; }
    this.modal = new PublicationModal(this);
    this.modal.open();
  }

  setState(state: PublicationState) {
    this.state = state;
    if (this.enabled) {
      this.status ??= this.plugin.addStatusBarItem();
      this.status.setText(`发布：${STAGE_LABELS[state.stage]}`);
      this.status.onclick = () => this.open();
    }
    this.modal?.render();
  }

  begin(title: string) {
    if (!this.enabled) return;
    this.epoch++;
    this.startedAt = new Date().toISOString();
    this.setState({ stage: "uploading", detail: `正在上传「${title}」。` });
    this.open();
  }

  failUpload() {
    if (this.enabled && this.state.stage === "uploading") this.setState({ stage: "failed", detail: "上传未完成。请先检查插件提示或网络，再右键上传。" });
  }

  async track(manager: GithubBranch, prop: Properties, slug: string, title: string, smartKey?: string) {
    if (!this.enabled) return;
    const number = manager.publicationRequests.get(`${prop.owner}/${prop.repo}`);
    if (!number) throw new Error("Upload did not identify its pull request");
    const response = await manager.octokit.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner: prop.owner, repo: prop.repo, pull_number: number, publication_refresh: Date.now(),
    });
    const pr = response.data;
    if (pr.head.ref !== manager.branchName || pr.base.ref !== prop.branch
      || pr.head.repo?.full_name !== `${prop.owner}/${prop.repo}`) throw new Error("Unmatched upload request");
    this.config.last = { owner: prop.owner, repo: prop.repo, base: prop.branch, branch: pr.head.ref,
      head: pr.head.sha, number, slug, title, smartKey, startedAt: this.startedAt };
    this.epoch++;
    await this.plugin.saveSettings();
    this.setState({ stage: "checking", detail: "上传成功。云端会检查、合并并部署，正在读取进度。" });
    await this.refresh();
  }

  async watch(record: PublicationRecord) {
    this.epoch++;
    this.config.last = record;
    await this.plugin.saveSettings();
    this.setState({ stage: 'checking', detail: '申请已提交，检查通过后自动部署。' });
    this.open();
  }

  async api<T>(record: Pick<PublicationRecord, 'owner' | 'repo' | 'smartKey'>, method: string, path: string, params: Record<string, unknown> = {}): Promise<T> {
    if (!/^[\w.-]+$/.test(record.owner) || !/^[\w.-]+$/.test(record.repo)) throw new Error("Invalid repository");
    const manager = await this.plugin.reloadOctokit(record.smartKey);
    const response = await manager.octokit.request(`${method} /repos/{owner}/{repo}/${path}`, {
      owner: record.owner, repo: record.repo, ...params,
      ...(method === "GET" ? { publication_refresh: Date.now() } : {}),
    });
    return response.data as T;
  }

  async refresh() {
    const record = this.config.last;
    if (this.busy || !record || this.state.stage === "uploading" || Date.now() < this.retryUntil) return;
    const epoch = this.epoch;
    this.busy = true;
    try {
      const pr = await this.api<PullRequest>(record, "GET", `pulls/${record.number}`);
      if (record.syncBase) {
        if (pr.head.sha === record.head) {
          if (epoch === this.epoch) this.setState({ stage: "checking", detail: "正在同步网站最新版本，随后自动重新检查。" });
          return;
        }
        const commit = await this.api<{ parents: { sha: string }[] }>(record, "GET", `git/commits/${pr.head.sha}`);
        const expected = { ...record, head: pr.head.sha };
        if (!matchesRecord(pr, expected) || commit.parents.length !== 2
          || commit.parents[0].sha !== record.head || commit.parents[1].sha !== record.syncBase) {
          throw new Error("Unexpected branch synchronization");
        }
        record.head = pr.head.sha;
        delete record.syncBase;
        await this.plugin.saveSettings();
      }
      if (!matchesRecord(pr, record)) {
        if (epoch === this.epoch) this.setState({ stage: "stale", detail: "该申请已有新的上传。请重新上传或在 GitHub 核对最新版本。" });
        return;
      }
      const runs = await this.api<{ workflow_runs: ActionRun[] }>(record, "GET", "actions/runs", {
        head_sha: pr.merged ? pr.merge_commit_sha : record.head, per_page: 100,
      });
      let automatic: ActionRun[] = [];
      if (!pr.merged) {
        automatic = (await this.api<{ workflow_runs: ActionRun[] }>(record, "GET",
          `actions/workflows/${encodeURIComponent(this.config.publishWorkflow)}/runs`, { per_page: 30 })).workflow_runs;
      }
      let state = deriveState(pr, record, runs.workflow_runs, automatic, runs.workflow_runs, this.config);
      if (pr.merged && pr.merge_commit_sha && this.config.siteUrl) {
        const site = publicSite(this.config.siteUrl);
        const release = await requestUrl({ url: new URL(`release.json?publish=${Date.now()}`, site).href, throw: false });
        const deployedSha = release.status === 200 ? (release.json as { source_sha?: string }).source_sha : undefined;
        let containsCommit = deployedSha === pr.merge_commit_sha;
        if (!containsCommit && deployedSha && /^[a-f0-9]{40}$/.test(deployedSha)) {
          const compare = await this.api<{ merge_base_commit: { sha: string } }>(record, "GET",
            `compare/${pr.merge_commit_sha}...${deployedSha}`);
          containsCommit = compare.merge_base_commit.sha === pr.merge_commit_sha;
        }
        if (containsCommit) {
          const search = await requestUrl({ url: new URL(`search-index.json?publish=${Date.now()}`, site).href, throw: false });
          const articleUrl = search.status === 200 ? findPublishedArticle(search.json, record.slug, site) : undefined;
          if (search.status !== 200) throw new Error('Search index unavailable');
          let excluded: 'hidden' | 'deleted' | undefined = record.action === 'hide' ? 'hidden' : record.action === 'delete' ? 'deleted' : undefined;
          if (!articleUrl && !record.action) {
            try {
              const data = await this.api<{ content: string }>(record, 'GET', `contents/${STATE_PATH}`, { ref: deployedSha });
              excluded = parseArticleState(Base64.decode(data.content)).articles[record.slug]?.state;
            } catch (error) { if ((error as { status?: number }).status !== 404) throw error; }
          }
          if (excluded) {
            const target = new URL(`posts/${encodeURIComponent(record.slug)}/?publish=${Date.now()}`, site);
            const page = await requestUrl({ url: target.href, throw: false });
            state = !articleUrl && [404, 410].includes(page.status)
              ? { stage: excluded, detail: excluded === 'hidden' ? '网站列表与直接链接均已下架；原稿保留，可在文章管理恢复。' : '线上文章已删除，直接链接已下架；Obsidian原稿保留。' }
              : { stage: 'verifying', detail: '正在核对下架结果，公开列表或链接尚未更新，稍后重新检查。' };
          } else state = articleUrl ? { stage: "live", detail: "已核对公开版本和文章索引。文章已经上线。", articleUrl }
            : { stage: "failed", detail: "网站版本已更新，但未找到这篇文章。请检查 draft 属性、slug 和站点生成结果。" };
        } else if (state.stage === "verifying") {
          state = { stage: "verifying", detail: "部署成功，公开站点尚未返回包含本次文章的版本；稍后自动重查。" };
        }
      } else if (state.stage === "verifying" && !this.config.siteUrl) {
        state = { stage: "verifying", detail: "部署成功。请在发布中心设置网站地址，才能核验文章并提供打开入口。" };
      }
      if (epoch === this.epoch) this.setState(state);
    } catch (error) {
      if (epoch !== this.epoch) return;
      const status = (error as { status?: number }).status;
      this.setState(status === 401 || status === 403 ? {
        stage: "permission", detail: "当前 Token 无法读取完整发布进度。请为现有专用 Token 增加 Actions 读写权限，再点击刷新。上传和云端发布不受此面板权限影响。",
      } : { stage: "network", detail: "暂时无法读取 GitHub 或公开网站。不会据此认定发布失败；可以稍后刷新或打开运行记录。" });
    } finally { this.busy = false; this.modal?.render(); }
  }

  async retry() {
    const record = this.config.last;
    const previous = this.state;
    if (this.busy || !record || !previous.retry || Date.now() < this.retryUntil) return;
    this.busy = true;
    this.modal?.render();
    try {
      const pr = await this.api<PullRequest>(record, "GET", `pulls/${record.number}`);
      if (!matchesRecord(pr, record)) throw new Error("Source changed");
      if (previous.retry === "check" && previous.failedRun && !pr.merged) {
        const run = await this.api<ActionRun>(record, "GET", `actions/runs/${previous.failedRun}`);
        if (run.head_sha !== record.head || !run.pull_requests?.some(p => p.number === record.number)) throw new Error("Source changed");
        await this.api(record, "POST", `actions/runs/${run.id}/rerun-failed-jobs`);
      } else if (pr.merged && previous.retry === "deploy") {
        const ref = await this.api<{ object: { sha: string } }>(record, "GET", `git/ref/heads/${encodeURIComponent(record.base)}`);
        const compare = await this.api<{ merge_base_commit: { sha: string } }>(record, "GET",
          `compare/${pr.merge_commit_sha}...${ref.object.sha}`);
        if (compare.merge_base_commit.sha !== pr.merge_commit_sha) throw new Error("Source changed");
        await this.api(record, "POST", `actions/workflows/${encodeURIComponent(this.config.deployWorkflow)}/dispatches`, {
          ref: record.base, inputs: { expected_sha: ref.object.sha },
        });
      } else {
        if (pr.merged || pr.state !== "open") throw new Error("Request is not open");
        const ref = await this.api<{ object: { sha: string } }>(record, "GET", `git/ref/heads/${encodeURIComponent(record.base)}`);
        if (pr.base.sha !== ref.object.sha) {
          // The existing token creates the branch update, so normal PR checks
          // run. Accept its new head only after checking both merge parents.
          record.syncBase = ref.object.sha;
          record.startedAt = new Date().toISOString();
          await this.plugin.saveSettings();
          try {
            await this.api(record, "PUT", `pulls/${record.number}/update-branch`, { expected_head_sha: record.head });
          } catch (error) {
            if ([401, 403, 422].includes((error as { status: number }).status)) {
              delete record.syncBase;
              await this.plugin.saveSettings();
            }
            throw error;
          }
          this.retryUntil = Date.now() + 20000;
          this.setState({ stage: "checking", detail: "已请求同步网站最新版本，等待重新检查；文章原稿不变。" });
          return;
        }
        await this.api(record, "POST", `actions/workflows/${encodeURIComponent(this.config.publishWorkflow)}/dispatches`, {
          ref: record.base, inputs: { pr_number: String(record.number), dry_run: "false" },
        });
      }
      this.retryUntil = Date.now() + 20000;
      this.setState({ stage: pr.merged ? "deploying" : "checking", detail: "重试请求已提交，等待云端运行。" });
    } catch (error) {
      const status = (error as { status?: number }).status;
      this.setState(status === 401 || status === 403 ? {
        stage: "permission", detail: "重试需要现有专用 Token 的 Actions 读写权限。请补充权限后刷新。",
      } : { stage: "network", detail: "重试未确认成功，或申请已有更新。请刷新并核对运行记录后再操作。" });
    } finally { this.busy = false; this.modal?.render(); }
  }

  get working(): boolean { return this.busy || Date.now() < this.retryUntil; }
}

class PublicationModal extends Modal {
  private timer?: number;
  private openedAt = 0;
  constructor(readonly center: PublicationCenter) { super(center.plugin.app); }
  onOpen() {
    this.openedAt = Date.now();
    this.render();
    void this.center.refresh();
    this.timer = window.setInterval(() => {
      if (Date.now() - this.openedAt < 20 * 60 * 1000
        && !["live", "hidden", "deleted", "permission", "failed", "stale"].includes(this.center.state.stage)) void this.center.refresh();
    }, 20000);
  }
  onClose() {
    if (this.timer) window.clearInterval(this.timer);
    this.center.modal = undefined;
    this.contentEl.empty();
  }
  render() {
    const { contentEl: el, center } = this;
    el.empty();
    el.addClass("enveloppe-publication");
    el.createEl("h2", { text: "文章发布" });
    if (center.config.last && center.state.stage !== "uploading") el.createEl("p", { text: `最近发布：${center.config.last.title}`, cls: "publication-title" });
    const status = el.createDiv({ cls: `publication-state is-${center.state.stage}` });
    status.setAttribute("role", "status");
    status.createEl("h3", { text: STAGE_LABELS[center.state.stage] });
    status.createEl("p", { text: center.state.detail });
    const actions = new Setting(el);
    if (center.state.articleUrl) actions.addButton(button => button.setButtonText("打开文章").setCta()
      .onClick(() => window.open(center.state.articleUrl, "_blank", "noopener,noreferrer")));
    if (center.state.retry) actions.addButton(button => button.setButtonText(center.state.retry === "check" ? "重试检查" : "重试发布")
      .setDisabled(center.working).onClick(() => center.retry()));
    actions.addButton(button => button.setButtonText("刷新进度").setDisabled(center.working)
      .onClick(() => center.refresh()));
    const record = center.config.last;
    if (record) {
      const base = `https://github.com/${encodeURIComponent(record.owner)}/${encodeURIComponent(record.repo)}`;
      const links = el.createDiv({ cls: "publication-links" });
      for (const [text, url] of [["查看发布申请", `${base}/pull/${record.number}`],
        ["查看运行记录", center.state.failedRun ? `${base}/actions/runs/${center.state.failedRun}` : `${base}/actions`]]) {
        links.createEl("a", { text, href: url, attr: { target: "_blank", rel: "noopener noreferrer" } });
      }
    }
    if (center.state.stage === "permission") el.createEl("a", { text: "打开 GitHub Token 权限设置", href: "https://github.com/settings/personal-access-tokens",
      attr: { target: "_blank", rel: "noopener noreferrer" } });
    new Setting(el).setDesc("关闭面板不会中断云端发布。可从右键菜单或命令面板重新查看。")
      .addButton(button => button.setButtonText('文章管理').onClick(() => center.articleManager.open()))
      .addButton(button => button.setButtonText("发布设置").onClick(() => new PublicationSettingsModal(center).open()));
  }
}

export class PublicationSettingsModal extends Modal {
  constructor(readonly center: PublicationCenter) { super(center.plugin.app); }
  onOpen() {
    const config = this.center.config;
    this.contentEl.createEl("h2", { text: "发布中心设置" });
    new Setting(this.contentEl).setName("上传后显示发布进度").setDesc("使用已有云端检查和部署流程，不直接跳过检查合并。")
      .addToggle(toggle => toggle.setValue(config.enabled).onChange(async value => {
        config.enabled = value;
        if (value) this.center.plugin.settings.github.automaticallyMergePR = false;
        await this.center.plugin.saveSettings();
      }));
    new Setting(this.contentEl).setName("公开网站地址").setDesc("用于核对 release.json 和文章索引；这里只发送公开请求，不发送 GitHub Token。")
      .addText(text => text.setPlaceholder("https://example.com/").setValue(config.siteUrl).onChange(async value => {
        try { config.siteUrl = value.trim() ? publicSite(value.trim()).href : ""; await this.center.plugin.saveSettings(); }
        catch { /* Keep the previous valid setting while the user is typing. */ }
      }));
    for (const [key, name] of [["publishWorkflow", "自动发布工作流"], ["deployWorkflow", "部署工作流"]] as const) {
      new Setting(this.contentEl).setName(name).addText(text => text.setValue(config[key]).onChange(async value => {
        if (/^[\w.-]+\.ya?ml$/.test(value.trim())) { config[key] = value.trim(); await this.center.plugin.saveSettings(); }
      }));
    }
    this.contentEl.createEl("p", { text: "复用插件现有仓库和钥匙串。完整进度与重试需要该专用 Token 的 Actions 读写权限；Contents 和 Pull requests 权限保持原配置。" });
    new Setting(this.contentEl).addButton(button => button.setButtonText("完成").setCta().onClick(() => { this.close(); this.center.open(); }));
  }
  onClose() { this.contentEl.empty(); }
}

export interface PublicationRecord {
  owner: string;
  repo: string;
  base: string;
  branch: string;
  head: string;
  number: number;
  slug: string;
  title: string;
  smartKey?: string;
  startedAt?: string;
  syncBase?: string;
}

export interface PublishingSettings {
  enabled: boolean;
  siteUrl: string;
  publishWorkflow: string;
  deployWorkflow: string;
  checkWorkflows: string[];
  last?: PublicationRecord;
}

export const DEFAULT_PUBLISHING: PublishingSettings = {
  enabled: false,
  siteUrl: "",
  publishWorkflow: "auto-publish-articles.yml",
  deployWorkflow: "astro-deploy.yml",
  checkWorkflows: ["astro-build.yml", "project-check.yml"],
};

export interface PullRequest {
  number: number;
  state: string;
  merged: boolean;
  merge_commit_sha: string | null;
  head: { sha: string; ref: string; repo: { full_name: string } | null };
  base: { ref: string; sha?: string };
}

export interface ActionRun {
  id: number;
  path: string;
  event: string;
  head_sha: string;
  head_branch: string;
  status: string;
  conclusion: string | null;
  display_title?: string;
  created_at?: string;
  pull_requests?: { number: number; head: { sha: string } }[];
}

export type Stage = "idle" | "uploading" | "checking" | "merging" | "deploying"
  | "verifying" | "live" | "failed" | "permission" | "stale" | "network";

export interface PublicationState {
  stage: Stage;
  detail: string;
  failedRun?: number;
  retry?: "check" | "publish" | "deploy";
  articleUrl?: string;
}

export const STAGE_LABELS: Record<Stage, string> = {
  idle: "还没有发布记录", uploading: "上传中", checking: "检查中",
  merging: "等待自动合并", deploying: "部署中", verifying: "核验网站中",
  live: "已上线", failed: "发布失败", permission: "需要补充权限",
  stale: "申请已有新版本", network: "暂时无法读取进度",
};

export function latestRun(runs: ActionRun[]): ActionRun | undefined {
  return [...runs].sort((a, b) => b.id - a.id)[0];
}

export function matchesRecord(pr: PullRequest, record: PublicationRecord): boolean {
  return pr.number === record.number && pr.head.sha === record.head
    && pr.head.ref === record.branch && pr.base.ref === record.base
    && pr.head.repo?.full_name === `${record.owner}/${record.repo}`;
}

export function deriveState(pr: PullRequest, record: PublicationRecord,
  checks: ActionRun[], automatic: ActionRun[], deployments: ActionRun[], config: PublishingSettings): PublicationState {
  if (!matchesRecord(pr, record)) return { stage: "stale", detail: "检测到新的上传。本次记录不会替新版本重试或宣称上线。" };
  if (!pr.merged && pr.state !== "open") return { stage: "failed", detail: "发布申请已关闭。需要发布时请重新上传文章。" };
  if (!pr.merged) {
    let waiting = false;
    for (const workflow of config.checkWorkflows) {
      const run = latestRun(checks.filter(item => item.path === `.github/workflows/${workflow}`
        && item.event === "pull_request" && item.head_sha === record.head
        && item.pull_requests?.some(p => p.number === record.number && p.head.sha === record.head)));
      if (run?.status === "completed" && run.conclusion !== "success") {
        return { stage: "failed", detail: `云端检查未通过：${workflow}。修改文章后再上传，或重试失败检查。`, failedRun: run.id, retry: "check" };
      }
      if (!run || run.status !== "completed") waiting = true;
    }
    if (waiting) return { stage: "checking", detail: "上传已完成，云端正在检查文章与构建。" };
    const gate = latestRun(automatic.filter(run => run.display_title === `Publish PR #${record.number}`
      && run.path === `.github/workflows/${config.publishWorkflow}`
      && (!record.startedAt || Date.parse(run.created_at || "") >= Date.parse(record.startedAt))));
    if (gate?.status === "completed" && gate.conclusion === "failure") {
      return { stage: "failed", detail: "自动发布检查停止。请查看失败步骤，确认后可重试发布。", failedRun: gate.id, retry: "publish" };
    }
    return { stage: "merging", detail: "文章检查已通过，等待云端自动合并。", retry: "publish" };
  }
  const deployment = latestRun(deployments.filter(run => run.head_sha === pr.merge_commit_sha
    && run.head_branch === record.base && run.path === `.github/workflows/${config.deployWorkflow}`));
  if (deployment?.status === "completed" && deployment.conclusion !== "success") {
    return { stage: "failed", detail: "部署未成功，网站尚未确认更新。可查看失败步骤并重试部署。", failedRun: deployment.id, retry: "deploy" };
  }
  if (deployment?.conclusion === "success") return { stage: "verifying", detail: "部署已成功，正在核对公开网站中的文章。" };
  return { stage: "deploying", detail: deployment ? "正在构建并更新网站。关闭此面板不会中断部署。" : "申请已合并，等待部署开始。", retry: deployment ? undefined : "deploy" };
}

export function publicSite(value: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) {
    throw new Error("请输入不带凭证、查询参数或锚点的 HTTPS 网站地址。");
  }
  if (!url.pathname.endsWith("/")) url.pathname += "/";
  return url;
}

export function findPublishedArticle(entries: unknown, slug: string, site: URL): string | undefined {
  if (!Array.isArray(entries)) return;
  const normalize = (value: string) => decodeURIComponent(value).replace(/\/$/, "").toLowerCase();
  const target = normalize(`posts/${encodeURIComponent(slug)}`);
  for (const entry of entries) {
    if (typeof entry?.url !== "string") continue;
    const url = new URL(entry.url, site);
    if (url.origin !== site.origin || !url.pathname.startsWith(site.pathname)) continue;
    if (normalize(url.pathname.slice(site.pathname.length)) === target) return url.href;
  }
}

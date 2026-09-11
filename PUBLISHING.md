# Enveloppe 发布中心（个人 fork）

本定制版 7.8.3 基于上游稳定版 7.8.2，并保留上游 AGPL-3.0 许可证和作者归属。它不是上游的新稳定版本。master 保留上游同步历史，定制代码在 codex/publish-center 分支；上游 8.x 测试版不混入此稳定分支。

## 日常操作

1. 在 Enveloppe 发布中心设置中启用「上传后显示发布进度」，填写自己的 HTTPS 网站地址。
2. 沿用已有公开标记、路径转换、仓库和钥匙串配置。启用发布中心会关闭默认仓库的插件直接自动合并，让云端先完成检查。
3. 右键当前公开文章，点击「发布 … 到博客」。面板显示上传、检查、等待自动合并、部署、网站核验，以及最后的「已上线」。
4. 已上线时可以打开文章；失败时可以查看对应申请/运行记录，或点击重试。旧申请落后于网站主分支时，重试会锁定上传版本并同步主分支，核对同步提交的两个父版本后重新跟踪检查。修改正文后需要重新上传；重试不会读取和重新上传原稿。
5. 从右键「查看发布进度与重试」、状态栏或命令面板重新打开最近一次发布记录。关闭面板会停止轮询，云端发布继续进行。

本版本主要适配单仓库、单篇上传。面板保存最近一次发布的申请编号、版本和文章标识，不保存正文或另一份Token。多仓库仍沿用原上传行为，未纳入单记录进度面板。面板打开时每20秒读取进度，最长20分钟；成功、明确失败、权限不足或版本过期时停止自动轮询。

## 云端与权限

这是已有云端发布流程的客户端。仓库需要具有对应的PR检查、自动合并和部署工作流。默认文件名为 astro-build.yml、project-check.yml、auto-publish-articles.yml 和 astro-deploy.yml；发布与部署文件名可在设置里更改，检查列表可在配置的checkWorkflows字段调整。

自动发布运行名称采用 Publish PR #申请编号，便于识别当前申请的失败。自动发布工作流的workflow_dispatch需要pr_number、dry_run输入；部署工作流的workflow_dispatch接收可选expected_sha。插件不会自动创建这些工作流或开启服务器服务，也不会绕过云端合并门禁。

完整进度读取与插件内重试需要专用GitHub Token对目标仓库具有Actions读写权限，并保留已有Contents和Pull requests权限。Token继续使用Enveloppe原有Obsidian钥匙串；403/401会明确显示缺权限，不把它当成文章失败或成功。公开网站请求不携带GitHub认证。

已上线的判断需要公开站点的release.json提供source_sha，并能在search-index.json中找到文章URL。只有本站版本包含这次合并，且本站索引存在对应文章，才显示已上线；较新的部署也会校验提交祖先关系。支持本站子路径以及含大写字母的slug。

## 安装与更新

从本fork的7.8.3发行附件取得main.js、manifest.json、styles.css，关闭插件后替换对应插件目录内这三个文件，再启用。保留data.json和原钥匙串，不复制另一台设备的Token。原插件ID不变，因此沿用已有设置。

仅fork仓库不会改变Obsidian已安装的插件，也不会自动把官方更新切换为本fork。后续定制版应从此fork的发行版更新；直接安装官方更新会覆盖定制代码。更新或回退前备份原插件的三个程序文件，必要时关闭插件并恢复这三个文件。

## 构建与验证

使用Node.js 24、pnpm 10.13.1及提交的pnpm-lock.yaml。初始化locale子模块后执行：

```text
pnpm install --frozen-lockfile --ignore-scripts
pnpm exec tsc --noEmit --skipLibCheck
pnpm run test:publication
node esbuild.config.mjs --production
```

pnpm的依赖隔离会为不同CodeMirror peer上下文创建独立Obsidian类型实例，因此tsconfig显式将obsidian映射到根依赖，使上游obsidian-typings扩展应用到同一实例；不修改运行时模块或屏蔽本项目的类型错误。

19组发布状态及API交互测试覆盖精确版本、失败和取消、旧检查、不同申请、网络/权限错误、公开链接安全、祖先版本验证、重试目标及旧申请同步。原英文申请标题直接依据7.8.2发行资源，中文资源来自已验证的完整翻译。另修复上游复用已有申请时取错其他PR的问题，严格按owner/repo/head/base匹配。

本地已完成类型检查、构建及真实Obsidian启动、发布面板和缺权限状态验证。完整联网进度与重试的最终验收以使用设备授权及当次记录为准；测试夹具不等于真实上传或部署。

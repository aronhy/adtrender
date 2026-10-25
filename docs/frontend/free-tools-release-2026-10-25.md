# Free 工具静态发布范围

产品基线：`origin/main@91896f5`，保留旧八个工具 URL；本次扩充为 17 个可用工具、目录和使用指南，共 19 个静态路径。公开正文、校验、公式、示例、Hook 和政策模板来自已经确认的 HTML 原型，11 份源文件的正文及 provenance 哈希保持不变。

## 实现边界

- 新模块在 `apps/web/src/client/free-tools/`，只依赖既有 React/Router 和浏览器能力；资源在 `apps/web/public/free-tools/assets/`，许可一并保留。
- `FreeToolsPage` 为全部工具路径使用同一个组件。原 `ToolsIndexRoute`、`FreeToolRoute` 及 `slug` 参数保留，新增 `/tools/guide`；跨工具资料在当前页面实例内共享。
- `ssr-snapshots.json` 包含 19 份初始静态正文。快照由已校验的原文脚本在隔离 JSDOM 中生成，不读取 API、数据库、账户、快照资料或访问者输入。所有静态表单都由 disabled fieldset 包裹，JavaScript 接管前不可提交；空字段和原型固定默认值保持不变。
- React 输出每页 title、description、canonical 和轻 DOM 快照，浏览器随后挂载无 slot 的 ShadowRoot 遮蔽快照。SSR 与首次 hydration 使用同一 DOM，交互仍运行原文脚本。
- 既有 Wasp SSR prerender、head 去重及 SPA fallback 构建逻辑保留。共享登记、robots 和 sitemap 扩展到 19 个工具路径，资源抓取仅新增 `/free-tools/assets/`。
- 工具路径的 `SiteAnalytics` 配置关闭 growth。GA/Clarity 仍由已有工具文档边界禁用，因此即使曾同意统计也不发送工具归因或第三方请求；营销页面配置保持原有行为。离开工具进入营销或私有路径时必须整页导航。
- 不修改 App、后端逻辑、数据库迁移、依赖或 lockfile。共享路径登记用于新前端构建；当前线上 API 保持原有精确枚举，不部署新 API，工具页不调用它。
- 文案中原有“本地预览”等措辞保留，没有擅自改成正式承诺。五个研究工具仍是原文筹备状态。

## 发布覆盖约束

候选目录必须以实时线上静态目录的完整副本为底座，只覆盖 `/tools/index.html`、`/tools/guide/index.html`、17 个详情 `index.html`、新增内容哈希资源、`free-tools/assets/`、robots 和 sitemap。所有原首页、`200.html`、其他页面及旧 assets 保持字节不变。新菜单和页脚仅随工具页面的新资源出现；不能把构建目录整体覆盖主站。

不改变 API、worker、DB、运行配置、容器或 Nginx。切换前后逐文件校验覆盖范围外的哈希，失败只回退静态指针。

## 可重复校验

使用仓库固定 Node 运行：

```sh
toolchain/node_modules/.bin/node scripts/generate-free-tools-snapshots.mjs --check
```

如果确认后的原文发生授权变化，先重新生成快照再审查；生成器会校验 11 份源文件哈希，任何非授权正文变动都会失败。

定向测试覆盖原文与算法、19 页 SSR、disabled 表单、hydration、旧八 URL、robots/sitemap、17 工具共享资料、统计隔离以及工具到营销/私有文档切换。真正构建产物还须运行 `scripts/free-tools-html.test.mjs`，部署后另做 HTTPS、19 路径直达和刷新、移动端、复制和 TXT 下载回读。

源码准备阶段实际结果：20 个受影响测试文件、316 项全部通过；快照 `--check`、11 份原文与 provenance 的逐字比对、全部资源逐字比对、`git diff --check` 通过。独立审查发现静态 fallback 继承主站浅字色，已给新宿主明确深色并验证真实 CSS 的对比度；未修改 11 份原文。此阶段没有运行全站构建或连接数据库，构建和线上回读由发布步骤另行记录。

这份说明记录源码准备范围；不代表已经提交、发布或完成线上验收。

# 发布准备与独立安装证据

更新日期：2026-10-05。下方首次安装与容器模板记录发生于2026-10-04，本机 macOS / arm64；当时未连接测试服务器、未安装 systemd / Caddy、未部署域名或启动生产服务。当前本地回归和Netcup部署状态分别见后续补充。

## 真实 Wasp 产物

实测 Wasp 0.25.0 的 `wasp build` 输出为 `.wasp/out`，`.waspinfo` 记录 `buildType=Production`；前端仍须单独执行 `vite build`。当前 SPA 构建只产生 `200.html`，不保证有 `index.html`。准备工具据此要求 200 fallback，并拒绝 Development 模式生成代码。

首次独立安装检查包位于 `/private/tmp/saas-release-install-review-20261004/`，共 1,175 个输入文件，准备时 artifactHash 为 `a0c4e14292471b7f3a4b9d149fbe73f336f9b277ecd5c70d6a0552ade35c8f91`。这是工作区未提交、前端 API 为 `https://api.example.invalid` 的检查包，不可发布。最终 CSS、worker 和 npm 版本声明更新后必须重新 prepare，不得把这个 hash 当最终发布版本。安装和再次编译会生成目标 OS 产物；上面 hash 只证明安装前的准备文件。

## 首次独立安装执行结果（历史）

| 检查 | 结果 |
| --- | --- |
| 发布准备工具独立夹具 | 5 项通过：相邻依赖布局、文件排除与重复 hash、越界依赖拒绝、敏感内容 / 符号链接拒绝、输出目录隔离、开发模式拒绝 |
| 锁文件独立安装 | 在新目录执行 `npm ci --include=dev --ignore-scripts --no-audit --offline`，成功安装 455 个包；未访问 registry |
| Prisma 生成 | 在发布目录显式 `prisma generate --schema=.wasp/out/db/schema.prisma`，成功生成 Prisma 5.19.1；未连接数据库或迁移 |
| API server bundle | 发布目录 `npm run bundle --workspace=@wasp.sh/generated-server --no-audit` 成功，`node --check` 成功 |
| contracts ESM 加载 | 实际解析并加载 `release/contracts/dist/collection.js`，未引用源仓库路径 |
| Prisma / server workspace | 同一 app 安装下解析到 Prisma 5.19.1 与 `app/.wasp/out/server/package.json` |
| 独立 worker | `node dist-worker/index.mjs --help` 成功；未运行任务或访问数据库 |
| 当前工具链 | 复核 Node 24.14.1 / npm 11.18.0；verify 与新准备包版本声明已对齐 |

独立安装保留了 npm 对 Lucia / Oslo 依赖的弃用提示；不将安装成功解释为第三方依赖长期维护承诺。此次显式跳过安装生命周期脚本后单独生成 Prisma，验证了所需生成步骤；正式目标 Linux 仍须按锁文件安装、生成平台原生客户端并复核依赖安全检查。

该轮检查后，目标 Linux 安装、Chromium 运行、Caddy 配置、systemd 生命周期、TLS、共同数据库连接、SMTP / S3 / OpenAI / Stripe、远端备份回退、外部真人业务均列为待独立验收。后续已验证范围以文末Netcup记录为准，未由首次本机安装结果推定通过。

## 容器模板初次追加静态验证（历史）

新增 `container/Dockerfile`、独立 Compose、外置 env 示例、单节点测试 Garage 配置和 Chromium sandbox 本地HTML检查脚本。Caddy 的非 assets 文件服务增加 `200.html` 索引，修复仅有 SPA fallback 时首页目录匹配的问题。

当次`container.test.mjs` 三项通过、0 跳过：Caddy 首页规则，Dockerfile 固定版本 / 显式构建 / 非root设置，Compose 真实 CLI 解析后的端口 / 网络 / 卷 / 共享环境约束。解析使用本机 Docker CLI 29.5.3 / Compose 5.1.4，`--no-env-resolution` 且只传不存在的占位 env 路径，没有读取真实凭证。本机 Docker daemon 未运行，没有执行 image build、pull、container up 或 Chromium Linux 运行检查。当前目标由主线程使用既有 Nginx；Caddy模板依然未实跑。

## 当前冻结回归（2026-10-05）

`vitest.config.ts`全量为 **39个文件、338项通过，0失败、0跳过**，00:56:48 HKT（UTC+8）开始，耗时8.29秒。原始报告 `/private/tmp/ds-meta-saas-final-338-vitest.json` 已回读，SHA-256：`34a7f2e2b52ae47210a888bcef1664f5afc4b483f95f34a694d2983d3443dc21`。此前研究fixture违反延迟OWNER约束导致suite失败，修复为同一事务初始化后重新全量通过；没有修改业务约束。

真实本机Wasp API/PostgreSQL/SMTP链路 **13组通过，SMTP捕获5封**，UTC区间 `2026-10-04T16:58:46.955Z` 至 `2026-10-04T16:58:49.982Z`（HKT为10月5日00:58:46.955–00:58:49.982）；`saas/.artifacts/http-smoke.json` SHA-256为 `607272aab7edb15ac706c28927f977668d496672d74c3a75adbde01233ec7217`，`externalProvidersUsed=false`。本轮含研究及后台分页真实HTTP入口，未调用真实供应商。

发布专项 **25/25通过，0失败、0跳过**：`prepare-release.test.mjs` 7项、`container.test.mjs` 5项、`nginx.test.mjs` 2项、`health-monitor.test.mjs` 11项。已回读 `/private/tmp/ds-meta-deploy-final-25.log`；覆盖源码与Wasp生成副本一致性、Chromium最小seccomp调整及外置override、真实本机Nginx、告警确认/重试/恢复与敏感内容隔离。告警真实接收端和远端调度仍待验。以上25项独立于338项SaaS测试；旧系统555项为已有记录，本轮未重跑。

## Netcup实际部署补充（2026-10-05）

以上macOS记录保留为历史安装证据。当前远端运行`20261005-test-3`（源码提交`7ce9682`，发布时工作区干净），已在Debian13完成干净Linux镜像构建、五迁移、受限数据库角色正反校验、非root Chromium sandbox与API/worker启动。API重启、worker恢复及远端新库37表恢复通过。新增分页及告警脚本已包含在test-3中，01:13升级/回退/再升级三轮通过；新版非root浏览器沙箱及镜像依赖只读核对通过。告警只完成dry-run，尚未发送通知或启用调度。公网DNS/TLS、真实供应商及客户流程仍待验。实际镜像ID、产物hash、外置运行修复与恢复结果以Netcup部署记录为准，不使用上方旧检查包发布。


## 2026-10-05 运维增量

当前独立发布与恢复检查60项通过（零失败/跳过），包含真实本机PostgreSQL及实际CLI联合恢复；应用全量47文件/464项与Wasp、API、前端、worker构建通过。源码与导出迁移逐字节一致性现纳入14项打包检查。完整范围和原始报告hash见运维增量。

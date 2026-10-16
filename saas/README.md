# AdTrender 广告研究 SaaS

本目录是第一阶段的新应用入口，与根目录的旧 DS 内部工具分开运行。它使用 Open SaaS / Wasp 登录基座，组织拥有订阅，工作区隔离收藏、笔记和分析。不得启动根目录 `npm start` 来启动本应用，也不得把旧 `local-media` 作为新媒体存储。

当前本地开发回归及Netcup独立测试服务部署已完成，正在进行真实环境验收。尚未完成生产部署、真实邮件收取、生产对象存储、真实支付或外部客户验收；不能据此宣布 M1–M4 或第一阶段完成。完整范围见 S01–S23 主表，分层证据见 验收记录。

## 目录与版本

| 目录 / 文件 | 用途 |
| --- | --- |
| `app/` | Wasp 应用、中文官网与工作台、认证、团队、计费、API、Prisma schema / migrations |
| `collector/src/` | 采集 worker、Meta 来源适配与样本测试 |
| `worker/src/` | 独立进程主入口，协调采集 / 邮件 / 分析任务 |
| `contracts/` | 应用与 worker 共享的数据契约 |
| `scripts/` | 项目工具链包装、构建、数据库与对象联合备份/恢复检查；不调用旧调度 |
| `toolchain/` | 锁定的 Node / npm / Wasp CLI |
| `upstream.lock.json`、`OPEN-SAAS-LICENSE` | 官方模板来源、固定 commit 与许可 |
| `vitest.config.ts` | SaaS 与旧数据盘点工具的独立测试配置 |
| `../scripts/saas-migration/` | 旧 `ads.json` 只读盘点、本机测试库导入、批准媒体上传和原始公共证据归档 |

锁定版本为 Node **24.14.1**、npm **11.18.0**、Wasp **0.25.0**、Prisma **5.19.1**。官方来源为 `https://github.com/wasp-lang/open-saas`，tag `wasp-v0.25-template`，commit `9ee052af84950433c76bffe999b317d24bc0205d`。具体保留与排除内容在 `upstream.lock.json`；已保留许可，不把上游演示 AI、假数据或个人订阅模型当作本产品能力。

## 本地配置与启动

先在 `saas/toolchain` 执行 `npm ci --no-audit` 安装固定工具链，再让后续命令优先使用该目录的 `.bin`。当前工具链锁包含 macOS Apple Silicon CLI 包；其他平台必须使用对应官方 CLI 包并单独验证，不能声称已跨平台验收。

```bash
cd saas/toolchain
npm ci --no-audit
cd ../..
export PATH="$PWD/saas/toolchain/node_modules/.bin:$PATH"
cd saas/app
npm ci --no-audit
if [ ! -f .env.server ]; then cp .env.server.example .env.server; fi
cd ../..
```

仅在 `.env.server` 尚不存在时复制示例。按需填写本地参数，不覆盖已有配置，不将凭证提交 Git。开发数据库示例为本机 `127.0.0.1:55438/saas_dev`，用户 `saas_local`；它与旧 SQLite / ERP 数据无关。Wasp 生成目录 `.wasp/` 不作为源代码修改。

```bash
# 以下命令从仓库根目录执行。
./saas/scripts/wasp.sh compile
# 先创建本地配置对应的 PostgreSQL 数据库；核实目标后部署已有迁移。
cd saas/app
node --env-file=.env.server node_modules/prisma/build/index.js migrate deploy
cd ../..
VITE_CUSTOMER_APP_ORIGIN=http://localhost:3000 \
VITE_ADMIN_APP_ORIGIN=http://localhost:3002 \
./saas/scripts/wasp.sh start
```

默认开发页面为 `http://localhost:3000`，API 为 `http://localhost:3001`。端口可配置，不能因文件存在就假定进程已启动。独立 worker 通过 `saas/scripts/build-worker.mjs` 构建；产物为 `app/dist-worker/index.mjs`，由 `scripts/worker.sh` 读取 app/.env.server 启动；Netcup测试容器托管已验证，正式环境仍待验，不复用旧 `collect:daily` 或个人 Mac 的定时任务。

前端未显式配置 origin 时使用公共站点域名；本地启动时需像上例一样设置两个 `VITE_*_APP_ORIGIN`，避免管理员入口跳到公共服务。它们是启动 / 构建命令的公开环境变量，Wasp 不从 `.env.client` 自动读取。要运行本地管理端，在 `.env.server` 设置 `ADMIN_WEB_CLIENT_URL=http://localhost:3002` 和至少 32 字符的 `JWT_SECRET`，并重启 API；再在第二个终端从 `saas/app` 执行：

```bash
REACT_APP_API_URL=http://localhost:3001 \
VITE_APP_SURFACE=admin \
VITE_CUSTOMER_APP_ORIGIN=http://localhost:3000 \
VITE_ADMIN_APP_ORIGIN=http://localhost:3002 \
../toolchain/node_modules/.bin/node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 3002 --strictPort
```

邮箱注册需要在 `.env.server` 设置 `OUTBOX_ENCRYPTION_KEY`（32 字节随机密钥的 64 位 hex）、可用的 SMTP 接收器，并启动独立 worker 投递 outbox。示例不包含 SMTP 服务；缺少密钥或 worker 时，页面启动成功也不能完成验证邮件流程。默认邀请模式还需配置 `REGISTRATION_ALLOWLIST`；只在需要开放本地注册时改为 `REGISTRATION_MODE=public`。

仅验证邮件流程时，可在仓库根目录构建并启动 mail-only worker；完整采集和其他后台任务需配置各自依赖后再启用：

```bash
./saas/toolchain/node_modules/.bin/node saas/scripts/build-worker.mjs
./saas/scripts/worker.sh --mail-only
```

| 配置 | 作用与边界 |
| --- | --- |
| `DATABASE_URL` | 独立 PostgreSQL；数据库密码只放环境变量 / 密钥服务 |
| `WASP_WEB_CLIENT_URL`、`WASP_SERVER_URL`、`PORT` | 客户端与 API 地址；生产必须 HTTPS |
| `JWT_SECRET` | 生产会话密钥，至少 32 字符 |
| `REGISTRATION_MODE`、`REGISTRATION_ALLOWLIST` | `invite` 或 `public`；受邀阶段限制注册邮箱 |
| `GOOGLE_AUTH_ENABLED`、`GOOGLE_CLIENT_ID`、`GOOGLE_CLIENT_SECRET` | Google 登录默认关闭；关闭时 ID/Secret 两个键仍须存在，可留空；启用需本 SaaS 专用 Web OAuth 客户端 |
| `SMTP_HOST`、`SMTP_PORT`、`SMTP_SECURE`、`SMTP_USERNAME`、`SMTP_PASSWORD`、`EMAIL_FROM` | 实际邮件投递；示例 SMTP 仅用于本机接收测试，不能代替真实邮箱验收 |
| `OUTBOX_ENCRYPTION_KEY` | 32 字节密钥的 64 位 hex；邮件链接与 outbox 加密，不写入浏览器或日志 |
| `RATE_LIMIT_HMAC_SECRET` | 限流标识散列密钥；生产按安全配置提供 |
| `S3_BUCKET`、`S3_REGION`、`S3_ENDPOINT`、`S3_FORCE_PATH_STYLE`、`AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY` | 私有对象存储与限时签名；必须实际测试写入、过期、删除和越权拒绝 |
| `OPENAI_API_KEY`、`ANALYSIS_MODEL` | 事实摘要 / 内容分析；缺失时明确不可用，不返回编造结果 |
| `BILLING_ENABLED`、`STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET` | Stripe 接入；本地默认关闭，先测试模式验收 |
| `LIVE_BILLING_ENABLED` | 真实收费需显式启用，测试模式通过不代表可收费 |
| `STRIPE_REFUND_POLICY` | 必须明确退款后权益规则：`RETAIN_PAID_PERIOD` 或 `REVOKE_FULL_CURRENT_PERIOD`；业务未确认前不得启用正式售卖 |

正式域名 `adtrender.com` 已于 2026-10-07 注册，公网 DNS、HTTPS 与登录页面已通过技术检查，Google 专用客户端已配置，指定 Gmail 账号的真实首次登录与重复登录已通过，见域名接入证据。经营与收款主体、币种、可售价格、退款权益规则及正式邮件 / 存储方案仍须确认。价格未定时页面显示“价格待公布”，不把访谈报价写入可售套餐。API、worker 和第三方凭证只在服务端；日志不得包含密码、邮件链接 token、支付密钥或素材 URL 查询 token。

AdTrender 线上已设置 `GOOGLE_AUTH_ENABLED=true`、`REGISTRATION_MODE=public`，Google 应用为正式版；支持 Google 和邮箱公开注册，无需邀请。仓库示例仍保持保守默认值。实现只请求 `openid`、`email`、`profile`，不复用旧 Google Ads 客户端，不自动合并同邮箱账号；邀请模式下的邀请/allowlist 检查及所有模式下的账号停用校验仍由服务端执行。控制台回调为 `WASP_SERVER_URL` + `/auth/google/callback`，前端 `/login/google/callback` 不是 Google 控制台回调。专用凭据、真实 Google 同意页、指定 Gmail 账号首次/重复登录及退出跳转已验收；其他场景仍按各自证据认定。配置、持久防重放及已知限制见 Google 登录运维说明。

## 路由与界面接口

官网：`/`、`/pricing`、`/help`、`/terms`、`/privacy`。工作台：`/app`、`/app/ads`、`/app/ads/:adId`、`/app/research`、`/app/settings`、`/app/admin`。`?workspace=` 只选择目标工作区，权限仍由服务端校验。前端通过 Wasp `getAppState`、`searchPublicAds`、`getPublicAd` 和 `appCommand` 读取与提交真实数据；不提供替代服务器的假 API。

数据源状态、广告观测、产品点击和广告实际效果必须分开。首次观测不是首次投放；缺少国家、发布时间或来源字段保持未知。产品不会展示未经证实的营收、点击、ROAS 或案例。临时条款 / 隐私页标明测试阶段范围，正式经营信息与服务规则未定前不能当作商业发布文本。

## 验证

```bash
# 占位地址仅用于本地构建检查，不可发布到正式环境。
REACT_APP_API_URL=https://api.example.invalid ./saas/scripts/verify.sh
```

先按 [贡献指南](../CONTRIBUTING.md) 安装根目录测试依赖和 Playwright Chromium。脚本使用项目 Node / npm，显式关闭 npm audit，检查操作脚本和发布准备测试，构建共享契约并执行 Wasp 生产生成，再运行依赖生成文件的测试、SaaS Vitest、API server bundle、Vite 静态网页和独立 worker build。运行前先停止开发预览，并显式设置 `REACT_APP_API_URL` 为 HTTPS origin；仅本地核验可用 `https://api.example.invalid`，该占位产物不可发布。数据库集成测试需要其指定的本机测试库环境变量；测试输出如有 skipped，必须原样记录，不能把跳过当通过。备份 / 恢复演练单独执行，不由普通验证命令自动建库。

## 备份、恢复与重复核验

`backup.sh` 需要 `psql`、`pg_dump`、`pg_restore` 位于 `PATH`，或通过 `PG_BIN` 指向 PostgreSQL bin 目录；脚本不绑定某台机器的安装路径。建议使用与数据库服务端相同主版本的工具。脚本持有只读一致性快照，在同一快照下生成 custom dump、各表行数、schema SHA-256 和数据库对象引用清单；输出文件为 `0600`，现有输出不覆盖。数据库用户需具备待备份对象的读取权。

```bash
# DATABASE_URL 由安全环境提供；不要把带密码的 URL 粘进命令行或日志。
./saas/scripts/backup.sh --output /private/tmp/saas-dev-20261004.dump
./saas/scripts/restore-check.sh \
  --backup /private/tmp/saas-dev-20261004.dump \
  --target-url postgresql://saas_local@127.0.0.1:55438/saas_restore_20261004
# 再执行相同恢复命令，只读核验已有恢复结果，输出 REPLAY_VERIFIED_NO_WRITE。
```

恢复先校验 dump SHA-256，目标 URL 必须显式提供，密码只通过 `PGPASSWORD`；只接受本机地址和含独立 `test` / `restore` 段的数据库名，目标不能是源库。仅新建目标库并单事务恢复，不执行 `--clean`、覆盖或自动删除。已有库只有匹配本次备份的成功报告时才允许只读重验；任一表计数、schema hash、外键或对象引用深比较不一致即失败。失败目标保留供调查，重试请换新库名，不能自动清除故障证据。

数据库 dump 后可显式运行 [object-backup.mjs](scripts/object-backup.mjs)：`backup` 只 GET 数据库清单所引用的公共媒体、私有文件与原始证据，逐对象核对字节、大小和内容类型，再生成绑定 dump/数据库 manifest 的对象归档；不遍历来源桶。`restore` 使用不同的独立空桶和新本机恢复库，调用数据库恢复检查，以条件 PUT 写入对象并 GET 复验，全部通过才记录 `JOINT_RESTORE_VERIFIED`。相同恢复可只读重验，冲突对象不覆盖，部分结果和失败证据保留。命令、独立恢复凭据及边界见 数据库与对象联合备份手册。

SHA-256 用于文件完整性与结果对账，不是加密或签名。备份含实际业务资料，正式环境还须配置加密、访问限制、异地副本、保留周期、RPO / RTO 和告警。联合备份工具已用真实本机 PostgreSQL 和 fake S3 验证；这不代表远端 Garage、供应商灾难恢复、大规模数据或生产恢复演练已验收。旧版数据库 manifest 缺少对象引用时只可获得数据库恢复结果，不能据此宣称联合恢复成功。

本轮已在带公开数据的本机独立演练库完成五个迁移后的 37 表 / 2,685 行备份恢复与重复只读核验；首轮 36 表备份和恢复库保留，未覆盖开发库。详见 公开迁移及恢复证据。

旧公开数据还需单独处理来源证据：`legacy-json-sha256:` 只是摘要，不能作为可恢复对象地址。已提供 [原始证据归档工具](../scripts/saas-migration/source-evidence.ts)，由显式批准的公共 manifest 绑定原输入、导入计划、目标库/桶和完整引用集合；仅接受整批 public 且零 quarantine 的本机隔离演练。工具保存原 JSON 的精确字节及每个唯一变体 JSON，全部条件上传、GET 验证后，才用一个事务将相关引用升级为 `s3:`，保持原有哈希和行映射。重复归档只读复验，旧公开导入 replay 仅核对数据库，不能冒称已验证 S3。离线生成可审查 plan、媒体上传和归档命令见 [迁移工具说明](../scripts/saas-migration/README.md#原始公共-json-与变体证据归档)。归档后须重新备份数据库再执行联合备份；真实旧源文件和远端迁移尚未执行。

## 发布与旧入口切换

广告列表与详情改版已于 2026-10-08 上线 adtrender.com，版本 `20261008-ads-ui-1`；固定产物、公网回读、真实素材附件与权限验证见 本次发布记录。此记录只覆盖本次改版技术上线，真人登录验收及第一阶段其他验收仍单独进行。

Linux systemd / Caddy 模板、Wasp 产物整理、相邻 contracts 包安装、统一 API / worker 环境和版本目录回退步骤见 [发布手册](deploy/README.md)。`scripts/prepare-release.mjs` 只复制真实构建产物、校验本地依赖和生成 hash，不安装、不迁移、不部署；正式服务仍未验收。

发布前固定 Git commit / 构建产物，检查迁移、配置与备份，在独立环境完成健康检查后切换。应用回退使用上一份已验证产物；数据库迁移不得盲目执行 down migration，先核实兼容性，必要时恢复到新库再切换连接。正式平台的进程、健康检查地址与回退演练尚未验证。

旧系统应按 旧数据盘点及停启手册 先对账、后停调度、再切入口。旧生产入口与 Mac 定时任务本轮未修改；不能把名称带 `review` 的旧 launchd 当成无写入测试环境。盘点 manifest 并非数据库导入凭证；来源或归属不明记录必须隔离，私有 ERP / Sales 数据不得混入公共广告库。

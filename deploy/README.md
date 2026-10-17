# 独立生产发布与回退

本目录提供 Linux systemd + Caddy 的发布模板，**尚未部署，也未通过远端服务验收**。本机 macOS 无 systemd / Caddy，不能把文件存在称为服务配置已验证。应用与独立 worker 使用同一个 PostgreSQL、同一套服务端密钥和同一份 `server.env`；两者为不同进程。

真实 Wasp 导出、独立锁文件安装、Prisma 生成、API bundle 和 worker 加载的本机结果见 [发布验证证据](verification.md)。

本轮目标服务器已有 Nginx、使用独立 Docker 项目时，采用 [容器测试模板](container/README.md)，不用同时安装此处 systemd / Caddy。容器模板只绑定 API / Garage 到宿主回环端口，不接管现有 80 / 443；已完成的Netcup运行与恢复检查见远端证据。

## 产物与固定目录

建议目录如下。版本号只是示例，发布时使用已核验的 commit / 发布编号；正式产物不应基于未提交工作区。

```text
/srv/ad-research/
  releases/20261004-abcdef0/
    apps/web/                 # package-lock、业务源码、.wasp/out/{server,sdk,libs,db}
      dist-worker/index.mjs   # 独立 worker，共用 apps/web/node_modules
    packages/contracts/dist/ # @ad-research/contracts 的 file:../../packages/contracts 实际目标
    public/                  # Wasp 生成的静态网页、assets、200.html
    deploy/                  # 本目录配置模板
    ops/                     # backup.sh / restore-check.sh / object-backup.mjs / object-references.sql
    scripts/build-api.mjs    # API 构建入口，apps/web/ 与 packages/contracts/ 保持仓库同一布局
    release-manifest.json    # 输入产物逐文件 SHA-256、版本、公开 API 地址
  current -> releases/20261004-abcdef0
  previous -> releases/<上一已验收版本>
/etc/ad-research/server.env   # root:root，0600，禁止进 Git 或发布压缩包
/opt/ad-research/node-v24.14.1/bin/{node,npm}
/var/cache/ad-research/playwright/
```

`prepare-release.mjs` 仅准备新目录，拒绝已有输出、不切 `current`，不运行安装 / 迁移 / 服务命令。Wasp 0.25 的真实生成目录是 `.wasp/out`，不是旧版本的 `.wasp/build`；工具要求 `.waspinfo` 明确为 Production / 0.25.0，并检查独立 Vite 静态构建和 worker 产物。它把 Wasp 导出目录还原为生成 Dockerfile 采用的 `.wasp/out` 运行路径，保留实际 sibling `contracts` 包；每个 `file:` 依赖必须解析到产物内的存在位置。不会复制 checkout 的 `node_modules`、`.env*`、`.npmrc`、`.pgpass` 或私钥文件，不复用 macOS 的 Prisma 引擎 / Playwright 浏览器。

准备工具的 15 项独立回归测试可运行 `toolchain/node_modules/.bin/node --test deploy/prepare-release.test.mjs`。它们使用临时构建夹具检查依赖布局、API 构建入口随包交付、文件排除、可重复 hash、敏感内容及符号链接拒绝、输出目录隔离开发模式产物拒绝，以及源码与导出迁移逐路径、逐字节一致；不代表真实 Wasp 产物已安装或服务已经部署。输出目录的父目录必须已经存在，指向 checkout 的符号链接也会被拒绝。

## 先构建，再准备

在源码仓库根目录执行，构建环境使用 Node 24.14.1、npm 11.18.0 和项目锁定的 Wasp 0.25.0。Wasp 的前端生产 API 变量是 **`REACT_APP_API_URL`**；它是公开地址，禁止放凭证。`WASP_SERVER_URL` / `WASP_WEB_CLIENT_URL` 是服务端运行配置，不能代替前端构建变量。

```bash
export PATH="$PWD/toolchain/node_modules/.bin:$PWD/apps/web/node_modules/.bin:$PATH"
export npm_config_audit=false
./scripts/wasp.sh build
(
  cd apps/web
  node ../../scripts/build-api.mjs
  REACT_APP_API_URL=https://api.research.example.com node node_modules/vite/bin/vite.js build
)
node scripts/build-worker.mjs
node scripts/prepare-release.mjs \
  --output /private/tmp/ad-research-20261004-review \
  --release-id 20261004-review \
  --public-api-url https://api.research.example.com
```

只有真实 `.wasp/out` 生产模式代码、独立 Vite 静态网页完整且前端 JS 包含指定 API 地址时才生成产物。`wasp build` 不会代替这里的 `vite build`；前端变量会在 Vite 构建时写入静态文件。[Wasp 0.25 官方环境变量说明](https://wasp.sh/docs/deployment/env-vars)

不同域名需要重新构建前端，不要上线仍指向 localhost 或 `https://api.example.invalid` 占位地址的页面。`release-manifest.json` 会记录 Git HEAD 及工作区是否脏；本轮开发准备包如 `workingTreeDirty=true` 仅用于本地核验，不能冒充一个已提交可回退版本。

Wasp 自带 Dockerfile 未按此发布目录重新设计，本方案使用下面的 systemd 路径。不要将平台无关准备包直接当已安装的 Linux 运行镜像。

## 在目标 Linux 安装依赖

以下步骤属于待执行 runbook。先安装对应 CPU 架构的 Node 24.14.1 / npm 11.18.0、OpenSSL、PostgreSQL 客户端和 Caddy，创建专用非 root 用户 `adresearch`，配置网络 / 防火墙、域名和 TLS。API 的 3001 端口只供反向代理访问。迁移与依赖安装在尚未切换的新版本目录完成。

```bash
cd /srv/ad-research/releases/20261004-abcdef0/apps/web
export PATH="/opt/ad-research/node-v24.14.1/bin:$PATH"
npm ci --include=dev --no-audit
node node_modules/prisma/build/index.js generate --schema=.wasp/out/db/schema.prisma
node ../../scripts/build-api.mjs
```

`apps/web/package-lock.json` 包含 Wasp workspace 锁；不要在子目录另用无锁 `npm install`。这些命令不需要生产数据库连接，Prisma generate 只生成与目标 OS 对应的客户端。安装后核对 `apps/web/node_modules/@ad-research/contracts` 能读取 `packages/contracts/dist/collection.js`，以及 API bundle / worker 可加载相同 `@prisma/client` 版本。实际安装结果、OS / 架构、产物 hash 应记录到本版本的发布验收附件。

worker 的 Chromium 也必须安装在目标 Linux，设置 `PLAYWRIGHT_BROWSERS_PATH=/var/cache/ad-research/playwright`，使用 `apps/web/node_modules/playwright/cli.js install --with-deps chromium`，再确认服务用户可读且能以适配器相同参数启动。`META_BROWSER_CHANNEL=chromium` 对应该浏览器。浏览器依赖安装和真实 Meta 查询仍须分别验收；来源拒绝 / 登录墙不能当作成功零结果。

## 配置、备份与迁移

复制 `server.env.example` 到 `/etc/ad-research/server.env`，在服务器的密钥管理流程中填写；文件保持 root 0600。不要把含密码的 URL 放在命令参数中，也不要用 `set -x`、`printenv` 或日志输出整份环境。API 和 worker 的 unit 都读取这一个文件，所以不会因复制两份 env 而连接不同数据库。

生产启动要求真实 SMTP、已验证 `EMAIL_FROM`、JWT、outbox 密钥和私有 S3；默认受邀注册、关闭收费。Stripe / OpenAI 可以在业务允许的功能范围内保持未配置，并在 UI 显示不可用。启用收费前先确认经营主体、币种、正式价格和退款权益规则，完成测试模式完整生命周期；不得直接启用 `LIVE_BILLING_ENABLED` 代替真实支付验收。

安排切换窗口后，先停止新 worker 的未来调度并等待在途任务结束 / 可恢复，再停 API 写入。**每次迁移前先备份**；数据库与对象存储需有对应恢复方案。下面用 Node 的 `--env-file` 注入环境，命令行中不出现数据库密码；实际备份路径须在受控目录中提前创建并配置权限。

```bash
cd /srv/ad-research/releases/20261004-abcdef0
sudo /opt/ad-research/node-v24.14.1/bin/node \
  --env-file=/etc/ad-research/server.env --input-type=module -e \
  'import {execFileSync} from "node:child_process"; execFileSync("./ops/backup.sh", ["--output", "/var/backups/ad-research/pre-release.dump"], {stdio:"inherit", env:{...process.env, PATH:"/opt/ad-research/node-v24.14.1/bin:"+process.env.PATH}});'

cd apps/web
sudo /opt/ad-research/node-v24.14.1/bin/node \
  --env-file=/etc/ad-research/server.env node_modules/prisma/build/index.js \
  migrate deploy --schema=.wasp/out/db/schema.prisma
```

备份输出不得重用已有文件名，示例 `pre-release.dump` 每次应替换为唯一版本名称。迁移失败时保持旧入口状态，先查证；**禁止自动执行破坏性 down migration**。大改动采用兼容旧版的新增结构 / 分阶段迁移。服务 unit 的启动命令不含 migrate，普通重启不会重复执行发布操作。

## 切换与健康检查

数据库 dump 现同时导出对象引用。需要恢复公共素材、团队私有文件和原始采集证据时，继续执行联合备份与恢复流程；仅有数据库恢复报告不能代表对象字节已经恢复。

目标存储必须支持 `If-None-Match: *` 条件写入。恢复前会探测并清理随机临时对象，
因此恢复凭据还需具备 `.adtrender-restore-probe/*` 的删除权限；业务对象不会被删除。
Garage 2.4.1 不满足该条件写入要求，脚本会在创建恢复数据库和上传业务对象之前拒绝恢复。
错误码、权限及验收入口见[存储兼容性说明](backup/README.md)。

把两份 service 文件放到 systemd 配置目录，按实际 Node / 应用路径校对，`systemd-analyze verify` 通过后再 `daemon-reload`。把 Caddy 示例域名换为实际域名，执行 `caddy fmt --diff /etc/caddy/Caddyfile`、`caddy adapt --config /etc/caddy/Caddyfile --validate`；后者校验配置但不会启动服务。[Caddy 官方命令说明](https://caddyserver.com/docs/command-line)

静态站点 fallback 是 Wasp 的 **`200.html`**，确保 `/app/ads/:adId` 可直达。当前包没有 index.html，因此非 assets 的 `file_server` 显式设置 `index index.html 200.html`，避免首页 `/` 已匹配根目录却找不到默认索引。`/assets/*` 单独处理，缺失资源返回404，不把页面HTML当作可缓存一年的素材。默认不启用带完整请求 URL 的访问日志，避免一次性邀请 / 认证 token 被日志记录。该规则已有静态断言，Caddy 实际运行尚未验证。[Caddy 官方 try_files 说明](https://caddyserver.com/docs/caddyfile/directives/try_files)

核实当前版本与目标版本后，先记录 `previous`，用临时符号链接＋同文件系统 rename 原子切换 `current`，再重启 API 与 worker，最后复核 Caddy。不要直接覆盖运行中的版本目录，也不要自动删除上一版本或故障证据。

```bash
# 在版本、数据库迁移与回退兼容性已经审核后执行。
cd /srv/ad-research
ln -s releases/20261004-abcdef0 current.next
mv -Tf current.next current
sudo systemctl restart ad-research-api ad-research-worker
curl --fail --silent https://api.research.example.com/health
```

`/health` 的 HTTP 200 只表示 API / DB 可用，必须同时检查 JSON 的 `worker`、`source` 和 `email`。来源暂停 / 未配置、worker 失联、邮件积压会显示 degraded，不能只看状态码宣布健康。再验注册收信、邀请接受、A / B 团队隔离、广告直达 / 多素材、收藏 / 笔记、分析 / 取消、账单入口及 worker 独立重启。两个进程的日志进入 journal，只记录已脱敏的事件与状态。

## 回退

若问题仅来自应用版本且新迁移仍兼容上一版本：停止新 worker、切 `current` 到已记录的 `previous`、重启上一版 API / worker，再查健康和任务状态。回退前核对两版本使用相同环境文件与数据语义；不要把回退版本当作绕过来源限制或恢复已取消任务的办法。

若迁移与上一版不兼容，或数据已受损：停止写入并保留原库；把备份恢复到**新的**测试 / 恢复库完成计数 / schema / 关系校验，再经负责人确认正式连接切换方案。不要原地覆盖原库，不猜测性执行 SQL 回滚，也不自动对付费 / 私有资料重导。恢复演练工具故意只接受本机 test / restore 库，不提供远端生产覆盖入口。

目前发布模板、产物准备和本机数据库恢复可以留开发证据，但远端安装、systemd / Caddy、生产 TLS、第三方服务、回退和外部真人业务全部另记验收；未实际执行即为未验证。

独立告警程序及每分钟systemd部署模板见[健康告警](health-monitor.md)。包含发送去重、失败重试、状态恢复、目标隔离和脱敏；真实接收器未配置，尚未启用远端定时通知。

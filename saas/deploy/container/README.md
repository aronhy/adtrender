# 独立测试容器

这份模板只用于独立测试环境。它不接入现有 mailcow / sub2api 的网络或卷，不占用宿主 80 / 443，不操作现有容器。本机静态解析及Netcup Linux镜像、五迁移、API/worker、Chromium sandbox已验证。公网DNS/TLS尚未完成，实际版本、运行配置hash和验收边界见远端部署记录。

## 输入布局与构建

必须从 `prepare-release.mjs` 生成的新版本目录构建，不能直接把源码 checkout 当作上下文：

```text
release/
  release-manifest.json
  app/package.json
  app/package-lock.json
  app/.wasp/out/{server,sdk,libs,db,.waspinfo}
  app/src/
  app/dist-worker/index.mjs
  contracts/dist/collection.js
  public/200.html
  deploy/container/{Dockerfile,Dockerfile.dockerignore,compose.yml,garage.toml,...}
```

`app` 和相邻 `contracts` 原样进入同一个镜像。镜像固定官方 Node `24.14.1-bookworm-slim`，安装 npm `11.18.0`，执行锁定依赖安装、显式 Prisma generate 和 server bundle；Chromium 使用项目已锁定的 Playwright `1.62.1` 安装。API / worker 使用同一镜像，运行 UID/GID 为 1000；不自动迁移数据库。构建期间不会运行 npm audit。

```bash
# 在已审查的新 release 根目录执行。版本名与外置 release.env 中一致。
docker build --pull --tag ad-research-saas-test:20261004-review \
  --file deploy/container/Dockerfile .

# 之后始终在该目录运行 Compose，确保 seccomp 相对路径明确。
cd deploy/container
docker compose --project-name ds-meta-saas-test \
  --env-file /etc/ad-research-test/release.env config --quiet
```

若用 Compose 构建，可在相同目录执行 `docker compose --project-name ds-meta-saas-test --env-file /etc/ad-research-test/release.env build api`。不要同时给 api / worker 构建两个不同版本。部署时记录镜像 digest、release artifactHash 和构建日志；不要使用 `latest` 作为可回退版本标识。

## 外置配置

只复制 example 到 `/etc/ad-research-test/`，再由主线程写入**新的测试专用**凭证。五个文件均 root 0600，不放入 release、镜像或 Git。Compose 的 `format: raw` 保留密码中的 `$`，值不要额外包引号；不要输出 `docker compose config` 的完整内容，它会展开 env 文件。普通校验使用 `config --quiet`。

| 外置文件 | 内容 |
| --- | --- |
| `release.env` | 仅版本号与另外三个 env 文件的绝对路径，来自 `release.env.example` |
| `database.env` | 新容器测试库的 POSTGRES_DB / POSTGRES_USER / POSTGRES_PASSWORD；不使用宿主管理员或旧库密码 |
| `garage.env` | GARAGE_RPC_SECRET、默认 S3 access / secret key 和 bucket；重启保持一致 |
| `app.env` | 基于上一层 `server.env.example`，API 和 worker 共用同一文件 |
| `migration.env` | 仅迁移容器使用的 DATABASE_URL，采用独立 migrator 身份；不挂给 API / worker |

`app.env` 的数据库主机为 Compose 服务名 `database:5432`，使用独立的 `saas_app` 身份访问测试库；不使用 `database.env` 中的初始化管理账号。`migration.env` 指向同一个新测试库，使用独立 migrator 身份执行 DDL。主线程在迁移后授予 `saas_app` 业务表 / 序列所需 CRUD 权限，应用不持有 DDL 或 superuser 权限；后续迁移新增表也需核对授权。PostgreSQL 服务明确使用 UTC，不映射宿主端口。

Garage 的 bucket / credentials 对应 app 的 `S3_BUCKET` / `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`，`S3_REGION=garage`、`S3_FORCE_PATH_STYLE=true`。**S3_ENDPOINT 必须是 Nginx 反代 Garage 的浏览器可访问 HTTPS origin**。当前代码共用一个 endpoint 上传与签名；`http://garage:3900` 会生成浏览器无法使用的内部 HTTP 签名 URL。Nginx 必须保留原始 Host、路径和查询参数，且不要记录签名查询串。API / worker 仍加入 data + outbound，通过 outbound 连接该 HTTPS 地址、SMTP / OpenAI / Stripe；数据库只加入 internal data。Garage 加入 data + 独立普通 bridge ingress，使回环发布端口可用，不使用固定容器 IP。

唯一宿主映射为 API `127.0.0.1:13001` 与 Garage S3 `127.0.0.1:13900`。不映射数据库、Garage RPC / admin / website 端口。前端由现有 Nginx 读取 `release/public`，主页和深层路由均回退 `200.html`；缺失 `/assets/` 文件必须返回404。这里没有修改既有 Nginx 文件。

主线程在 Docker 29 目标环境实测：Garage 只接 internal 网络时即使声明 PortBindings，实际 3900 端口仍未发布，宿主回环连接失败。因此 ingress 明确采用普通 bridge；它不是防出网网络，Garage 的对外入口仍由宿主 `127.0.0.1:13900` 限定。更换此模板后，由主线程在原项目和版本目录运行下列定向重建，再核对回环 S3 响应；不删除或重建数据卷，不重启数据库及现有服务。修复后远端回环S3响应已回读为匿名403；未开放公网存储。

```bash
docker compose --project-name ds-meta-saas-test \
  --env-file /etc/ad-research-test/release.env up -d --no-deps --force-recreate garage
```

## Garage 单节点边界

按 [Garage 官方 quick start](https://garagehq.deuxfleurs.fr/documentation/quick-start/) 使用 `/garage server --single-node --default-bucket`，凭证从 env 读取；`garage.toml` 不包含密钥，RPC secret 使用官方支持的 `GARAGE_RPC_SECRET`。配置为 `/data/meta` 和 `/data/objects`，各自持久卷；PostgreSQL 使用第三个卷。Compose 项目名会为卷和网络加前缀，不指定已有容器名、外部网络或全局卷名。

镜像固定 `dxflrs/garage:v2.4.1`，数据库固定已选定版本 `postgres:15.17-bookworm`；部署时记录实际 image digest。单节点 `replication_factor=1` 没有冗余，只用于测试。不能据此宣布对象存储生产备份或高可用已经就绪。[Garage 配置说明](https://garagehq.deuxfleurs.fr/documentation/reference-manual/configuration/)

## 同域 Nginx 与静态发布

`nginx-site.conf.example` 使用用户于 2026-10-07 确认并注册的 **`adtrender.com`**。该文件是独立虚拟主机示例，只加载进既有 Nginx 的 http 配置；不得替换全局 nginx.conf、其他站点或 mailcow 配置。模板更新不代表已经安装或重载远端 Nginx。已有内部项目名、目录、bucket 和证书名 `ad-research-test` 保持不变，避免域名变更误建新数据卷。

前端重新构建时 `REACT_APP_API_URL`、服务端 `WASP_SERVER_URL` / `WASP_WEB_CLIENT_URL` 以及 `S3_ENDPOINT` 均为 `https://adtrender.com`。`S3_BUCKET` / `GARAGE_DEFAULT_BUCKET` 统一为 `ad-research-test-objects`，`S3_FORCE_PATH_STYLE=true`。S3_ENDPOINT 只填写 origin，不附带 bucket 路径；SDK 会生成 `/ad-research-test-objects/<key>?<signature>`。Google 控制台回调为 `https://adtrender.com/auth/google/callback`，完整接入要求见 Google 登录说明。

| 请求 | 本模板路由 |
| --- | --- |
| `/auth/…` | API 13001；覆盖 me / logout 和 email signup / login / verify / reset |
| `/operations/…` | API 13001；get-app-state / search-public-ads / get-public-ad / app-command |
| `/billing/stripe/webhook`、`/health` | API 13001；保留原方法、请求体和路径 |
| `/ad-research-test-objects/…` | Garage S3 13900；原始编码 URI、query、Host 保留；不向 Garage 转发其他 bucket 或根路径 |
| `/assets/…` | 静态文件；缺失返回404，不回退 HTML |
| `/`、`/app/…`、登录 / 邮件验证页 | `/www/wwwroot/adtrender/current/200.html` SPA fallback |

已核对当前 Wasp 生成路由与 main.wasp.ts：没有另立 `/media`、`/invitations` 或 WebSocket API；邀请、素材签名、成员、研究操作均经 `/operations/app-command` 或查询操作返回。以后增加 API 必须同步此列表，不应让 API 路径落入 SPA。Nginx 的 `proxy_pass` 不带 URI 后缀，S3 路由不变更路径，并用 `$http_host` 保持签名 Host。[Nginx 官方说明](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_pass)

所有 API 路径都会覆盖 `X-Real-IP` 为 Nginx 的 `$remote_addr`，不沿用访客传入的同名头。应用 `TRUSTED_PROXY_IPS` 只填写主线程创建网络后核验的代理 socket IP（容器网络中通常是实际网关 IP），禁止通配；应用只对该白名单 socket 读取单值 `X-Real-IP`，不据访客提供的 X-Forwarded-For 放宽限流。API 宿主端口仍只绑定回环。备用 Caddy 模板也显式设置 `header_up X-Real-IP {remote_host}`。

应用版本目录为 `/opt/ad-research-test/releases/<version>`，保留现有 root 专用父目录权限。仅将已核验 release 的 `public/` 导出到 `/www/wwwroot/adtrender/releases/<version>`，按发布 manifest 逐项比对文件路径、大小与 SHA-256；不导出应用源码、环境文件或备份。公开目录 0755、静态文件 0644，并以真实 Nginx 用户验证可读。`/www/wwwroot/adtrender/current` 原子指向对应公开版本，和应用 `current` 一同记录、切换及回退。不得通过放宽整个应用目录权限解决 Nginx 读取问题，也不能复用另一版本的旧前端。

切换前核对静态 JS 中的真实 API origin、公开文件可读权限、应用 / worker 镜像版本和数据库迁移；保留上一版本和对应镜像，只切换本应用软链接，不覆盖既有站点目录。Nginx 日志目录 `/var/log/nginx` 须在配置检查前存在。

ACME 只使用已有 webroot `/www/wwwroot/acme`。首次证书尚不存在时先仅加载示例的80端口 server 块并核对 challenge 可访问，再由主线程申请专用证书：

```bash
# 仅在确认 DNS 和 ACME 路由后，由主线程执行；模板不代表已申请。
certbot certonly --webroot -w /www/wwwroot/acme \
  --cert-name ad-research-test -d adtrender.com
```

获得 `/etc/letsencrypt/live/ad-research-test/{fullchain.pem,privkey.pem}` 后再加载443块；先 `nginx -t`，再按现有托管方式 reload，不新启第二个 Nginx。续期继续使用同一 cert-name / webroot，避免复用或覆盖别的证书。模板关闭 access log，只保留 critical 级错误，避免邀请 token 和 S3 查询签名出现在请求日志；运行诊断使用应用脱敏日志与 health。

本地 `nginx.test.mjs` 使用临时证书、高位回环端口和独立 prefix，不读取正式证书、不连接远端。它检查首页 / 深层 SPA、缺失 assets 404、API 分流、访客伪造 X-Real-IP 被覆盖和编码 S3 URI / Host 保留；本机结果不等于远端 TLS / Certbot 验收。

## 受控启动顺序与核验

下面是新环境的启动顺序；Netcup测试环境已完成对应迁移和服务启动。维护现有`20261005-test-3`（或回退test-2）必须在所有Compose命令加入`-f compose.yml -f /etc/ad-research-test/ds-meta-worker-runtime.yml`，不可遗漏外置sandbox修复。第一次迁移是新空库；后续迁移必须先做备份并核对恢复方案，不删除持久卷、不原地覆盖旧库。

```bash
# 当前目录：release/deploy/container
docker compose --project-name ds-meta-saas-test --env-file /etc/ad-research-test/release.env up -d database garage
# 版本需替换成此次已核验镜像；仅此短时容器读取 migrator 凭证。
docker run --rm --env-file /etc/ad-research-test/migration.env \
  --network ds-meta-saas-test_data ad-research-saas-test:20261004-review \
  node node_modules/prisma/build/index.js migrate deploy --schema=.wasp/out/db/schema.prisma

# 主线程核对迁移成功并授予 saas_app CRUD 后，再启动应用。
# 不访问外网、不连接数据库，确认非root Chromium能在sandbox中启动。
docker compose --project-name ds-meta-saas-test --env-file /etc/ad-research-test/release.env run --rm --no-deps worker \
  node /opt/ad-research/check-browser.mjs

docker compose --project-name ds-meta-saas-test --env-file /etc/ad-research-test/release.env up -d api worker
curl --fail --silent http://127.0.0.1:13001/health
```

Compose API healthcheck只查 API / 数据库；必须另读 `/health` 的 worker / source / email 状态。然后按项目验收表验证真实收信、S3 写入 / 签名 / 到期 / 删除、两租户隔离、广告 / 收藏 / 分析、独立 worker 重启。未配置来源或供应商时 degraded 是事实，不把200当全部健康。需要临时停止时只指向 `--project-name ds-meta-saas-test` 的指定服务，不执行影响其他项目的清理命令。

## Chromium sandbox

镜像以 UID/GID 1000 运行，worker 使用独立 1GiB `/dev/shm`、Docker init、只读根目录和临时目录，保持 `cap_drop: [ALL]`、`no-new-privileges:true`，不使用 host IPC、privileged、SYS_ADMIN 或 `seccomp=unconfined`。模板基于 [Playwright 1.62.1 官方 seccomp 配置](https://github.com/microsoft/playwright/blob/v1.62.1/utils/docker/seccomp_profile.json)，原始 SHA-256 为 `cc3e61cabda6bbc1e53e54d27ba4d55a9d3be829b6dd1a596f4a7b31b1cc7849`，许可证随附；项目仅移除 `chroot` 规则的 `includes.caps` 条件并添加原因注释，现文件 SHA-256 为 `b1645f71c92c70e43cb869b511867c7430a75d423d7bdc76a542e5f38274fc5c`。

主线程的远端 Linux 检查在 `sys_chroot('/proc/self/fdinfo/')` 失败。[Chromium 源码](https://chromium.googlesource.com/chromium/src/sandbox/+/refs/heads/main/linux/services/credentials.cc) 用该调用收紧 sandbox 的文件系统访问；原规则按容器启动时 capability 决定是否允许 syscall，`cap_drop: ALL` 会排除它。本次仅允许 syscall 进入内核，不添加容器 capability；[Linux chroot 实现](https://github.com/torvalds/linux/blob/v6.12/fs/open.c#L569-L587) 仍检查当前 user namespace 的 `CAP_SYS_CHROOT` 和 `security_path_chroot`。默认 seccomp action 仍为 ERRNO，其他规则原样保留；这不替代远端 sandbox 启动验收。

已制作且 manifest 固定的 release 不原地改文件。若主线程先对现有测试镜像应用此运行修复，可将新 profile 放在 `/etc/ad-research-test/seccomp_profile.json`（root 0600），外置 `/etc/ad-research-test/ds-meta-worker-runtime.yml` 只写：

```yaml
services:
  worker:
    security_opt: !override
      - no-new-privileges:true
      - seccomp=/etc/ad-research-test/seccomp_profile.json
```

[Compose `!override`](https://docs.docker.com/reference/compose-file/merge/#replace-value) 要求版本至少 2.24.4，它完全替换 security_opt，避免同时留下两份 seccomp；目标 Compose 5.5.1 满足版本要求。主线程须用基础 compose + 此 override 的双 `-f` 参数进行解析、sandbox 检查及后续 worker 操作，并单独记录两个外置文件的 hash、镜像 digest 和 release artifactHash。核对最终 worker 仍为 UID 1000、cap_drop ALL、只读根文件系统和 NNP，API 配置不变。此时 release manifest 记录原文件，运行配置 hash 另行记录；下个 release 默认包含修复后的 profile。

必须同时确认业务适配器 `chromium.launch` 启用 `chromiumSandbox:true`；仅设置 USER 不会改变 Playwright 默认值，适配器由主线程 / collector 子任务整合。上面的检查脚本只打开本地HTML，强制 sandbox；若宿主内核 / AppArmor 不允许用户 namespace，检查会失败，须记录并交由主线程处理，不能以增加 `--no-sandbox` 绕过。[Playwright 容器说明](https://playwright.dev/docs/docker)

本地静态检查：`saas/toolchain/node_modules/.bin/node --test saas/deploy/container.test.mjs`。检查覆盖 Caddy 根路径、镜像关键参数、Compose 真实解析、端口与网络边界；它不替代 Docker build 或运行验收。

2026-10-04 本地验证：项目 Node `24.14.1` 执行 `prepare-release.test.mjs`、`container.test.mjs`、`nginx.test.mjs`，最终25项通过、0跳过（准备工具7、容器5、Nginx2、告警11）；其中 Nginx `1.26.3` 为独立临时进程实测。远端容器镜像构建与Linux Chromium另已通过；Caddy和公网TLS仍未验收。S3回环与公网签名的证据分别记录，不能互相替代。

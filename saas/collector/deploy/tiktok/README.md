# TikTok 常驻采集部署

独立 `tiktok-collector.service` 管理固定名称的 Docker 容器 `tiktok-collector`，复用现有 Meta/Pinterest 服务器、不可变应用镜像和 `ad_research_test` 广告库。网站进程与当前对话退出不影响该服务。

**2026-10-07 状态：**本机匿名浏览器取得 3 条真实详情，真实批次的数据库权限、幂等和历史保护回滚验证通过；远端有界 probe 也取得同批 3 条。本轮服务已启用，systemd 为 `active/enabled`，动态目录为 33 国、初始 165 个任务；已自动新增 85 条、更新 3 条，重启断点检查通过。18:21 遇到来源限流，保留数据后冷却至当日 19:21:44（UTC+8），届时自动重试。生产批次间隔已调为 600 秒。详见实际验收记录。素材下载、完整遍历和长期无人值守验收尚未完成。

## 采集与调度

- 国家目录通过公开页面的 `Ad target country` 控件动态读取，本轮实测 33 国；代码不把这个数字或美国写死。每个 UTC 日重新发现目录。新国家默认回溯近 30 个 UTC 日期，已有国家补昨天至今天的重叠增量窗口。
- 查询采用网页 `Last shown date`。初始窗口跨度 7 天，相邻窗口共享一个边界日期；网页不支持起止同一天，最小窗口是相隔 1 天的两个日期。查询日期不代表广告投放起止日期。
- 失败计数为 1–2 的任务，在 `retryAt` 到期后优先重试，避免被初始任务积压拖延；达到 3 次失败后回到普通的最近执行时间轮转，避免持续失败任务垄断队列。未来 `retryAt` 不会提前领取，全局暂停和冷却仍优先。每批最多 20 条；成功提交一批后代码默认等待 120 秒，本次生产配置为 600 秒以降低请求密度。该数量是运行及事务预算，不是来源广告总量限制。
- 每批启动全新的匿名 Chromium 和浏览器上下文，关闭时销毁。没有持久化浏览器 profile，不复制个人 Cookie 或账号会话。浏览器只继承 PATH、HOME、LANG、TZ 和 Playwright 路径等白名单环境变量，不继承数据库连接。
- 页面没有稳定游标。下一批从列表开头重放，跳过已提交的 `seen` ID；`page` 保存已到达的 `View more` 层级。默认本轮搜索范围为 `min(2000, job.page + 30)` 层，同时限制约 240 秒，另有 5 秒浏览器关闭缓冲。
- 仅详情与证据成功、数据库确认提交后才记录成功 ID。`PARTIAL` 可入库已成功的详情，但不会推进页码或宣称该分片完成。
- 已提交批次为 `TIKTOK_REPLAY_BUDGET` 或 `TIKTOK_TIME_BUDGET`、没有新增成功 ID、窗口跨度大于 1 天时，按中间 UTC 日期拆成两个重叠子片。父片标记 `superseded`，保留历史但不再调度或刷新，也不记为完成。子片 ID 由国家和日期确定，重放不重复建任务。最小 1 天窗口仍保留未完成状态与退避。
- 涉及最近两天、且没有失败退避的窗口每 6 小时开始新的观察周期。失败窗口的 `seen` 和等待时间不会被刷新清空。
- 当前未验证可靠的列表结束标志。两次提交搜索都显示空列表只记 `NO_RESULTS / REPEATED_EMPTY_NOT_EXHAUSTIVE`，仍为 `exhausted=false`；看不到 `View more` 记 `TIKTOK_END_UNCONFIRMED`。预算耗尽、空页面和 partial 都不能证明采完，`completeSourceCoverage` 始终为 false。

## 失败与恢复

普通分片失败从 1 分钟开始指数退避，最多 6 小时。429 / 限流触发全服务冷却：从 1 小时逐步延长，普通上限 24 小时；若来源 `Retry-After` 更长，则按来源要求等待。不能通过切换国家继续访问受限来源。

验证码、登录要求和 403 / access blocked 进入 `manualPause`，须人工确认限制已解除，再使用 `--resume`。目录发现也执行同样的暂停和冷却规则；其他目录、磁盘或服务错误记录 `serviceError`，不伪造可用目录，默认 60 秒后再检查。没有验证码破解、账号轮换或自动换 IP。

持久化顺序为：私有批次归档 → `state.json` 保存 pending → `tiktok_collector.ingest(text)` → 确认 `IMPORTED` 或 `ALREADY_IMPORTED` → 更新断点。数据库失败时 pending 保留；重启先校验路径和 SHA-256，再重放同一批字节，之后才访问来源或刷新目录。不要手工清空 pending。

`status.json` 在批次开始、提交及等待循环中更新，包含 `state`、`updatedAt`、`pending`、`activeJobId`、`manualPause`、`pauseUntil`、`serviceError`、`completedJobs`、`supersededJobs` 和最近回执。空闲、暂停或冷却通常每 15 秒刷新；采集中可间隔一个批次才再次写入。`RUNNING` 只表示运行状态。

## 数据与权限

- 固定来源 `tiktok_commercial_library`、平台 `TIKTOK`、版本 `tiktok-public-dom-1`；每事务最多 20 条和 25 MB 原始 JSON。
- 数字广告 ID、规范来源 URL、同 ID 的 HTTP 200 详情证据、可见 `Ad ID` 和观察时间必须一致；`completedIds` 必须恰好对应本批广告。
- 查询国家与来源披露地区分别保存。广告状态为 `UNKNOWN`；first shown / last shown 保留为来源字段，不写成投放开始或结束时间。付款主体、注册地、列表显示名和详情广告主名保留各自含义。
- 有真实 `adv_biz_ids` 才按来源广告主 ID 关联；缺少稳定 ID 时采用 `ad-local:<sourceAdId>`，不按同名合并广告主。
- 保存文案、来源字段和媒体 URL 元数据。媒体初次入库为 `UNAVAILABLE / PLATFORM_MEDIA_ADAPTER_PENDING`；符合 TikTok 来源规则的图片和视频已接入统一素材服务，保存成功后为 READY。常驻采集器另有有界来源链接刷新，保留旧观察与失败记录。当前文件保存与采集状态见系统总览。
- SHA-256 批次幂等；旧观察追加历史，不覆盖较新的广告或广告主事实。空 `FAILED` / `NO_RESULTS` 也可记运行记录；后者在运行表映射为 `SUCCEEDED`，原始语义保留在 `coverage.batchStatus`。
- 原始证据可能含平台签名媒体 URL，目录权限 0700，证据和状态文件 0600。不要把原始批次、签名 URL、数据库连接写入公开日志或 Git。

`tiktok_collector_runtime` 只有数据库 CONNECT、专用 schema USAGE 和 `tiktok_collector.ingest(text)` EXECUTE。函数固定 `search_path=pg_catalog`、UTC，显式引用 public 表，撤销 PUBLIC 执行权限。专用账户不能直接读用户、凭据、广告表，不能直接写表、DDL、TEMP 或切换角色。

来源与归档任务在旧采集系统中保持 `PAUSED`，独立 daemon 由 systemd 控制；不要打开旧 Meta-only 调度器来启动 TikTok。

## 远端文件

| 内容 | 位置 |
| --- | --- |
| daemon / probe bundle、SQL、验证脚本 | `/opt/tiktok-collector/code/` |
| 启动脚本、Chromium seccomp | `/opt/tiktok-collector/run.sh`、`/opt/tiktok-collector/seccomp_profile.json` |
| 状态、进程锁与归档 | `/var/lib/tiktok-collector/evidence/` |
| 原始批次 | `/var/lib/tiktok-collector/evidence/archive/tiktok/<sha>/batch.json` |
| 独立 probe / 回滚验证证据 | `/var/lib/tiktok-collector/validation/` |
| 专用数据库连接，0600 | `/etc/tiktok-collector.env` |
| 不可变镜像 ID，0600 | `/etc/tiktok-collector-runtime.env` |

数据库证据引用为 `local-private:tiktok/<sha>/batch.json`；服务内 `TIKTOK_STATE_DIR=/data`。代码默认间隔 `TIKTOK_INTERVAL_MS=120000`，本次生产配置为 `600000`；首次回溯 `TIKTOK_LOOKBACK_DAYS=30`、浏览器 channel 为 `chromium`。

## 构建与有界 probe

在仓库根目录运行，使用已安装的 Playwright Chromium：

```sh
./node_modules/.bin/vitest run --config saas/vitest.config.ts saas/collector/src/tiktok-service
./node_modules/.bin/tsc -p saas/collector/src/tiktok-service/tsconfig.json
./node_modules/.bin/esbuild saas/collector/src/tiktok-service/daemon.ts --bundle --platform=node --format=esm --packages=external --outfile=/tmp/tiktok-daemon.mjs
./node_modules/.bin/esbuild saas/collector/src/tiktok-service/probe.ts --bundle --platform=node --format=esm --packages=external --outfile=/tmp/tiktok-probe.mjs
./node_modules/.bin/tsx saas/collector/src/tiktok-service/probe.ts --catalog --channel chromium
./node_modules/.bin/tsx saas/collector/src/tiktok-service/probe.ts --out /private/tmp/tiktok-probe-20261007 --country DE --start 2026-10-06 --end 2026-10-07 --limit 3 --channel chromium
```

日期和国家按本次验证目标调整，起止至少相隔一天。`probe.json` 保存在指定私有目录；stdout 仅输出状态、数量、ID、国家及媒体类型。probe 不连接数据库，也不推进服务队列。

将两个 bundle 与本目录的 `ingest.sql`、`provision.py`、`verify-permissions.mjs` 发布至远端 code 目录；`run.sh` 放至服务根目录并设为可执行，复用已经验证的 Chromium seccomp 文件。持久目录属主设为 UID/GID 1000、权限 0700，代码由部署 owner 持有并只读挂载。

在服务器由部署 owner 运行：

```sh
python3 /opt/tiktok-collector/code/provision.py
```

首次可在该进程提供 `TIKTOK_IMAGE=sha256:<64 hex>`；否则采用现有 Meta/Pinterest 容器的不可变 image ID，以后沿用保存值。已有角色和密码不重置。发现既有继承权限、TEMP/CREATE 或直接表权限异常时停止部署，先查清权限；脚本不会修改其他服务的共享授权。

## 真实批次回滚验证

在单独验证容器中，复用应用镜像的 Node/Prisma，将真实 `probe.json` 只读挂载为 `/validation/batch.json`，将 `verify-permissions.mjs` 只读挂载至应用目录，加载专用账户的环境文件，再运行：

```sh
node /opt/ad-research/app/tiktok-service/verify-permissions.mjs
```

容器须接入数据库内部网络；`TIKTOK_VALIDATION_BATCH`、`TIKTOK_APP_PACKAGE` 可覆盖默认路径。该脚本检查受限权限、合法导入、SHA 重放、旧观察保护、错误来源/证据拒绝和空批次，所有测试写入都回滚。可在这个独立 owner 验证进程临时提供 `TIKTOK_OWNER_DATABASE_URL` 增加实际表读回；该凭据不得进入服务环境文件或浏览器进程。

安装对应 systemd unit 并通过代码、真实来源 probe 和权限回滚验证后启用：

```sh
systemctl daemon-reload
systemctl enable --now tiktok-collector.service
systemctl status tiktok-collector.service
cat /var/lib/tiktok-collector/evidence/status.json
docker logs --tail 20 tiktok-collector
```

## 停止、重启与人工恢复

```sh
systemctl stop tiktok-collector.service
systemctl start tiktok-collector.service
systemctl restart tiktok-collector.service
systemctl disable --now tiktok-collector.service
```

停止会中断等待循环，允许当前批次完成归档和提交；Docker 停止宽限 300 秒，systemd 总停止超时 320 秒。超时强制退出后仍依靠 pending 幂等恢复。

`process.lock` 采用独占创建。正常退出释放；存在锁时直接拒绝启动，不按 PID 或 hostname 抢锁。`run.sh` 只有确认固定名称 `tiktok-collector` 容器不存在后，才清理遗留 `process.lock`。它不清理浏览器 Singleton 锁，因为此服务没有持久 profile。不要在旧进程仍运行时删除进程锁，也不要在服务内另起一个 daemon。

**`--resume` 必须先停止服务。** 人工确认来源限制已解除后，确认旧容器已退出；若遗留已停止的容器，由 owner 先处理容器再恢复。以下命令只读取不含数据库连接的 runtime.env；不要 source 数据库环境文件。

```sh
systemctl stop tiktok-collector.service
if docker inspect tiktok-collector >/dev/null 2>&1; then
  echo 'TIKTOK_CONTAINER_STILL_EXISTS' >&2
  exit 1
fi
. /etc/tiktok-collector-runtime.env
export TIKTOK_IMAGE
/opt/tiktok-collector/run.sh --resume --once
cat /var/lib/tiktok-collector/evidence/status.json
```

`run.sh` 透传参数，并继续使用同一固定容器名、进程锁与安全配置。`--resume --once` 清除手动暂停和全局冷却后执行至多一个队列步骤，可能立即访问来源和提交一批数据；它不只是修改标志。回执正常且未再次出现 manualPause 后，再 `systemctl start tiktok-collector.service`。若仍受限，保留证据和暂停，不反复执行 resume。

容器没有公开监听端口，非 root、只读根目录、Chromium 沙箱/seccomp、cap-drop ALL；2 CPU、2 GiB、384 PID。常驻容器日志轮转 10 MB × 3。剩余磁盘低于 2 GiB 时不发起新采集，pending 提交仍优先尝试。证据尚未自动清理，需纳入磁盘与备份管理。

## 验收边界

本地和远端有界 probe 的 3 条真实样本证明相应查询的列表、详情、证据和入库契约。本轮相关回归为 12 文件、83 测试通过，其中 TikTok 独立测试 50 条，生产 TypeScript 检查通过。常驻服务已确认自动入库、重启断点保留及真实限流退避；更多国家、深分页、长期成功率及网页端人工验收仍需继续记录。没有下载媒体文件，也未证明全库覆盖。

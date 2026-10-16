# 独立广告素材存储服务

`ad-media-storage.service` 从共享广告库领取素材，下载真实图片或视频并写入私有 S3；成功后记录 `storageKey`、SHA-256、MIME、字节数和下载时间。采集器继续负责广告与原始证据，存储服务不修改来源 URL、广告文案或平台身份。

支持 Meta、Google / YouTube、TikTok、Pinterest、Snapchat 的已验证素材路径。Pinterest 图片已有真实存储验证；视频适配支持已验证的公开 Pin MP4 路径，但真实 Ads Repository 广告视频的采集、入库和存储闭环仍待验证。进程运行或样本验证不代表全库下载完成。

## 运行边界

- 单文件最大 **256 MiB**；视频下载最多 **90 秒**，图片最多 **20 秒**。HTTPS、每跳公共 DNS、来源主机/路径、MIME、文件头、长度和 SHA-256 均校验；不把头像、HTML 或播放器页面当素材。
- 常驻进程并发 2，使用 `FOR UPDATE SKIP LOCKED` 与普通 worker 共用行锁；新增记录与历史积压交错处理。独立运行多个下载命令会叠加并发。
- 网络、超时、HTTP、存储失败最多 **5 次实际下载尝试**；间隔依次为 30 秒、2 分钟、8 分钟、30 分钟。第 5 次失败后不再自动重试；次数和下次时间保存在数据库，重启不重置。正常取消不消耗重试次数。
- 来源不支持、头像、类型不符等错误不盲目重试。旧 `MEDIA_URL_REJECTED` / `MEDIA_TOO_LARGE` 记录仅在当前策略支持且尝试数为 0 时重新领取。
- 状态目录所在磁盘剩余不足 2 GiB 时暂停领取，空间恢复后再继续。容器限制为 3 GiB、2 CPU、128 PID，日志轮转 10 MiB × 3。
- 源 URL 的 `expire` / `oe` 或平台签名失效不等于已存文件失效。已保存文件由系统保留策略及 `MediaObject.expiresAt` 管理；不要把源 URL 的过期时间写成存储文件的删除时间。网站短时 S3 访问签名到期后应重新签发，文件本体仍保留。

上传成功但数据库 COMMIT 回执不明时，worker 对原素材 ID 再次加行锁，等待旧锁释放后核对；确认已 `READY` 就保留对象并返回 `READY`。数据库不可读或结果无法确认时也保留对象，不根据一次异常盲目删除。后续孤儿对象核对由 owner 检查全部引用后处理，不自动扫删；不为此给媒体运行角色增加 `PrivateFile` 读取权限。

## 构建与部署

在仓库根目录使用已安装依赖构建。每次生成新目录，避免覆盖已验证的 bundle：

```sh
MEDIA_BUILD=$(mktemp -d /private/tmp/ad-media-storage-release.XXXXXX)
mkdir -p "$MEDIA_BUILD/schema"
./node_modules/.bin/esbuild saas/worker/src/media-storage-cli.ts --bundle --platform=node --format=esm --packages=external --outfile="$MEDIA_BUILD/media-storage.mjs"
./node_modules/.bin/esbuild saas/worker/src/media-recovery-cli.ts --bundle --platform=node --format=esm --packages=external --outfile="$MEDIA_BUILD/media-recovery.mjs"
./node_modules/.bin/esbuild saas/worker/src/media-priority-cli.ts --bundle --platform=node --format=esm --packages=external --outfile="$MEDIA_BUILD/media-priority.mjs"
cp saas/worker/deploy/media-storage/run.sh saas/worker/deploy/media-storage/provision.py saas/worker/deploy/media-storage/ad-media-storage.service saas/worker/deploy/media-storage/verify-storage.mjs "$MEDIA_BUILD/"
cp saas/app/schema.prisma "$MEDIA_BUILD/schema/schema.prisma"
cp -R saas/app/migrations "$MEDIA_BUILD/schema/"
```

上传构建目录内容至 `/opt/ad-media-storage/code/`。`schema/` 使用当前 `saas/app/schema.prisma` 和完整 `saas/app/migrations/`，保留 `migration_lock.toml`；本轮有 9 个迁移目录，新增 `20261008120000_media_download_retry`。不要从旧 `.wasp/out` 复制不包含新迁移的 schema。

数据库迁移由部署 owner 执行，运行角色没有迁移权限。先建立私有备份并确认可读取目录，再使用现有不可变应用镜像应用迁移：

```sh
umask 0077
install -d -m 700 /opt/ad-media-storage/backups
MEDIA_BACKUP=/opt/ad-media-storage/backups/pre-media-retry-$(date -u +%Y%m%dT%H%M%SZ).dump
docker exec ds-meta-saas-test-database-1 pg_dump -U saas_migrator -Fc ad_research_test > "$MEDIA_BACKUP"
docker exec -i ds-meta-saas-test-database-1 pg_restore --list < "$MEDIA_BACKUP" > /dev/null
MEDIA_IMAGE=$(docker inspect ds-meta-saas-test-api-1 --format '{{.Image}}')
docker run --rm --network ds-meta-saas-test_data \
  --env-file /etc/ad-research-test/migration.env \
  -v /opt/ad-media-storage/code/schema:/media-schema:ro \
  "$MEDIA_IMAGE" node /opt/ad-research/app/node_modules/prisma/build/index.js migrate deploy --schema /media-schema/schema.prisma
```

迁移只新增 `downloadAttempts`、`lastDownloadAttemptAt`、`nextDownloadAttemptAt`、次数约束和索引。已应用时 `migrate deploy` 不重复执行；不要手工 `resolve` 绕过失败，也不要为回滚删除这些字段或广告数据。

服务端私有配置来源为 `/etc/ad-research-test/app.env`。`provision.py` 仅读取 S3 相关白名单项，生成独立数据库角色及 `/etc/ad-media-storage.env`（0600）。必需项为 `DATABASE_URL`、`S3_BUCKET`、`S3_REGION`、`AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`；另支持 `S3_ENDPOINT`、`S3_FORCE_PATH_STYLE`、`AWS_SESSION_TOKEN`，状态目录固定为 `/data`。这些值不进入 Git、前端或日志。

S3 沿用既有私有 bucket 配置，本服务只写 `public-media/`。若另配凭据，应限定该前缀的 Put/Get/Delete 权限。镜像锁保存在 `/etc/ad-media-storage-runtime.env`（0600），仅包含不可变 `MEDIA_IMAGE=sha256:…`，不包含数据库或 S3 凭据。

完成迁移后安装服务：

```sh
python3 /opt/ad-media-storage/code/provision.py
install -d -m 700 -o 1000 -g 1000 /var/lib/ad-media-storage
install -m 755 /opt/ad-media-storage/code/run.sh /opt/ad-media-storage/run.sh
install -m 644 /opt/ad-media-storage/code/ad-media-storage.service /etc/systemd/system/ad-media-storage.service
systemctl daemon-reload
systemctl enable --now ad-media-storage.service
```

角色、配置或镜像不一致时先核对错误原因；不要删除既有私有配置来绕过保护。服务不发布端口，代码只读挂载，使用数据库内部网络与独立出站网络；既有 API、worker、采集器镜像不随此安装自动切换。S3 的公网 Nginx location 需要 `client_max_body_size 272m`，容纳 256 MiB 文件及传输封装；API location 保留 `2m`。更新对应 location 后先 `nginx -t`，不替换整个既有站点配置。

## 数据库最小权限

`media_storage_runtime` 为非超级用户、不可建库/建角色、不继承额外角色，连接上限 8；statement timeout 为 150 秒，空闲事务超时 180 秒。授权仅为：

| 范围 | 权限 |
| --- | --- |
| `ad_research_test` / `public` | CONNECT / USAGE |
| `MediaObject` | SELECT |
| `Ad` | 只 SELECT `id`、`dataSourceId` |
| `DataSource` | 只 SELECT `id`、`key` |
| `MediaObject` 更新列 | `updatedAt`、`status`、`errorCode`、`storageKey`、`mimeType`、`sizeBytes`、`sha256`、`type`、`downloadedAt`、`expiresAt`、三个下载重试字段 |

不授权用户表、来源凭据、广告/来源写入、INSERT/DELETE 或 DDL。`verify-storage.mjs` 实际验证用户读取、凭据读取、来源更新、广告更新及建表均被拒绝。

## 状态、统计与存储验证

```sh
systemctl is-active ad-media-storage.service
systemctl is-enabled ad-media-storage.service
cat /var/lib/ad-media-storage/status.json
docker logs --tail 30 ad-media-storage
docker exec ad-media-storage node /opt/ad-research/app/media-storage/verify-storage.mjs
```

`status.json` 的 `counts` 是本次进程的处理次数，重启后重新累计；重复失败也计入，不能据此计算唯一素材完成数。`RUNNING` 表示进程状态；`PAUSED / DISK_SPACE_LOW` 每 60 秒检查空间，`PAUSED / MEDIA_SERVICE_ERROR` 15 秒后重试，`retryAt` 给出下次检查时间。

验证脚本按来源与类型抽取 9 类 `READY` 样本：Meta 图片/视频、Google 图片/视频、TikTok 图片/视频、Pinterest 图片、Snapchat 图片/视频。每类只取 1 条，重新 `GetObject` 核对实际字节数、SHA-256 和 MIME；缺少必需样本或校验不符会以非零状态退出。输出不含对象 key 或签名地址，不能代替全量核验，也未包含真实 Pinterest 广告视频。

按平台、类型、状态和错误查数据库累计量，不读取原始 URL：

```sh
docker exec -i ds-meta-saas-test-database-1 psql -X -U saas_migrator -d ad_research_test <<'SQL'
BEGIN READ ONLY;
SELECT s.key, m.type, m.status, coalesce(m."errorCode", '') AS error,
       count(*) AS media_count,
       coalesce(sum(m."sizeBytes") FILTER (WHERE m.status='READY'), 0) AS ready_bytes,
       count(*) FILTER (WHERE m.status='FAILED' AND m."nextDownloadAttemptAt"<=now()) AS due_retries
FROM "MediaObject" m
JOIN "Ad" a ON a.id=m."adId"
JOIN "DataSource" s ON s.id=a."dataSourceId"
GROUP BY s.key, m.type, m.status, m."errorCode"
ORDER BY s.key, m.type, m.status, m."errorCode";
COMMIT;
SQL
```

## 刷新源链接与有界恢复

403、超时或签名失效时，先让对应采集器重新观察同一广告详情，按正常证据与入库校验保存新 URL。旧观察保留，新合法 URL 成为新的下载候选；存储角色不能修改来源 URL。403 本身不能证明链接过期。已保存的文件无需因源 URL 过期重复下载，也不要重置所有失败次数来无限重试旧 URL。

只读查看当前可执行队列，默认不下载：

```sh
docker exec ad-media-storage node /opt/ad-research/app/media-storage/media-recovery.mjs --limit=50
```

确需有界恢复时先停止常驻服务，避免增加并发；以下临时容器最多领取 50 条、并发 2、总时限 15 分钟，仍遵守同一来源策略、重试时间和 5 次预算。可加 `--ad-id=UUID` 缩小范围。

```sh
systemctl stop ad-media-storage.service
. /etc/ad-media-storage-runtime.env
docker run --rm --name ad-media-storage-recovery --init \
  --user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --tmpfs /tmp:rw,nosuid,nodev,size=64m,mode=1777 --memory 3g --cpus 2 --pids-limit 128 \
  --network ds-meta-saas-test_data --network ds-meta-saas-test_outbound \
  --env-file /etc/ad-media-storage.env \
  -v /opt/ad-media-storage/code:/opt/ad-research/app/media-storage:ro \
  "$MEDIA_IMAGE" node /opt/ad-research/app/media-storage/media-recovery.mjs --limit=50 --execute
systemctl start ad-media-storage.service
```

`media-priority.mjs` 是 Google 视频的有界救援工具，最多选取 100 条，适用于仍有效的短时源链接；不是额外常驻调度器。需要执行时同样使用上述临时容器并暂停常驻服务，只替换末尾命令。普通 worker 若仍下载媒体，总并发也应一并核对。

## 更新与回滚

更新前保存上一版 bundle、启动脚本、unit 和镜像锁的 hash/副本。停止 `ad-media-storage.service`，确认专用容器退出后替换已验证文件，再启动并检查状态、统计及真实存储字节。systemd 停止给 Docker 150 秒，总超时 180 秒；重启延迟 30 秒。

回滚优先恢复上一版 bundle、启动脚本、unit 与匹配的不可变镜像；服务端私有凭据继续沿用。若上一版不支持当前迁移，先保持服务停止排查兼容性。新增数据库字段、历史观察和已存 S3 文件保留，不通过删除迁移或恢复旧数据库覆盖新增数据。只停用此独立服务可执行：

```sh
systemctl disable --now ad-media-storage.service
```

此操作保留数据库记录和 S3 文件，不影响网站与各平台采集器。备份恢复属于单独事故恢复步骤，应先在隔离目标验证。

## 同步原通用 worker

原通用 worker 也处理部分素材，必须同步相同的下载、重试和提交保护代码。只部署独立服务会留下旧下载逻辑。本轮采用现有 API 不可变镜像作为依赖基线，用 `worker.Dockerfile` 仅替换通用 worker bundle；不重建网站或 API。

在仓库根目录建立仅含 Dockerfile、bundle 和 source map 的构建目录：

```sh
WORKER_BUILD=$(mktemp -d /private/tmp/ad-media-general-worker.XXXXXX)
./node_modules/.bin/esbuild saas/worker/src/cli.ts --bundle --platform=node --format=esm --target=node24 --packages=external --sourcemap --outfile="$WORKER_BUILD/index.mjs"
cp saas/worker/deploy/media-storage/worker.Dockerfile "$WORKER_BUILD/Dockerfile"
git rev-parse HEAD
shasum -a 256 "$WORKER_BUILD/index.mjs"
```

上传上述三个文件到专用服务器目录，构建时传入已提交的源码 SHA 和 bundle SHA。基线镜像只打本地 tag，不拉取或安装依赖；新 image 的 revision 与 bundle-sha256 标签分别记录这两个值。先以 `--network none` 执行新 image 的 `node dist-worker/index.mjs --help`，确认依赖能加载且不运行任务。

最后追加一个仅修改 worker 的 Compose override：image 使用实际 `sha256:…`，`pull_policy: never`，`stop_grace_period: 180s`。保留现有三个 Compose 文件和私有 release.env，只用 `up -d --no-deps --no-build --pull never --force-recreate worker` 更新通用 worker。不能执行 `--remove-orphans`，不能重建 API、数据库或 Garage。

更新前记录 worker/API 的容器 ID、image、配置路径和媒体字段权限；更新后核对 worker 的 bundle SHA、heartbeat、/health 及真实文件。回退使用原三个 Compose 文件去掉最后 override，再只重建 worker。未来完整应用发布应包含最新 worker bundle并移除本次专用 image override，避免旧修复覆盖新版本。

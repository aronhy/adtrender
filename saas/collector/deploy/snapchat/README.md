# Snapchat 独立常驻采集

`公开广告主候选池 → Snapchat Ads Gallery 验证 → 私有原始证据 → 受限入库函数 → 共享广告数据库`。独立进程运行，没有付费采集 API。其他平台已采到的公开广告主名称可作为候选线索；广告详情、状态、国家和素材仍只凭 Snapchat 原生证据入库。

## 数据与覆盖

2026-10-07 先在匿名浏览器实测网页请求，再用原生 Node fetch 验证同一公开入口：

- `POST https://adsapi.snapchat.com/v1/ads_library/ads/search?limit=8`：`countries` 和 `paying_advertiser_name`，读取来源返回的 `paging.next_link`。
- `GET https://adsapi.snapchat.com/v1/ads_library/ads/<UUID>`：逐条读取完整公开详情。无需账号和令牌，不采集会话请求头。
- 来源 `snapchat_ads_gallery`，平台 `SNAPCHAT`，唯一键为来源 + UUID。广告主名称不是稳定广告主 ID，不凭名称创建虚假 ID。
- 首版 12 个词只用于首次启动。2026-10-09 增加动态候选池：每小时从现有广告库的公开 Advertiser 名称、观察快照的 advertiserName / brand / advertiser.name 更新名称目录，并合并共享电商、游戏、漫剧主库的官方产品／公司名称线索；Snapchat 每次真实入库后继续扩展付款方和品牌名称。名称按大小写去重，保留原语言和来源，不生成虚假广告主 ID。
- `export-candidates.py` 通过已有 owner 运维入口只读导出公开名称，写入 `advertiser-candidates.json`；`snapchat-candidates.timer` 每小时刷新。采集角色仍只有原来的 ingest 权限，不增加表读取权限。目录失败时保留上一份原子文件；采集器状态明确显示 MISSING / INVALID / STALE，不能将缺失目录报告成广泛发现。
- 名称只是候选，收到 Snapchat 广告并成功入库才确认。状态分别报告 publishers、candidatePublishers、confirmedPublishers、unvisitedPublishers；这些是检索名称数，不是稳定广告主实体数或已采广告数。
- 默认 `ALL` 查询，保留来源所有返回地区；可用地区来自实测菜单：欧盟 27 国 + Turkey，共 28 国。来源介绍为最近 12 个月，每日更新。广告主检索必填；这不是 Snapchat 全球全量枚举。
- `queryCountry` 为请求条件，`reportedCountries` 只取来源曝光量大于 0 的国家。零曝光项仍保存在原始曝光映射。来源 `el` 规范化为 `GR`，原始字段保留。
- `languages` 使用来源实际声明，空值不推断；标题、CTA、商品描述等原语言保留。商品描述留在 products，不拼成广告正文。没有正文则 body=null。
- PAUSED 对应 INACTIVE，同时保存原始 sourceState；未知状态为 UNKNOWN。日期只读来源 start_date/end_date。
- 曝光量是来源说明的生命周期或最近 12 个月累计、非去重曝光，不是点击、转化或实际花费。
- 完整公开响应保留在私有归档；完整详情也入观察快照，包含商品、定向、审核字段及素材引用。只把明确图片/视频字段转成 MediaObject；模板 HTML、品牌 logo 不当创意文件。素材初次入库为 `UNAVAILABLE / PLATFORM_MEDIA_ADAPTER_PENDING`，符合 Snapchat 平台规则的图片和视频已接入统一素材服务，文件保存成功后为 READY；签名来源链接可能过期。当前状态见系统总览。

## 调度与恢复

- 单进程原生 HTTP，无浏览器常驻，1 CPU / 512MiB 内存限额；非 root、只读根目录、无公网端口。
- 每批最多 2 个源列表页、通常 8 条详情；全新两页合并时最多 15 条。单请求最多 45 秒、批次 180 秒、详情间隔 1 秒；批次间隔 10 分钟。有可执行任务时交替安排候选发现和持续监测，避免新增候选或大品牌翻页长期独占队列。已确认名称末页隔天复查；尚未确认且明确无结果的候选 7 天后再试。
- 使用来源游标，批次/时间预算不表示采完。广告库公开返回可能变化，不能承诺不遗漏。过期游标 HTTP400 后保留已采 ID、从首屏重新推进。
- 403、429、验证页、登录要求全局退避 1 小时起、最高 24 小时，并尊重更长 Retry-After；不破解验证、不换账号或 IP。普通错误单任务退避。
- 原始文件 SHA 归档 → pending 状态 → 事务入库 → 更新断点。文件 fsync + 原子 rename；数据库成功后才推进。SHA 重放返回 ALREADY_IMPORTED；损坏/缺失证据或数据库失败保留 pending、停止新任务。
- 限定单个响应 4MB / 每批公开响应 6MB，SQL 整批 25MB / 20 条。磁盘可用不足 2GiB 暂停。无自动删除原始证据，需要备份和容量管理。

## 权限与目录

专用 `snapchat_collector_runtime` 仅 CONNECT、schema USAGE、EXECUTE `snapchat_collector.ingest(text)`；拒绝读取用户/凭据、直接写广告表、建表、调用其他平台 importer。函数校验来源、版本、UUID、平台、地区、列表请求/响应、详情原始对象和素材域名。保留老来源/任务 PAUSED，由独立 systemd 调度。

- `/opt/snapchat-collector/code/`：bundle、入库函数和验证工具。
- `/etc/snapchat-collector.env`：专用数据库凭据，0600，不得输出或入 Git。
- `/etc/snapchat-collector-runtime.env`：固定 Docker 镜像摘要。
- `/var/lib/snapchat-collector/evidence/{state,status}.json`：断点/脱敏状态。
- `archive/snapchat/<sha>/batch.json`：私有原始批次，数据库记录 `local-private:snapchat/<sha>/batch.json`。

## 构建与发布

仓库根目录：

```sh
./node_modules/.bin/vitest run --config saas/vitest.config.ts saas/collector/src/snapchat-service
./node_modules/.bin/esbuild saas/collector/src/snapchat-service/daemon.ts --bundle --platform=node --format=esm --packages=external --outfile=/tmp/snapchat-daemon.mjs
./node_modules/.bin/esbuild saas/collector/src/snapchat-service/probe.ts --bundle --platform=node --format=esm --packages=external --outfile=/tmp/snapchat-probe.mjs
```

上传 code 和 deploy 文件。首次无数据库凭据执行 probe，生成真实 probe.json；`provision.py` 创建专用角色、受限函数和0600配置。`verify-transport` 在 `--network none` 容器测成功/429/验证页/重定向，`verify-permissions.mjs` 在仅数据库网络运行真实批次回滚和权限拒绝测试；`verify-owner.py` 仅 owner 运行事务回滚合并测试。

服务尚未启用时，daemon `--bootstrap` 导入已验证的真实 probe.json 并创建队列；随后安装 run.sh/systemd，`systemctl enable --now snapchat-collector.service`。后续发布替换 bundle、应用 ingest.sql 并重启，不能重复初始化或删除 state。保留固定镜像 ID；不需要重建网站。

```sh
python3 /opt/snapchat-collector/code/status.py
systemctl is-active snapchat-collector.service
systemctl is-enabled snapchat-collector.service
docker logs --tail 10 snapchat-collector
systemctl restart snapchat-collector.service
systemctl disable --now snapchat-collector.service
```

active 仅说明进程运行；同时核对最近批次时间、游标推进、数据库增量及 cooldown。状态不打印凭据、源分页游标和签名素材 URL。

## 升级动态广告主发现

先验证、构建新 daemon，备份旧 bundle 和 state。主库导出 `research-publishers.json`，先放入 `/opt/snapchat-collector/code/`，再替换 `export-candidates.py`。导出服务未找到或未通过校验的主库会失败，旧名称目录保留。运行导出服务成功后重启 Snapchat；启动时立即读本地目录，之后每小时刷新，保留 seen / nextUrl / retryAt / pending。无需更改数据库权限、原始证据或冷却。

```sh
./node_modules/.bin/esbuild saas/collector/src/research-seeds/export.ts --bundle --platform=node --format=esm --outfile=/tmp/research-seed-export.mjs
node /tmp/research-seed-export.mjs --publishers > /tmp/research-publishers.json
```

```sh
install -m 0644 snapchat-candidates.service snapchat-candidates.timer /etc/systemd/system/
systemctl daemon-reload
systemctl start snapchat-candidates.service
systemctl enable --now snapchat-candidates.timer
systemctl restart snapchat-collector.service
```

可用 `SNAPCHAT_CANDIDATES_FILE` 指向同格式的公开品牌目录，默认 `/data/advertiser-candidates.json`。格式：`{"schema":1,"generatedAt":"2026-10-09T00:00:00Z","candidates":[{"publisher":"Example Shop","sources":["public-brand-catalog"]}]}`。目录不是 Snapchat 投放证明，也不能据此估算全平台覆盖率。

回滚时停止候选 timer，恢复旧 bundle 并重启。新增任务字段向后兼容；保留扩展后的 state、证据和数据。不要将运行后的 state 回滚到旧备份，避免丢失已完成的断点。

# 已知广告历史复查服务

独立服务只处理已有真实 AdObservation 的广告身份。发现服务继续负责扩充广告库；复查没有 seen 去重，成功结果通过原生 ingest 追加 AdObservation。公共历史由应用现有历史 projector 处理。

## 调度和证据

- `history_collector.seed()` 每小时扫描全部已知广告；一条广告一个持久目标，原发现查询范围单独保留。首次按最近真实观察 + 24 小时安排，明确 INACTIVE 为 + 7 天；旧广告立即到期。
- 活跃/未知观察后 24 小时；明确结束 7 天；缺采不改状态；失败指数退避 15 分钟至 24 小时。`NOT_OBSERVED`、`UNSUPPORTED` 与失败/明确结束分别记录。
- 每来源每日复查数量不设上限；有到期任务就继续领取。同来源至少 2 分钟间隔，单进程串行，每广告 90 秒预算。状态中的 `dailyLimit: null` 表示无每日额度；运行速度仍取决于请求间隔、页面响应和来源冷却，未处理的广告保留 due。
- 老数据库中的 `source_control.daily_limit` 字段为兼容保留，领取和状态函数均不再读取它；新安装不创建此字段。升级只需应用新版数据库函数，常驻服务下一轮自动生效。
- 403/429/login/challenge 来源级冷却至少 6 小时，重复限制递增到最多 96 小时，同时遵循 Retry-After（最多 7 天）。不使用人工 Cookie，不更换身份、不绕验证码。首次部署前 owner 应把其他采集服务已知冷却同步至 source_control.not_before/reason，避免再次触发已知限制。
- 10 分钟数据库租约，过期尝试标记 ABANDONED 并延后 10 分钟；事务内原子完成 native ingest + attempt + nextDueAt。重放完成调用同哈希返回相同结果，不同 payload 拒绝。租约认领和来源请求间隔共用数据库锁。
- 私有证据先落盘并 fsync，再写 pending，最后调用 SQL；失败不记录虚假广告快照。`/data/archive/<platform>/<sha>/batch.json` 对应 native 的 `local-private:<platform>/...`，失败存 `/data/archive/history/<attempt>/result.json`。此服务归档位于 history-collector 的独立卷，读取证据时须同时搜索该卷。
- `query.historyKind=HISTORY_RECHECK`，`scopeKind=EXACT_AD_DETAIL`，`countryMeaning=original-discovery-context-not-targeting-or-current-filter`。原发现国家不等于复查过滤国家或实际投放国家。

## 五平台能力与限制

| 平台 | 实际入口 | 观察边界 |
|---|---|---|
| Meta | 固定 Library ID 公共详情；复用原生 DOM parser | 仅身份完全匹配的实际 card；来源限制会失败，详情 DOM 不匹配记未观察 |
| Google / YouTube | 固定 advertiserId 当前平台 listing，最多 6 次滚动精确匹配 creative ID，再固定详情和最多 10 个变体 | 本次 listing 证明平台归属；有限窗口未找到仅 NOT_OBSERVED；last shown 从不转结束；缺平台上下文 UNSUPPORTED |
| TikTok | 原生独立详情路径，每次只取已知 ad_id | 复用 MEDIA_REFRESH 的安全定向读取实现，但入库 query 标为 HISTORY_RECHECK；旧发现日期用于原生 envelope 兼容，不宣称本次日期筛选 |
| Pinterest | 固定 repository ID 详情、原生 fields/media parser | 详情未展示的卡片文案保持 null；原生主表保留之前摘要，快照不复制旧文案；不从 Date range 推断当前活跃 |
| Snapchat | 既有公开 ads_library/ads/<UUID> 单条 GET | 保留完整原生响应，精确 ID 匹配；原生 ingest 只有对既有 Ad 的 HISTORY_RECHECK 才免除 search 证据 |

无可信原生身份、原始范围不够或解析入口不支持时记录 UNSUPPORTED。只复查公共页面/原生公共详情，不访问广告落地页、不增加第三方服务、不下载媒体。

## 本地验证 / 构建

在仓库根目录：

```sh
node node_modules/typescript/bin/tsc -p saas/collector/src/history-service/tsconfig.json
HISTORY_BROWSER_TESTS=1 HISTORY_TEST_CHANNEL=chrome HISTORY_TEST_ENV=/private/tmp/ds-meta-history-pg-c3jhjgme/test.env node node_modules/vitest/vitest.mjs run --config saas/vitest.config.ts saas/collector/src/history-service
node saas/collector/deploy/history/build.mjs /private/tmp/ds-meta-history-build
```

`HISTORY_TEST_ENV` 是隔离本机测试库文件，包含 `SAAS_TEST_DATABASE_URL`；测试拒绝非 localhost 或名称无 `_test` 的数据库。所有浏览器测试请求由路由 fixture 截获，不访问来源。生产镜像使用其既有 Chromium；`HISTORY_TEST_CHANNEL` 仅测试使用本机 Chrome。

## 部署（由主任务执行）

1. 固定镜像 SHA，须包含现有 pinned Node 24 / Prisma / Playwright 和 Chromium；沿用原采集器 seccomp_profile.json。
2. 构建产物 `history-daemon.mjs`、`schema.sql` 放 `/opt/history-collector/code/`；本目录 `run.sh`、`provision.py` 放 `/opt/history-collector/`；systemd 文件放 `/etc/systemd/system/`。创建 `/var/lib/history-collector/evidence`，owner `1000:1000`，mode `0700`。
3. owner 在数据库先更新 `saas/collector/deploy/snapchat/ingest.sql` 和 `saas/collector/deploy/pinterest/ingest.sql`；其他三份原生 ingest 必须已经存在。运行 `HISTORY_IMAGE=<immutable-sha> python3 /opt/history-collector/provision.py`（不要把输出的私密环境文件内容发到日志）。
4. provision 生成 `/etc/history-collector.env`（`DATABASE_URL`、`HISTORY_STATE_DIR`）和 `/etc/history-collector-runtime.env`（`HISTORY_IMAGE`），均 0600。runtime 仅四个 RPC EXECUTE，不能读业务表/队列表，不能直接调用原生 ingest。schema owner 通过 SECURITY DEFINER 调用原生 ingest。
5. 同步已知来源冷却后 `systemctl daemon-reload`、`systemctl enable --now history-collector.service`。
6. 状态：`docker exec history-collector node /opt/ad-research/app/history-service/history-daemon.mjs --status`；私有磁盘 `/var/lib/history-collector/evidence/status.json`；systemd 日志只打印内部 attempt ID、来源 key、结果和通用错误码，不打印 URL、正文、DB 连接串。
7. 一次手动执行：停 systemd 后用同容器约束运行 bundle `--once`。`--seed` 仅补目标池，`--status` 只读；禁止并行运行共享 pending 文件的两个实例。数据库认领虽有租约，磁盘 pending 文件只设计为单服务实例。

## 应用只读接口

`history_collector.public_daily` 仅向现有 `saas_app` 授予 SELECT：

- `ad_id text`
- `day text`（YYYY-MM-DD 上海日）
- `outcome text`（当天最新 started_at 的尝试结果，可能 RUNNING）
- `checked_at timestamptz`
- `attempt_count int`
- `failure_count int`（FAILED + ABANDONED）

此视图跨原发现 country 范围，不能表述为每个国家完成复查；它不包含 error code、evidence、lease、原始 result。应用仍需正常认证和工作区授权，并限制 ad/date 查询范围。

上线验证必须分别记录：部署启动、目标池覆盖、来源实时结果、每日完成比例、历史 UI 回读。离线/隔离测试不等于在线全量每日完成验收。

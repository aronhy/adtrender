# Google / YouTube 独立常驻采集

`google-collector.service` 独立于网站、Meta、Pinterest。自己的匿名 Chromium profile 与 Google 发现队列，接入有官方来源的共享电商、游戏、漫剧种子，不使用付费数据 API。名称和域名只是检索线索，Google 广告事实仍以原生结果为准。

## 入口和事实口径

- DISCOVER：Google 广告透明度中心 `/search?query=...`，按广告主名称商业词检索，逐行打开取得真实 AR ID；分页游标是 page+row，每批4个广告主。初始31国14语150个任务，发现词不是广告文案关键词。Google 没有提供无限全量枚举；自动发现覆盖取决于词表和公开返回。
- SEARCH：每个新广告主派生 Search 筛选任务，观察公开 CR 创意、图片预览、可读文案、CTA、落地页及变体。部分 Text 广告只有图片预览，文本留空，不做未经验证 OCR。
- YOUTUBE：独立任务，必须同时验证来源 YouTube 筛选与 Video 格式。保存标题、说明、CTA、公开视频 ID、播放器引用和来源直接给出的素材地址。YouTube 平台也可能有 Text 广告；本期视频队列专门选 Video。
- SERP：初始 60 个任务，2026-10-09 接入共享主库在现有 31 国的电商、游戏、漫剧关键词。只提取明确 Sponsored/Ad 的搜索结果，不点击付费广告，不把自然结果当广告。不具备稳定 CR ID 的结果保存为搜索观察和域名发现，不能写成伪造广告。gl/hl 不是本地真人出口证明。异常流量验证后独立冷却 24 小时，不影响 ATC。

共享主库的创意关键词只进入 SERP；15 个有来源的产品／公司名称线索进入 DISCOVER，有核验域名的产品派生 SEARCH / YOUTUBE 查询。只有 Google 原生结果才生成 AR / CR 身份。Slot 两类统一使用 slots，不按付费性质分开标记。任务目的按电商、游戏、漫剧、未标记旧任务轮转，各 kind 和限制域继续独立调度；旧 cursor、seen、到期时间、限制状态原样保留。

来源统一 `google_ads_transparency`；唯一键是来源+CR ID，多平台数组合并，观察记录分开保存。queryCountry 只是请求筛选，reportedCountries 保持空；Last shown 只保存原始字段，不当作广告结束日期或当前活跃状态。未知 sourceStatus 保持 UNKNOWN。广告主注册地不当投放地区。

公开渲染 HTML、可观察广告业务元数据、广告主发现页、平台筛选页与逐变体详情私有归档。删除脚本、账户页头、输入框、隐藏对话框和非必要属性，不归档会话请求头。公开视频播放页 URL 不冒充 MP4 文件。Google 素材初次入库仍为 UNAVAILABLE / PLATFORM_MEDIA_ADAPTER_PENDING；符合平台规则的图片和直接视频文件已接入统一素材服务，保存成功后为 READY，签名来源链接可能过期。访问的变体数和预期总数保留，超过每广告10变体/每批180秒预算不宣称完整。当前文件保存与采集状态见系统总览。

## 调度、恢复与权限

单独串行浏览器，四类任务公平轮转，每批间隔120秒，Google ATC/Google Search 两个限制域独立退避。ATC 403/429/验证码1小时起指数退避最高24小时，SERP限制固定24小时；不求解验证码、不轮换账号/IP。每批默认4个广告，滚动预算不代表广告总量上限。列表停滞记 PARTIAL/FAILED，不标成采完。每日重查，动态排序和深分页仍可能遗漏。

归档 → pending → 数据库函数事务 → 状态断点。重放 SHA 幂等；证据损坏/数据库错误保留 pending 并停止推进任务。磁盘可用不足2GiB暂停请求。后台状态必须结合 systemd、最近批次时间和队列推进判读，active 不等于持续有新增。

专用 `google_collector_runtime` 仅 CONNECT、schema USAGE、EXECUTE `google_collector.ingest(text)`；没有用户表、凭据表读取、直接写表或 DDL 权限。函数约束来源、版本、CR/AR ID、查询国家/平台和详情/列表证据、20条/25MB上限、素材域名。Google 旧来源/任务继续 PAUSED，调度由独立 systemd 负责。

- 代码：`/opt/google-collector/code/`
- 状态/私有证据：`/var/lib/google-collector/evidence/{state,status}.json`、`archive/google/<sha>/batch.json`
- 配置：`/etc/google-collector.env`，包含专用数据库凭据，600；不得输出或入 Git。
- runtime：`/etc/google-collector-runtime.env`，固定不可变镜像 ID。
- 浏览器：`browser-profile/`。非root UID1000、Chromium沙箱、只读根目录、cap-dropALL、seccomp；2CPU/2GiB，无公网端口。

## 发布与验证

仓库根目录：

```sh
./node_modules/.bin/esbuild apps/collector/src/google-service/daemon.ts --bundle --platform=node --format=esm --packages=external --outfile=/tmp/google-daemon.mjs
./node_modules/.bin/esbuild apps/collector/src/google-service/probe.ts --bundle --platform=node --format=esm --packages=external --outfile=/tmp/google-probe.mjs
./node_modules/.bin/esbuild apps/collector/deploy/google/verify-browser.ts --bundle --platform=node --format=esm --packages=external --outfile=/tmp/google-verify-browser.mjs
./node_modules/.bin/vitest run --config vitest.config.ts apps/collector/src/google-service
```

发布至 code 目录；执行 provision.py 创建专用角色/函数与600配置，已有角色不重置密码。`GOOGLE_IMAGE` 可指定不可变镜像，首次默认固定当前Pinterest镜像；后续沿用原ID。可传入真实预检限制对应的 `GOOGLE_SERP_NOT_BEFORE` epoch毫秒。

先以无数据库权限的隔离浏览器执行 probe DISCOVER，再执行 SEARCH、YOUTUBE，保存真实 discover/search/youtube.json。`verify-browser` 必须 `--network none` 验证真实浏览器生产路径；`verify-permissions.mjs` 使用专用角色对 search.json 回滚演练和权限拒绝。确认后服务未运行时执行 daemon `--bootstrap` 导入上述真实批次并创建断点，再安装 run.sh/systemd 单元并 enable --now。

```sh
systemctl status google-collector.service
cat /var/lib/google-collector/evidence/status.json
docker logs --tail 10 google-collector
systemctl restart google-collector.service
systemctl disable --now google-collector.service
```

重启保留任务与已见 ID；只在旧容器移除后清除三个 Chromium Singleton 锁。不要删除 state/pending/profile 处理普通请求失败。原始证据无自动清理，需备份和磁盘容量管理。

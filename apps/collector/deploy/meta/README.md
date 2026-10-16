# Meta 原生常驻采集

独立 systemd 服务 `meta-collector.service` / Docker 容器 `meta-collector`。初版固定复用现有应用镜像的不可变 image ID，网站与 Pinterest 进程独立。浏览器仅使用本服务创建的匿名 profile，不复制用户账号、Cookie、浏览器会话，也不接付费数据 API。

## 发现范围

统一主库位于 `../../src/research-seeds/`，`spy-seeds.ts` 保留兼容入口。主库为电商、游戏、漫剧三条主线，共 53 类、393 个词，249 个国家／地区码展开为 37,546 个候选查询；这不是平台实际覆盖。Meta 按现有 33 个市场接入，保留历史信息流场景任务及已发现广告主断点。详细口径见主库计划。

电商保留 30 个品类。游戏增加 15 类，以 Slot 为重点，包含各国本地词与产品／公司线索；免费社交老虎机与真钱赌场类统一纳入 slots，不分开标记。漫剧增加 8 类，包含动态漫画、动画短剧、AI 漫剧、竖屏动画和题材词；普通真人短剧不凭名称划入漫剧。

电商、游戏、漫剧、已发现广告主与历史信息流任务轮转；轮内优先到期的失败重试，同时遵守全局冷却。`seedFamilies` / `seedCategories` 仅记录检索目的，不能作为广告行业、语言或实际 Feed placement 的来源事实。不按品牌白名单或关键词匹配结果过滤返回的广告。旧任务可能同时保留历史与新目的标签，各标签计数不能直接相加。

使用 `active_status=all / ad_type=all / media_type=all` 搜索来源实际可见的全部状态和媒体；不承诺来源未公开的历史广告。从明确数字主页 ID 派生广告主任务；非数字主页 URL 仍保存，但不猜 Page ID。每批 20 条是事务/运行预算，不是单个关键词总量上限。正常批次之间至少等待 120 秒，单浏览器串行运行。

搜索和详情均通过公开页面可见控件。实测最初 document 返回 403，但正常公开搜索产生成功数据响应和真实卡片；单凭入口 403 不再立即放弃。若没有成功数据响应、出现实际验证码/登录要求或广告数据 403/429，以及 HTTP 200 中的 GraphQL 限流错误（实测 code=1675004），则关闭浏览器停止页面自身重试，并整体退避 1 小时，重复限制逐步延长至 24 小时。没有 CAPTCHA 求解、自动换 IP 或账号轮换。

滚动期间保持已见 ID，重启后重放列表并去重。预算耗尽和滚动停滞不能标记采完；只有明确无结果或结束文案才标记该查询本轮结束，6 小时后重查。未完成的深查询不再因超过 6 小时清空 seen，避免扩大队列后永远重复前部结果；已采广告的状态与素材复查由独立 history 服务承担。排序动态变化、虚拟列表和深结果集重放预算仍可能造成遗漏/未完成，不能宣称全球全量覆盖。当前广告主发现和前部搜索结果已实测；跳过首批 30 条后的深分页遇到来源应用级限流，尚未通过验收。所有国家覆盖和长时间稳定性需继续验收。

## 数据与权限

专用 DB 角色 `meta_collector_runtime` 仅 CONNECT 数据库、USAGE `meta_collector` schema、EXECUTE `meta_collector.ingest(text)`。无用户/凭据读取、直接表写、DDL 权限。函数固定 Meta 来源、每批 20 条/25MB、稳定广告 ID、证据与查询国家一致性；PUBLIC 撤权，固定 search_path，和既有导入器共享排序锁。

广告按来源+广告 ID 去重；观察记录保留历史。查询国家不会写成 reportedCountries；来源未披露平台时保留空数组，不自动补 Facebook。保留文案、CTA、落地页、状态、日期、素材引用、公开列表文本与净化 HTML、可打开的详情弹窗。详情为尽力补充，复杂广告变体未保证穷尽。

白名单 Meta CDN 图片/视频进入现有媒体下载队列，复用现有安全下载、对象存储与 READY/FAILED 状态。未知媒体域名仅保留在原始证据，不下载。原始页面脚本、表单和非必要属性被移除；无请求头、密码或会话 Token 归档。profile 本身属于私有运行数据，不能上传 Git。

旧 DataSource 和导入任务维持 PAUSED，避免旧签名能力门禁调度器误领；本服务由 systemd 调度，不伪造旧能力验证。当前 UI 的旧来源状态不是本服务运行状态。

## 持久化与恢复

- `/opt/meta-collector/code/`：代码、SQL 与验证脚本。
- `/var/lib/meta-collector/evidence/state.json`：任务、已见 ID、退避和 pending 指针。
- `/var/lib/meta-collector/evidence/status.json`：运行状态、覆盖和最近批次。
- `/var/lib/meta-collector/evidence/archive/meta/<sha>/batch.json`：不可变来源证据，DB 引用 `local-private:meta/<sha>/batch.json`。
- `/var/lib/meta-collector/evidence/browser-profile/`：仅本服务的匿名 profile，700。
- `/etc/meta-collector.env`：仅受限 DATABASE_URL 和 META_STATE_DIR，600。
- `/etc/meta-collector-runtime.env`：不可变镜像 ID，600。

顺序为归档 → pending 指针 → 数据库提交 → 推进断点。提交后进程退出而状态未保存，重启会重放相同 SHA；函数返回 ALREADY_IMPORTED。数据库不可用或证据损坏时保留 pending，暂停新任务，日志记录失败，不丢弃数据。运行状态文件只是快照，应同时确认 systemd 和最后批次时间。

非 root UID1000、只读根目录、Chromium 沙箱、seccomp、no-new-privileges、cap-drop ALL；2 CPU / 2GiB / 384 PID，无公网端口。浏览器子进程不继承 DATABASE_URL。每批有时限，空间不足 2GiB 时停止发起新任务；日志轮转 10MiB×3。原始证据未自动清理，需备份及容量管理。

## 构建与启停

在仓库根目录执行：

```sh
./node_modules/.bin/esbuild apps/collector/src/meta-service/daemon.ts --bundle --platform=node --format=esm --packages=external --outfile=/tmp/meta-daemon.mjs
./node_modules/.bin/esbuild apps/collector/src/meta-service/probe.ts --bundle --platform=node --format=esm --packages=external --outfile=/tmp/meta-probe.mjs
```

发布到上述 code 目录。运行 `provision.py` 以随机密码创建专用角色及 600 环境文件，并应用 `ingest.sql`；已有角色/配置不会被重置，重复应用 SQL 可升级函数。首次可传入不可变 `META_IMAGE=sha256:...`，否则复用当前 Pinterest 镜像；后续沿用已固定镜像。用 `verify-permissions.mjs` 对真实 probe.json 做回滚权限验证，再开启服务。

```sh
systemctl status meta-collector.service
cat /var/lib/meta-collector/evidence/status.json
docker logs --tail 20 meta-collector
systemctl stop meta-collector.service
systemctl start meta-collector.service
systemctl disable --now meta-collector.service
```

停止时最多等待 240 秒让当前批次归档提交；重启保留断点。容器重建后 Chromium 的旧主机锁可能残留；启动脚本确认旧容器已不存在后，仅移除三个 Singleton 锁文件，保留 profile 和全部采集状态。运行中发现 profile 锁错误会归档错误并退出，由 systemd 重启恢复。退避到期的失败查询优先重试。不要删除 state/profile 来处理普通超时，不要手动清空 pending。

`verify-browser.ts` 为禁网容器浏览器集成检查：通过 Playwright route 本地响应模拟 HTTP 200 限流，使用生产 collectBatch 验证立即关闭、返回限流且不标记采完。运行时必须使用 `--network none`，不连接真实来源、不写数据库。

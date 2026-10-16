# Pinterest 常驻全覆盖服务

2026-10-07 上线。独立 systemd 服务 `pinterest-collector.service` 管理独立 Docker 容器 `pinterest-collector`，不依赖当前网站 API 进程存活。为复用已经验收的 Chromium / Prisma 运行环境，初版固定使用现有镜像的不可变 image ID；尚未完成独立精简镜像的构建拆分。

## 覆盖与调度

- 从官方页面动态读取支持国家和品类。首次实测 30 国、25 个具体品类（另有 ALL）。查询广告主留空、品类 ALL，不限品牌，不按受众收窄。
- 初始区间 2025-10-07 至 2026-10-07，7 天一个窗口，共 1590 个国家×日期分片。页面单次查询日期范围必须小于 30 天。
- 每轮处理一个分片的一页。每页所有可见稳定广告 ID 都进入详情流程，24 条的页面分为最多 20 条的数据库事务。通过公开 Next page 控件前进；恢复时重放已保存的页码。
- 按分片轮转。失败页在退避到期后优先重试；1 分钟开始，指数退避最多 6 小时。403、429、登录/挑战会触发整体暂停 1 小时，不自动切换 IP 绕过。
- 每个 UTC 日补建最近两天分片，并刷新国家目录，新支持国家加入一年回溯。
- 只有来源明确无结果（第一页）或下一页按钮明确禁用，且该页详情已处理、归档、数据库提交后，才完成分片。
- 页面变动、超时、详情缺失、游标失效都保持未完成。未实现来源结果变化下的快照隔离，翻页恢复基于公开 UI 页码，广告库变动可能带来重复或漏项；重叠增量查询补扫并去重，不能据此宣称全球广告百分之百完整。
- 已拒登/内容撤回的记录保留来源披露的状态、触达与拒登原因，不伪造广告主或素材。当前已有原始文本/HTML/字段与素材链接；图片已接入统一素材服务，保存成功后为 READY。真实广告视频与全部变体完整闭环仍待验证，当前状态见系统总览。

## 持久化与恢复

服务器目录：

- `/opt/pinterest-collector/code/`：发布代码及 SQL。
- `/var/lib/pinterest-collector/evidence/state.json`：完整分片和断点。
- `/var/lib/pinterest-collector/evidence/status.json`：最近状态。
- `/var/lib/pinterest-collector/evidence/pending/`：待提交/历史采集结果。
- `/var/lib/pinterest-collector/evidence/archive/pinterest/<sha>/batch.json`：数据库引用的不可变证据。
- `/etc/pinterest-collector.env`：仅受限 DATABASE_URL 和数据目录，0600。
- `/etc/pinterest-collector-runtime.env`：固定镜像 ID，0600。

持久卷先写证据，再保存 pending，再提交数据库，最后推进页码。重启发现 pending 时重放；数据库以原始 JSON SHA256 幂等。不同来源相同 ID 不合并，Pinterest 重复观察追加历史，旧观察不覆盖新字段。采集单进程，由 systemd 和固定容器名防止多实例。

## 权限

账号 `pinterest_collector_runtime` 仅 CONNECT 当前数据库、USAGE 专用 schema、EXECUTE `pinterest_collector.ingest(text)`。无直接表读写、DDL、用户/凭据/支付数据权限。函数固定 Pinterest 来源，限制批次 20 条、25MB、稳定 ID/来源 URL/证据一致性和图片域名；固定 search_path，函数对 PUBLIC 撤权。

验证脚本 `verify-permissions.mjs` 检查合法导入事务回滚、用户读取拒绝、凭据读取拒绝、直接广告修改拒绝、DDL 拒绝及跨平台导入拒绝。

容器非 root，根文件系统只读、capabilities 全部移除、no-new-privileges、Chromium 沙箱和 seccomp 保留。限制 2 CPU / 2 GiB 内存 / 256 PID，无对外监听端口。数据库使用内部网络。浏览器子进程不继承 DATABASE_URL。

为避免旧的 Meta-only 调度器误领任务，DataSource 和归档 CollectionTask 在旧调度体系中保持 PAUSED；本服务由 systemd 单独启停。不要通过修改旧来源签名能力假装启用本服务。

## 运维

```sh
systemctl status pinterest-collector.service
journalctl -u pinterest-collector.service --since '30 minutes ago'
cat /var/lib/pinterest-collector/evidence/status.json
# 停止持续采集，保留数据库与证据
systemctl stop pinterest-collector.service
# 恢复，沿用断点
systemctl start pinterest-collector.service
# 停止且取消开机启动
systemctl disable --now pinterest-collector.service
```

低于 2 GiB 剩余空间停止发起新采集。每页设 12 分钟上限；日志轮转。证据暂未自动删除，需纳入磁盘与备份管理。状态文件中的 completed 表示真正遍历完成的分片，进程 running 不代表全量已采完。覆盖完成、长期成功率及网页端人工展示仍需持续验收。

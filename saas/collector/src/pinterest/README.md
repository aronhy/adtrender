# Pinterest 独立采集命令

从 Pinterest Ads Repository 的公开表单与详情页面采集。独立于网站启动，不读取个人浏览器 Cookie，不使用付费数据 API。保留有界人工命令；已新增服务器常驻全覆盖服务，部署、权限与断点说明见 [后台服务文档](../../deploy/pinterest/README.md)。

## 运行

仓库根目录，使用已安装的 Node、tsx、Playwright 和 Chrome：

```sh
./node_modules/.bin/tsx saas/collector/src/pinterest/cli.ts \
  --keyword Nike --country DE --limit 3 \
  --out saas/.local/pinterest-live --channel chrome
```

`country` 必须是当前页面支持的国家；不默认全球。每次最多 20 条，只取本轮已完整渲染的首批卡片，可能少于 limit。不分页，不声称完成全库覆盖。输出私有 JSON 文件与 SHA256，目录 0700、文件 0600。批次中的 query 保存实际日期窗口；来源报告国家单独记录。

每条保留广告 ID 字符串、标题、公开文案、截断标记、广告主名称、图片 URL、原始详情字段、页面文本和去脚本 HTML。公开的 None/No 原样保留。没有广告主稳定 ID 时不凭名称合并身份；没有投放状态时保留 UNKNOWN。初版仅识别来源页面 `Ad image` 图片，不声明视频/多变体完整支持。

退出码 0 为成功或明确无结果，2 为部分成功/来源失败。HTTP 200 空白页、挑战、403/429、登录要求、页面结构变化分别处理；不以失败表示零广告，不自动轮换 IP 重试。辅助资源失败保存在 diagnostics，广告数据页是否可用按其真实内容判断。

## 导入

使用应用 schema 生成的 Prisma client 和服务端 DATABASE_URL。不要把连接串写进命令、Git 或前端。导入仅供已授权操作员运行；不是未认证 HTTP 接口。

```sh
./node_modules/.bin/tsx saas/collector/src/pinterest/import-cli.ts \
  --batch saas/.local/pinterest-live/pinterest-<sha256>.json \
  --archive saas/.local/operator-browser
# 默认执行数据库写入事务后回滚。验证后添加 --apply 正式入库。
```

`PINTEREST_PRISMA_PACKAGE` 可指向已部署应用的 package.json，默认 saas/app/package.json。来源 `pinterest_ads_repository` 必须预先存在。归档目录需持久化备份；证据引用相对此归档根目录。不要把唯一证据只放在容器 /tmp。

事务级来源锁、批次哈希幂等、来源+广告 ID 去重；再次观察追加快照，旧观察不覆盖新的广告字段。一次写入包含任务、运行、广告、观察、素材元数据与审计。任务保持 PAUSED、不配置 cron，不修改来源的验证能力。素材初次入库为 UNAVAILABLE / PLATFORM_MEDIA_ADAPTER_PENDING；符合平台规则的图片已由统一素材服务领取保存，真实广告视频与全部变体完整闭环仍待验证。当前状态见系统总览。

## 已验证与边界

2026-10-07，本机独立无登录 Chrome 成功采到 Nike 德国广告两条，服务器事务回滚、正式入库、幂等重放和字段回读通过。内置浏览器空白不代表该入口无广告；目前尚不能确定两个浏览器差异的唯一原因。

后续同日已部署常驻浏览器、受限入库角色及国家/日期分片和分页断点。图片下载、视频及变体、全部分片完成与长期运行验收仍未完成。旧人工命令的上述数量限制不代表后台服务总采集上限。

测试：

```sh
./node_modules/.bin/vitest run --config saas/vitest.config.ts saas/collector/src/pinterest
```

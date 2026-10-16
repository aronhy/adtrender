# 动态采集节点、中央派发与自动同步

节点登记表在 `registry.json`；`targets.json` 保留主节点和默认资源模板。美国节点为 `198.51.100.21`（`us01`），运行 Pinterest、Google/YouTube、TikTok、Snapchat；Google 与 YouTube 共用采集器，但保留原平台字段。Meta 继续使用现有主节点和美国出口。

四台服务器已登记，CI 凭据已配置；美国、新加坡、日本已核验连接，香港按用户要求跳过。实际发布版本与验收见服务器清单。

## 自动部署怎么启用

将代码合并/推送到 `main` 后，`.github/workflows/collector-fleet-deploy.yml` 在采集源码、共享合同、依赖或部署配置更新时自动测试、构建并同步。也支持从 `main` 手动触发 workflow。PR 只供审核，不执行这个发布任务。发布串行，进行中的迁移不会被下一次提交取消。

当前使用合并 Secret `COLLECTOR_FLEET_SSH_PASSWORDS`；也兼容以下两个已有服务器的独立 Secret：

| Secret | 用途 |
| --- | --- |
| `COLLECTOR_SOURCE_SSH_PASSWORD` | 主节点 `203.0.113.10` 的 SSH；读取各平台受限配置、迁移断点、更新入库函数；为美国节点建立数据库私网转发 |
| `COLLECTOR_US01_SSH_PASSWORD` | 美国节点 `198.51.100.21` 的 SSH；安装/更新采集服务 |

代码只保存 Secret 名称及已核验的公共主机密钥。密码不在参数、Git、发布包或日志中；缺少 Secret 时发布明确失败。CI 与服务端密码文件均为 `0600`；服务使用 systemd `LoadCredential`。主机密钥变化必须核实后更新 `registry.json`（或其 Actions Variable 覆盖值）。GitHub 的配置方式见 [Actions Secrets 官方说明](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)。

2026-10-09 用户明确要求开始部署后，已配置合并 Secret `COLLECTOR_FLEET_SSH_PASSWORDS`。发布结果与远端验收另行记录。

## 多服务器与任务派发

用户已要求后续节点沿用同一套发布流程，采集任务由我们统一派发。节点只能执行分配给自己的任务，无任务时保持空闲；不能在新增节点复制完整种子/队列自行采集。自动更新保留各节点自己的断点、任务与冷却。

已实现按整个平台队列的中央指定节点与短期执行授权。每 15 分钟续发、最长有效 40 分钟，失联不续发，到期不能继续启动采集。逐条查询任务的多节点分片和断点自动接管尚未实现；变更已移交平台的所有者会被拒绝，避免从旧快照重复采集。完整规则见 多服务器任务派发规则。

## 动态登记

已登记 `us01`、`sg01`、`jp01`、`hk01`。新加坡、日本已验证连接并启用为待命目标，香港 SSH 暂时不可达，保持停用；日本账户为 `ubuntu`，已验证 `sudo -n`。四台到期时间都未提供，保留 `null`。

```sh
python3 -B saas/collector/deploy/fleet/registry.py list
python3 -B saas/collector/deploy/fleet/registry.py disable sg01
python3 -B saas/collector/deploy/fleet/registry.py expire sg01 2026-12-01T00:00:00+08:00
python3 -B saas/collector/deploy/fleet/registry.py expire sg01 unknown
python3 -B saas/collector/deploy/fleet/registry.py add /path/to/public-node.json
python3 -B saas/collector/deploy/fleet/registry.py assign sg01 google
python3 -B saas/collector/deploy/fleet/registry.py unassign google
```

以上示例修改本地登记表，默认不连接服务器；示例日期不是用户的真实到期日。`enable <node>` 只改变启用开关，未核验主机密钥的节点仍不可发布。新增记录可复制现有公开记录结构，必须使用新 ID 和真实地址；不能包含密码。删除 assignment 不删除该平台状态。

在仓库 Actions Variable 中设置完整 JSON `COLLECTOR_FLEET_REGISTRY`，即可覆盖默认表。变量更新在下次定期检查时用于续发/撤销授权；首次部署或需更改服务配置时，手动触发发布 workflow。源码更新继续由 main push 自动发布。所有已部署平台转移节点必须先做断点移交，不能仅改 assignment。

多个节点的密码统一存放在 Actions Secret `COLLECTOR_FLEET_SSH_PASSWORDS`（JSON 字典），键名按以下规则：

- 主节点：`COLLECTOR_SOURCE_SSH_PASSWORD`
- 四个采集节点：`COLLECTOR_US01_SSH_PASSWORD`、`COLLECTOR_SG01_SSH_PASSWORD`、`COLLECTOR_JP01_SSH_PASSWORD`、`COLLECTOR_HK01_SSH_PASSWORD`
- 新 ID 转大写、连字符转下划线，前后加 `COLLECTOR_` 和 `_SSH_PASSWORD`。

不要把真实密码写进命令行。Secret 缺失或某节点不可达时，该节点失败，其他节点仍继续检查/发布。凭据通过标准输入写入 GitHub 加密 Secret，本地副本继续保持私有。

`autoDeploy=false` 表示暂不更新代码；停止采集应设置 `enabled=false`。停用通常在下一次定期检查生效；控制端或网络不可达时，最迟随本地执行授权过期而停止发起新采集。GitHub 调度延迟可能使节点暂时空闲，不能把 Actions 定时视为高可用的秒级调度器。

## 运行安排

这台服务器已有其他应用，采用共享锁轮转启动现有 daemon：

| 采集器 | 每小时启动分钟 |
| --- | --- |
| Pinterest | 00、20、40 |
| Google / YouTube | 05、25、45 |
| TikTok | 10、30、50 |
| Snapchat | 15、35、55 |

每次最多运行 180 秒，然后给予 330 秒正常退出时间；锁一直持有到容器停止。若上一轮仍在运行、可用内存不足 900 MiB 或空闲磁盘不足 2 GiB，本轮跳过。单个采集容器限制为 768 MiB、0.75 CPU。调度只限制运行窗口；各来源的限频、冷却、重试和覆盖判断继续由原采集器处理。实际吞吐量仍需首次发布后根据日志验收。

CI 从 `saas/app/package.json` 的固定版本构建独立 Node/Playwright/Prisma 镜像，所有依赖包及嵌套依赖的版本/校验值沿用 `saas/app/package-lock.json`，不重新选择依赖版本。镜像构建在 CI 完成。四套 daemon 使用现有代码，打包后在 `/opt/adtrender-collectors/us01/current` 运行。镜像按提交标签传输，校验架构、操作系统、完整运行配置和有序层摘要一致后，固定使用目标 Docker 的本地内容 ID；兼容 classic/containerd 存储的 ID 差异。代码按清单逐文件校验 SHA-256。脏工作区产物不得部署。

数据仍入现有 PostgreSQL。美国节点的数据库 relay 通过校验主机密钥的 SSH 加密转发到主节点当前数据库容器地址；无数据库公网监听、无 Docker 发布端口。每套采集器只接收自己的 `*_collector_runtime` 配置。发布前验证角色没有超级用户/建库/建角色/绕过 RLS、公共表读写或公共 schema 创建权限，并能执行自己的入库函数。

生成的 Prisma schema 仅用于生成支持 raw query 的客户端，里面的 `CollectorRuntimeProbe` 不会被查询或建表；流程不执行 Prisma migrate/db push。现有入库 SQL 在主节点通过原 migrator 更新。

Snapchat 候选生产仍在主节点；美国节点首次启用前校验候选 feed，此后每小时通过同一私网 SSH 通道同步。候选文件必须是有效、未截断的完整 JSON，采集器继续进行自身业务校验。

## 首次移交、更新和回退

首次发布先验证美国节点镜像、离线浏览器、数据库通道和角色，再停止主节点四套旧服务。确认旧容器退出后，迁移完整 `state.json`、archive、pending、profile 和证据；不携带旧进程锁。美国节点技术准备完成后，旧四套服务禁用启动；完成移交回执后才发放执行授权，避免两个节点重复采集。Meta 和 Snapchat 候选生产服务不在迁移范围内。

后续发布只更新代码、镜像、受限配置及 timer，保留美国节点当前断点、已采 ID、队列、待入库批次和冷却。当前与上一版本保留用于回退，清理只针对本流程创建的旧版本/镜像，不清理采集状态或其他业务容器。

若准备或启用失败，确认美国采集进程停止后，恢复上一版配置和 timer；首次移交恢复旧节点原来运行的服务。无法确认美国节点停止时，旧节点保持暂停。若美国节点已就绪但旧服务禁用回执失败，则保留美国节点和旧节点的暂停状态，下次执行完成回执，不重新覆盖断点。

每次发布先读持久化事务记录：上次任务在准备阶段中断则先恢复旧版本/旧所有者，再发布新提交；已准备就绪的美国节点中断则先补齐所有权回执。这适用于同一次发布重试，以及新提交接续上次中断。

## 本地检查

默认命令只输出计划，不依赖密码，也不建立连接：

```sh
python3 -B saas/collector/deploy/fleet/release.py
python3 -m unittest discover -s saas/collector/deploy/fleet -p 'test_*.py'
```

`--execute` 是实际部署入口，仅由发布 workflow 调用，必须提供清洁发布包、对应镜像归档以及上述外部 Secrets。开发构建可使用 `build.mjs --allow-dirty --output <全新目录>` 验证打包，产物标记为脏工作区，部署校验会拒绝。

数据库通道、离线浏览器、持久断点迁移、服务唯一所有权、timer 实际运行及来源恢复，以 workflow 回执和服务器日志为准；部署通过不表示来源限频已经解除。

## 无任务节点的部署

已核验且启用的节点即使没有平台 assignment，也会同步同一份完整代码和运行镜像，并通过离线浏览器测试。状态为 `STANDBY_READY`，不创建采集 timer、数据库转发或种子队列，不发放执行授权。后续中央派发平台时，仍需完成原有断点移交再开始采集。待命节点最多保留当前与上一版本；不能用待命发布覆盖已有平台所有权。

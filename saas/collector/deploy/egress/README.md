# 私有 SSH 出口

将资源较小且已有业务的服务器作为出口，浏览器与统一入库继续使用现有采集主服务器。当前实例是美国 `us-netcup-01`，私网端点为 `socks5://adtrender-egress-us01:11081`。

## 运行方式

`adtrender-egress-us01.service` 在主采集服务器启动独立容器，加入 `ds-meta-saas-test_outbound`。SOCKS 监听容器内部 `0.0.0.0:11081`，**没有 Docker 发布端口**，主机没有该监听端口。原有防火墙规则维持原状。

容器只读根目录、drop ALL capabilities、no-new-privileges，128 MiB 内存、10% 单核 CPU、32 PID；不挂载数据库、广告业务状态或用户浏览器 profile。构建前将已核验的采集镜像 ID 标记为本地 `adtrender-egress-base:20261009`，`Dockerfile` 只安装 SSH 客户端；使用 `--pull=false` 构建并将最终不可变 image ID 写到私有 `runtime.env`。

## 凭据与信任

主节点 `/etc/adtrender-egress/us01/` 为 root 所有、700。`password`、`known_hosts`、`ssh.conf`、`runtime.env` 为 600，`askpass.sh` 为 700。密码由用户提供的本机私有资料写入；systemd `LoadCredential` 在运行时提供，凭据不进入镜像、Git、进程参数、Chromium 环境或日志。

`known_hosts` 必须与用户邮件中的 ED25519 指纹相符。SSH 使用 `StrictHostKeyChecking=yes`，只允许该已核验主机密钥。`ssh.conf` 实例：

```sshconfig
Host us01
  HostName 198.51.100.21
  User root
  Port 22
  UserKnownHostsFile /etc/adtrender-egress/us01/known_hosts
  StrictHostKeyChecking yes
  HostKeyAlgorithms ssh-ed25519
  PreferredAuthentications password
  PubkeyAuthentication no
  NumberOfPasswordPrompts 1
  ConnectTimeout 15
  ExitOnForwardFailure yes
  ServerAliveInterval 30
  ServerAliveCountMax 3
  ForwardAgent no
  ForwardX11 no
  RequestTTY no
  PermitLocalCommand no
```

## 采集器接入

`META_PROXY_URL` 是可选配置。未设置时保留原直连行为；设置时传给生产 `browserContext`。只接受带显式端口的 SOCKS5 私网/本机地址或 `adtrender-egress-*` 部署节点名；拒绝 URL 密码、其他协议、缺失端口、路径和查询参数。无效配置停止浏览器启动，不回退直连。

主节点的 root 私有 `/etc/meta-collector.env` 已添加：

```dotenv
META_PROXY_URL=socks5://adtrender-egress-us01:11081
```

本轮接入一个美国出口，单队列、单浏览器、原批次间隔和全局冷却继续使用。后续服务器资料到齐后再安排多节点分工；不得复制完整队列到各台重复执行。

## 发布验证与回退

发布前要求去除本轮出口代码后的本机构建 SHA-256 与运行中 `meta-daemon.mjs` 完全匹配，避免覆盖其他并行改动。候选版本通过真实生产 `browserContext` 的 HTTPS 出口核验后，才在无 pending 的冷却窗口更新正式代码与环境文件。

发布前备份位于主节点 `/var/lib/adtrender-egress/meta-before-us-egress/`：`meta-daemon.mjs`、`meta-probe.mjs`、`meta-collector.env` 与只作核对的 `state.json`。回退时停止 Meta 服务，恢复两个代码文件与环境文件，启动服务；保留当前 `state.json`，避免回退采集进度。随后可停止并禁用出口服务。

验收包含：service active/enabled、无 published ports、浏览器实际出口、正式容器的代理配置、已有任务/已见 ID/冷却不变、其他容器与 nginx 配置不变、网站 HTTP 200。出口检查没有请求 Facebook，来源新批次仍待冷却结束后的真实观察。

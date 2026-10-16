# 独立健康告警

`health-monitor.mjs` 使用 Node 原生 API，每次读取一个明确配置的 health 地址。它只保留 `api`、`database`、`worker`、`source`、`email` 的已知状态；额外字段和供应商响应正文不会写进日志、告警或状态文件。网络故障、超时、非 JSON、无效字段、HTTP 错误、响应超限分别记录。来源暂停或未配置也会报告 degraded。

首次运行发送 `initial`，之后只有状态改变才发送：从正常变异常为 `alert`，异常之间变化为 `change`，恢复正常为 `recovery`。接收器须接受 JSON POST，凭证只通过 `Authorization: Bearer …` 请求头传递。webhook 必须是 HTTPS，不允许 URL userinfo、query 或 fragment，也不要把凭证放进 URL 路径。两个请求均有超时，且拒绝跳转。

仅接收器返回 2xx 后才原子更新 `state.json`；这表示接收器接受请求，不等于真人已读。失败不确认，下次运行重试相同 `Idempotency-Key`，建议接收器据此去重。更换服务标识、health 地址、接收 URL 或接收凭证后会重新发送首次状态。持久文件仅保存状态、时间和身份散列，不保存 URL 或凭证。进程崩溃在“接收成功、落盘前”时可能重送；不会静默假设成功。

## 配置与手动检查

复制 `monitor.env.example` 到独立的 `/etc/ad-research-test/monitor.env`，由运维填入接收器及 token，权限设为 root 所有的 `0600`。**当前没有真实接收目标，不设置 `MONITOR_ENABLED=true`、不启用 timer，也不执行真实通知。** 此配置不读取 `app.env`，不调用邮件、Stripe、OpenAI 或 Meta。

准备持久状态目录：

```sh
install -d -o 1000 -g 1000 -m 0700 /var/lib/ad-research-test-monitor
chmod 0600 /etc/ad-research-test/monitor.env
```

以下例子使用固定版本路径和该版本已有的 Node 应用镜像。部署时将两处 `RELEASE_ID` 替换为实际版本；不能用未核验的浮动镜像。脚本随 release 的 `deploy/` 目录分发，以只读 bind 挂入容器，无需重建镜像，也不启动 API 或 worker。

```sh
docker --host unix:///var/run/docker.sock run --rm \
  --network host --read-only --user 1000:1000 \
  --cap-drop ALL --security-opt no-new-privileges:true \
  --pids-limit 64 --memory 128m --cpus 0.5 --log-driver none \
  --env-file /etc/ad-research-test/monitor.env \
  --mount type=bind,src=/opt/ad-research-test/releases/RELEASE_ID/deploy/health-monitor.mjs,dst=/monitor.mjs,readonly \
  --mount type=bind,src=/var/lib/ad-research-test-monitor,dst=/state \
  --entrypoint node ad-research-saas-test:RELEASE_ID /monitor.mjs --dry-run
```

`--dry-run` 只查询 health 并输出脱敏结果，不发通知、不创建锁、不写确认状态。接收器配置仍需完整，以准确校验配置和目标身份；缺少配置返回 `NOT_ENABLED / CONFIGURATION_REQUIRED`，不会假称告警已启用。`MONITOR_ENABLED=false` 返回 `NOT_ENABLED / DISABLED`。只有 HTTPS health 或字面回环 IP 的 HTTP health 可用；本例 host 网络用于访问宿主 `127.0.0.1:13001`，同时允许连接指定 HTTPS 接收器，不能当作防出网隔离。

## systemd 每分钟运行模板

仅在用户提供真实接收目标并完成 dry-run/接收确认后部署。建立 `/etc/systemd/system/ad-research-health-monitor.service`，先替换固定版本 `RELEASE_ID`：

```ini
[Unit]
Description=Ad Research isolated health notification
After=docker.service network-online.target
Wants=network-online.target
Requires=docker.service

[Service]
Type=oneshot
ExecStart=/usr/bin/docker --host unix:///var/run/docker.sock run --rm --name ad-research-health-monitor --network host --read-only --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges:true --pids-limit 64 --memory 128m --cpus 0.5 --log-driver none --env-file /etc/ad-research-test/monitor.env --mount type=bind,src=/opt/ad-research-test/releases/RELEASE_ID/deploy/health-monitor.mjs,dst=/monitor.mjs,readonly --mount type=bind,src=/var/lib/ad-research-test-monitor,dst=/state --entrypoint node ad-research-saas-test:RELEASE_ID /monitor.mjs
TimeoutStartSec=75
UMask=0077
StandardOutput=journal
StandardError=journal
```

宿主 unit 需要调用 Docker 的权限；实际脚本以容器 UID/GID `1000:1000` 执行。只挂入确切脚本和专属状态目录，不挂 Docker socket，不读应用 env。`TimeoutStartSec` 覆盖最多两个 30 秒请求。Docker 基础设施失败也会令 unit 失败，可从 journal 判断；不要以全量 `docker inspect` 或打印 env 的方式排查。

建立 `/etc/systemd/system/ad-research-health-monitor.timer`：

```ini
[Unit]
Description=Run Ad Research health notification each minute

[Timer]
OnBootSec=2min
OnUnitActiveSec=60s
RandomizedDelaySec=5s
Unit=ad-research-health-monitor.service

[Install]
WantedBy=timers.target
```

配置完成后由运维执行 `systemctl daemon-reload`，先手动运行该 service 核对接收器收到的状态，再执行 `systemctl enable --now ad-research-health-monitor.timer`。这些命令是待部署模板，本轮没有执行。升级时仅把 service 中的固定脚本路径和镜像版本一起更新，保留状态目录。

`monitor.lock` 通过排他创建实现单实例；锁和状态均为 `0600`，状态目录必须真实路径、当前执行用户所有且为 `0700`。脚本不会猜测锁是否过期。若崩溃留下锁，先停 timer，确认专属容器及进程已结束，再由运维只删除该目录下的 `monitor.lock` 后恢复；不要删 `state.json` 或其他任务的锁。

## 本地验证

```sh
node --test deploy/health-monitor.test.mjs
```

测试只使用本机 HTTP fixture；HTTPS 接收地址由测试传输层明确映射到本机，生产 CLI 仍使用原生 fetch 和 HTTPS 校验。覆盖变化、重复、恢复、失败重试、目标变更、互斥锁、dry-run、超时/错误分型、跳转拒绝与敏感内容不进入输出。未发真实外部通知，实际接收交付仍待验收。

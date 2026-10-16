# SMTP 与私有对象存储技术验收

`verify-services.mjs` 随镜像复制到 `/opt/ad-research/verify-services.mjs`，必须在镜像的 `/opt/ad-research/app` 工作目录执行，依赖从该目录的 `package.json` 解析。脚本只读取现有环境变量，不读取或输出 env 文件、密钥、签名 URL、邮件正文或供应商错误正文。

在 release 的 `deploy/container` 目录执行，下面命令使用既有 API 容器环境：

```bash
# 仅连接、TLS、SMTP 认证；不会调用 sendMail。
docker compose --project-name ds-meta-saas-test \
  --env-file /etc/ad-research-test/release.env exec -T api \
  node /opt/ad-research/verify-services.mjs --smtp

# 仅对一个专用随机对象执行真实 S3 生命周期验证。
docker compose --project-name ds-meta-saas-test \
  --env-file /etc/ad-research-test/release.env exec -T api \
  node /opt/ad-research/verify-services.mjs --storage
```

省略参数会依次验证两项；也支持 `--help`。容器尚未启动时，可将 `exec -T api` 换为 `run --rm --no-deps api`。不需要数据库或 worker；脚本不调用 OpenAI、Stripe 或 Meta。

SMTP 要求 `SMTP_HOST`、`SMTP_USERNAME`、`SMTP_PASSWORD`；端口默认 587，`SMTP_SECURE=true` 使用隐式 TLS，否则强制 STARTTLS。证书校验开启。`connection_auth_verified` **只表示连接和认证通过，不表示邮件投递或真人收信通过**。

存储要求 `S3_BUCKET`、`S3_REGION`、HTTPS origin 形式的 `S3_ENDPOINT`、`AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`；读取 `S3_FORCE_PATH_STYLE`，可使用 `AWS_SESSION_TOKEN`。使用显式凭证，不发现其他主机身份。部署凭证需要允许在专用 `verify/` 前缀创建、读取和删除对象；脚本不会列举 bucket 或读已有对象。

每次使用新的 `verify/<随机 UUID>.png`，写入 68 字节合成 PNG，再严格验证：

1. 无签名 GET 返回 403。
2. 有效期 2 秒的签名 GET 返回 200，字节完全一致。
3. 等待 2.5 秒后，同一签名返回 403。
4. 删除对象后，新签名 GET 返回 404。

请求不跟随重定向，HTTP / SDK 请求设置超时；2.5 秒是主动等待时间，不含网络耗时。Garage 时钟偏差、额外签名宽限、反代错误或权限导致其他状态都会失败，不放宽期望值。

输出为脱敏 JSON，全部通过退出码为 0，否则为 1。任一步失败仍尝试删除本次对象。`cleanup=delete_acknowledged` 只代表删除请求被接受；若 `cleanup=FAILED`，输出的 `cleanupObjectId` 可组成本次对象键 `verify/<cleanupObjectId>.png`，供运维定点清理，不能据此宣称对象已删除。

本轮只完成语法检查及 8 个本地假传输场景验证，S3 签名与请求使用已安装的真实 AWS SDK `3.1000.0`；覆盖成功、单项选择、匿名暴露、到期未拒绝、字节不一致、删除失败、缺少配置。没有连接真实 SMTP / S3，也没有发邮件。真实结果应另行归档。

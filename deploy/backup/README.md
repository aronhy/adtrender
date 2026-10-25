# 对象恢复的存储兼容性

`scripts/object-backup.mjs restore` 需要目标存储正确执行 `PutObject` 的
`If-None-Match: *`：目标键存在时必须返回 HTTP 412，并保留原字节。
仅有 S3 API 或 PutObject 支持不足以保证这一点。

恢复有待上传对象时，脚本先在目标桶的 `.adtrender-restore-probe/<随机 UUID>`
创建临时对象，再尝试条件覆盖，检查 HTTP 412、原字节和清理结果。
全部通过后才执行数据库恢复及业务对象上传；每次业务上传仍带条件请求头。
完整恢复的只读重验以及空对象快照不执行探测。

恢复凭据除现有 ListBucket、GetObject、PutObject 权限外，需要对
`.adtrender-restore-probe/*` 的 DeleteObject 权限。脚本只删除自身探测键，
业务对象不进入删除路径。若清理失败，会保留失败状态；检查该前缀下的残留探测对象，
确认没有业务数据后清理，再重试。不要通过放宽目标桶隔离检查来绕过失败。

| 错误码 | 含义 |
| --- | --- |
| `OBJECT_STORE_CONDITIONAL_PUT_UNSUPPORTED` | 存储接受了条件覆盖，或返回 412 后原字节已改变 |
| `OBJECT_STORE_CONDITIONAL_PUT_UNVERIFIED` | 权限、连接或其他响应使条件写入无法确认 |
| `OBJECT_STORE_PROBE_CLEANUP_FAILED` | 无法确认临时对象已清理；异常字节会保留，不自动删除 |

**Garage 2.4.1 不支持本恢复流程要求的条件写入语义。** 真实实例中，
SDK 已发送正确请求头，但服务仍覆盖已有对象。脚本会在创建恢复数据库、上传业务对象
及发布恢复回执之前拒绝执行。该限制不影响只读对象备份；Garage 的安全恢复方案需另行实现。
探测用于识别此类不兼容实现，不能替代存储服务自身的原子性保证。

本地协议回归不需要数据库或 Docker：

```sh
node --test deploy/object-backup.test.mjs deploy/object-backup-boundaries.test.mjs deploy/object-backup-protocol.test.mjs
```

完整验收需要 Docker、Node.js 24 和 PostgreSQL 15 客户端，以及显式指定的回环测试数据库：

```sh
export SAAS_BACKUP_TEST_DATABASE_URL='postgresql://test_user:test_password@127.0.0.1:55438/adtrender_test'
# 若客户端不在 PATH，设置 PG_BIN 为 PostgreSQL 15 的 bin 目录。
node deploy/backup/run-garage-rehearsal.mjs
```

验收创建随机命名数据库及独立源、目标 Garage 实例，使用合成数据；完成后删除本次资源。
覆盖真实 PostgreSQL 与兼容 HTTP 存储的成功恢复、五类对象引用校验、无写入重验，
以及真实 Garage 的拒绝路径：源桶只读凭据有效、目标数据库未创建、目标桶为空、无成功回执。
CI 执行相同入口。

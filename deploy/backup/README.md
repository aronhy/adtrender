# 联合备份恢复回归

普通回归已接入 `scripts/verify.sh`：对象归档和边界测试始终运行；三个 PostgreSQL 集成测试需显式设置 `SAAS_BACKUP_TEST_DATABASE_URL`，缺失时本机跳过、CI 报错。测试仅接受本机测试库地址，并创建、清理各自随机命名的数据库，不清空传入的数据库。

## 真实 Garage 演练

先完成项目依赖安装及 Wasp 生成，确保 PostgreSQL 15 测试实例可用。环境变量由本机私有配置提供，不把含密码的 URL 写进命令行或日志：

```bash
# 必需：SAAS_BACKUP_TEST_DATABASE_URL，连接本机、库名含独立 test/restore 段。
# 该账号需有 CREATEDB 权限；全部数据均为测试生成的合成数据。
# 可选：PG_BIN，指向与 PostgreSQL 服务端同主版本的客户端目录。
node deploy/backup/run-garage-rehearsal.mjs
```

演练需要 Docker Compose。runner 为本次运行生成随机项目名、凭据和两个独立 Garage 2.4.1 实例；仅向本机发布动态 S3 端口，不发布 RPC。配置文件权限为 `0600`，源、目标使用独立数据卷和不同凭据，备份 CLI 仅获得源桶的只读密钥。结束时清理该项目的容器和卷，不使用应用的 Compose 项目、`.env` 或存储卷。

演练调用实际 `backup.sh`、`object-backup.mjs` 和 `restore-check.sh`，覆盖：

- 真实数据库迁移、私有笔记及五类对象引用的备份恢复，逐字节校验公共媒体、私有文件和来源证据。
- 源只读权限、目标条件 PUT 的 `412` 响应及原对象保留。
- 源对象或本地归档损坏时失败；不发布成功 manifest，不新建恢复库或写入目标对象。
- 非空目标桶拒绝、重复恢复只读、数据库元数据变化、目标对象变化或丢失时拒绝通过。
- 透传 HTTP 观察器将签名请求完整转发至真实 Garage，仅记录方法，确认备份无写操作、恢复恰好三次 PUT、重复核验无 PUT/DELETE。响应由 Garage 生成。

GitHub Actions 在独立 PostgreSQL 15 服务和临时 Garage 实例上运行本演练。现有模拟 S3 测试继续验证并发竞争、部分失败和边界条件。

此处验证合成数据的恢复正确性，不代表生产异地恢复、加密备份、保留策略、大规模吞吐、RPO/RTO 或恢复后整套应用的业务验收。

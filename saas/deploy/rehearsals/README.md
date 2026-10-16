# 隔离测试服务器的研究数据重启验收

`research-persistence.py` 仅供操作员在 Netcup 的 `ds-meta-saas-test` 项目执行。它要求明确传入当前测试版本、40位源码提交和 `--execute`，核验 current、镜像、七项迁移及数据库角色后才开始。已有客户、研究记录、邮件或采集/分析队列时拒绝运行。不要用于生产或已有客户的测试库。

脚本创建3个随机合成身份及会话，通过运行中的原生 API 创建两个团队、一条收藏、文件夹和编辑笔记；检查重复收藏和权限后，仅重启本项目 API/worker，再次用同一会话和记录 ID 回读。它不测试注册、邮件投递、真实 Google 登录、来源采集或模型分析。

完整流程由控制器调用同目录的 `research-persistence-probe.mjs`。**不要单独运行或公开探针 stdout**：探针返回的 `state` 包含本次临时会话，控制器只把安全的 `report` 写入验收输出；状态在服务器 root0600 文件保存，成功清理后移除，失败时保留路径用于精确恢复。不会打印环境密钥、会话或原始异常。

```bash
python3 /opt/ad-research-test/releases/当前版本/deploy/rehearsals/research-persistence.py \
  --release 当前版本 \
  --source-commit 该版本manifest中的40位源码提交 \
  --execute
```

清理依据预先生成的用户/来源/广告 UUID 与本次运行标记重新发现记录，同一事务按外键顺序删除，保留最后所有者约束；不执行空间归档、不截断表、不删除既有数据。试用套餐只有在本轮新建且没有其他订阅引用时才清理。随后验证业务计数、既有套餐和来源与运行前一致，旧会话已失效，原有23个容器及数据库/Garage未变，当前worker心跳正常。

成功报告为 `RESEARCH_PERSISTENCE_VERIFIED`，只证明该版本在真实服务器上使用合成数据的技术结果。真实客户使用、外部两团队验收及数据库与媒体联合恢复必须另外记录。

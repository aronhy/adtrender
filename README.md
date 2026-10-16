<p align="center">
  <a href="https://adtrender.com" target="_blank">
    <img alt="AdTrender" src="saas/app/public/adthrender-mark.svg" width="96" />
  </a>
</p>

<h1 align="center">AdTrender</h1>

<p align="center">
  <a href="https://opensource.org/license/mit"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
</p>

<p align="center">
  <strong>开源的广告研究平台：采集 Facebook、Instagram、TikTok、Google / YouTube、Pinterest、Snapchat 公开广告，搜索、收藏、分析竞品素材。</strong><br />
  An open-source ad research platform for cross-border e-commerce teams and agencies.
</p>

<p align="center">
  <a href="https://adtrender.com"><strong>AdTrender Cloud »</strong></a>
  ·
  <a href="saas/README.md">自托管文档</a>
  ·
  <a href="https://github.com/aronhy/adtrender/issues">反馈问题</a>
</p>

<p align="center">
  <img alt="Facebook" src="saas/app/public/platforms/facebook.png" width="28">
  <img alt="Instagram" src="saas/app/public/platforms/instagram.png" width="28">
  <img alt="TikTok" src="saas/app/public/platforms/tiktok.png" width="28">
  <img alt="Google" src="saas/app/public/platforms/google.png" width="28">
  <img alt="YouTube" src="saas/app/public/platforms/youtube.png" width="28">
  <img alt="Pinterest" src="saas/app/public/platforms/pinterest.svg" width="28">
  <img alt="Snapchat" src="saas/app/public/platforms/snapchat.svg" width="28">
</p>

想省去部署和采集节点运维，直接用 [adtrender.com](https://adtrender.com)；想掌控数据，就用这个仓库在自己的服务器上部署。

## 功能

- **多平台广告库**：按关键词、平台、国家、素材类型搜索公开广告，查看广告详情、投放历史和广告主。
- **种子库与无人值守采集**：集中管理采集任务，采集节点按分配领取、断点续采、去重入库。
- **团队工作区**：组织、成员、收藏、笔记和分析按工作区隔离。
- **订阅与计费**：组织级订阅，接入 Stripe。
- **平台后台**：用户、组织、广告与采集状态的运营面板。

只展示能从公开来源观测到的事实；首次观测不等于首次投放，产品不会编造营收、点击或 ROAS。

## 技术栈

[Wasp](https://wasp.sh) / [Open SaaS](https://github.com/wasp-lang/open-saas) · React · Node.js · PostgreSQL + Prisma · Playwright 采集器 · S3 兼容对象存储

| 目录 | 内容 |
| --- | --- |
| [`saas/app`](saas/app) | Web 应用：官网、工作台、认证、团队、计费、API、数据库迁移 |
| [`saas/collector`](saas/collector) | 各平台采集器与节点部署工具 |
| [`saas/worker`](saas/worker) | 独立后台进程：采集调度、邮件、分析任务 |
| [`saas/contracts`](saas/contracts) | 应用与 worker 共享的数据契约 |
| [`saas/deploy`](saas/deploy) | 容器、反向代理、备份恢复与健康检查 |
| [`scripts/saas-migration`](scripts/saas-migration) | 旧数据导入工具 |

## 快速开始

需要 Node.js 24、PostgreSQL。完整配置项、启动和发布说明见 [saas/README.md](saas/README.md)。

```bash
cd saas/toolchain && npm ci --no-audit && cd ..
export PATH="$PWD/toolchain/node_modules/.bin:$PATH"
cd app && npm ci --no-audit
cp .env.server.example .env.server   # 填写数据库等配置
cd .. && ./scripts/wasp.sh start
```

默认页面 `http://localhost:3000`，API `http://localhost:3001`。

## 参与贡献

欢迎提 Issue 和 Pull Request，流程见 [CONTRIBUTING.md](CONTRIBUTING.md)。发现安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。

## 许可

[MIT](LICENSE)。`saas/` 基于 Open SaaS 模板，其许可见 [saas/OPEN-SAAS-LICENSE](saas/OPEN-SAAS-LICENSE)。

采集公开广告数据时，请遵守各平台的服务条款和所在地区的法律法规。

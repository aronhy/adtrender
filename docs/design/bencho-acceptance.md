# 前台改版本地验收记录

日期：2026-10-18。范围：PRD 第一批 F01–F04、第二批 F05–F08。代码位于新仓库 `/Users/aron/Desktop/01_开发项目/adtrender`，分支 `codex/frontend-bencho-prd`。基线 `14bdbb58`；第一阶段实现提交 `cc2095c`。没有推送或部署，没有使用生产数据、密钥或现有数据库。

## 当前结果

八项均已实现并接入真实页面。实现不依赖 Bencho Pro；逐项取得情况、授权和独立实现选择见 [源码核验](bencho-source-audit.md)。保留现有温灰/橙色品牌、四种语言及后端鉴权和查询值，没有引入新 UI 框架或修改数据库 schema。

本地入口：[研究工作区](http://127.0.0.1:7310/app/research?workspace=21ce19f7-45b5-4b7b-82f2-067185fe6779&lang=zh-CN)、[广告资料库](http://127.0.0.1:7310/app/ads)、[官网](http://127.0.0.1:7310/)。示例账号在本机 `.local/frontend-redesign/fixture.json`，已在预览会话通过正常邮箱密码流程登录；凭据不提交 Git。

## 逐项验收

| 项目 | 接入页面与行为证据 | 当前验收边界 |
|---|---|---|
| F01 Shimmer | `AdMedia.tsx` 的真实图片/视频就绪状态驱动，保留签名刷新和缓存；媒体 DOM 回归覆盖加载、失败、过期、海报和文本广告 | 自动浏览器中的本机 HTTPS 证书仍未受信任，已实测失败后停止占位并提供刷新；签名图片响应的服务验证通过，**浏览器成功加载和扫光过渡待确认** |
| F02 Toast | 实际收藏后“已收藏到当前工作区”；实际保存笔记后“笔记已保存”；焦点展开并暂停。测试覆盖 5 条队列、错误保留、去重、跨工作区、工作台和业务列表回读失败、重试 | 真实生产服务错误不在本轮范围；相关分支以受控 DOM/命令测试验证 |
| F03 Copy | 详情全文和安全原始 URL 使用共用按钮，等待 Clipboard 确认；失败保留可选文本。测试覆盖多行中文/emoji、拒绝、空值、切换广告 | 真实浏览器点击后已确认“已复制文案”，成功截图已保存；未读取用户剪贴板 |
| F04 Dropdown | 实际国家列表搜索“美国”，提交后 URL 为 `country=US`；Tab 从搜索框进入“文案状态”触发器。原生 FormData、reset、controlled/disabled、Google 条件均保留 | 已验证本地选择与查询参数，未改变来源能力或抓取覆盖 |
| F05 Sidebar | 实际收起为 76px；键盘提示 portal 位于 BODY，避免侧栏裁切；396px 手机抽屉保留全部 5 个导航名称且 opacity=1，无页面横向溢出 | 保存偏好后跨断点已验证；系统读屏实机未验收 |
| F06 Tab bar | 详情 End 键切到“相关广告”，研究页保留“收藏广告/分析记录”文字与计数；不重建左侧媒体 | 存在下文记录的一个样式细节 |
| F07 Resize | 详情 Home→右键后 aria-valuenow=296px，明确复位按钮可用；组件测试验证左右边界、保存和媒体 DOM 身份 | 未在自动浏览器中播放实际视频；指针和宽度限制按组件实现及审查验证 |
| F08 FAQ | 官网初始全部关闭；帮助首项展开。实际打开“查询国家与投放国家…”后首项关闭；官网另一问题可展开；关闭内容 inert | 手机/桌面截图已保存；没有改写原有问答口径 |

真实组合流程：搜索/地区筛选 → COFFEE CLUB 示例详情 → 收藏 → 研究列表回读 3 条记录 → 保存研究笔记 → 回读笔记与通知。全部发生在独立本机合成数据库。

## 独立审查与修复

独立审查覆盖 `14bdbb58..cc2095c`，没有 Critical。六项 Important 已修复：移动导航文字隐藏、侧栏 tooltip 裁切、可搜索下拉 Tab 焦点丢失、素材下载重试通知 ID 冲突、手动刷新重建分析卡片丢失终态、只检查工作台而未检查业务列表的回读失败。

新增复现测试先在旧行为失败，再修复并通过。侧栏样式测试曾先遇到测试文件 URL 读取错误；修正读取路径后，在原提交 CSS 上确认 opacity=0 的实际失败，再用新 CSS 通过。最终整仓回归通过。没有再派发第二次审查。

保留的 Minor：研究页标签是 React fragment，语言或数量改变而容器宽度不变时，选中底板可能暂未重新测量；下次切换或尺寸变化会更新。文字、选择和业务内容仍正确。本轮未扩展这处样式修整。

## 验证结果

- 最终修复后：215 个测试文件通过，1 个跳过；**2049 项通过、28 项跳过**（2077 项总计），`.local/frontend-redesign/review-full-suite.log`，退出 0。
- 最终 TypeScript：`tsc -p apps/web/tsconfig.build.json --noEmit`，退出 0。
- 最终前端生产构建：`vite build`，退出 0；仍有既有大 chunk 警告，未因本轮扩展包体优化范围。
- 修复前整套 `scripts/verify.sh` 已退出 0，包含真实 Wasp 生成、API、前端和独立 worker 构建；修复后再次运行完整测试和前端构建。API/worker 没有业务修改。
- 明确配置本轮拥有的测试库 `adtrender_ui_test_frontend`；没有把数据库测试全部跳过当成通过。跳过项仍按现有 suite 条件保留，不等同外部服务或用户验收。
- 本机媒体服务：无签名请求 403，真实签名图片 200 且有有效 PNG 字节，篡改签名 403。验证使用明确的本机证书 CA；没有关闭 TLS 校验，也没有代替用户绕过浏览器警告。
- 初次整仓验证的 collector 子进程缺根目录 `tsx`，已通过仅本机 `node_modules/tsx` 链接到锁定 Web 依赖解决；没有改动采集器源码或依赖清单。重装根目录依赖后，重新验证前需恢复该本机链接。

## 本地环境与恢复

独立 PostgreSQL 监听 `127.0.0.1:55449`，API `7311`、前端 `7310`、合成媒体 HTTPS `17443`。媒体图来自仓库已有示例图的分片；没有下载 Bencho 图片。合成广告、组织、工作区均有“本地示例”标识，不代表真实广告数据。

在此 checkout 中运行（脚本和凭据均忽略提交）：

```sh
cd /Users/aron/Desktop/01_开发项目/adtrender
.local/frontend-redesign/start-preview.sh
```

该脚本只在相应本机端口未响应时启动预览，不会终止占用端口的其他进程。源码编译清理 Wasp 目录后，可能需要重新启动 Vite。证书有效期 3 天，过期后需重建本机证书并由使用者本人处理浏览器信任；不把自签名例外推广到产品。

用户回复已允许证书，但本次 Codex 与 Chrome 自动验收会话仍返回 `ERR_CERT_AUTHORITY_INVALID`；已请求定位用户实际放行的浏览器。此限制不表述为媒体成功验收。未保存改版前的浏览器截图，源代码基线可用 Git 对比；以下只展示本轮实际画面。

## 截图

- [研究工作区](evidence/adtrender-research.png)
- [真实笔记保存通知](evidence/adtrender-research-toast.png)
- [详情与复制控件](evidence/adtrender-detail.png)
- [真实复制成功](evidence/adtrender-copy-success.png)
- [筛选下拉](evidence/adtrender-dropdown.png)
- [收起侧栏](evidence/adtrender-sidebar.png)
- [手机抽屉](evidence/adtrender-mobile-nav.png)
- [手机帮助 FAQ](evidence/adtrender-mobile-faq.png)
- [官网 FAQ](evidence/adtrender-home-faq.png)

本地效果可以查看；生产上线、真实账号和媒体成功播放仍是独立验收边界。其他聊天的 README、docs README、planning/research 内容保持原样，未纳入此改版提交。

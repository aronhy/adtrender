# AdTrender Free Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 把导航免费工具做成可独立使用的真实功能，首批交付 8 项，并为 Shopify 检测/导出保留清楚的后续边界。

**Architecture:** 沿用 `apps/web` 的 React/Wasp。一个工具注册表、一套公开页面壳、6 个纯函数计算器、规则 Hook 生成器和固定官方广告库链接生成器。首批不新增业务 API、模型服务或数据表，仅扩充既有统计公开路径契约。

**Tech Stack:** 项目固定 Node 24.14.1、Wasp 0.25、React 19、TypeScript 6、Vitest；金额计算采用已核对的 big.js 7.0.1 及对应开发期类型定义，锁定版本和 lockfile，不搬第三方整站。

**Spec:** [范围、14 项清单、源码许可与公式口径](../../research/2026-10-22-free-tools-open-source.md)。用户已批准第一批；2026-10-23 已完成本地实现与验收。

## Global Constraints

- 开发归属公开 `aronhy/adtrender`；执行时从最新 `main` 建 `codex/free-tools` 独立分支，保留其他工作区改动。
- 基础功能免登录；只有访问现有工作区、保存到云端等动作走原有登录与权限。
- 计算器处理用户输入；Hook 首版为模板生成，不调用付费模型、不声称 AI 读过真实商品或广告。
- 每个已上线工具有独立 `/tools/<slug>` 页面；尚未实现的 6 项不再伪装成可点击功能跳到帮助页。
- 不新增通用插件平台、任务队列、独立服务或完整会计系统。
- 不收集计算金额、客户假设、Hook 原文或品牌查询词；现有网站统计继续遵守同意/撤回规则。
- 来源与许可证记录到依赖许可说明，真实生产数据、账号配置与快照发布流程留在私有仓。

## Review Focus

1. 空字段、0 分母、非法/超大数、亏损、币种及年/月单位混用。
2. 盈亏平衡 ROAS 不重复扣广告费；ROI 不重复扣成本；LTV 不冒充利润或实际预测。
3. 访客无工作区、未登录、重置/复制失败、手机/键盘操作仍能完成工具任务。
4. 注册表、导航、实际路由、SEO 与统计白名单保持一致；未知 slug 显示未找到。
5. 用户输入只作文本/数值处理；不进入任意外链、HTML、URL 统计参数或第三方回放。

## 批次与交付

| 批次 | 内容 | 完成条件 |
| --- | --- | --- |
| 第一批（本实施计划） | 6 计算器＋模板 Hook＋广告库导航器，共 8 项 | 无需新数据源即可真实使用；8 个独立页面、导航、说明、边界及验证齐全。 |
| 第二批（另开小计划） | Shopify 主题、应用、公开商品导出，共 3 项 | 审计选定开源模块；共用受控读取；有限样本实测及 partial/unknown 状态通过。 |
| 第三批（按数据准备） | Chrome 扩展、竞品分析、商品线索，共 3 项 | 扩展连接/撤销和分发分别验收；分析具备可核对来源；没有销量数据则不发布销售爆款榜。 |

## 第一批文件与接口

以 `apps/web` 为根，不另建应用。以下是计划新增/修改的位置，实施前结合最新 main 检查命名冲突。

| 文件 | 责任/接口 |
| --- | --- |
| `src/client/tools/registry.ts` | 工具名称、slug、状态、说明；导航与工具目录唯一来源。导出 `freeTools`、`getFreeTool(slug)`。 |
| `src/client/tools/ToolsPage.tsx` | `/tools` 总目录、`/tools/:slug` 分发。导出 `ToolsIndexPage`、`FreeToolPage`。 |
| `src/client/tools/ToolLayout.tsx`、`tools.css` | 表单、结果、公式、示例、重置与复制反馈；沿用官网品牌和现有全局页头/页脚，避免重复套壳。 |
| `src/client/tools/calculators.ts` | `calculateRoas`、`calculateProfit`、`calculateMargin`、`calculateRoi`、`calculateLtv`、`calculateShopifyCost`；参数为十进制字符串，业务逻辑不依赖 DOM/Wasp。 |
| `src/client/tools/CalculatorTool.tsx` | 共享字段渲染和 6 种计算器配置；纯客户端状态，不导入工作区数据 Provider。 |
| `src/client/tools/hooks.ts`、`HookTool.tsx` | `generateHooks({product,audience,benefit,language})` 返回带分类的 10 条模板文本；中文/英文句式原创。 |
| `src/client/tools/ad-finder.ts`、`AdFinderTool.tsx` | `adFinderLinks(query,platform)` 返回固定官方广告库入口及 AdTrender 搜索入口；不调用需 workspaceId 的查库 API。 |
| `src/client/tools/*.test.ts` | 纯函数、组件、匿名路由与导航一致性；fixtures 均合成。 |
| `main.wasp.ts`、`src/client/Pages.tsx` | 注册两个公开路由 `/tools`、`/tools/:slug`，位于通配 404 前。 |
| `src/client/studio/StudioPublic.tsx`、`src/client/PublicPages.tsx` | FREE 菜单读取注册表；帮助页旧入口引导到 `/tools`。 |
| `public/robots.txt`、`public/sitemap.xml` | 只放行并列出实际上线的工具页，继续阻止认证/工作区收录。 |
| `src/client/site-analytics/analytics.ts`、`growth.ts`、`src/growth/contract.ts` | 为上线工具增加确切公开路径；只记录已授权访问和现有注册/登录 CTA，不发送表单值。 |
| `package.json`、`package-lock.json`、`docs/frontend/free-tools-sources.md` | 添加单一已审金额依赖并保留来源/许可；不安装其他候选项目。 |

统一纯函数结果：`CalcResult = {ok:true; values:Record<string,string>} | {ok:false; fieldErrors:Record<string,string>}`。计算器字段错误返回给表单，不向用户显示 Infinity/NaN 或底层库异常。中间不提前舍入，输出金额/百分比/倍数保留两位；百分比输入例如 `40` 表示 40%。

## Task 1：目录、路由和导航

**Files:** registry、ToolsPage、ToolLayout、tools.css、main.wasp、Pages、StudioPublic、PublicPages 及对应 tests。

**Interfaces:** `freeTools` 区分 `ready/planned`；slug 固定为调研表中的 8 项。外部路由依旧受原有 SurfaceBoundary 管理。

- [x] 写匿名工具目录测试：8 个 ready 链接均能打开具体工具，不跳登录；planned 项有明确筹备状态，无假功能按钮。
- [x] 写未知 slug、键盘导航及 390px 布局断言，先确认新增测试失败。
- [x] 实现共用页面壳、两个公开路由和注册表；页面含独立标题/说明/公式区域。外部链接仅打开来源站，工作区入口明确需登录。
- [x] 执行新增路由/导航测试及既有 App、认证、SurfaceBoundary 回归，通过后提交这一小步。

## Task 2：ROAS、利润、利润率、ROI

**Files:** calculators、CalculatorTool、共享字段/结果组件、calculator tests、依赖和来源说明。

**Interfaces:** `calculateRoas({revenue,adSpend,contributionMarginPct})`；`calculateProfit({revenue,goods,fulfillment,payment,adSpend,other})`；`calculateMargin({revenue,cost})`；`calculateRoi({returns,cost})`。所有字段为同币种、同期间的十进制字符串。

- [x] 用调研表例子写失败测试：ROAS 4 倍、回本 ROAS 2.5 倍、利润 200/−200、利润率 20%、ROI 25%；广告费/收入/投入为 0 时返回对应字段错误。
- [x] 增加空输入、负成本、非有限数字、重复扣广告费/成本、0.1＋0.2 的精度用例；数值输入只接受普通十进制（最多 12 位整数、4 位小数），拒绝指数表达式、Infinity/NaN 和负成本。
- [x] 引入 big.js 7.0.1，补齐对应 @types/big.js 开发期类型并锁入 lockfile，记录 MIT notice；实现纯函数和共享 UI。金额非负，计算出的亏损允许为负；贡献率≤0 提示当前成本结构无法回本，>100% 拒绝。
- [x] 验证表单可编辑、计算/重置、复制成功/失败、负利润呈现和错误聚焦，运行定向测试通过后提交。

## Task 3：LTV 与 Shopify 订阅预算

**Files:** calculators、CalculatorTool 及对应 tests。

**Interfaces:** `calculateLtv({aov,purchasesPerYear,lifetimeYears,contributionMarginPct})`；`calculateShopifyCost({subscriptionAmount,billing:'monthly'|'annual',appsMonthly,domainAnnual,oneOff})`。

- [x] 写失败测试：LTV 50×3×2＝300、贡献 LTV 120；缺少任一假设不生成完整结果；购买频次只接受每年，客户年限只接受年。
- [x] 写预算失败测试：年订阅 360、应用 20/月、域名 12/年→51/月、612/年；一次性费用不能重复计入经常性月费。
- [x] 实现两页，年付分摊显示月度预算；一次性费用单列，并给出首年总预算。订阅费用由用户填报，不内置全球价目表；明确交易处理费、税等未计入范围，链接官方报价来源。
- [x] 校验 ROAS/利润工具没有被新配置破坏；两页匿名、手机/键盘、空值及切换账期测试通过后提交。

## Task 4：模板 Hook 生成器

**Files:** hooks、HookTool、原创模板与 tests、free-tools-sources。

**Interfaces:** `generateHooks({product:string,audience:string,benefit:string,language:'zh-CN'|'en'}) -> Array<{id:string;category:string;text:string}>`。

- [x] 写失败测试：三个必填字段缺少时不生成；完整输入得到 10 条含所填卖点的开头；相同输入产生可复现结果。
- [x] 测试引号/换行/HTML 字符仅作为文字显示；每字段最多 200 字符，超长给字段错误。没有证据输入就不生成数字业绩、用户评价或效果保证。
- [x] 参考已核验分类，自写约 20 个中/英文句式供各语种选用。界面标“模板生成”，输入采用对应输出语种，不承诺自动翻译；支持单条/全部复制与失败反馈。
- [x] 验证没有模型网络请求、没有写入浏览器长期存储或统计表单原文；通过测试后提交。

## Task 5：广告库导航器

**Files:** ad-finder、AdFinderTool、home-search-intent 现有接入点及 tests。

**Interfaces:** `adFinderLinks(query,platform) -> Array<{label:string;url:string;kind:'official'|'workspace'}>`；所有目的站固定，关键词只编码为数据。

- [x] 写失败测试：空查询不跳转；`& ? # 中文`正确编码；无法注入任意主机或脚本 URL；未登录仍可使用官方入口。
- [x] 实现品牌/关键词输入，官方来源与 AdTrender 已收录数据入口明确区分。已核实查询参数的平台才预填查询；其余打开官方入口并提供复制关键词，避免编造不生效参数。
- [x] AdTrender 入口复用受限搜索意图保存，登录后保留查询；不绕过 workspaceId/来源授权校验，不预先调用需权限的搜索接口。
- [x] 验证外链、登录返回、输入编码和授权广告搜索原回归，通过后提交。

## Task 6：可发现性与最终验收

**Files:** robots、sitemap、工具页元信息、现有 analytics/growth 路径契约与 tests。

- [x] 写失败测试：注册表中每个 ready 路由都在导航、sitemap、公开路径白名单中；未知/筹备 slug 不进入 sitemap。
- [x] 修改 robots 仅放行对应 `/tools` 路由；为 8 页设置 title、description、canonical。验证服务端 HTML 可看到标题与工具说明，不能只检查浏览器 document.title。
- [x] 扩充现有同意后的 PAGE_VIEW/CTA_CLICK 路径；拒绝统计仍可完整使用工具。金额、Hook、品牌查询及任意输入不进入事件或 URL；工具输入/输出区域默认禁止第三方回放采集。
- [x] 按下列命令执行定向测试、源类型检查、Wasp/API/Vite 生产构建；再实测匿名/登录、桌面/390px、复制拒绝、页面刷新和8条URL直达。
- [ ] 生产发布（后续授权）：检查实际部署路由、robots/sitemap 与 HTTPS 读回。本次仅完成源码/许可审查、静态页面、Nginx 模板修正与本地验收；尚未部署到服务器。

验证命令（在仓库根，使用项目固定 toolchain）：

```bash
export PATH="$PWD/toolchain/node_modules/.bin:$PATH"
node node_modules/vitest/vitest.mjs run --config vitest.config.ts apps/web/src/client/tools apps/web/src/client/site-analytics apps/web/src/growth/contract.test.ts
apps/web/node_modules/.bin/tsc -p apps/web/tsconfig.src.json --noEmit
./scripts/wasp.sh build
node scripts/build-api.mjs
(cd apps/web && node node_modules/vite/bin/vite.js build)
```

Wasp/Vite构建需要显式 `REACT_APP_API_URL` 及站点来源配置；纯构建检查可使用明确的示例域名，部署必须使用实际配置。数据库集成与真实店铺样本不以纯函数/组件测试替代。

## 第二、三批的后续准入

第二批单独约定：只取 HTTPS 公网 HTML/JSON、限制重定向/响应体/超时、每跳及 DNS 地址校验、同源商品分页、无用户 Cookie、无脚本执行、带限流/短缓存。复用 `isPublicAddress` 的思想与测试，不能放开原媒体下载白名单。应用采用 MIT 内置指纹；商品 CSV 处理公式注入，输出带覆盖状态。用固定已授权测试页/合成响应及少量公开样本验收。

第三批先复用已有扩展与对比能力，分别核验连接、撤销、私有数据隔离、浏览器商店分发。商品线索需要来源和关联证据；没有真实销售来源时，不制造销量/营收/爆款评分。

## 本地验收记录（2026-10-23）

- 第一批 8 项已实现，导航与目录读同一注册表；另 6 项标为筹备中。
- 650 项前端、表单、隐私、路径契约回归通过；15 项原生 SSR 插件/元信息及真实 HTML 产物检查通过；源 TypeScript、Wasp、API、Vite 生产构建通过。
- 浏览器实测 6 个计算示例、Hook 生成 10 条与重置、关键词入口及编码、复制成功、错误聚焦和刷新清空；8 项在 390px 下均无横向溢出，标签关联正常，未发现控制台错误。
- 工具文档不加载 GA/Clarity；仅沿用同意后的第一方有界事件。跨营销/工具/登录区整页导航，首次 hydration 保持表单 DOM 与 ID，原生表单在脚本就绪前禁用。
- Wasp 原生预渲染产出工具目录及 8 个独立 HTML；工具独立 title/description/canonical 在原始 HTML 中可读，保留工作区 `200.html` 回退；Nginx 模板优先读取对应 `index.html`。
- 实施接口调整：纯注册表位于 `src/shared/free-tools.ts`，客户端 `registry.ts` 再导出；Wasp 路由直接惰性加载 `ToolsPage.tsx`。没有新增业务 API、数据表、模型服务或生产写入。
- 本次代码位于公开产品仓库的独立 `codex/free-tools` 分支。服务器发布与公开 HTTPS 验收尚未执行。

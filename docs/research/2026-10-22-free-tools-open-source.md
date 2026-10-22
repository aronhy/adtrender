# AdTrender 免费工具：范围与开源调研

核验日期：2026-10-22。产品基线：`aronhy/adtrender` 的 `main@edfe98a`。
本轮仅完成产品规划、源码及许可证审阅；没有安装候选依赖，没有验证其真实店铺识别准确率，没有开始产品实现。

## 建议

先做 8 个可独立使用的工具：6 个计算器、模板 Hook 生成器、广告库导航器。全部在浏览器运行，不增加模型调用、抓取任务或业务数据表。
第二批共用一次受控页面读取，完成 Shopify 主题、前台应用检测和公开商品导出。第三批再接浏览器扩展及依赖真实数据的研究工具。
目标按“免费使用工具 → 按需进入 AdTrender 工作区”规划，基础计算、生成和复制不要求注册。

## 当前事实

- 导航列出 14 项工具；首项指向 `/app/ads`，其余 13 项指向 `/help#free-tools`。
- `/app/ads` 要求登录及工作区权限，不能直接当成匿名查库接口。
- 公开仓已有广告搜索、收藏、笔记、广告主对比和 CSV 导出，可复用这些能力，不复制其他产品的整套应用。
- 当前 `StudioCatalog.products` 为 `never[]`；`ProductEvent` 是站内事件，并非商品/订单/销量模型。没有依据制作“销量爆款榜”。
- 现有 `robots.txt` 只放行少数公开页；新增 `/tools` 时必须同步 sitemap、标题、canonical 与现有统计路径白名单。
- 私有开发仓已有 MV3 扩展原型，权限仅 `activeTab`、`storage`，主要使用当前标签页 URL 查询库内记录，不是任意外部广告采集器。公开仓尚未包含该扩展、连接 API 和令牌模型。

## 14 项工具及批次

| 导航名称 | 批次及页面 | 最小可交付结果 |
| --- | --- | --- |
| 竞品广告查找器 | 1：`/tools/ad-finder` | 输入品牌或关键词，打开平台官方广告库；可继续到需登录的 AdTrender 已收录广告搜索。明确两类结果的区别。 |
| ROAS 盈亏平衡计算器 | 1：`/tools/roas-calculator` | 实际 ROAS、广告前贡献毛利率对应的盈亏平衡 ROAS；展示计算口径。 |
| 免费 Chrome 扩展程序 | 3：`/tools/chrome-extension` | 优先复用已有原型；公开站点适配、连接/撤销、包安装和浏览器商店审核分别验收。 |
| Shopify 订阅费用计算器 | 1：`/tools/shopify-cost-calculator` | 用户填写订阅、应用、域名费用，比较月度/年度预算；不冒充地区官方报价或账单。 |
| Shopify 主题检测工具 | 2：`/tools/shopify-theme-detector` | 页面实际披露的主题字段、检测时间、证据；未识别显示未知。 |
| 电商利润计算器 | 1：`/tools/ecommerce-profit-calculator` | 同期销售净额减去已填写成本，保留亏损，标为预估利润。 |
| 电商竞争对手分析 | 3：`/tools/competitor-analysis` | 复用已收录广告与第二批站点信息；每项标明来源、范围和时间，不推算营收、销量或 ROAS。 |
| 爆款产品查找器 | 3：`/tools/product-finder` | 待商品来源及广告→商品关联可验证后设计；只有广告活跃度时，改称商品线索，不能称销售爆款。 |
| 免费 Hook 生成器 | 1：`/tools/hook-generator` | 产品、受众、卖点生成 10 条模板开头；中文/英文模板、分类、复制；明确模板版。 |
| Shopify 应用探测器 | 2：`/tools/shopify-app-detector` | 仅报告当前页面命中的前台应用/集成及证据，不声称枚举后台所有安装应用。 |
| Shopify 产品导出工具 | 2：`/tools/shopify-product-exporter` | 导出公开可读取字段与覆盖/失败报告；完整后台商品另走店主授权 API。 |
| ROI 计算器 | 1：`/tools/roi-calculator` | 净增收益除以投入；区分总收益和已扣成本净收益，避免重复扣减。 |
| 客户终身价值计算器 | 1：`/tools/customer-lifetime-value-calculator` | 同一时间单位下的收入 LTV 与贡献 LTV，标明用户输入假设。 |
| 利润率计算器 | 1：`/tools/profit-margin-calculator` | 利润/销售净额；明确与加价率的区别。 |

## 可复用项目

“可复用”表示许可证与选定源码已检查，不表示安装、接入或准确率验收已完成。若复制/派生代码或模板，保留对应版权与许可；以固定提交记录来源。

| 项目及核验提交 | 许可 | 采用判断 |
| --- | --- | --- |
| [MikeMcl/big.js](https://github.com/MikeMcl/big.js/tree/cdbc06f1d5ae9be429b97f433ee884cf9ad28072)，默认分支提交 2025-04-22 | [MIT](https://github.com/MikeMcl/big.js/blob/cdbc06f1d5ae9be429b97f433ee884cf9ad28072/LICENCE.md) | 首批采用的小型十进制计算库（该提交 package.json 版本为 7.0.1，类型需另补）；金额/比率纯函数自行实现。只引入这一个金额库，不同时引入 decimal.js/finance.js。 |
| [SkillMedev/skills](https://github.com/SkillMedev/skills/tree/97a13607d669157a4a16d5ba79b77f208319f7b9) | [MIT](https://github.com/SkillMedev/skills/blob/97a13607d669157a4a16d5ba79b77f208319f7b9/LICENSE) | [social-hook-generator](https://github.com/SkillMedev/skills/blob/97a13607d669157a4a16d5ba79b77f208319f7b9/skills/social-hook-generator/SKILL.md) 的模式分类可参考；中文/英文具体句式自己写，不安装整套 skills，不搬示例成果数字。 |
| [Houseofmvps/opentechalyzer](https://github.com/Houseofmvps/opentechalyzer/tree/a3d30e479c91c06732ef88867d69b7feef8f3f35)，默认分支提交 2026-07-27，未归档 | [MIT](https://github.com/Houseofmvps/opentechalyzer/blob/a3d30e479c91c06732ef88867d69b7feef8f3f35/LICENSE) | 第二批应用检测主候选：只用内置指纹和纯检测器，自行提供受控读取后的证据。不要直接接整套 CLI。 |
| [feracommerce/shopify_app_detector](https://github.com/feracommerce/shopify_app_detector/tree/afa77b6700b3236a51fff7b66e3c05776f7ab9f2)，默认分支提交 2023-05-09，未归档 | [Apache-2.0](https://github.com/feracommerce/shopify_app_detector/blob/afa77b6700b3236a51fff7b66e3c05776f7ab9f2/LICENSE.md) | 可补充主题/应用本地匹配；规则较旧。不能照搬“未识别即 fully_custom”的兜底，也不能把商家可改名的 name 当成原主题名称。 |
| [tonic20/stackpeek-extension](https://github.com/tonic20/stackpeek-extension/tree/991b67695ac914f00fd383ac753605454deb9f9b)，默认分支提交 2026-08-23，未归档 | [MIT](https://github.com/tonic20/stackpeek-extension/blob/991b67695ac914f00fd383ac753605454deb9f9b/LICENSE) | 只抽 `lib/collector.ts`、`catalogue.ts`、`csv.ts` 的字段采集、公开产品分页与 CSV 映射。其核心应用检测依赖未开源后端，不能当完整自部署方案。 |
| [Nir-Bhay/store-catalog-exporter](https://github.com/Nir-Bhay/store-catalog-exporter/tree/ca8b4412610917e0323d3ae1b7d45f6bbabd7246)，默认分支提交 2026-10-09，未归档 | [MIT](https://github.com/Nir-Bhay/store-catalog-exporter/blob/ca8b4412610917e0323d3ae1b7d45f6bbabd7246/LICENSE) | 借鉴重复页检测、分页预算和 partial 覆盖报告；项目较新且为 Python，不为复用它新增 Python 服务。 |

### 暂不采用

- [ebradyjobory/finance.js](https://github.com/ebradyjobory/finance.js)：MIT，默认分支提交停留在 2018-10-11。ROI 实现含取绝对值、缺少除零保护，不值得搬完整金融计算库。
- [OpenAdKit](https://github.com/IamRamgarhia/OpenAdKit-Open-Source-AI-Marketing-Tool)：MIT；有真实广告提示词模块，但整套 Next/LLM/外部抓取架构不适合当前 Wasp 首版。仅作后续 AI 改写备选。
- [ad-maker-claude-skill](https://github.com/whatsuppiyush/ad-maker-claude-skill)：MIT，有 Hook 框架，可作补充资料；不与首选模板库重复引入，不复制其效果承诺。
- [WXT](https://github.com/wxt-dev/wxt)：MIT，适合新建扩展，但已有 MV3 原型；先审查复用，确有必要再换框架。
- [PapaParse](https://github.com/mholt/PapaParse)：MIT、支持 CSV 解析/导出；第二批确需本地大 CSV 导入时再用，首批不为简单复制按钮增加依赖。

### Opentechalyzer 的具体边界

其 [getFingerprints 默认实现](https://github.com/Houseofmvps/opentechalyzer/blob/a3d30e479c91c06732ef88867d69b7feef8f3f35/src/fingerprints/index.ts) 会读取本机已导入的外部数据库；[外部来源](https://github.com/Houseofmvps/opentechalyzer/blob/a3d30e479c91c06732ef88867d69b7feef8f3f35/src/fingerprints/external.ts) 包含 GPL-3.0 Wappalyzer 数据。
采用时固定 `BUILTIN_FINGERPRINTS` 传给纯 `detect()`；如用 `analyze()` 则显式传第三个指纹参数。不调用默认 `analyzeMany()`，不导入/分发外部指纹缓存。关闭环境变量只能作为补充，不能替代显式限定。

## 首批计算口径

金额字段使用同一币种、同一期间；销售净额已扣折扣退款且不含代收税。成本范围在结果旁列出，未填写项不悄悄当成已经计入。

| 工具 | 公式/约束 | 合成验收例 |
| --- | --- | --- |
| ROAS | 归因收入÷广告费；不等于利润率 | 1000÷250＝4 倍＝400%；广告费 0 则不可计算。 |
| 盈亏平衡 ROAS | `1 / 广告前贡献毛利率`；该毛利率已扣商品、履约、支付等变动成本，未扣广告和固定费 | 毛利率 40%→2.5 倍；≤0 时提示当前结构无法回本，不显示负门槛。 |
| 电商利润 | `销售净额－已填写全部成本` | 收入 1000、总成本 800→200；成本 1200→−200。 |
| 利润率 | `利润÷销售净额×100%` | 200÷1000→20%；销售净额 0 不可计算。 |
| ROI | 输入总收益 B 与总投入 C，`(B−C)÷C×100%` | B=1000、C=800→25%；C=0 不可计算。首版不另做“已扣成本净收益”输入模式。 |
| LTV | 收入 LTV＝客单价×年购买次数×客户年限；贡献 LTV＝收入 LTV×广告前贡献毛利率 | 50×3×2→300；贡献率 40%→120。不是实际订单预测，不使用“行业推荐值”填空。 |
| Shopify 成本 | 年付订阅÷12＋每月应用费＋年域名费÷12；年预算按同样口径累加，一次性支出单列 | 年费 360、应用 20/月、域名 12/年→51/月、612/年。示例不是 Shopify 官方报价。 |

ROAS 定义参考 [Google Ads 转化值/费用说明](https://support.google.com/google-ads/answer/6270625?hl=en)，LTV 及其时间单位参考 [Shopify LTV](https://www.shopify.com/blog/customer-lifetime-value)。盈亏平衡公式由上述贡献率假设推导，不代表整个企业含固定费用后的回本点。
Shopify 的地区、方案、支付方式、账期会影响费用；首版由用户从[官方价格页](https://www.shopify.com/pricing)或账单填写。月付账期与年付分摊不是同一张实际账单，结果标为“月度预算/年度预算”。订阅预算默认不含交易处理费及税，不把第三方交易费与支付处理费混为一项。[官方支付费用说明](https://help.shopify.com/en/manual/payments/shopify-payments/onboarding/cost-of-shopify-payments)。

## 后续数据边界

- URL 检测需要服务端受控 HTML/JSON 读取；浏览器直接跨域会受 CORS 影响。已有媒体下载器只允许媒体 MIME 与固定主机，不可直接放开充当网页代理。
- 主题只显示页面提供的 `name`、`theme_store_id`、`schema_name`、`schema_version`。name 可改名，headless/隐藏字段返回未知，不判断盗版或无主题。
- 应用识别只证明某页面命中了前台信号；没有命中不能证明未安装。第一版不启用 Playwright 执行页面脚本。
- 商品公开 feed 可能被阻断、截断或不稳定。导出应带 `complete/partial/unavailable`（仅针对本次可读来源的分页覆盖）、读取时间、页数与行数；不能将 `complete` 称为后台全量。
- 完整后台商品读取需店主授权的 [Shopify Admin GraphQL products](https://shopify.dev/docs/api/admin-graphql/latest/queries/products)；公开目录不提供真实销量或完整库存。

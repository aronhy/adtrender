/** Product metadata shared by public navigation and consent-based analytics. */
export type FreeTool = {slug:string;title:string;description:string;category:'calculators'|'creative'|'research'|'operations'|'shopify';kind:'calculator'|'hooks'|'finder'|'utm'|'policy'|'planned';status:'ready'|'planned'};
export const freeTools:readonly FreeTool[] = [
 {slug:'roas-calculator',title:'ROAS 与盈亏平衡计算器',description:'输入收入和广告费，算出 ROAS 和回本 ROAS。',category:'calculators',kind:'calculator',status:'ready'},
 {slug:'ecommerce-profit-calculator',title:'电商利润计算器',description:'填收入和各项成本，算出这段时间的利润。',category:'calculators',kind:'calculator',status:'ready'},
 {slug:'profit-margin-calculator',title:'利润率计算器',description:'填收入和总成本，算出利润率。',category:'calculators',kind:'calculator',status:'ready'},
 {slug:'roi-calculator',title:'ROI 投资回报计算器',description:'填投入和回收金额，算出 ROI。',category:'calculators',kind:'calculator',status:'ready'},
 {slug:'customer-lifetime-value-calculator',title:'客户终身价值 LTV 计算器',description:'填客单价、年购买次数和年限，算出客户终身价值。',category:'calculators',kind:'calculator',status:'ready'},
 {slug:'shopify-cost-calculator',title:'Shopify 店铺费用预算',description:'填订阅、应用和域名费用，算出开店第一年的总花费。',category:'calculators',kind:'calculator',status:'ready'},
 {slug:'cpa-calculator',title:'CPA 获客成本计算器',description:'填广告花费和转化数，算出 CPA；也可以用 CPC 和转化率推算。',category:'calculators',kind:'calculator',status:'ready'},
 {slug:'traffic-goal-calculator',title:'目标利润与流量计算器',description:'填利润目标、客单价和成本，算出需要的订单和访问量。',category:'calculators',kind:'calculator',status:'ready'},
 {slug:'ad-budget-calculator',title:'广告预算计算器',description:'填订单目标、CPM、CTR 和转化率，算出广告预算。',category:'calculators',kind:'calculator',status:'ready'},
 {slug:'hook-generator',title:'广告 Hook 模板生成器',description:'填产品、人群和卖点，生成 10 条广告开头。',category:'creative',kind:'hooks',status:'ready'},
 {slug:'ad-finder',title:'官方广告库入口助手',description:'输入关键词，打开 Meta、Google、TikTok、Pinterest 的官方广告库。',category:'research',kind:'finder',status:'ready'},
 {slug:'utm-link-builder',title:'UTM 链接生成器',description:'填落地页和渠道参数，生成带 UTM 的链接。',category:'operations',kind:'utm',status:'ready'},
 {slug:'privacy-policy-generator',title:'隐私政策模板',description:'填收集的信息、用途和服务商，生成英文隐私政策。',category:'shopify',kind:'policy',status:'ready'},
 {slug:'refund-policy-generator',title:'退款政策模板',description:'填退款条件、金额和到账时间，生成英文退款政策。',category:'shopify',kind:'policy',status:'ready'},
 {slug:'terms-and-conditions-generator',title:'服务条款模板',description:'填下单、付款和取消规则，生成英文服务条款。',category:'shopify',kind:'policy',status:'ready'},
 {slug:'returns-policy-generator',title:'退换货政策模板',description:'填退货期限、条件和运费规则，生成英文退换货政策。',category:'shopify',kind:'policy',status:'ready'},
 {slug:'shipping-policy-generator',title:'配送政策模板',description:'填配送范围、时效和运费，生成英文配送政策。',category:'shopify',kind:'policy',status:'ready'},
 {slug:'shopify-theme-detector',title:'Shopify 主题检测工具',description:'查看商店公开披露的主题信息。',category:'shopify',kind:'planned',status:'planned'},
 {slug:'shopify-app-detector',title:'Shopify 应用探测器',description:'查找公开页面中的应用与集成信号。',category:'shopify',kind:'planned',status:'planned'},
 {slug:'shopify-product-exporter',title:'Shopify 产品导出工具',description:'整理公开可读取的商品字段。',category:'shopify',kind:'planned',status:'planned'},
 {slug:'chrome-extension',title:'免费 Chrome 扩展程序',description:'从浏览中的网站进入广告研究。',category:'research',kind:'planned',status:'planned'},
 {slug:'competitor-analysis',title:'电商竞争对手分析',description:'结合有来源的广告与商店信息进行对比。',category:'research',kind:'planned',status:'planned'},
 {slug:'product-finder',title:'爆款产品查找器',description:'待商品来源与关联依据接入后开放。',category:'research',kind:'planned',status:'planned'},
];
export const readyFreeTools = freeTools.filter(tool=>tool.status==='ready');
export const freeToolPaths = ['/tools','/tools/guide',...readyFreeTools.map(tool=>'/tools/'+tool.slug)];
export const isFreeToolPath=(path:string)=>freeToolPaths.includes(path);
export const getFreeTool=(slug:string)=>freeTools.find(tool=>tool.slug===slug);

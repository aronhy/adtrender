/** Product metadata shared by public navigation and consent-based analytics. */
export type FreeTool = {slug:string;title:string;description:string;category:'calculators'|'creative'|'research'|'shopify';kind:'calculator'|'hooks'|'finder'|'planned';status:'ready'|'planned'};
export const freeTools:readonly FreeTool[] = [
 {slug:'roas-calculator',title:'ROAS 盈亏平衡计算器',description:'计算广告回报，以及当前成本结构下的回本门槛。',category:'calculators',kind:'calculator',status:'ready'},
 {slug:'ecommerce-profit-calculator',title:'电商利润计算器',description:'把商品、履约、支付和广告成本算在一起。',category:'calculators',kind:'calculator',status:'ready'},
 {slug:'profit-margin-calculator',title:'利润率计算器',description:'看清每一笔销售收入中，能够留下多少利润。',category:'calculators',kind:'calculator',status:'ready'},
 {slug:'roi-calculator',title:'ROI 计算器',description:'用总收益与总投入计算投资回报率。',category:'calculators',kind:'calculator',status:'ready'},
 {slug:'customer-lifetime-value-calculator',title:'客户终身价值计算器',description:'根据客单价、复购和客户年限，估算收入与贡献 LTV。',category:'calculators',kind:'calculator',status:'ready'},
 {slug:'shopify-cost-calculator',title:'Shopify 订阅费用计算器',description:'将订阅、应用和域名费用整理成月度与年度预算。',category:'calculators',kind:'calculator',status:'ready'},
 {slug:'hook-generator',title:'免费 Hook 生成器',description:'用产品、受众和卖点，整理 10 条广告开头。',category:'creative',kind:'hooks',status:'ready'},
 {slug:'ad-finder',title:'竞品广告查找器',description:'从品牌与关键词，进入官方广告库继续研究。',category:'research',kind:'finder',status:'ready'},
 {slug:'shopify-theme-detector',title:'Shopify 主题检测工具',description:'查看商店公开披露的主题信息。',category:'shopify',kind:'planned',status:'planned'},
 {slug:'shopify-app-detector',title:'Shopify 应用探测器',description:'查找公开页面中的应用与集成信号。',category:'shopify',kind:'planned',status:'planned'},
 {slug:'shopify-product-exporter',title:'Shopify 产品导出工具',description:'整理公开可读取的商品字段。',category:'shopify',kind:'planned',status:'planned'},
 {slug:'chrome-extension',title:'免费 Chrome 扩展程序',description:'从浏览中的网站进入广告研究。',category:'research',kind:'planned',status:'planned'},
 {slug:'competitor-analysis',title:'电商竞争对手分析',description:'结合有来源的广告与商店信息进行对比。',category:'research',kind:'planned',status:'planned'},
 {slug:'product-finder',title:'爆款产品查找器',description:'待商品来源与关联依据接入后开放。',category:'research',kind:'planned',status:'planned'},
];
export const readyFreeTools = freeTools.filter(tool=>tool.status==='ready');
export const freeToolPaths = ['/tools',...readyFreeTools.map(tool=>'/tools/'+tool.slug)];
export const isFreeToolPath=(path:string)=>freeToolPaths.includes(path);
export const getFreeTool=(slug:string)=>freeTools.find(tool=>tool.slug===slug);

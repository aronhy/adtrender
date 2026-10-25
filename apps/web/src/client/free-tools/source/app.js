// Source copied verbatim from the approved HTML prototype. See provenance.json.
export default function initialize(window, document, location, requestAnimationFrame, cancelAnimationFrame, setTimeout, clearTimeout) {
// BEGIN APPROVED SOURCE
/* Standalone local UI prototype. No fetch, analytics, accounts or persistent input storage. */
(() => {
  'use strict';
  const $ = (s, parent = document) => parent.querySelector(s);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const icon = (name, cls = '', weight) => window.FreeIcons.render(name, {className:cls, weight});
  const n = (key,label,placeholder,unit='money',extra={}) => ({key,label,placeholder,unit,...extra});
  const tools = [
    {id:'F01',slug:'roas-calculator',name:'ROAS 与盈亏平衡计算器',short:'ROAS 计算器',category:'A',icon:'chart',kind:'回报测算',desc:'输入收入和广告费，算出 ROAS 和回本 ROAS。',fields:[n('revenue','归因净收入','如 10000'),n('adSpend','广告费用','如 2000'),n('margin','广告前贡献率','如 40','percent',{full:true,help:'扣除商品、物流、手续费等变动成本后剩下的比例，不含广告费和固定成本。'})],example:{revenue:'10000',adSpend:'2000',margin:'40'},labels:['实际 ROAS','ROAS 百分比','盈亏平衡 ROAS'],formula:'实际 ROAS = 归因净收入 ÷ 广告费；盈亏平衡 ROAS = 1 ÷ 广告前贡献率。',scope:'收入和广告费需使用同一时间段、同一归因方式的数据。回本 ROAS 不含固定成本。',related:['F02','F09','F03']},
    {id:'F02',slug:'ecommerce-profit-calculator',name:'电商利润计算器',short:'电商利润计算器',category:'A',icon:'profit',kind:'经营测算',desc:'填收入和各项成本，算出这段时间的利润。',fields:[n('revenue','销售净额','如 10000'),n('cogs','商品成本','如 3000'),n('fulfillment','履约与物流','如 1000'),n('payment','支付处理费用','如 300'),n('adSpend','广告费用','如 2000'),n('other','其他成本','无此项填 0')],example:{revenue:'10000',cogs:'3000',fulfillment:'1000',payment:'300',adSpend:'2000',other:'200'},labels:['预估利润','总成本'],formula:'预估利润 = 净销售额 − 商品 − 履约物流 − 支付处理 − 广告 − 其他成本。',scope:'各项请填写同一时间段的数据。结果为负数表示亏损。',related:['F03','F01','F06']},
    {id:'F03',slug:'profit-margin-calculator',name:'利润率计算器',short:'利润率计算器',category:'A',icon:'percent',kind:'利润测算',desc:'填收入和总成本，算出利润率。',fields:[n('revenue','销售净额','如 10000','money',{full:true}),n('cost','总成本','如 6500','money',{full:true})],example:{revenue:'10000',cost:'6500'},labels:['销售利润率','预估利润'],formula:'利润率 =（净销售额 − 总成本）÷ 净销售额 × 100%。',scope:'利润率以销售额为分母，不同于以成本为分母的加价率。如果总成本已包含广告费，不要重复扣除。',related:['F02','F04','F01']},
    {id:'F04',slug:'roi-calculator',name:'ROI 投资回报计算器',short:'ROI 计算器',category:'A',icon:'roi',kind:'投资回报',desc:'填投入和回收金额，算出 ROI。',fields:[n('returns','总收益 / 回收额','如 15000','money',{full:true,help:'填写收回的总金额，不要先扣除投入。'}),n('investment','总投入','如 10000','money',{full:true})],example:{returns:'15000',investment:'10000'},labels:['投资回报率 ROI','净增收益'],formula:'ROI =（总回收额 − 总投入）÷ 总投入 × 100%。',scope:'ROI 是净收益占投入的比例，与 ROAS（收入 ÷ 广告费）不同。',related:['F01','F02','F03']},
    {id:'F05',slug:'customer-lifetime-value-calculator',name:'客户终身价值 LTV 计算器',short:'客户终身价值 LTV',category:'A',icon:'users',kind:'客户价值',desc:'填客单价、年购买次数和年限，算出客户终身价值。',fields:[n('aov','平均净客单价','如 50'),n('frequency','每年购买次数','如 4','plain',{suffix:'次'}),n('years','客户年限','如 3','plain',{suffix:'年'}),n('margin','广告前贡献率','如 40','percent')],example:{aov:'50',frequency:'4',years:'3',margin:'40'},labels:['收入 LTV','贡献 LTV'],formula:'收入 LTV = 客单价 × 每年购买次数 × 年限；贡献 LTV = 收入 LTV × 贡献率。',scope:'简化估算：假设每年复购次数不变，未考虑折现和获客成本。收入 LTV 不等于可承受的 CPA 上限。',related:['F09','F02','F01']},
    {id:'F06',slug:'shopify-cost-calculator',name:'Shopify 店铺费用预算',short:'Shopify 费用预算',category:'A',icon:'shop',kind:'店铺预算',desc:'填订阅、应用和域名费用，算出开店第一年的总花费。',fields:[{key:'period',label:'订阅账期',type:'select',options:[['month','月付'],['year','年付']],full:true},n('subscription','该账期订阅费用','如 39'),n('apps','应用费用 / 月','如 20'),n('domain','域名费用 / 年','如 12'),n('oneTime','一次性支出','如 100')],defaults:{period:'month'},example:{period:'month',subscription:'39',apps:'20',domain:'12',oneTime:'100'},labels:['首年总预算','月均','每年固定开销','一次性支出'],formula:'年度经常费用 = 年化订阅 + 应用月费 × 12 + 域名年费；首年总预算再加一次性支出。',scope:'按你填写的价格计算，不查询 Shopify 官方报价。月均为平摊金额，不是每月实际扣款。',related:['F02','F03','F11']},
    {id:'F09',slug:'cpa-calculator',name:'CPA 获客成本计算器',short:'CPA 获客成本',category:'A',icon:'target',kind:'获客测算',desc:'填广告花费和转化数，算出 CPA；也可以用 CPC 和转化率推算。',fields:[],defaults:{mode:'actual'},example:{mode:'actual',spend:'1000',conversions:'50',target:'25'},labels:['每次转化成本 CPA','和目标差多少','偏离目标'],formula:'实际 CPA = 广告花费 ÷ 转化次数；推算 CPA = CPC ÷ 点击到转化率。',scope:'转化可以是订单或线索，请使用同一种转化。目标 CPA 仅用于对比。',related:['F01','F11','F10']},
    {id:'F10',slug:'traffic-goal-calculator',name:'目标利润与流量计算器',short:'目标利润与流量',category:'A',icon:'traffic',kind:'目标倒推',desc:'填利润目标、客单价和成本，算出需要的订单和访问量。',fields:[n('target','周期利润目标','如 1000'),n('days','周期天数','30','plain',{suffix:'天'}),n('aov','平均净客单价','如 50'),n('unitCost','单均非广告变动成本','如 25'),n('cpa','单均广告成本','如 15'),n('cvr','访问 → 订单转化率','如 2','percent'),n('fixed','周期固定成本','0','money',{full:true,help:'没有可填 0，需与利润目标使用同一时间段。'})],defaults:{days:'30',fixed:'0'},example:{target:'1000',days:'30',aov:'50',unitCost:'25',cpa:'15',cvr:'2',fixed:'0'},labels:['需要的访问量','需要的订单','预计收入','广告花费','实际能赚','每天订单','每天访问'],formula:'单均贡献 = 客单价 − 非广告成本 − 广告成本；订单 = 向上取整((目标利润 + 固定成本) ÷ 单均贡献)；访问 = 向上取整(订单 ÷ CVR)。',scope:'根据目标反推，不是网站实际流量。访问量指访问次数，不是独立访客；假设客单价、成本和转化率不变。',related:['F02','F11','F12']},
    {id:'F11',slug:'ad-budget-calculator',name:'广告预算计算器',short:'广告预算计算器',category:'A',icon:'budget',kind:'投放预算',desc:'填订单目标、CPM、CTR 和转化率，算出广告预算。',fields:[n('orders','目标订单数','如 100','plain',{suffix:'单'}),n('days','周期天数','30','plain',{suffix:'天'}),n('cpm','千次展示成本 CPM','如 10'),n('ctr','展示 → 点击率 CTR','如 2','percent'),n('cvr','点击 → 订单转化率','如 5','percent',{full:true})],defaults:{days:'30'},example:{orders:'100',days:'30',cpm:'10',ctr:'2',cvr:'5'},labels:['总预算','每天预算','需要的点击','需要的展示','折算 CPC','折算 CPA'],formula:'点击 = 目标订单 ÷ CVR；展示 = 点击 ÷ CTR；预算 = 展示 ÷ 1000 × CPM。',scope:'点击和展示数向上取整，预算按精确值计算。不含税费、服务费和素材费，实际订单量取决于投放效果。',related:['F09','F10','F12']},
    {id:'F07',slug:'hook-generator',name:'广告 Hook 模板生成器',short:'广告 Hook 模板',category:'B',icon:'spark',kind:'广告创意',desc:'填产品、人群和卖点，生成 10 条广告开头。',fields:[{key:'product',label:'你的产品',type:'textarea',placeholder:'如：可重复使用的随行水杯',full:true},{key:'audience',label:'目标受众',type:'text',placeholder:'如：每天通勤、喜欢轻装出行的人',full:true},{key:'benefit',label:'核心卖点',type:'textarea',placeholder:'如：轻巧便携，可反复使用',full:true},{key:'language',label:'模板语言',type:'select',options:[['zh','中文模板'],['en','English templates']],full:true}],defaults:{language:'zh'},example:{product:'随行水杯',audience:'每天通勤、喜欢轻装出行的人',benefit:'轻巧便携，可反复使用',language:'zh'},labels:['十条广告开头模板'],formula:'将产品、人群和卖点套入 10 个固定模板，每个模板对应一种开场方式。',scope:'固定模板生成，不调用 AI，不翻译。选择英文模板时，建议用英文填写产品信息。',related:['F08','F12','F01']},
    {id:'F08',slug:'ad-finder',name:'官方广告库入口助手',short:'官方广告库入口',category:'C',icon:'library',kind:'广告研究',desc:'输入关键词，打开 Meta、Google、TikTok、Pinterest 的官方广告库。',fields:[{key:'query',label:'品牌或关键词',type:'text',placeholder:'如：travel accessories',full:true,help:'这里提供官方广告库链接，不直接返回搜索结果。'}],defaults:{platform:'meta'},example:{query:'travel accessories',platform:'meta'},labels:['官方广告库与工作区入口'],formula:'按所选平台提供官方广告库链接，并可复制关键词。',scope:'打开官方页面后需手动粘贴关键词搜索。AdTrender 工作区正式版需要登录，当前预览仅演示入口。',related:['F07','F12','F01']},
    {id:'F12',slug:'utm-link-builder',name:'UTM 链接生成器',short:'UTM 链接生成器',category:'D',icon:'link',kind:'投放运营',desc:'填落地页和渠道参数，生成带 UTM 的链接。',fields:[{key:'url',label:'落地页 URL',type:'text',placeholder:'https://example.com/products/bottle',full:true,help:'保留链接中原有的参数和 # 锚点，仅支持 http / https。'},{key:'utm_source',label:'渠道来源 · utm_source',type:'text',placeholder:'如 tiktok',full:false},{key:'utm_medium',label:'渠道媒介 · utm_medium',type:'text',placeholder:'如 paid_social',full:false},{key:'utm_campaign',label:'活动名称 · utm_campaign',type:'text',placeholder:'如 summer_launch',full:true},{key:'utm_content',label:'创意内容 · utm_content',type:'text',placeholder:'如 video_a',optional:true},{key:'utm_term',label:'关键词 · utm_term',type:'text',placeholder:'如 reusable_bottle',optional:true}],example:{url:'https://example.com/products/bottle?variant=1#details',utm_source:'tiktok',utm_medium:'paid_social',utm_campaign:'summer_launch',utm_content:'video_a',utm_term:''},labels:['你的投放链接'],formula:'原链接中的 5 个 UTM 参数会替换为表单中的值；选填项留空时，原有值会被删除。',scope:'大小写和其他参数保持不变，空格、中文和 & 会自动编码。UTM 只是来源标记，数据需在分析工具中查看。',related:['F11','F07','F08']}
  ];
  if(window.FreePolicies){const policyIcons={F18:'privacy',F19:'refund',F20:'terms',F21:'returns',F22:'shipping'};tools.push(...window.FreePolicies.tools.map(t=>({...t,icon:policyIcons[t.id]})));}
  const accents={F01:'ROAS',F02:'利润',F03:'利润率',F04:'ROI',F05:'LTV',F06:'Shopify',F09:'CPA',F10:'流量',F11:'预算',F07:'Hook',F08:'广告库',F12:'UTM',F18:'隐私',F19:'退款',F20:'服务条款',F21:'退换货',F22:'配送'};
  const accentName=t=>{const a=accents[t.id];return a&&t.name.includes(a)?t.name.replace(a,`<span class="accent">${a}</span>`):t.name;};
  const kicker=t=>t.type==='policy'?'免费 Shopify 店铺工具':t.category==='A'?'免费电商计算工具':'免费广告投放工具';
  const categories = [['all','全部工具'],['A','成本与收益'],['B','广告创意'],['C','广告研究'],['D','投放与店铺运营']].map(([key,label])=>[key,label,key==='all'?tools.length:tools.filter(t=>t.category===key).length]);
  const categoryNames = {A:'COST & RETURN',B:'AD CREATIVE',C:'AD RESEARCH',D:'CAMPAIGN TOOLS'};
  const platforms = {meta:{name:'Meta',label:'Meta 广告资料库',mark:'∞',url:'https://www.facebook.com/ads/library/'},google:{name:'Google',label:'Google 广告透明度中心',mark:'G',url:'https://adstransparency.google.com/'},tiktok:{name:'TikTok',label:'TikTok 商业内容库',mark:'♪',url:'https://library.tiktok.com/ads'},pinterest:{name:'Pinterest',label:'Pinterest 广告资料库',mark:'P',url:'https://ads.pinterest.com/ads-repository/'}};
  const utmKeys = ['utm_source','utm_medium','utm_campaign','utm_content','utm_term'];
  const state = {category:'all',search:'',tool:null,values:{},currency:'USD',result:null,copyText:'',copyItems:[],duplicates:[],edited:false,policyProfile:{}};
  const main = $('#main');
  let toastTimer;

  function card(t) { return `<a class="tool-card" href="#/tools/${t.slug}"><div class="card-top"><span class="tool-icon">${icon(t.icon)}</span></div><h3>${t.short}</h3><p>${t.desc}</p><span class="card-button">${t.type==='policy'?'免费生成':'免费使用'}</span></a>`; }
  function filteredTools() { const q=state.search.trim().toLowerCase(); return tools.filter(t=>(state.category==='all'||t.category===state.category)&&(!q||`${t.name} ${t.short} ${t.desc} ${t.slug}`.toLowerCase().includes(q))); }
  function renderCards() {
    const list=filteredTools(),q=state.search.trim();
    const popular=['F01','F02','F12','F19'].map(id=>tools.find(t=>t.id===id)).filter(Boolean);
    const sections = state.category==='all' ? [...(q?[]:[{title:'热门工具',desc:'大家最常用的 4 个工具。',items:popular,popular:true}]),{title:'成本与收益',desc:'计算 ROAS、利润、CPA 和广告预算。',items:list.filter(t=>t.category==='A')},{title:'投放准备',desc:'写广告开头、打开官方广告库、生成 UTM 链接。',items:list.filter(t=>t.category!=='A'&&t.type!=='policy')},{title:'Shopify 店铺政策模板',desc:'生成英文店铺政策，编辑后复制到 Shopify。',items:list.filter(t=>t.type==='policy')}] : [{title:categories.find(c=>c[0]===state.category)[1],desc:'',items:list}];
    $('#directory-tools').innerHTML = list.length ? `${state.search?`<p class="filtered-label">搜索「${esc(state.search)}」，找到 ${list.length} 个工具</p>`:''}${sections.filter(s=>s.items.length).map(s=>`<section class="tool-section${s.popular?' popular-section':''}"><div class="section-heading"><div><h2>${s.title}</h2><p>${s.desc}</p></div><span class="section-number">${s.items.length} 个工具</span></div><div class="tool-grid${s.popular?' popular-grid':''}">${s.items.map(card).join('')}</div></section>`).join('')}` : `<div class="no-results">${icon('search')}<h2>没找到相关工具</h2><p>换个词试试，比如 ROAS、利润、预算、Hook、UTM。</p><button class="button button-secondary" type="button" data-clear-search>清除筛选</button></div>`;
    document.querySelectorAll('.category-button').forEach(b=>{b.classList.toggle('active',b.dataset.category===state.category);b.setAttribute('aria-pressed',String(b.dataset.category===state.category));});window.FreeMotion?.directory($('#directory-tools'));
  }
  function renderDirectory() {
    document.title='免费电商与广告工具 · AdTrender'; state.tool=null;
    main.innerHTML=`<section class="directory-hero"><p class="hero-kicker">AdTrender 免费工具</p><h1>电商与广告<span class="accent">免费工具</span></h1><p>算 ROAS 和利润、写广告开头、生成店铺政策。</p><div class="hero-meta"><span>${icon('check')}免费</span><span>${icon('shield')}无需登录</span><span>${icon('clock')}无需下载</span></div><label class="search-wrap">${icon('search')}<input type="search" id="tool-search" autocomplete="off" placeholder="搜索工具，例如 ROAS、利润、UTM…" value="${esc(state.search)}" aria-label="搜索免费工具"><kbd>/</kbd></label></section><div class="category-shell"><nav class="category-bar container" aria-label="按任务筛选">${categories.map(c=>`<button type="button" class="category-button ${state.category===c[0]?'active':''}" data-category="${c[0]}" aria-pressed="${state.category===c[0]}">${c[1]} <b>${c[2]}</b></button>`).join('')}</nav></div><div class="container directory-content"><div id="directory-tools"></div><details class="roadmap"><summary><div><strong>即将推出：店铺研究工具</strong><small>5 个工具，开发中</small></div>${icon('chevron')}</summary><div class="roadmap-body"><div><h3>店铺检测与研究</h3>${['Shopify 主题检测','Shopify 应用线索检测','Shopify 公开产品导出','电商竞店分析','产品发现'].map(s=>`<div class="roadmap-item"><span>${s}</span><span>筹备中</span></div>`).join('')}</div><p class="roadmap-note">需要接入数据后才能开放。</p></div></details></div>`;
    renderCards();
  }

  function fieldsForTool(t) {
    if(t.id!=='F09') return t.fields;
    const fields=state.values.mode==='estimate' ? [n('cpc','单次点击成本 CPC','如 0.40','money',{full:true}),n('cvr','点击 → 转化率 CVR','如 2','percent',{full:true})] : [n('spend','广告花费','如 1000','money',{full:true}),n('conversions','转化次数','如 50','plain',{full:true,suffix:'次',help:'请使用同一转化事件的数量，例如订单或有效线索。'})];
    return [...fields,n('target','目标 CPA','可留空','money',{optional:true,full:true})];
  }
  const currencySymbol=()=>({USD:'$',CNY:'¥',EUR:'€',GBP:'£'}[state.currency]||'$');
  function renderField(f) {
    const value=state.values[f.key]??'';
    const label=`<label class="field-label" for="field-${f.key}">${f.label}${f.optional?'<span class="field-optional">选填</span>':''}</label>`;
    const attrs=`id="field-${f.key}" name="${f.key}" aria-describedby="help-${f.key} error-${f.key}" autocomplete="off"`;
    let control;
    if(f.type==='select') control=`<select ${attrs}>${f.options.map(([v,l])=>`<option value="${v}" ${v===value?'selected':''}>${l}</option>`).join('')}</select>`;
    else if(f.type==='textarea') control=`<textarea ${attrs} placeholder="${esc(f.placeholder)}">${esc(value)}</textarea>`;
    else {
      const prefix=f.unit==='money'?currencySymbol():'';
      const suffix=f.unit==='percent'?'%':(f.suffix||'');
      control=`<div class="input-shell">${prefix?`<span class="prefix" data-money-symbol>${prefix}</span>`:''}<input ${attrs} type="text" ${f.unit?'inputmode="decimal"':''} class="${prefix?'with-prefix ':''}${suffix?'with-suffix':''}" placeholder="${esc(f.placeholder||'')}" value="${esc(value)}">${suffix?`<span>${suffix}</span>`:''}</div>`;
    }
    return `<div class="field ${f.full?'full':''}" data-field="${f.key}">${label}${control}<p class="field-help" id="help-${f.key}" ${f.help?'':'hidden'}>${f.help||''}</p><p class="field-error" id="error-${f.key}" hidden></p></div>`;
  }
  function hasCurrency(t) {return t.type!=='policy'&&!['F07','F08','F12'].includes(t.id);}
  function actionLabel(t) { return t.type==='policy'?'生成政策':t.id==='F07'?'生成 10 条 Hook':t.id==='F08'?'获取链接':t.id==='F12'?'生成链接':'计算'; }
  function renderForm() {
    const t=state.tool;
    const mode=t.id==='F09'?`<div class="segment" aria-label="CPA 计算模式">${[['actual','实际成本'],['estimate','CPC / CVR 推算']].map(([v,l])=>`<button type="button" data-mode="${v}" class="${state.values.mode===v?'active':''}" aria-pressed="${state.values.mode===v}">${l}</button>`).join('')}</div>`:'';
    const platform=t.id==='F08'?`<div class="field full"><span class="field-label" id="platform-label">选择广告平台</span><div class="platform-grid" role="group" aria-labelledby="platform-label">${Object.entries(platforms).map(([key,p])=>`<button type="button" class="platform-button ${state.values.platform===key?'active':''}" data-platform="${key}" aria-pressed="${state.values.platform===key}"><span class="platform-logo">${icon('brand-'+key)}</span>${p.name}</button>`).join('')}</div></div>`:'';
    $('#tool-form').innerHTML=`<div class="panel-top"><h2>${t.type==='policy'?'店铺信息和规则':t.id==='F07'?'产品信息':t.id==='F08'?'关键词和平台':t.id==='F12'?'链接和参数':'填数据'}</h2>${hasCurrency(t)?`<label class="currency-picker">币种<select name="currency" aria-label="金额币种">${['USD','CNY','EUR','GBP'].map(s=>`<option value="${s}" ${s===state.currency?'selected':''}>${s}</option>`).join('')}</select></label>`:t.type==='policy'?`<button type="button" class="example-button policy-demo" data-policy-demo>查看示例 ${icon('arrow')}</button>`:''}</div>${mode}<div class="field-grid">${fieldsForTool(t).map(renderField).join('')}${platform}</div>${t.id==='F12'?'<div id="utm-warning-area"></div>':''}<div id="form-error" class="inline-form-error" role="alert" hidden></div><div class="form-actions"><button type="submit" class="button button-primary calculate-button">${actionLabel(t)} ${icon('arrow')}</button><button type="reset" class="reset-button" title="清空" aria-label="清空所有输入">${icon('reset')}</button></div><div class="form-bottom"><button type="button" class="example-button" data-example>${icon('spark','','regular')}填入示例</button><span class="local-note">${icon('shield')}数据不会上传</span></div><a class="view-result" href="#result-panel" data-view-result hidden>查看结果 ↓</a>`;
    if(t.id==='F12'&&state.duplicates.length) showUtmWarning();
  }
  function primaryMarkup(metric) {
    const v=formatted(metric),unit=metric.unit;
    const number=unit==='money'?`<span class="currency-symbol">${currencySymbol()}</span>${esc(v)}`:`${esc(v)}${unit==='percent'?'<span>%</span>':unit==='multiple'?'<span>×</span>':''}`;
    return `<div class="primary-result"><p class="primary-label">${esc(metric.label)}</p><div class="primary-number ${v.length>15?'smaller':''}">${number}</div><div class="primary-caption">${unit==='count'?'整个周期合计':unit==='money'?state.currency:state.tool.id==='F09'?'每次转化 · '+state.currency:''}</div></div>`;
  }
  function formatted(metric) { return window.FreeToolMath.format(metric.exact||metric.value,{decimals:metric.unit==='count'?0:2}); }
  function metricMarkup(m) { return `<div class="metric"><span class="metric-label">${esc(m.label)}</span><span class="metric-value">${m.unit==='money'?currencySymbol():''}${esc(formatted(m))}${m.unit==='percent'?'<span>%</span>':m.unit==='multiple'?'<span>×</span>':''}</span></div>`; }
  function resultHeader(ready=false,copyAction='') {return `<div class="result-head"><h2>${state.tool.type==='policy'?'英文政策正文':state.tool.id==='F07'?'广告开头':state.tool.id==='F08'?'去这里搜':state.tool.id==='F12'?'你的投放链接':'计算结果'}</h2>${copyAction||`<span class="result-status ${ready?'ready':''}">${ready?'已更新':state.edited?'数据已修改，请重新计算':'未填写'}</span>`}</div>`;}
  function specialEmpty(t) { return `<div class="special-empty"><span class="empty-icon">${icon(t.icon)}</span><h3>${t.id==='F07'?'10 条广告开头':t.id==='F08'?'官方广告库链接':'UTM 链接'}</h3><p>${t.id==='F07'?'填写左侧信息后，这里会显示 10 条开头，可逐条复制。':t.id==='F08'?'输入关键词并选择平台后，这里会显示官方广告库链接。':'填写落地页和渠道参数后，这里会显示完整链接。'}</p><div class="empty-outline-lines"><span></span><span></span><span></span></div></div>`; }
  function renderResult() {
    const t=state.tool,panel=$('#result-panel');if(!t||!panel)return;
    let html=resultHeader(!!state.result);
    if(t.type==='policy'){
      if(!state.result){html+=`<div class="special-empty"><span class="empty-icon">${icon(t.icon)}</span><h3>英文政策正文</h3><p>填写左侧资料后点击生成，正文可直接编辑、复制或下载 TXT。</p><div class="empty-outline-lines"><span></span><span></span><span></span></div></div><p class="result-note">通用模板，发布前请按店铺实际规则和销售地区核对。</p>`;}
      else{const r=state.result;html=resultHeader(true,`<span class="policy-draft-status" id="policy-draft-status">${r.stale?'资料已修改':r.edited?'已编辑':'草稿'}</span>`);html+=`${r.stale?'<p class="policy-stale">资料已修改，点击生成后更新正文。</p>':''}${r.warnings?.length?`<div class="policy-warnings"><strong>发布前要补</strong>${r.warnings.map(w=>`<div>${esc(w)}</div>`).join('')}</div>`:''}<div class="policy-document-meta"><span>${esc(r.title)}</span><span id="policy-word-count">${r.text.trim().split(/\s+/).filter(Boolean).length} words</span></div><div class="policy-result-actions"><button type="button" class="button button-primary" data-copy="all">${icon('copy')}复制正文</button><button type="button" class="button button-secondary" data-download-policy>${icon('external')}下载 TXT</button></div><textarea id="policy-text" class="policy-text" aria-label="英文政策正文，可编辑" spellcheck="false">${esc(r.text)}</textarea><p class="result-note">仅复制正文，可粘贴到 Shopify 后台 Settings → Policies。</p><p class="policy-version">模板版本 · ${esc(r.version)}</p>`;}
      panel.innerHTML=html;const view=$('[data-view-result]');if(view)view.hidden=!state.result;return;
    }
    if(!state.result) {
      if(['F07','F08','F12'].includes(t.id)) html+=specialEmpty(t);
      else html+=`<div class="primary-result"><p class="primary-label">${t.labels[0]}</p><div class="primary-number placeholder">— —</div><div class="primary-caption">${state.edited?'数据已修改，请重新计算':'填写左侧数据后显示结果'}</div></div><div class="result-metrics">${t.labels.slice(1).map(label=>`<div class="metric"><span class="metric-label">${label}</span><span class="metric-value" style="color:#c5cad0">—</span></div>`).join('')}</div><button type="button" class="button button-secondary result-copy" disabled>${icon('copy')}复制结果</button>`;
      html+=`<p class="result-note">${t.scope}</p>`;
    } else if(t.id==='F07') {
      html=resultHeader(true,`<button type="button" class="copy-one" data-copy="all">${icon('copy')}复制全部</button>`);
      html+=`<div class="hook-results">${state.result.map((r,i)=>`<article class="hook-row"><div class="hook-row-top"><span>${String(i+1).padStart(2,'0')} · ${esc(r.type)}</span><button type="button" class="copy-one" data-copy="${i}">${icon('copy')}复制</button></div><p>${esc(r.text)}</p></article>`).join('')}</div><p class="result-note">由固定模板生成，复制后可按产品修改。</p>`;
    } else if(t.id==='F08') {
      const p=platforms[state.values.platform];
      html+=`<div class="destination-card"><div class="destination-top"><h3>${p.label}</h3><span class="destination-tag">官方</span></div><p>打开后粘贴下方关键词进行搜索。</p><a href="${p.url}" target="_blank" rel="noopener noreferrer" class="button button-primary">打开 ${p.name} 广告库 ${icon('external')}</a><div class="keyword-preview"><span>${esc(state.values.query.trim())}</span><button class="copy-one" type="button" data-copy="query">${icon('copy')}复制关键词</button></div></div><div class="destination-card"><div class="destination-top"><h3>AdTrender 广告资料库</h3><span class="destination-tag">需登录</span></div><p>正式版中，关键词会带入工作区直接搜索，需要登录。</p><button class="button button-secondary" type="button" data-workspace>了解工作区 ${icon('arrow')}</button></div><p class="result-note">官方广告库不会自动带入关键词，需要手动粘贴。</p>`;
    } else if(t.id==='F12') {
      html+=`<textarea class="utm-output" readonly aria-label="生成的投放链接">${esc(state.result.url)}</textarea><div class="parameter-list">${utmKeys.filter(k=>state.result.params[k]).map(k=>`<div class="parameter-row"><span>${k}</span><span>${esc(state.result.params[k])}</span></div>`).join('')}</div><button class="button button-secondary result-copy" type="button" data-copy="all">${icon('copy')}复制链接</button><p class="result-note">${t.scope}</p>`;
    } else {
      html+=primaryMarkup(state.result.primary);
      if(state.result.metrics.length) html+=`<div class="result-metrics">${state.result.metrics.map(metricMarkup).join('')}</div>`;
      html+=`<p class="result-note">${esc(state.result.note||t.scope)}</p><button class="button button-secondary result-copy" type="button" data-copy="all">${icon('copy')}复制结果</button><p class="result-footer">查看更多广告：<button type="button" data-workspace>去广告资料库 ↗</button></p>`;
    }
    panel.innerHTML=html;
    const view=$('[data-view-result]');if(view)view.hidden=!state.result;
  }
  function stepArt(i,t) {
    if(i===0)return `<div class="step-art art-form" aria-hidden="true"><span class="art-label"></span><span class="art-input"></span><span class="art-label short"></span><span class="art-input focus"><i></i></span><span class="art-label"></span><span class="art-input"></span></div>`;
    if(i===1)return `<div class="step-art art-button" aria-hidden="true"><span class="art-btn">${t.type==='policy'?'生成政策':actionLabel(t)}</span><svg class="art-cursor" viewBox="0 0 24 24" width="30" height="30"><path d="M5 3l14 8-6 1.6L10 19z" fill="#1c1e21" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg></div>`;
    return t.type==='policy'?`<div class="step-art art-doc" aria-hidden="true"><span class="art-doc-title">Refund Policy</span><span></span><span></span><span class="short"></span><span></span><span class="short"></span></div>`:`<div class="step-art art-number" aria-hidden="true"><small>${esc(t.labels[0])}</small><b>${t.id==='F07'?'10 条':t.id==='F08'?'4 个平台':t.id==='F12'?'UTM ✓':'5.00×'}</b></div>`;
  }
  function detailBottom(t) {
    if(t.type==='policy')return policyBottom(t);
    return `<section class="assumption-block"><div class="assumption-heading">${icon('info')}怎么算的</div><div class="assumption-copy"><p class="formula">${esc(t.formula)}</p><p>${esc(t.scope)}</p>${hasCurrency(t)?'<p>币种仅用于显示，不做汇率换算。结果保留两位小数。</p>':''}</div></section><section class="how-to"><h2 class="subsection-title center">怎么用</h2><div class="steps">${[['填写数据','填写你的数据，或先用示例数据试用。'],['查看结果','右侧显示主要结果和相关指标。'],['复制结果','复制结果和公式，方便分享或粘贴到表格。']].map((s,i)=>`<div class="step">${stepArt(i,t)}<h3>${s[0]}</h3><p>${s[1]}</p></div>`).join('')}</div></section><section class="related-section"><h2 class="subsection-title">相关工具</h2><div class="related-grid">${t.related.map(id=>{const r=tools.find(x=>x.id===id);return `<a class="related-card" href="#/tools/${r.slug}"><span class="tool-icon">${icon(r.icon)}</span><span class="related-name">${r.short}</span>${icon('arrow')}</a>`;}).join('')}</div></section><section class="faq-section"><div class="faq-side"><span class="faq-mark" aria-hidden="true">?</span><h2>常见问题</h2></div><div class="faq-list">${[['需要注册或付费吗？',`不需要。这 ${tools.length} 个工具都可以免费使用，无需登录。AdTrender 广告资料库需要登录。`],[t.id==='F07'?'这是 AI 生成的吗？':t.id==='F12'?'加了 UTM 就能看到数据吗？':t.id==='F08'?'能直接在这里搜广告吗？':'计算结果准确吗？',t.id==='F07'?'不是。工具使用 10 个固定模板，把你填写的内容套入，不调用 AI，也不翻译。':t.id==='F12'?'UTM 只是链接中的来源标记，数据需要在 GA4、Shopify 等分析工具中查看。':t.id==='F08'?'不能。这里提供官方广告库的链接，打开后粘贴关键词搜索。':'公式本身是准确的，结果取决于你填写的数据。工具不连接广告账户或店铺，不会核对数据。'],['我的输入会被保存吗？','不会。所有计算在浏览器中完成，不会上传，关闭页面后清空。']].map(([q,a])=>`<details class="faq"><summary>${q}</summary><p>${a}</p></details>`).join('')}</div></section>`;
  }
  function policyBottom(t) {
    return `<section class="assumption-block"><div class="assumption-heading">${icon('info')}使用说明</div><div class="assumption-copy"><p>${esc(t.formula)}</p><p>这是通用模板，不构成法律意见。发布前请按实际规则、商品和销售地区核对。</p><p>贴到哪里：<a href="https://help.shopify.com/en/manual/checkout-settings/refund-privacy-tos" target="_blank" rel="noopener noreferrer">Shopify Settings → Policies ↗</a></p><p>如果店铺启用了自动生成政策，请先切换为手动编辑再粘贴，否则内容会被覆盖。</p></div></section><section class="how-to"><h2 class="subsection-title center">怎么用</h2><div class="steps">${[['填写规则','按实际情况填写店铺信息、退货期限和运费等。'],['编辑正文','生成后可在右侧直接修改。'],['粘贴到店铺','复制正文，粘贴到 Shopify 后台的政策设置中。']].map((s,i)=>`<div class="step">${stepArt(i,t)}<h3>${s[0]}</h3><p>${s[1]}</p></div>`).join('')}</div></section><section class="related-section"><h2 class="subsection-title">其他政策模板</h2><div class="related-grid">${t.related.map(id=>{const r=tools.find(x=>x.id===id);return r?`<a class="related-card" href="#/tools/${r.slug}"><span class="tool-icon">${icon(r.icon)}</span><span class="related-name">${r.short}</span>${icon('arrow')}</a>`:'';}).join('')}</div></section><section class="faq-section"><div class="faq-side"><span class="faq-mark" aria-hidden="true">?</span><h2>常见问题</h2></div><div class="faq-list">${[['生成后可以复制吗？','可以。点击“复制正文”获取纯文本，也可以编辑后再复制，或下载 TXT。'],['每个模板都要重填店铺信息吗？','不需要。店铺名、网址、邮箱和退货规则只需填写一次，五个模板通用；刷新页面后清空。'],['生成后可以直接发布吗？','建议先核对。各国要求不同，请按销售地区检查；退款政策和退换货政策的规则需保持一致。']].map(([q,a])=>`<details class="faq"><summary>${q}</summary><p>${a}</p></details>`).join('')}</div></section>`;
  }
  function renderDetail(t) {
    state.tool=t;state.values={...t.defaults,...(t.type==='policy'?state.policyProfile:{})};state.currency='USD';state.result=null;state.copyText='';state.copyItems=[];state.duplicates=[];state.edited=false;
    document.title=`${t.name} · AdTrender`;
    main.innerHTML=`<div class="container"><nav class="breadcrumb" aria-label="面包屑"><a href="#/">免费工具</a>${icon('chevron-right')}<span>${t.name}</span></nav><header class="detail-intro"><p class="hero-kicker">${kicker(t)}</p><h1>${accentName(t)}</h1><p>${t.desc}</p><div class="hero-meta"><span>${icon('check')}免费使用，无需登录</span><span>${icon('shield')}${t.id==='F07'?'固定模板生成':'数据不上传'}</span></div></header><div class="detail-shell"><div class="workbench ${t.type==='policy'?'policy-workbench':''}"><form id="tool-form" class="input-panel" novalidate></form><section id="result-panel" class="result-panel" aria-label="工具结果" aria-live="polite" aria-atomic="false"></section></div>${detailBottom(t)}</div></div>`;
    renderForm();renderResult();
  }
  function clearErrors() {document.querySelectorAll('.has-error').forEach(e=>e.classList.remove('has-error'));document.querySelectorAll('.field-error').forEach(e=>{e.hidden=true;e.textContent='';});document.querySelectorAll('[aria-invalid]').forEach(e=>e.removeAttribute('aria-invalid'));const error=$('#form-error');if(error){error.hidden=true;error.textContent='';}}
  function showError(error) {
    const key=error.field||'',field=$(`[data-field="${key}"]`),input=$(`#field-${key}`);
    if(field&&input){field.classList.add('has-error');const msg=$('.field-error',field);msg.textContent=error.message;msg.hidden=false;input.setAttribute('aria-invalid','true');input.focus();window.FreeMotion?.nudge(field);}
    else {const el=$('#form-error');el.textContent=error.message;el.hidden=false;}
  }
  function fail(field,message) {const e=new Error(message);e.field=field;throw e;}
  function hookTemplates(v) {
    for(const k of ['product','audience','benefit']) {if(!String(v[k]||'').trim())fail(k,'请填写此项。');if(Array.from(v[k]).length>200)fail(k,'最多 200 个字符。');}
    const p=v.product.trim(),a=v.audience.trim(),b=v.benefit.trim();
    const zh=[['提问',`还在找${b}的${p}？`],['使用场景',`${a}，这款${p}你可能会喜欢：${b}。`],['换个角度',`买${p}，很多人忽略了这一点：${b}。`],['选购清单',`挑${p}时，「${b}」在不在你的清单上？`],['看细节',`这款${p}最打动我的一点：${b}。`],['从需求开始',`${a}，挑${p}最在意什么？`],['使用视角',`如果你是${a}，这款${p}值得看看。`],['比较维度',`对比${p}的时候，记得看看是不是${b}。`],['开场邀请',`30 秒看懂这款${p}：${b}。`],['选择理由',`就冲${b}这一点，这款${p}值得试试。`]];
    const en=[['Question',`Looking for ${p} with ${b}?`],['Audience',`For ${a}: take a closer look at ${p}.`],['Fresh angle',`A different way to look at ${p}: ${b}.`],['Checklist',`Choosing ${p}? Add ${b} to your checklist.`],['Detail',`One detail to explore in ${p}: ${b}.`],['Needs first',`As ${a}, what matters to you when choosing ${p}?`],['Perspective',`A look at ${p} from the perspective of ${a}.`],['Compare',`When comparing ${p}, consider ${b}.`],['Invitation',`Let's take a closer look at ${p} and ${b}.`],['Reason',`Could ${b} be a reason to consider ${p}?`]];
    return (v.language==='en'?en:zh).map(([type,text])=>({type,text}));
  }
  function parseLanding(raw) {if(!raw||!raw.trim())fail('url','请填落地页链接。');if(raw.length>4096)fail('url','链接最多 4096 个字符。');let u;try{u=new URL(raw.trim());}catch{fail('url','请输入完整链接，例如 https://example.com。');}if(!['http:','https:'].includes(u.protocol)||!u.hostname)fail('url','只支持 http 或 https 开头的链接。');if(u.username||u.password)fail('url','链接中不能包含账号或密码。');return u;}
  function buildUtm(v,confirmed=false) {
    const u=parseLanding(v.url);
    const duplicates=utmKeys.filter(k=>u.searchParams.getAll(k).length>1);
    if(duplicates.length&&!confirmed)fail('url','链接中有重复的 UTM 参数，请先勾选下方确认。');
    const params={};
    utmKeys.forEach((k,i)=>{const raw=String(v[k]||'').trim();if(i<3&&!raw)fail(k,'请填写此项。');if(Array.from(raw).length>200)fail(k,'最多 200 个字符。');params[k]=raw;u.searchParams.delete(k);if(raw)u.searchParams.set(k,raw);});
    return {url:u.href,params};
  }
  function showUtmWarning() {
    const area=$('#utm-warning-area');if(!area)return;
    let current;try{current=parseLanding(state.values.url);}catch{current=null;}
    area.innerHTML=state.duplicates.length?`<div class="utm-warning">链接中有重复参数：${state.duplicates.map(k=>`<div><strong>${k}</strong>：${current?current.searchParams.getAll(k).map(esc).join(' / '):''}</div>`).join('')}表单中已填入第一个值，确认后将用表单中的值替换。</div><label class="utm-confirm"><input type="checkbox" name="confirmUtm" value="yes">确认用表单中的值替换</label>`:'';
  }
  function inspectUtm() {
    let u;try{u=parseLanding(state.values.url);}catch{state.duplicates=[];showUtmWarning();return;}
    state.duplicates=utmKeys.filter(k=>u.searchParams.getAll(k).length>1);
    utmKeys.forEach(k=>{const vals=u.searchParams.getAll(k);if(vals.length){state.values[k]=vals[0];$(`#field-${k}`).value=vals[0];}});
    showUtmWarning();
  }
  function collect() {const form=$('#tool-form');if(!form)return;const fd=new FormData(form);for(const[k,v]of fd){if(k==='currency')state.currency=v;else if(k!=='confirmUtm')state.values[k]=v;}if(state.tool?.type==='policy')for(const key of window.FreePolicies.sharedKeys)if(key in state.values)state.policyProfile[key]=state.values[key];}
  function invalidate() {if(!state.tool)return;if(state.tool.type==='policy'&&state.result?.edited){state.result.stale=true;state.edited=true;clearErrors();renderResult();return;}state.edited=!!state.result||state.edited;state.result=null;state.copyText='';state.copyItems=[];clearErrors();renderResult();}
  function prepareCopy() {
    const t=state.tool;
    if(t.type==='policy')state.copyText=state.result.text;
    else if(t.id==='F07'){state.copyItems=state.result.map(r=>r.text);state.copyText=state.result.map((r,i)=>`${i+1}. [${r.type}] ${r.text}`).join('\n\n');}
    else if(t.id==='F08')state.copyText=state.values.query.trim();
    else if(t.id==='F12')state.copyText=state.result.url;
    else{const inputs=fieldsForTool(t).map(f=>`${f.label}：${state.values[f.key]??''}${f.unit==='percent'?'%':''}`).join('\n');const metrics=[state.result.primary,...state.result.metrics].map(m=>`${m.label}：${m.unit==='money'?state.currency+' ':''}${formatted(m)}${m.unit==='percent'?'%':m.unit==='multiple'?'×':''}`).join('\n');state.copyText=`${t.name}\n${state.currency}（不换汇）\n\n输入\n${inputs}\n\n结果\n${metrics}\n\n${t.formula}\n${t.scope}\n公式版本：preview-v1`;} }
  function submit(force=false) {
    collect();clearErrors();const t=state.tool;
    if(t.type==='policy'&&state.result?.edited&&!force){$('#policy-regenerate-dialog').showModal();return;}
    try{
      if(t.type==='policy')state.result=window.FreePolicies.generate(t.id,state.values);
      else if(t.id==='F07')state.result=hookTemplates(state.values);
      else if(t.id==='F08'){const q=String(state.values.query||'').trim();if(!q)fail('query','请输入品牌名或关键词。');if(q.length>200)fail('query','最多 200 个字符。');state.result={ready:true};}
      else if(t.id==='F12')state.result=buildUtm(state.values,!!$('[name="confirmUtm"]:checked'));
      else state.result=window.FreeToolMath.calculate(t.id,state.values);
      prepareCopy();renderResult();window.FreeMotion?.result($('#result-panel'));$('#result-panel').classList.remove('updated');void $('#result-panel').offsetWidth;$('#result-panel').classList.add('updated');if(t.type==='policy')$('#result-panel').scrollIntoView({behavior:'smooth',block:'start'});
    }catch(e){if(!(t.type==='policy'&&state.result?.edited))state.result=null;renderResult();showError(e);}
  }
  function toast(message) {const el=$('.toast');el.textContent=message;el.classList.add('visible');clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove('visible'),2600);}
  async function copy(text,button) {
    if(!text)return;
    const original=button.innerHTML,copyTool=state.tool,copyResult=state.result,copySnapshot=state.copyText;button.disabled=true;
    const stillCurrent=()=>state.tool===copyTool&&state.result===copyResult&&state.copyText===copySnapshot&&button.isConnected;
    try{if(!navigator.clipboard?.writeText)throw new Error('clipboard unavailable');await navigator.clipboard.writeText(text);if(!stillCurrent())return;button.innerHTML=`${icon('check')}已复制`;toast('已复制');}
    catch{if(!stillCurrent())return;const panel=$('#result-panel');if(!panel)return;let fallback=$('#manual-copy');if(!fallback){fallback=document.createElement('div');fallback.id='manual-copy';fallback.className='manual-copy';fallback.innerHTML='<label>自动复制失败，请选中下方文字手动复制。<textarea readonly></textarea></label>';panel.append(fallback);}const area=$('textarea',fallback);area.value=text;area.focus();area.select();toast('请手动复制');button.innerHTML='手动复制';}
    setTimeout(()=>{if(button.isConnected){button.disabled=false;button.innerHTML=original;}},1800);
  }
  function renderGuide() {
    state.tool=null;document.title='免费工具使用指南 · AdTrender';
    main.innerHTML=`<div class="container"><div class="guide-intro"><h1>按任务选择工具</h1><p>全部工具免费使用，无需登录。</p></div><div class="guide-content">${[['算回报与利润','看广告回报用 ROAS，看整体利润用电商利润计算器。ROI、利润率和 LTV 的算法不同，按需选择。','F01'],['倒推流量与预算','有利润目标时，用目标利润与流量计算器反推订单和访问量；有订单目标时，用广告预算计算器，根据 CPM、CTR、CVR 计算预算。','F10'],['准备创意和链接','Hook 模板生成广告开头，UTM 生成器给链接添加渠道参数，官方广告库入口提供各平台广告库链接。','F07']].map(([title,desc,id])=>`<section class="assumption-block"><div><h2>${title}</h2><p class="assumption-copy">${desc}</p><a class="button button-secondary" href="#/tools/${tools.find(t=>t.id===id).slug}">打开工具 ${icon('arrow')}</a></div></section>`).join('')}<div class="assumption-block"><div class="assumption-heading">${icon('info')}关于这个预览</div><p class="assumption-copy">本地预览版，共 ${tools.length} 个工具，用于确认界面和流程。计算和模板均在本地完成；官方广告库链接会打开外部网站，工作区按钮仅显示说明。另有 5 个店铺研究工具在开发中。</p></div></div></div>`;
  }
  function route() {
    const hash=location.hash.replace(/^#\/?/,'');
    if(hash==='result-panel'||hash==='main')return;
    clearTimeout(toastTimer);$('.toast').classList.remove('visible');
    if(hash.startsWith('tools/')){const t=tools.find(x=>x.slug===hash.slice(6));if(t)renderDetail(t);else renderDirectory();}
    else if(hash==='guide')renderGuide();else renderDirectory();
    $('.mobile-nav').hidden=true;$('.mobile-menu').setAttribute('aria-expanded','false');window.scrollTo({top:0,behavior:'instant'});
  }
  document.addEventListener('click',e=>{
    if(e.target.closest('.skip-link')){e.preventDefault();main.focus({preventScroll:true});main.scrollIntoView({block:'start'});return;}
    if(e.target.closest('a[href="#/"]')){e.preventDefault();if(location.hash!=='#/')location.hash='/';else{renderDirectory();window.scrollTo({top:0,left:0,behavior:'instant'});}return;}
    const workspace=e.target.closest('[data-workspace]');if(workspace){e.preventDefault();$('#workspace-dialog').showModal();return;}
    if(e.target.closest('.dialog-close,.dialog-return')){$('#workspace-dialog').close();return;}
    if(e.target.closest('.mobile-menu')){const nav=$('.mobile-nav');nav.hidden=!nav.hidden;$('.mobile-menu').setAttribute('aria-expanded',String(!nav.hidden));return;}
    const category=e.target.closest('[data-category]');if(category){state.category=category.dataset.category;renderCards();return;}
    if(e.target.closest('[data-clear-search]')){state.search='';state.category='all';$('#tool-search').value='';renderCards();return;}
    if(e.target.closest('[data-policy-demo]')){state.values={...state.tool.defaults,...state.tool.example};if(state.result?.edited)state.result.stale=true;else state.result=null;renderForm();submit();toast('已生成示例，请替换为你的店铺信息');if(!state.result?.stale&&window.matchMedia('(max-width:767px)').matches)$('#result-panel').scrollIntoView({behavior:'smooth',block:'start'});return;}
    if(e.target.closest('[data-example]')){state.values={...state.tool.defaults,...state.tool.example};if(state.tool.type==='policy')for(const key of window.FreePolicies.sharedKeys)if(key in state.values)state.policyProfile[key]=state.values[key];if(state.tool.type==='policy'&&state.result?.edited){state.result.stale=true;state.edited=true;}else{state.result=null;state.edited=false;}state.duplicates=[];renderForm();renderResult();toast('已填入示例数据');return;}
    const mode=e.target.closest('[data-mode]');if(mode){collect();state.values.mode=mode.dataset.mode;invalidate();renderForm();return;}
    const platform=e.target.closest('[data-platform]');if(platform){collect();state.values.platform=platform.dataset.platform;invalidate();renderForm();return;}
    const copyButton=e.target.closest('[data-copy]');if(copyButton){const key=copyButton.dataset.copy;copy(key==='all'?state.copyText:key==='query'?state.values.query.trim():state.copyItems[Number(key)],copyButton);return;}
    if(e.target.closest('[data-download-policy]')){const blob=new Blob([state.result.text],{type:'text/plain;charset=utf-8'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=state.tool.slug+'.txt';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);return;}
    if(e.target.closest('[data-policy-keep]')){$('#policy-regenerate-dialog').close();return;}
    if(e.target.closest('[data-policy-replace]')){$('#policy-regenerate-dialog').close();submit(true);return;}
    if(e.target.closest('[data-view-result]')){e.preventDefault();$('#result-panel').scrollIntoView({behavior:'smooth',block:'start'});return;}
  });
  document.addEventListener('input',e=>{if(e.target.id==='policy-text'&&state.tool?.type==='policy'&&state.result){state.result.text=e.target.value;state.result.edited=true;state.copyText=e.target.value;$('#policy-draft-status').textContent=state.result.stale?'资料已修改 · 已编辑':'已编辑';$('#policy-word-count').textContent=e.target.value.trim().split(/\s+/).filter(Boolean).length+' words';return;}if(e.target.id==='tool-search'){state.search=e.target.value;renderCards();}else if(e.target.closest('#tool-form')){collect();invalidate();if(e.target.name==='url')inspectUtm();if(e.target.name==='currency')document.querySelectorAll('[data-money-symbol]').forEach(s=>s.textContent=currencySymbol());}});
  document.addEventListener('change',e=>{if(e.target.closest('#tool-form')){collect();invalidate();if(e.target.name==='url')inspectUtm();if(e.target.name==='currency')document.querySelectorAll('[data-money-symbol]').forEach(s=>s.textContent=currencySymbol());}});
  document.addEventListener('submit',e=>{if(e.target.id==='tool-form'){e.preventDefault();submit();}});
  document.addEventListener('reset',e=>{if(e.target.id==='tool-form'){e.preventDefault();if(state.tool.type==='policy')state.policyProfile={};state.values={...state.tool.defaults};state.currency='USD';state.result=null;state.edited=false;state.duplicates=[];renderForm();renderResult();}});
  document.addEventListener('keydown',e=>{if(e.key==='/'&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName)&&$('#tool-search')){e.preventDefault();$('#tool-search').focus();}if(e.key==='Escape'){$('.mobile-nav').hidden=true;$('.mobile-menu').setAttribute('aria-expanded','false');}});
  $('#workspace-dialog').addEventListener('click',e=>{if(e.target===$('#workspace-dialog')){const r=e.target.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)e.target.close();}});
  window.addEventListener('hashchange',route);
  window.FreeToolPreview={tools,hookTemplates,buildUtm};
  route();
})();

// END APPROVED SOURCE
}

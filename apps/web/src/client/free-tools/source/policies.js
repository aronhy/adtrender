// Source copied verbatim from the approved HTML prototype. See provenance.json.
export default function initialize(window, document, location, requestAnimationFrame, cancelAnimationFrame, setTimeout, clearTimeout) {
// BEGIN APPROVED SOURCE
/* Original English policy drafts for this local prototype. Pure text, memory only. */
(() => {
  'use strict';

  const version = 'policy-preview-v1';
  const scope = '通用模板，发布前请按店铺实际规则和销售地区核对。';
  const field = (key, label, type = 'text', extra = {}) => ({key, label, type, placeholder: '', ...extra});
  const text = (key, label, placeholder, extra = {}) => field(key, label, 'text', {placeholder, ...extra});
  const area = (key, label, placeholder, extra = {}) => field(key, label, 'textarea', {placeholder, full: true, ...extra});
  const select = (key, label, options, extra = {}) => field(key, label, 'select', {options: [['', '请选择'], ...options], ...extra});
  const contactFields = () => [
    text('storeName', '店铺名称', '如 Northline Supply'),
    text('website', '店铺网址', 'https://example.com', {help: '以 https:// 开头的完整网址。'}),
    text('email', '客服邮箱', 'support@example.com', {full: true})
  ];
  const returnFields = () => [
    text('returnWindow', '退货期限（天）', '如 30', {help: '顾客可申请退货的天数，退款政策和退换货政策共用此项。'}),
    select('returnStart', '起算日', [['delivery', '自签收之日起'], ['purchase', '自购买之日起']]),
    area('returnConditions', '可退货条件', 'Use English to describe the actual item condition and proof of purchase required.'),
    area('exclusions', '不可退货商品', 'List actual exclusions in English, or state that no product exclusions apply.'),
    select('returnShipping', '退货运费承担', [['customer', '买家承担'], ['merchant', '店铺承担']], {full: true, help: '指退货寄回的运费。原订单运费是否退还，在退款政策中填写。'})
  ];
  const contactExample = {storeName: 'Northline Supply', website: 'https://example.com', email: 'support@example.com'};
  const returnExample = {
    returnWindow: '30', returnStart: 'delivery',
    returnConditions: 'Items must be unused, in their original packaging, and accompanied by an order number.',
    exclusions: 'Personalized items are excluded from change-of-mind returns. Contact us separately about damaged or incorrect items.',
    returnShipping: 'customer'
  };
  const makeTool = (data) => ({category: 'D', kind: '政策模板', type: 'policy', labels: ['英文政策正文'], defaults: {}, scope, ...data});

  const tools = [
    makeTool({
      id: 'F18', slug: 'privacy-policy-generator', name: '隐私政策模板', short: '隐私政策模板', icon: 'users',
      desc: '填收集的信息、用途和服务商，生成英文隐私政策。',
      fields: [
        ...contactFields(), text('businessName', '公司或经营者名称', '如 Northline Supply — Example Business', {full: true}),
        area('address', '联系地址', 'Enter the real business or policy contact address before publication.'),
        area('collectedData', '收集的信息类别', 'For example: contact details, delivery addresses, and order records.', {help: '按实际情况填写，未收集的信息不要列出。'}),
        area('usePurposes', '信息用途', 'Describe why each category is used.'),
        area('serviceProviders', '服务商及用途', 'Name the actual providers and purposes, or explicitly state none.'),
        area('retention', '保留期限与删除规则', 'Describe the actual retention periods or the criteria used to decide them.'),
        select('cookieUse', '是否使用 Cookie 或类似追踪', [['yes', '是'], ['no', '否'], ['unknown', '不确定']], {full: true, help: '选择“不确定”时，正文会标注待补充。'}),
        area('cookieDetails', 'Cookie 用途与关闭方式', 'Describe the actual technologies, purposes, and available controls.', {optional: true, help: '选择“是”时必填。'})
      ],
      example: {...contactExample, businessName: 'Northline Supply — Example Business', address: '100 Example Way, Example City, Example Region',
        collectedData: 'Customer names, email addresses, delivery addresses, and order records supplied during checkout or support requests.',
        usePurposes: 'To process orders, arrange delivery, answer support requests, and keep transaction records.',
        serviceProviders: 'Shopify hosts the storefront and supports checkout. The delivery provider selected for an order receives the details needed to deliver it.',
        retention: 'Order records are kept for the period stated in our internal record-retention schedule. Support correspondence is deleted when it is no longer needed for the request.',
        cookieUse: 'unknown', cookieDetails: ''},
      formula: '将填写的内容放入对应的英文段落，未填写或未确认的部分会在正文中标注。',
      related: ['F20', 'F19', 'F22']
    }),
    makeTool({
      id: 'F19', slug: 'refund-policy-generator', name: '退款政策模板', short: '退款政策模板', icon: 'profit',
      desc: '填退款条件、金额和到账时间，生成英文退款政策。',
      fields: [
        ...contactFields(),
        area('refundEligibility', '可退款情况', 'Describe when a refund is available, including refunds that do not require a physical return.'),
        area('refundAmountRule', '退款金额规则', 'State when full or partial refunds apply and how the amount is determined.'),
        select('refundIncludesReturns', '是否包含退货规则', [['yes', '是，在下方填写退货规则'], ['no', '否，仅适用于无需退货的退款']], {full: true}),
        ...returnFields().map(f => ({...f, optional: true, help: `包含退货规则时必填。${f.help || ''}`})),
        select('refundMethod', '退款方式', [['original', '原支付方式'], ['store-credit', '店铺余额'], ['custom', '其他方式']], {full: true}),
        area('refundMethodDetails', '其他退款方式说明', 'Describe the actual method and any conditions.', {optional: true, help: '选择“其他方式”时必填。'}),
        text('refundProcessing', '退款处理时间（工作日）', '如 5', {full: true, help: '从收到退款申请起计算，不含银行或支付平台的到账时间。'}),
        area('paymentArrival', '到账时间说明', 'State the actual payment-provider guidance or explain that the timing must be confirmed with the provider.'),
        area('refundCosts', '原运费和手续费的退还规则', 'State which original delivery charges or fees are refunded or excluded. Do not invent a fee.'),
        text('returnsPolicyUrl', '退换货政策链接', 'https://example.com/pages/returns', {optional: true, full: true, help: '可暂时留空，正文会标注待补充。'})
      ],
      example: {...contactExample, ...returnExample,
        refundEligibility: 'A refund may be requested for an approved return or an order that we confirm cannot be fulfilled. Contact support about damaged or incorrect items.',
        refundAmountRule: 'An approved return of an eligible item is refunded at the item price paid. Any proposed partial refund is explained before it is agreed.',
        refundIncludesReturns: 'yes', refundMethod: 'original', refundMethodDetails: '', refundProcessing: '5',
        paymentArrival: 'After we issue a refund, the payment provider controls when it appears in the account. Ask support for the provider reference if a refund is not visible.',
        refundCosts: 'Original delivery charges are not refunded for change-of-mind returns. Charges relating to a store-confirmed error are reviewed with support.',
        returnsPolicyUrl: 'https://example.com/pages/returns'},
      formula: '按退款条件、金额、方式、处理时间和到账时间分段生成。退货规则与退换货政策共用。',
      related: ['F21', 'F22', 'F20']
    }),
    makeTool({
      id: 'F20', slug: 'terms-and-conditions-generator', name: '服务条款模板', short: '服务条款模板', icon: 'library',
      desc: '填下单、付款和取消规则，生成英文服务条款。',
      fields: [
        ...contactFields(), text('businessName', '公司或经营者名称', 'Enter the actual business / operator name.', {full: true}),
        area('productScope', '商品或服务类型', 'Describe the products or services this draft covers.'),
        text('salesMarkets', '销售国家或地区', 'List the markets actually served.', {full: true}),
        area('orderAcceptance', '订单确认规则', 'Describe when an order is accepted and how customers are notified.'),
        area('paymentRule', '支付与价格规则', 'State accepted payment methods and how prices, taxes, and delivery charges are shown.'),
        area('fulfillmentRule', '发货与交付方式', 'Describe delivery, collection, or service fulfillment and any relevant policy.'),
        area('cancellationRule', '订单取消规则', 'Describe how to request cancellation and the actual cutoff or limitations.'),
        area('policyLinks', '其他政策的链接', 'https://example.com/pages/privacy\nhttps://example.com/pages/returns', {optional: true, help: '每行一个链接。可暂时留空，正文会标注待补充。'})
      ],
      example: {...contactExample, businessName: 'Northline Supply — Example Business',
        productScope: 'Physical consumer goods described on the product pages of this example store.', salesMarkets: 'United States (example market only)',
        orderAcceptance: 'An order is accepted when we send an order-acceptance message. An automated receipt only confirms that the request was received.',
        paymentRule: 'The payment methods available for an order are shown at checkout. The checkout summary states the price, delivery charges, and any taxes collected by the store.',
        fulfillmentRule: 'Physical orders are shipped to the delivery address supplied at checkout, subject to the destinations and timing stated in our Shipping Policy.',
        cancellationRule: 'Email support with the order number to request cancellation before dispatch. After dispatch, use the returns process instead.',
        policyLinks: 'https://example.com/pages/privacy\nhttps://example.com/pages/refunds\nhttps://example.com/pages/returns\nhttps://example.com/pages/shipping'},
      formula: '仅使用你填写的内容生成条款，不包含适用法律或管辖地条款。其他政策只引用你提供的链接。',
      related: ['F18', 'F21', 'F22']
    }),
    makeTool({
      id: 'F21', slug: 'returns-policy-generator', name: '退换货政策模板', short: '退换货政策模板', icon: 'shop',
      desc: '填退货期限、条件和运费规则，生成英文退换货政策。',
      fields: [
        ...contactFields(), ...returnFields(),
        select('returnAddressMode', '退货地址提供方式', [['provided', '写在政策中'], ['on-request', '退货申请通过后提供'], ['unknown', '不确定']], {full: true}),
        area('returnAddress', '退货地址', 'Enter an actual return address only if it is ready to be published.', {optional: true, help: '选择“写在政策中”时必填。'}),
        area('exchangeRule', '换货规则', 'Describe whether exchanges are offered and the actual process. If unavailable, state that explicitly.'),
        area('damagedItems', '损坏或错发处理', 'Describe how to report a damaged or incorrect item and the information needed.'),
        text('refundPolicyUrl', '退款政策链接', 'https://example.com/pages/refunds', {optional: true, full: true, help: '退款金额、方式和到账时间在退款政策中说明，这里只填链接。'})
      ],
      example: {...contactExample, ...returnExample, returnAddressMode: 'on-request', returnAddress: '',
        exchangeRule: 'Contact support about an exchange before sending an item back. Availability must be confirmed for the replacement item.',
        damagedItems: 'Contact support with the order number, a description of the issue, and photos if available. Support will explain the next step before an item is sent back.',
        refundPolicyUrl: 'https://example.com/pages/refunds'},
      formula: '包含退货期限、条件、运费承担和退货地址。退款金额和到账时间引用退款政策，避免两份政策不一致。',
      related: ['F19', 'F22', 'F20']
    }),
    makeTool({
      id: 'F22', slug: 'shipping-policy-generator', name: '配送政策模板', short: '配送政策模板', icon: 'link',
      desc: '填配送范围、时效和运费，生成英文配送政策。',
      fields: [
        ...contactFields(),
        area('destinations', '配送范围', 'List the destinations served and any destination restrictions.'),
        text('processingTime', '发货时间', 'For example: 2–4 business days after order confirmation.', {full: true, help: '请写明单位，例如 2–4 business days。'}),
        text('transitTime', '运输时间', 'For example: 5–8 business days after dispatch.', {full: true, help: '从发货到送达的时间，与发货时间分开填写。'}),
        area('shippingFees', '运费和包邮规则（写明币种）', 'State the actual fees and currency, or describe where the charge is shown before purchase.'),
        area('duties', '关税承担', 'Describe who pays applicable import charges and how this is communicated.'),
        area('stockOut', '缺货与预售处理', 'Describe the actual process for unavailable or preorder items.'),
        area('tracking', '物流跟踪方式', 'Describe how tracking information is provided, or state if tracking is unavailable.'),
        area('deliveryIssues', '延误与丢件处理', 'Describe whom to contact and the actual investigation or resolution process.')
      ],
      example: {...contactExample, destinations: 'Contiguous United States only for this example. Other destinations are not offered.',
        processingTime: '2–4 business days after order confirmation.', transitTime: '5–8 business days after dispatch.',
        shippingFees: 'Shipping charges are shown in USD at checkout before payment. No free-shipping threshold is offered in this example.',
        duties: 'This example offers domestic delivery only. Import duties are not included as a supported scenario.',
        stockOut: 'If a confirmed item is unavailable, support contacts the customer to discuss the available options before proceeding. Preorders are not offered in this example.',
        tracking: 'A dispatch email includes a tracking link when the selected delivery service provides one.',
        deliveryIssues: 'Email support with the order number and delivery details. Support checks the shipment with the delivery provider and discusses the available next steps.'},
      formula: '将填写的配送信息分段生成，不会添加未填写的时效或价格。',
      related: ['F21', 'F19', 'F20']
    })
  ];

  // Same key always has the same meaning. Reuse is limited to the current page's memory.
  const sharedKeys = ['storeName', 'businessName', 'website', 'email', 'address', 'returnWindow', 'returnStart',
    'returnConditions', 'exclusions', 'returnShipping', 'returnAddressMode', 'returnAddress', 'returnsPolicyUrl', 'refundPolicyUrl'];
  function fail(key, message) { const error = new Error(message); error.field = key; throw error; }
  function normalize(raw, f) {
    if (raw == null) return '';
    if (!['string', 'number'].includes(typeof raw)) fail(f.key, '请填写文字。');
    let value = String(raw).replace(/\r\n?/g, '\n').trim();
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u202A-\u202E\u2066-\u2069]/.test(value)) fail(f.key, '内容包含不可见字符，请删除后重新输入。');
    if (f.type !== 'textarea') value = value.replace(/\s+/g, ' ');
    const limit = f.key === 'website' || /PolicyUrl$/.test(f.key) ? 2048 : f.type === 'textarea' ? 8000 : 1000;
    if (value.length > limit) fail(f.key, `最多 ${limit} 个字符。`);
    return value;
  }
  function website(value, key) {
    let url;
    try { url = new URL(value); } catch { fail(key, '请输入以 https:// 开头的完整链接。'); }
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) fail(key, '请用 https:// 开头、不带账号密码的链接。');
    return url.href;
  }
  function integer(value, key, max) {
    if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > max) fail(key, `请填 1 到 ${max} 之间的整数。`);
    return String(Number(value));
  }
  function duration(value, key) {
    if (/(^|[^\d\s])\s*[-−]\s*\d/.test(value)) fail(key, '时长不能为负数。');
    const ranges = value.matchAll(/(\d+(?:\.\d+)?)\s*((?:(?:business|calendar)\s+)?(?:hours?|days?|weeks?|months?))?\s*(?:-|–|—|to)\s*(\d+(?:\.\d+)?)\s*((?:(?:business|calendar)\s+)?(?:hours?|days?|weeks?|months?))?/gi);
    for (const range of ranges) {
      const unit = s => (s || '').toLowerCase().replace(/s$/, '').replace(/\s+/g, ' ');
      if (range[2] && range[4] && unit(range[2]) !== unit(range[4])) fail(key, '时间范围的单位需一致，例如都用 days。');
      if (Number(range[1]) > Number(range[3])) fail(key, '起始值不能大于结束值。');
    }
    if (/\d/.test(value) && !/\b(?:hours?|days?|weeks?|months?)\b|工作日|自然日|小时|周|天/i.test(value)) fail(key, '请写明单位，例如 business days、days、weeks。');
  }
  function validate(tool, values) {
    const v = Object.create(null);
    for (const f of tool.fields) {
      if(tool.id==='F19'&&values.refundIncludesReturns==='no'&&['returnWindow','returnStart','returnConditions','exclusions','returnShipping','returnsPolicyUrl'].includes(f.key)){v[f.key]='';continue;}
      v[f.key] = normalize(Object.prototype.hasOwnProperty.call(values, f.key) ? values[f.key] : '', f);
      if (!v[f.key] && !f.optional) fail(f.key, `请填写「${f.label}」。`);
      if (f.type === 'select' && v[f.key] && !f.options.some(([key]) => key !== '' && key === v[f.key])) fail(f.key, '请从列表里选一项。');
    }
    v.website = website(v.website, 'website');
    const emailParts = /^([^\s@<>()\[\]\\,;:"]+)@([^\s@<>()\[\]\\,;:"]+)$/.exec(v.email);
    let emailDomain;
    try { emailDomain = new URL(`https://${emailParts ? emailParts[2] : ''}`); } catch { fail('email', '请输入有效的邮箱地址。'); }
    if (!emailParts || emailParts[1].startsWith('.') || emailParts[1].endsWith('.') || emailParts[1].includes('..') ||
      emailDomain.pathname !== '/' || emailDomain.port || emailDomain.search || emailDomain.hash ||
      !emailDomain.hostname.includes('.') || !emailDomain.hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))) fail('email', '请输入有效的邮箱地址。');
    for (const key of ['returnsPolicyUrl', 'refundPolicyUrl']) if (v[key]) v[key] = website(v[key], key);
    if (v.policyLinks) v.policyLinks = v.policyLinks.split('\n').map(line => line.trim()).filter(Boolean).map(url => website(url, 'policyLinks')).join('\n');
    if (v.returnWindow) v.returnWindow = integer(v.returnWindow, 'returnWindow', 365);
    if (v.refundProcessing) v.refundProcessing = integer(v.refundProcessing, 'refundProcessing', 60);
    if (v.refundMethod === 'custom' && !v.refundMethodDetails) fail('refundMethodDetails', '请说明其他退款方式。');
    if (v.refundIncludesReturns === 'yes') for (const f of returnFields()) if (!v[f.key]) fail(f.key, `包含退货规则时，请填写「${f.label}」。`);
    if (v.returnAddressMode === 'provided' && !v.returnAddress) fail('returnAddress', '请填写退货地址，或选择其他提供方式。');
    if (v.cookieUse === 'yes' && !v.cookieDetails) fail('cookieDetails', '请填写 Cookie 用途与关闭方式。');
    for (const key of ['processingTime', 'transitTime']) if (v[key]) duration(v[key], key);
    return v;
  }
  const block = (heading, body) => `${heading}\n${body}`;
  const dayCount = (count, business = false) => `${count} ${business ? 'business ' : 'calendar '}${count === '1' ? 'day' : 'days'}`;
  const intro = v => `This policy explains the practices and rules of ${v.storeName} at ${v.website}.`;
  const contact = v => `For questions about this policy, contact ${v.storeName} at ${v.email}.`;
  function generate(id, values = {}) {
    const tool = tools.find(item => item.id === id);
    if (!tool) fail('id', '未知的政策模板。');
    if (values == null || typeof values !== 'object') fail('storeName', '请填写店铺资料。');
    const v = validate(tool, values);
    const warnings = [];
    if (Object.values(v).some(value => /[^\x00-\x7F\u00A0\u2000-\u206F\u20A0-\u20CF]/.test(value))) warnings.push('部分内容不是英文，正文会原样保留，请改为英文。');
    if (Object.values(v).some(value => /[<>]/.test(value))) warnings.push('内容中的 < 或 > 会按普通文字保留。');
    if (Object.values(v).some(value => /(?:example\.com|Example (?:Business|City|Region|Way)|example market)/i.test(value))) warnings.push('内容中仍有示例信息，请替换为你的店铺信息。');
    const pending = (message, english) => { warnings.push(message); return `[DRAFT: ${english}]`; };
    const returnsTerms = () => `For refunds involving returned goods, a return request must be made within ${dayCount(v.returnWindow)} of ${v.returnStart === 'delivery' ? 'delivery' : 'purchase'}.\n\nItem conditions:\n${v.returnConditions}\n\nReturn exclusions:\n${v.exclusions}`;
    let title, sections;
    if (id === 'F18') {
      title = 'Privacy Policy';
      let cookies;
      if (v.cookieUse === 'yes') cookies = v.cookieDetails;
      else if (v.cookieUse === 'no') cookies = 'We do not use cookies or similar tracking technologies on this storefront.';
      else cookies = pending('Cookie 使用情况、用途和关闭方式。', 'Confirm whether cookies or similar tracking technologies are used. Describe the actual purposes, providers, and available controls before publication.');
      sections = [intro(v), block('Store operator and contact', `${v.businessName}\n${v.address}\nEmail: ${v.email}`),
        block('Information collected', v.collectedData), block('How information is used', v.usePurposes),
        block('Service providers and information sharing', v.serviceProviders), block('Retention and deletion', v.retention),
        block('Cookies and similar technologies', cookies),
        block('Questions and requests about information', `Send questions or requests about your information to ${v.email}.\n${pending('顾客查看或删除个人信息的申请方式（按销售地区要求补充）。', 'Add the information-request process and any notices needed for the actual markets served. Do not publish this draft as a statement of compliance with every jurisdiction.')} `)];
    } else if (id === 'F19') {
      title = 'Refund Policy';
      const method = v.refundMethod === 'original' ? 'Approved refunds are issued to the original payment method.' : v.refundMethod === 'store-credit' ? 'Approved refunds are issued as store credit.' : v.refundMethodDetails;
      const returnLink = v.refundIncludesReturns !== 'yes' ? '' : v.returnsPolicyUrl ? `For the physical return process, see ${v.returnsPolicyUrl}` : pending('退换货政策链接。', 'Add the published Returns Policy URL describing how to request and send back a return.');
      sections = [intro(v), block('When a refund is available', v.refundEligibility), block('Refund amounts', v.refundAmountRule),
        ...(v.refundIncludesReturns === 'yes' ? [block('Refunds involving returned goods', `${returnsTerms()}\n\n${returnLink}`)] : []), block('Refund method', method),
        block('Review and store processing', `We review and process a refund request within ${dayCount(v.refundProcessing, true)} after receiving the complete information needed for that request. This is the store's review and processing period; it does not include the payment provider's posting time. A request is not an automatic refund approval.`),
        block('Payment-provider posting time', v.paymentArrival), block('Original delivery charges and fees', v.refundCosts),
        ...(v.refundIncludesReturns === 'yes' ? [block('Return shipping costs', v.returnShipping === 'customer' ? 'The customer is responsible for return shipping costs under the return rules stated above.' : 'The store is responsible for return shipping costs under the return rules stated above.')] : []),
        block('Contact', contact(v))];
    } else if (id === 'F20') {
      title = 'Terms and Conditions';
      const links = v.policyLinks || pending('其他政策的链接。', 'Add the actual published Privacy, Refund, Returns, and Shipping Policy URLs that apply to this store.');
      sections = [intro(v), block('Store operator', `${v.businessName} operates ${v.storeName}.\nWebsite: ${v.website}\nContact: ${v.email}`),
        block('Products and services covered', v.productScope), block('Markets served', v.salesMarkets), block('Order acceptance', v.orderAcceptance),
        block('Prices and payment', v.paymentRule), block('Fulfillment', v.fulfillmentRule), block('Order cancellation', v.cancellationRule),
        block('Related store policies', links), block('Questions', `Contact ${v.email} with the order number, where relevant, and a description of the question.`)];
    } else if (id === 'F21') {
      title = 'Returns and Exchanges Policy';
      let address;
      if (v.returnAddressMode === 'provided') address = `Use the following confirmed return address:\n${v.returnAddress}`;
      else if (v.returnAddressMode === 'on-request') address = `Contact ${v.email} before sending an item back. Once the return is approved, we provide the return address and instructions. The store's business address must not be assumed to be the return address.`;
      else address = pending('退货地址或提供方式。', 'Confirm the return address or the process for providing it after an approved request.');
      const refundLink = v.refundPolicyUrl ? `Refund amounts, refund methods, review periods, and payment-provider posting are described in our Refund Policy: ${v.refundPolicyUrl}` : pending('退款政策链接。', 'Add the actual Refund Policy URL for refund amounts, methods, review periods, and payment-provider posting.');
      sections = [intro(v), block('Return request window', `A return request must be made within ${dayCount(v.returnWindow)} of ${v.returnStart === 'delivery' ? 'delivery' : 'purchase'}.`),
        block('Item conditions', v.returnConditions), block('Return exclusions', v.exclusions),
        block('Start a return', `For information about starting a return, contact ${v.email}.\n\n${address}`),
        block('Return shipping costs', v.returnShipping === 'customer' ? 'The customer is responsible for return shipping costs under this policy.' : 'The store is responsible for return shipping costs under this policy.'),
        block('Exchanges', v.exchangeRule), block('Damaged or incorrect items', v.damagedItems), block('Refunds', refundLink), block('Contact', contact(v))];
    } else {
      title = 'Shipping Policy';
      sections = [intro(v), block('Delivery destinations', v.destinations), block('Order processing and dispatch', v.processingTime),
        block('Estimated transit time', `${v.transitTime}\nTransit estimates apply after dispatch and are separate from order processing. An estimate is not a guaranteed delivery date.`),
        block('Shipping charges', v.shippingFees), block('Import duties and taxes', v.duties), block('Unavailable and preorder items', v.stockOut),
        block('Tracking', v.tracking), block('Delays, missing parcels, and delivery issues', v.deliveryIssues), block('Contact', contact(v))];
    }
    return {title, text: `${title}\n\n${sections.join('\n\n')}`, warnings, version};
  }
  window.FreePolicies = {tools, sharedKeys, generate};
})();

// END APPROVED SOURCE
}

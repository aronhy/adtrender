import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { CopyResultButton } from './CopyResultButton';
import { ClientToolForm } from './ClientToolForm';
import { calculateLtv, calculateMargin, calculateProfit, calculateRoas, calculateRoi, calculateShopifyCost, type CalcResult } from './calculators';

type Field = { name: string; label: string; unit?: string; help?: string };
type ResultField = { name: string; label: string; unit?: '%' | '倍' };
type Calculator = {
  fields: Field[];
  example: Record<string, string>;
  calculate: (fields: Record<string, string>) => CalcResult;
  results: ResultField[];
  formula: string;
  note: ReactNode;
  billing?: boolean;
};

const contributionField: Field = { name: 'contributionMarginPct', label: '广告前贡献毛利率', unit: '%', help: '40 表示 40%。已扣商品、履约、支付等变动成本，未扣广告和固定费。' };
const revenueField: Field = { name: 'revenue', label: '销售净额', help: '已扣折扣与退款，不含代收税；请与成本使用同一期间。' };
const samePeriod = '请使用同一币种、同一期间的数据。结果仅根据已填写项目估算，未单列的费用不视为已计入。';

const calculators: Record<string, Calculator> = {
  'roas-calculator': {
    fields: [{ name: 'revenue', label: '归因收入', help: '与广告费采用相同归因口径与期间。' }, { name: 'adSpend', label: '广告费' }, contributionField],
    example: { revenue: '1000', adSpend: '250', contributionMarginPct: '40' },
    calculate: fields => calculateRoas({ revenue: fields.revenue, adSpend: fields.adSpend, contributionMarginPct: fields.contributionMarginPct }),
    results: [{ name: 'roas', label: '实际 ROAS', unit: '倍' }, { name: 'roasPct', label: 'ROAS 百分比', unit: '%' }, { name: 'breakEvenRoas', label: '盈亏平衡 ROAS', unit: '倍' }],
    formula: '实际 ROAS = 归因收入 ÷ 广告费；盈亏平衡 ROAS = 1 ÷ 广告前贡献毛利率。',
    note: <>{samePeriod} ROAS 不等于利润率。回本门槛未计固定费用，贡献率中不要重复扣广告费。</>,
  },
  'ecommerce-profit-calculator': {
    fields: [revenueField, { name: 'goods', label: '商品成本' }, { name: 'fulfillment', label: '履约与物流成本' }, { name: 'payment', label: '支付处理成本' }, { name: 'adSpend', label: '广告费' }, { name: 'other', label: '其他成本', help: '如需计入固定费用、税费等，请填写在此；避免与前面项目重复。' }],
    example: { revenue: '1000', goods: '400', fulfillment: '100', payment: '50', adSpend: '200', other: '50' },
    calculate: fields => calculateProfit({ revenue: fields.revenue, goods: fields.goods, fulfillment: fields.fulfillment, payment: fields.payment, adSpend: fields.adSpend, other: fields.other }),
    results: [{ name: 'profit', label: '预估利润' }, { name: 'totalCost', label: '已填写总成本' }],
    formula: '预估利润 = 销售净额 − 商品成本 − 履约与物流 − 支付处理 − 广告费 − 其他成本。',
    note: <>{samePeriod} 每项成本只扣一次；负数表示预估亏损。没有该项费用时请明确填写 0。</>,
  },
  'profit-margin-calculator': {
    fields: [revenueField, { name: 'cost', label: '总成本', help: '填写本期希望计入的全部成本，避免重复相加。' }],
    example: { revenue: '1000', cost: '800' },
    calculate: fields => calculateMargin({ revenue: fields.revenue, cost: fields.cost }),
    results: [{ name: 'marginPct', label: '利润率', unit: '%' }, { name: 'profit', label: '预估利润' }],
    formula: '利润 = 销售净额 − 总成本；利润率 = 利润 ÷ 销售净额 × 100%。',
    note: <>{samePeriod} 利润率以销售净额为分母；加价率以成本为分母，两者不同。销售净额须大于 0。</>,
  },
  'roi-calculator': {
    fields: [{ name: 'returns', label: '总收益', help: '填写尚未扣除本次投入的总收益。不要填已经扣成本的净收益。' }, { name: 'cost', label: '总投入' }],
    example: { returns: '1000', cost: '800' },
    calculate: fields => calculateRoi({ returns: fields.returns, cost: fields.cost }),
    results: [{ name: 'roiPct', label: 'ROI', unit: '%' }, { name: 'netReturn', label: '净增收益' }],
    formula: '净增收益 = 总收益 − 总投入；ROI = 净增收益 ÷ 总投入 × 100%。',
    note: <>{samePeriod} 总投入只扣一次，须大于 0。负 ROI 表示收益低于投入。</>,
  },
  'customer-lifetime-value-calculator': {
    fields: [{ name: 'aov', label: '平均客单价' }, { name: 'purchasesPerYear', label: '每年购买次数', unit: '次/年', help: '仅接受年频次；若掌握每月频次，请先换算为每年次数。' }, { name: 'lifetimeYears', label: '客户年限', unit: '年', help: '使用年作为单位，例如 6 个月填写 0.5。' }, contributionField],
    example: { aov: '50', purchasesPerYear: '3', lifetimeYears: '2', contributionMarginPct: '40' },
    calculate: fields => calculateLtv({ aov: fields.aov, purchasesPerYear: fields.purchasesPerYear, lifetimeYears: fields.lifetimeYears, contributionMarginPct: fields.contributionMarginPct }),
    results: [{ name: 'revenueLtv', label: '收入 LTV' }, { name: 'contributionLtv', label: '贡献 LTV' }],
    formula: '收入 LTV = 客单价 × 每年购买次数 × 客户年限；贡献 LTV = 收入 LTV × 广告前贡献毛利率。',
    note: <>这是基于用户假设的估算，不是实际订单预测，也不等于净利润。贡献 LTV 未扣广告与固定费用；所有金额须使用同一币种。示例为合成数据，不是行业推荐值。</>,
  },
  'shopify-cost-calculator': {
    billing: true,
    fields: [{ name: 'subscriptionAmount', label: '订阅费用', help: '按所选账期填写实际报价或账单金额。' }, { name: 'appsMonthly', label: '应用费用', unit: '/月' }, { name: 'domainAnnual', label: '域名费用', unit: '/年' }, { name: 'oneOff', label: '一次性支出', help: '例如主题购买费；单列并仅加入首年总预算。没有则填 0。' }],
    example: { subscriptionAmount: '360', billing: 'annual', appsMonthly: '20', domainAnnual: '12', oneOff: '0' },
    calculate: fields => calculateShopifyCost({ subscriptionAmount: fields.subscriptionAmount, billing: fields.billing as 'monthly' | 'annual', appsMonthly: fields.appsMonthly, domainAnnual: fields.domainAnnual, oneOff: fields.oneOff }),
    results: [{ name: 'monthlyBudget', label: '月度预算' }, { name: 'annualBudget', label: '年度预算' }, { name: 'oneOff', label: '一次性支出' }, { name: 'firstYearBudget', label: '首年总预算' }],
    formula: '年度预算 = 年订阅费用（或月费 × 12）+ 每月应用费 × 12 + 年域名费；月度预算 = 年度预算 ÷ 12；首年总预算 = 年度预算 + 一次性支出。',
    note: <>月度预算是年费用分摊，并非实际月账单。预算默认不含交易处理费、税费和未填写费用；所有金额须使用同一币种。示例不是 Shopify 官方报价。请从 <a href="https://www.shopify.com/pricing" target="_blank" rel="noopener noreferrer">Shopify 官方价格页</a>或账单填写；<a href="https://help.shopify.com/en/manual/payments/shopify-payments/onboarding/cost-of-shopify-payments" target="_blank" rel="noopener noreferrer">支付处理费</a>另行核算。</>,
  },
};

function CalculatorForm({ calculator }: { calculator: Calculator }) {
  const prefix = useId();
  const form = useRef<HTMLFormElement>(null);
  const emptyFields = () => ({ ...Object.fromEntries(calculator.fields.map(field => [field.name, ''])), ...(calculator.billing ? { billing: 'annual' } : {}) });
  const [fields, setFields] = useState<Record<string, string>>(emptyFields);
  const [currency, setCurrency] = useState('USD');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [values, setValues] = useState<Record<string, string> | null>(null);
  const [status, setStatus] = useState('');

  function edit(name: string, value: string) {
    setFields(previous => ({ ...previous, [name]: value }));
    setValues(null);
    setErrors(previous => { const next = { ...previous }; delete next[name]; return next; });
    setStatus('输入已修改，请重新计算。');
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const calculated = calculator.calculate(fields);
    if (!calculated.ok) {
      setValues(null);
      setErrors(calculated.fieldErrors);
      setStatus('请检查标记的字段后重新计算。');
      const firstField = calculator.fields.find(field => calculated.fieldErrors[field.name])?.name ?? Object.keys(calculated.fieldErrors)[0];
      const element = form.current?.elements.namedItem(firstField);
      if (element instanceof HTMLElement) element.focus();
      return;
    }
    setErrors({});
    setValues(calculated.values);
    setStatus('计算完成。');
  }
  function reset() {
    setFields(emptyFields());
    setCurrency('USD');
    setErrors({});
    setValues(null);
    setStatus('已重置。');
  }
  const resultText = values ? calculator.results.map(item => `${item.label}：${values[item.name]}${item.unit ?? ` ${currency}`}`).join('\n') : '';

  return <>
    <div className="tool-workbench" data-clarity-mask="true">
      <ClientToolForm ref={form} className="tool-form" onSubmit={submit} noValidate>
        <div className="tool-field tool-currency">
          <label htmlFor={`${prefix}-currency`}>金额币种</label>
          <select id={`${prefix}-currency`} value={currency} onChange={event => { setCurrency(event.target.value); setValues(null); setStatus('币种标记已修改，请重新计算。'); }} aria-describedby={`${prefix}-currency-note`}>
            {['USD', 'CNY', 'EUR', 'GBP'].map(code => <option key={code} value={code}>{code}</option>)}
          </select>
          <small id={`${prefix}-currency-note`}>仅标记金额格式，不做汇率换算；所有金额须使用同一币种。</small>
        </div>
        {calculator.billing && <div className="tool-field">
          <label htmlFor={`${prefix}-billing`}>订阅账期</label>
          <select id={`${prefix}-billing`} name="billing" value={fields.billing} onChange={event => edit('billing', event.target.value)}>
            <option value="annual">按年付费（填写年费）</option><option value="monthly">按月付费（填写月费）</option>
          </select>
        </div>}
        <p className="tool-note" id={`${prefix}-input-note`}>所有字段必填；没有的成本请填 0。最多 12 位整数、4 位小数，不接受负金额或指数写法。</p>
        <div className="tool-grid">
          {calculator.fields.map(field => {
            const id = `${prefix}-${field.name}`;
            const help = field.name === 'subscriptionAmount' ? `${field.help} 当前填写${fields.billing === 'annual' ? '年费' : '月费'}。` : field.help;
            const description = [`${prefix}-input-note`, ...(help ? [`${id}-help`] : []), ...(errors[field.name] ? [`${id}-error`] : [])].join(' ');
            return <div className="tool-field" key={field.name}>
              <label htmlFor={id}>{field.label}{field.unit ? `（${field.unit}）` : ''}</label>
              <input id={id} name={field.name} type="text" inputMode="decimal" autoComplete="off" spellCheck={false} value={fields[field.name]} onChange={event => edit(field.name, event.target.value)} aria-invalid={errors[field.name] ? true : undefined} aria-describedby={description} required />
              {help && <small id={`${id}-help`}>{help}</small>}
              {errors[field.name] && <p className="tool-error" id={`${id}-error`}>{errors[field.name]}</p>}
            </div>;
          })}
        </div>
        <div className="tool-actions">
          <button type="submit" className="tool-primary">计算</button>
          <button type="button" onClick={() => { setFields({ ...calculator.example }); setErrors({}); setValues(null); setStatus('已填入合成示例，请点击计算。'); }}>填入示例</button>
          <button type="button" onClick={reset}>重置</button>
        </div>
        <p className="tool-note" role="status" aria-live="polite" aria-atomic="true">{status}</p>
      </ClientToolForm>
      <section aria-label="计算结果">
        {values ? <div className="tool-results" aria-live="polite" aria-atomic="true">
          <h2>计算结果</h2>
          <dl>{calculator.results.map(item => <div className="tool-result" key={item.name}>
            <dt>{item.label}</dt><dd><strong className="tool-result-value">{values[item.name]}</strong> <span>{item.unit ?? currency}</span></dd>
          </div>)}</dl>
          <div className="tool-actions"><CopyResultButton text={resultText} label="复制结果" /></div>
        </div> : <div className="tool-result tool-note"><h2>等待计算</h2><p>{status || '填写自己的数据，或点击“填入示例”试算。'}</p>{calculator.billing && <p>结果包含月度预算、年度预算、一次性支出与首年总预算。</p>}</div>}
      </section>
    </div>
    <section className="tool-formula" aria-label="计算口径">
      <h2>计算口径</h2><p>{calculator.formula}</p><p className="tool-note">{calculator.note}</p>
      <p className="tool-note">计算在当前浏览器内完成；金额不会保存到浏览器长期存储。</p>
    </section>
  </>;
}

export function CalculatorTool({ slug }: { slug: string }) {
  const calculator = Object.hasOwn(calculators, slug) ? calculators[slug] : undefined;
  return calculator ? <CalculatorForm key={slug} calculator={calculator} /> : <p>未找到此计算器。</p>;
}

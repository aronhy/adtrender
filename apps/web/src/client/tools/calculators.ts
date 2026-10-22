import Big from 'big.js';

export type CalcResult =
  | { ok: true; values: Record<string, string> }
  | { ok: false; fieldErrors: Record<string, string> };

// Keep calculator precision local; do not alter the library defaults for other consumers.
const Decimal = Big();
Decimal.DP = 80;
Decimal.RM = Big.roundHalfUp;
const decimalPattern = /^\d{1,12}(?:\.\d{1,4})?$/;

function parseFields<T extends string>(input: Record<T, string>, fields: readonly T[]) {
  const amounts = {} as Record<T, Big>;
  const fieldErrors: Record<string, string> = {};
  for (const field of fields) {
    const value = typeof input[field] === 'string' ? input[field].trim() : '';
    if (!value) fieldErrors[field] = '请填写数值；没有此项费用时请填写 0。';
    else if (!decimalPattern.test(value)) fieldErrors[field] = '请输入非负十进制数，最多 12 位整数和 4 位小数。';
    else amounts[field] = new Decimal(value);
  }
  return { amounts, fieldErrors };
}

function result(fieldErrors: Record<string, string>, calculate: () => Record<string, Big>): CalcResult {
  if (Object.keys(fieldErrors).length) return { ok: false, fieldErrors };
  return { ok: true, values: Object.fromEntries(Object.entries(calculate()).map(([key, amount]) => [key, amount.toFixed(2)])) };
}

function requirePositive(amount: Big | undefined, field: string, fieldErrors: Record<string, string>) {
  if (amount?.eq(0)) fieldErrors[field] = '此项须大于 0，不能作为零分母。';
}

function validateContribution(amount: Big | undefined, fieldErrors: Record<string, string>) {
  if (amount?.gt(100)) fieldErrors.contributionMarginPct = '广告前贡献毛利率不能超过 100%。';
}

export function calculateRoas(input: { revenue: string; adSpend: string; contributionMarginPct: string }): CalcResult {
  const { amounts: a, fieldErrors } = parseFields(input, ['revenue', 'adSpend', 'contributionMarginPct']);
  requirePositive(a.adSpend, 'adSpend', fieldErrors);
  validateContribution(a.contributionMarginPct, fieldErrors);
  // A negative margin is not a meaningful break-even target, even if other fields are valid.
  const rawMargin = input.contributionMarginPct?.trim();
  if (a.contributionMarginPct?.eq(0) || /^-\d{1,12}(?:\.\d{1,4})?$/.test(rawMargin)) {
    fieldErrors.contributionMarginPct = '广告前贡献毛利率须大于 0%；当前成本结构无法回本。';
  }
  return result(fieldErrors, () => ({
    roas: a.revenue.div(a.adSpend),
    roasPct: a.revenue.times(100).div(a.adSpend),
    breakEvenRoas: new Decimal(100).div(a.contributionMarginPct),
  }));
}

export function calculateProfit(input: { revenue: string; goods: string; fulfillment: string; payment: string; adSpend: string; other: string }): CalcResult {
  const costFields = ['goods', 'fulfillment', 'payment', 'adSpend', 'other'] as const;
  const { amounts: a, fieldErrors } = parseFields(input, ['revenue', ...costFields]);
  return result(fieldErrors, () => {
    const totalCost = costFields.reduce((sum, field) => sum.plus(a[field]), new Decimal(0));
    return { totalCost, profit: a.revenue.minus(totalCost) };
  });
}

export function calculateMargin(input: { revenue: string; cost: string }): CalcResult {
  const { amounts: a, fieldErrors } = parseFields(input, ['revenue', 'cost']);
  requirePositive(a.revenue, 'revenue', fieldErrors);
  return result(fieldErrors, () => ({ profit: a.revenue.minus(a.cost), marginPct: a.revenue.minus(a.cost).times(100).div(a.revenue) }));
}

export function calculateRoi(input: { returns: string; cost: string }): CalcResult {
  const { amounts: a, fieldErrors } = parseFields(input, ['returns', 'cost']);
  requirePositive(a.cost, 'cost', fieldErrors);
  return result(fieldErrors, () => ({ netReturn: a.returns.minus(a.cost), roiPct: a.returns.minus(a.cost).times(100).div(a.cost) }));
}

export function calculateLtv(input: { aov: string; purchasesPerYear: string; lifetimeYears: string; contributionMarginPct: string }): CalcResult {
  const { amounts: a, fieldErrors } = parseFields(input, ['aov', 'purchasesPerYear', 'lifetimeYears', 'contributionMarginPct']);
  validateContribution(a.contributionMarginPct, fieldErrors);
  return result(fieldErrors, () => {
    const revenueLtv = a.aov.times(a.purchasesPerYear).times(a.lifetimeYears);
    return { revenueLtv, contributionLtv: revenueLtv.times(a.contributionMarginPct).div(100) };
  });
}

export function calculateShopifyCost(input: { subscriptionAmount: string; billing: 'monthly' | 'annual'; appsMonthly: string; domainAnnual: string; oneOff: string }): CalcResult {
  const { amounts: a, fieldErrors } = parseFields(input, ['subscriptionAmount', 'appsMonthly', 'domainAnnual', 'oneOff']);
  if (input.billing !== 'monthly' && input.billing !== 'annual') fieldErrors.billing = '请选择按月或按年订阅。';
  return result(fieldErrors, () => {
    const annualSubscription = input.billing === 'monthly' ? a.subscriptionAmount.times(12) : a.subscriptionAmount;
    const annualBudget = annualSubscription.plus(a.appsMonthly.times(12)).plus(a.domainAnnual);
    return { monthlyBudget: annualBudget.div(12), annualBudget, oneOff: a.oneOff, firstYearBudget: annualBudget.plus(a.oneOff) };
  });
}

import { describe, expect, it } from 'vitest';
import { calculateLtv, calculateMargin, calculateProfit, calculateRoas, calculateRoi, calculateShopifyCost, type CalcResult } from './calculators';

function values(result: CalcResult) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(`Unexpected validation: ${JSON.stringify(result.fieldErrors)}`);
  return result.values;
}
function fieldError(result: CalcResult, field: string) {
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Expected field error');
  expect(result.fieldErrors[field]).toBeTruthy();
}
const profitInput = { revenue: '1000', goods: '400', fulfillment: '100', payment: '50', adSpend: '200', other: '50' };
const ltvInput = { aov: '50', purchasesPerYear: '3', lifetimeYears: '2', contributionMarginPct: '40' };
const shopifyInput = { subscriptionAmount: '360', billing: 'annual' as const, appsMonthly: '20', domainAnnual: '12', oneOff: '0' };

describe('ROAS and break-even ROAS', () => {
  it('keeps actual return and the pre-ad-cost break-even threshold separate', () => {
    expect(values(calculateRoas({ revenue: '1000', adSpend: '250', contributionMarginPct: '40' }))).toEqual({ roas: '4.00', roasPct: '400.00', breakEvenRoas: '2.50' });
  });
  it('allows zero revenue', () => {
    expect(values(calculateRoas({ revenue: '0', adSpend: '250', contributionMarginPct: '40' })).roas).toBe('0.00');
  });
  it('rejects a zero advertising denominator', () => fieldError(calculateRoas({ revenue: '1000', adSpend: '0', contributionMarginPct: '40' }), 'adSpend'));
  it.each(['0', '-1'])('does not report a negative or infinite break-even threshold for margin %s', margin => {
    const result = calculateRoas({ revenue: '1000', adSpend: '250', contributionMarginPct: margin });
    fieldError(result, 'contributionMarginPct');
    if (!result.ok) expect(result.fieldErrors.contributionMarginPct).toContain('无法回本');
  });
  it('rejects a contribution rate over 100 percent', () => fieldError(calculateRoas({ revenue: '1000', adSpend: '250', contributionMarginPct: '100.0001' }), 'contributionMarginPct'));
  it('rounds only the final ratio', () => {
    expect(values(calculateRoas({ revenue: '1', adSpend: '6', contributionMarginPct: '30' }))).toEqual({ roas: '0.17', roasPct: '16.67', breakEvenRoas: '3.33' });
  });
});

describe('profit, profit margin and ROI', () => {
  it('subtracts each entered cost exactly once', () => expect(values(calculateProfit(profitInput))).toEqual({ totalCost: '800.00', profit: '200.00' }));
  it('keeps a loss signed', () => expect(values(calculateProfit({ ...profitInput, goods: '800' }))).toEqual({ totalCost: '1200.00', profit: '-200.00' }));
  it('sums decimal costs without binary floating point error', () => {
    expect(values(calculateProfit({ revenue: '0.3', goods: '0.1', fulfillment: '0.2', payment: '0', adSpend: '0', other: '0' }))).toEqual({ totalCost: '0.30', profit: '0.00' });
  });
  it('preserves small costs when adding them to 12-digit amounts', () => {
    expect(values(calculateProfit({ revenue: '999999999999.9999', goods: '999999999999.9949', fulfillment: '0', payment: '0', adSpend: '0', other: '0' })).profit).toBe('0.01');
  });
  it('allows an explicitly zero sales period when computing profit', () => expect(values(calculateProfit({ ...profitInput, revenue: '0' })).profit).toBe('-800.00'));
  it('computes margin against sales instead of markup against cost', () => expect(values(calculateMargin({ revenue: '1000', cost: '800' }))).toEqual({ profit: '200.00', marginPct: '20.00' }));
  it('keeps negative margins', () => expect(values(calculateMargin({ revenue: '1000', cost: '1200' })).marginPct).toBe('-20.00'));
  it('rejects zero sales for a margin denominator', () => fieldError(calculateMargin({ revenue: '0', cost: '800' }), 'revenue'));
  it('computes ROI from total returns less investment exactly once', () => expect(values(calculateRoi({ returns: '1000', cost: '800' }))).toEqual({ netReturn: '200.00', roiPct: '25.00' }));
  it('keeps a negative ROI', () => expect(values(calculateRoi({ returns: '600', cost: '800' })).roiPct).toBe('-25.00'));
  it('allows zero total returns', () => expect(values(calculateRoi({ returns: '0', cost: '800' })).roiPct).toBe('-100.00'));
  it('rejects zero investment', () => fieldError(calculateRoi({ returns: '1000', cost: '0' }), 'cost'));
  it('does not round net returns before calculating ROI', () => expect(values(calculateRoi({ returns: '0.015', cost: '0.01' }))).toEqual({ netReturn: '0.01', roiPct: '50.00' }));
});

describe('annual-assumption LTV', () => {
  it('separates revenue LTV from contribution LTV', () => expect(values(calculateLtv(ltvInput))).toEqual({ revenueLtv: '300.00', contributionLtv: '120.00' }));
  it.each(['aov', 'purchasesPerYear', 'lifetimeYears', 'contributionMarginPct'])('requires the explicit %s assumption', key => fieldError(calculateLtv({ ...ltvInput, [key]: '' }), key));
  it('allows an explicit zero contribution assumption', () => expect(values(calculateLtv({ ...ltvInput, contributionMarginPct: '0' })).contributionLtv).toBe('0.00'));
  it('accepts fractional annual frequency and lifetime', () => expect(values(calculateLtv({ aov: '0.1', purchasesPerYear: '0.2', lifetimeYears: '0.5', contributionMarginPct: '50' }))).toEqual({ revenueLtv: '0.01', contributionLtv: '0.01' }));
  it('retains precision for products that exceed Number safe integers', () => expect(values(calculateLtv({ aov: '999999999999.9999', purchasesPerYear: '999999999999.9999', lifetimeYears: '1', contributionMarginPct: '100' })).revenueLtv).toBe('999999999999999800000000.00'));
  it('rejects a contribution rate over 100 percent', () => fieldError(calculateLtv({ ...ltvInput, contributionMarginPct: '101' }), 'contributionMarginPct'));
});

describe('Shopify subscription budget', () => {
  it('spreads annual subscription and domain cost over 12 months', () => expect(values(calculateShopifyCost(shopifyInput))).toEqual({ monthlyBudget: '51.00', annualBudget: '612.00', oneOff: '0.00', firstYearBudget: '612.00' }));
  it('keeps one-time expenses out of recurring budgets', () => expect(values(calculateShopifyCost({ ...shopifyInput, oneOff: '100' }))).toEqual({ monthlyBudget: '51.00', annualBudget: '612.00', oneOff: '100.00', firstYearBudget: '712.00' }));
  it('uses the selected monthly billing period', () => expect(values(calculateShopifyCost({ ...shopifyInput, subscriptionAmount: '30', billing: 'monthly' }))).toEqual({ monthlyBudget: '51.00', annualBudget: '612.00', oneOff: '0.00', firstYearBudget: '612.00' }));
  it('does not reconstruct the annual budget from rounded monthly values', () => expect(values(calculateShopifyCost({ subscriptionAmount: '1', billing: 'annual', appsMonthly: '0', domainAnnual: '0', oneOff: '0' }))).toEqual({ monthlyBudget: '0.08', annualBudget: '1.00', oneOff: '0.00', firstYearBudget: '1.00' }));
  it('rejects unsupported billing periods', () => fieldError(calculateShopifyCost({ ...shopifyInput, billing: 'weekly' as 'annual' }), 'billing'));
  it('allows explicitly zero budgets', () => expect(values(calculateShopifyCost({ subscriptionAmount: '0', billing: 'monthly', appsMonthly: '0', domainAnnual: '0', oneOff: '0' })).annualBudget).toBe('0.00'));
});

describe('decimal input boundaries', () => {
  it.each(['', ' ', '-1', '-0', 'NaN', 'Infinity', '1e3', '0x10', '1,000', '1.00001', '1000000000000', '.5', '1.', '<script>1</script>'])('rejects invalid decimal input %j with a field error', cost => fieldError(calculateRoi({ returns: '1000', cost }), 'cost'));
  it('accepts the maximum precision and surrounding whitespace', () => expect(calculateRoi({ returns: ' 999999999999.9999 ', cost: '0.0001' }).ok).toBe(true));
  it.each(['goods', 'fulfillment', 'payment', 'adSpend', 'other'])('requires an explicit cost instead of silently omitting %s', key => fieldError(calculateProfit({ ...profitInput, [key]: '' }), key));
  it('reports all invalid fields in one response', () => {
    const result = calculateMargin({ revenue: '', cost: '-1' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.fieldErrors)).toEqual(['revenue', 'cost']);
  });
});

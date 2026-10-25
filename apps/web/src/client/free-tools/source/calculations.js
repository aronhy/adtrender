// Source copied verbatim from the approved HTML prototype. See provenance.json.
export default function initialize(window, document, location, requestAnimationFrame, cancelAnimationFrame, setTimeout, clearTimeout) {
// BEGIN APPROVED SOURCE
/* Public prototype math. Classic script; no network, storage, or dependencies.
 * calculate('F01', values) -> { primary, metrics, note }
 * Each metric has { label, value, unit, exact }:
 *   value: plain decimal string (up to 80 places for repeating fractions).
 *   exact: reduced "numerator/denominator", without intermediate rounding.
 * format(metric.exact || metric.value, { decimals: 2, group: true })
 * Supported format options: decimals (0..12), group, ceil, small.
 * Units: money / percent / multiple / count / plain. Add symbols in the UI.
 * Invalid input throws Error with error.field identifying the input key.
 */
(function (global) {
  'use strict';

  function fail(field, message) {
    var error = new Error(message);
    error.field = field;
    throw error;
  }

  function abs(value) { return value < 0n ? -value : value; }
  function gcd(a, b) {
    a = abs(a); b = abs(b);
    while (b) { var remainder = a % b; a = b; b = remainder; }
    return a || 1n;
  }

  class Rational {
    constructor(numerator, denominator) {
      var n = BigInt(numerator);
      var d = denominator === undefined ? 1n : BigInt(denominator);
      if (!d) fail('value', '除数不能为 0。');
      if (d < 0n) { n = -n; d = -d; }
      var divisor = gcd(n, d);
      this.n = n / divisor;
      this.d = d / divisor;
    }
    add(other) { return new Rational(this.n * other.d + other.n * this.d, this.d * other.d); }
    sub(other) { return new Rational(this.n * other.d - other.n * this.d, this.d * other.d); }
    mul(other) { return new Rational(this.n * other.n, this.d * other.d); }
    div(other) { return new Rational(this.n * other.d, this.d * other.n); }
    ceil() {
      return new Rational(this.n >= 0n ? (this.n + this.d - 1n) / this.d : this.n / this.d);
    }
    exact() { return this.n.toString() + '/' + this.d.toString(); }
    decimal() {
      var n = abs(this.n);
      var whole = (n / this.d).toString();
      var remainder = n % this.d;
      var fraction = '';
      for (var index = 0; remainder && index < 80; index += 1) {
        remainder *= 10n;
        fraction += (remainder / this.d).toString();
        remainder %= this.d;
      }
      fraction = fraction.replace(/0+$/, '');
      return (this.n < 0n ? '-' : '') + whole + (fraction ? '.' + fraction : '');
    }
  }

  function integer(value) { return new Rational(BigInt(value)); }
  var ZERO = integer(0);
  var HUNDRED = integer(100);
  var TWELVE = integer(12);

  function input(values, field, options) {
    options = options || {};
    var raw = values[field];
    if (raw === undefined && options.defaultValue !== undefined) raw = options.defaultValue;
    if ((raw === null || String(raw).trim() === '') && options.emptyDefault !== undefined) raw = options.emptyDefault;
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      fail(field, '请填写数值，没有可填 0。');
    }
    if (typeof raw !== 'string' && typeof raw !== 'number') fail(field, '请输入数字。');
    var text = String(raw).trim();
    if (!/^\d{1,12}(?:\.\d{1,4})?$/.test(text)) {
      fail(field, '请填 0 或正数，最多 4 位小数。');
    }
    var parts = text.split('.');
    var scale = parts[1] ? 10n ** BigInt(parts[1].length) : 1n;
    var amount = new Rational(BigInt(parts[0] + (parts[1] || '')), scale);
    if (options.positive && amount.n === 0n) fail(field, '必须大于 0。');
    if (options.integer && amount.d !== 1n) fail(field, '请填写整数。');
    if (options.percent && amount.n > amount.d * 100n) fail(field, '百分比不能超过 100%。');
    if (options.days && (amount.d !== 1n || amount.n < 1n || amount.n > 365n)) {
      fail(field, '天数请填 1 到 365 之间的整数。');
    }
    return amount;
  }

  function metric(label, value, unit) {
    return { label: label, value: value.decimal(), unit: unit, exact: value.exact() };
  }
  function result(primary, metrics, note) {
    return { primary: primary, metrics: metrics, note: note || '币种仅用于显示，不做汇率换算。' };
  }

  function calculate(id, values) {
    values = values || {};
    id = String(id).toUpperCase();
    var read = function (key, options) { return input(values, key, options); };
    var revenue, cost, profit, margin, aov, days, cvr, cpa;

    switch (id) {
      case 'F01': {
        revenue = read('revenue');
        var adSpend = read('adSpend', { positive: true });
        margin = read('margin', { positive: true, percent: true });
        var roas = revenue.div(adSpend);
        return result(metric('实际 ROAS', roas, 'multiple'), [
          metric('ROAS 百分比', roas.mul(HUNDRED), 'percent'),
          metric('盈亏平衡 ROAS', HUNDRED.div(margin), 'multiple')
        ], '回本 ROAS 只考虑变动成本，不含固定成本，达到它不代表整店盈利。');
      }
      case 'F02': {
        revenue = read('revenue');
        cost = ['cogs', 'fulfillment', 'payment', 'adSpend', 'other'].reduce(function (sum, key) {
          return sum.add(read(key));
        }, ZERO);
        return result(metric('预估利润', revenue.sub(cost), 'money'), [
          metric('总成本', cost, 'money')
        ], '各项成本需为同一时间段，未填写的成本不会自动计入。');
      }
      case 'F03': {
        revenue = read('revenue', { positive: true });
        cost = read('cost');
        profit = revenue.sub(cost);
        return result(metric('销售利润率', profit.div(revenue).mul(HUNDRED), 'percent'), [
          metric('预估利润', profit, 'money')
        ], '利润率是除以销售额，不是除以成本。');
      }
      case 'F04': {
        var returns = read('returns');
        var investment = read('investment', { positive: true });
        profit = returns.sub(investment);
        return result(metric('ROI 投资回报率', profit.div(investment).mul(HUNDRED), 'percent'), [
          metric('净增收益', profit, 'money')
        ], '回收额为收回的总金额，不要先扣除投入。');
      }
      case 'F05': {
        aov = read('aov');
        var frequency = read('frequency');
        var years = read('years');
        margin = read('margin', { percent: true });
        var revenueLtv = aov.mul(frequency).mul(years);
        return result(metric('收入 LTV', revenueLtv, 'money'), [
          metric('贡献 LTV', revenueLtv.mul(margin).div(HUNDRED), 'money')
        ], '简化估算，未考虑折现、客户流失和获客成本。收入 LTV 不等于可承受的 CPA 上限。');
      }
      case 'F06': {
        var period = values.period === undefined ? 'month' : values.period;
        if (period !== 'month' && period !== 'year') fail('period', '请选月付或年付。');
        var subscription = read('subscription');
        var apps = read('apps');
        var domain = read('domain');
        var oneTime = read('oneTime');
        var annual = (period === 'month' ? subscription.mul(TWELVE) : subscription)
          .add(apps.mul(TWELVE)).add(domain);
        return result(metric('首年总预算', annual.add(oneTime), 'money'), [
          metric('月均', annual.div(TWELVE), 'money'),
          metric('每年固定开销', annual, 'money'),
          metric('一次性支出', oneTime, 'money')
        ], '按你填写的价格计算。月均为平摊金额，不是每月实际扣款，不含交易手续费。');
      }
      case 'F09': {
        var mode = values.mode === undefined ? 'actual' : values.mode;
        var metrics = [];
        if (mode === 'actual') {
          var spend = read('spend');
          var conversions = read('conversions', { positive: true, integer: true });
          cpa = spend.div(conversions);
          metrics.push(metric('广告花费', spend, 'money'), metric('转化次数', conversions, 'count'));
        } else if (mode === 'estimate') {
          var cpc = read('cpc');
          cvr = read('cvr', { positive: true, percent: true });
          cpa = cpc.mul(HUNDRED).div(cvr);
          metrics.push(metric('每次点击成本', cpc, 'money'), metric('点击转化率', cvr, 'percent'));
        } else fail('mode', '请选一种计算方式。');
        var note = mode === 'actual' ? '花费和转化数需来自同一时间段、同一转化事件。' : '此处转化率指点击到转化，不是落地页访问到转化。';
        if (values.target !== undefined && values.target !== null && String(values.target).trim() !== '') {
          var target = read('target', { positive: true });
          var difference = cpa.sub(target);
          metrics.push(metric('目标 CPA', target, 'money'));
          metrics.push(metric('和目标差多少（CPA − 目标）', difference, 'money'));
          metrics.push(metric('偏离目标', difference.div(target).mul(HUNDRED), 'percent'));
          note += difference.n === 0n ? ' 正好等于目标。' : difference.n < 0n ? ' 比目标低。' : ' 比目标高。';
        }
        return result(metric(mode === 'actual' ? '实际 CPA（每次转化）' : '推算 CPA（每次转化）', cpa, 'money'), metrics, note);
      }
      case 'F10': {
        var targetProfit = read('target', { positive: true });
        days = read('days', { defaultValue: '30', days: true });
        aov = read('aov', { positive: true });
        var unitCost = read('unitCost');
        cpa = read('cpa');
        cvr = read('cvr', { positive: true, percent: true });
        var fixed = read('fixed', { defaultValue: '0', emptyDefault: '0' });
        var contribution = aov.sub(unitCost).sub(cpa);
        if (contribution.n <= 0n) fail('aov', '客单价低于单均成本与广告成本之和，每单亏损，无法达到利润目标。请调整客单价或成本。');
        var orders = targetProfit.add(fixed).div(contribution).ceil();
        var visits = orders.mul(HUNDRED).div(cvr).ceil();
        return result(metric('需要的访问量', visits, 'count'), [
          metric('需要的订单', orders, 'count'),
          metric('每单赚', contribution, 'money'),
          metric('预计收入', orders.mul(aov), 'money'),
          metric('广告花费', orders.mul(cpa), 'money'),
          metric('实际能赚', orders.mul(contribution).sub(fixed), 'money'),
          metric('每天订单', orders.div(days), 'plain'),
          metric('每天访问', visits.div(days).ceil(), 'count'),
          metric('周期天数', days, 'count')
        ], '假设客单价、成本和转化率不变。访问量指访问次数，不是独立访客。');
      }
      case 'F11': {
        var targetOrders = read('orders', { positive: true, integer: true });
        days = read('days', { defaultValue: '30', days: true });
        var cpm = read('cpm', { positive: true });
        var ctr = read('ctr', { positive: true, percent: true });
        cvr = read('cvr', { positive: true, percent: true });
        var clicks = targetOrders.mul(HUNDRED).div(cvr);
        var impressions = clicks.mul(HUNDRED).div(ctr);
        var budget = impressions.div(integer(1000)).mul(cpm);
        return result(metric('总预算', budget, 'money'), [
          metric('每天预算', budget.div(days), 'money'),
          metric('需要的点击', clicks.ceil(), 'count'),
          metric('需要的展示', impressions.ceil(), 'count'),
          metric('折算 CPC', budget.div(clicks), 'money'),
          metric('折算 CPA', budget.div(targetOrders), 'money'),
          metric('目标订单', targetOrders, 'count'),
          metric('周期天数', days, 'count')
        ], '点击和展示数向上取整，预算按精确值计算。不含税费、服务费和素材费，实际订单量取决于投放效果。');
      }
      default: fail('id', '不支持此计算器。');
    }
  }

  function displayValue(value) {
    if (value instanceof Rational) return value;
    if (value && typeof value === 'object' && value.exact) value = value.exact;
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') fail('value', '无法格式化此数值。');
    var text = String(value).trim();
    var fraction = /^(-?\d+)\/(\d+)$/.exec(text);
    if (fraction) return new Rational(fraction[1], fraction[2]);
    var decimal = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
    if (!decimal) fail('value', '无法格式化此数值。');
    var exponent = Number(decimal[4] || 0);
    if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 400) fail('value', '数值超出格式化范围。');
    var digits = (decimal[3] || '').length - exponent;
    var numerator = BigInt(decimal[2] + (decimal[3] || ''));
    if (decimal[1] === '-') numerator = -numerator;
    return digits >= 0 ? new Rational(numerator, 10n ** BigInt(digits)) : new Rational(numerator * 10n ** BigInt(-digits));
  }

  function format(value, options) {
    options = options || {};
    var decimals = options.decimals === undefined ? 2 : options.decimals;
    if (!Number.isInteger(decimals) || decimals < 0 || decimals > 12) fail('value', '显示小数位须为 0–12 的整数。');
    var amount = displayValue(value);
    var scale = 10n ** BigInt(decimals);
    var scaled;
    if (options.ceil) {
      scaled = amount.mul(new Rational(scale)).ceil().n;
    } else {
      var unsigned = abs(amount.n) * scale;
      var rounded = unsigned / amount.d + ((unsigned % amount.d) * 2n >= amount.d ? 1n : 0n);
      scaled = amount.n < 0n ? -rounded : rounded;
    }
    if (scaled === 0n && amount.n !== 0n && options.small !== false) {
      var threshold = decimals ? '0.' + '0'.repeat(decimals - 1) + '1' : '1';
      return amount.n > 0n ? '<' + threshold : '>-' + threshold + ' 且 <0';
    }
    var digitsText = abs(scaled).toString().padStart(decimals + 1, '0');
    var whole = decimals ? digitsText.slice(0, -decimals) : digitsText;
    if (options.group !== false) whole = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (scaled < 0n ? '-' : '') + whole + (decimals ? '.' + digitsText.slice(-decimals) : '');
  }

  global.FreeToolMath = Object.freeze({ calculate: calculate, format: format });
})(window);

// END APPROVED SOURCE
}

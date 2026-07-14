/* backtest.js — Hindsight's portfolio-math core.
   Pure functions only: no DOM, no fetch, no globals besides the module
   export itself. Loaded as a plain <script> in the browser (attaches
   window.Backtest) and required directly by tests/backtest.test.js under
   Node — same "no build step" pattern as the rest of MarketPulse. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Backtest = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const TRADING_DAYS_YEAR = 252;
  const MS_PER_YEAR = 365.25 * 24 * 3600 * 1000;

  const REBALANCE_NONE = "none";
  const REBALANCE_MONTHLY = "monthly";
  const REBALANCE_QUARTERLY = "quarterly";
  const REBALANCE_ANNUAL = "annual";

  // ---- small stats helpers -------------------------------------------------
  function mean(arr) {
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  function stdev(arr) {
    // sample stdev (n-1) — consistent with standard Sharpe/vol conventions
    const m = mean(arr);
    const variance = arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1);
    return Math.sqrt(variance);
  }

  function simpleReturns(values) {
    const out = [];
    for (let i = 1; i < values.length; i++) out.push(values[i] / values[i - 1] - 1);
    return out;
  }

  function yearsBetween(dateA, dateB) {
    return (new Date(dateB) - new Date(dateA)) / MS_PER_YEAR;
  }

  // ---- calendar alignment ---------------------------------------------------
  // The 15 indices trade on different national holidays, so a naive
  // day-by-day walk would silently compare mismatched dates. We align on the
  // INTERSECTION of trading dates across every included index — simpler and
  // more conservative than forward-filling gaps, at the cost of dropping a
  // handful of single-market-holiday dates from the backtest entirely (this
  // is stated on the Hindsight tab).
  function intersectDates(seriesByCode) {
    const codes = Object.keys(seriesByCode);
    if (codes.length === 0) return [];
    let common = new Set(seriesByCode[codes[0]].dates);
    for (let i = 1; i < codes.length; i++) {
      const s = new Set(seriesByCode[codes[i]].dates);
      common = new Set(Array.from(common).filter((d) => s.has(d)));
    }
    return Array.from(common).sort();
  }

  function alignOnIntersection(seriesByCode) {
    const dates = intersectDates(seriesByCode);
    const closes = {};
    for (const code of Object.keys(seriesByCode)) {
      const byDate = new Map(seriesByCode[code].dates.map((d, i) => [d, seriesByCode[code].closes[i]]));
      closes[code] = dates.map((d) => byDate.get(d));
    }
    return { dates, closes };
  }

  // Indices with shorter history than the chosen start date are excluded from
  // the run rather than having their weight silently folded into the rest —
  // callers must surface `excluded` to the user, not renormalize around it.
  function partitionByStartDate(seriesByCode, startDate) {
    const included = [];
    const excluded = [];
    for (const code of Object.keys(seriesByCode)) {
      const dates = seriesByCode[code].dates;
      (dates.length > 0 && dates[0] <= startDate ? included : excluded).push(code);
    }
    return { included, excluded };
  }

  function sliceFromDate(dates, closesByCode, startDate) {
    let from = dates.findIndex((d) => d >= startDate);
    if (from === -1) from = dates.length;
    const outCloses = {};
    for (const code of Object.keys(closesByCode)) outCloses[code] = closesByCode[code].slice(from);
    return { dates: dates.slice(from), closes: outCloses };
  }

  // ---- portfolio simulation ---------------------------------------------
  function periodKey(dateStr, rule) {
    const year = dateStr.slice(0, 4);
    const month = Number(dateStr.slice(5, 7));
    if (rule === REBALANCE_MONTHLY) return `${year}-${String(month).padStart(2, "0")}`;
    if (rule === REBALANCE_QUARTERLY) return `${year}-Q${Math.ceil(month / 3)}`;
    if (rule === REBALANCE_ANNUAL) return year;
    return null; // "none" — weights drift with the market, never reset
  }

  // dates: string[]; closes: {code: number[]} already aligned 1:1 with dates;
  // weights: {code: fraction}, must sum to ~1. Returns [{date, value}].
  function runBacktest({ dates, closes, weights, initialAmount, rebalance = REBALANCE_NONE }) {
    const codes = Object.keys(weights);
    const units = {};
    for (const code of codes) units[code] = (initialAmount * weights[code]) / closes[code][0];

    const curve = [];
    let prevPeriod = periodKey(dates[0], rebalance);
    for (let i = 0; i < dates.length; i++) {
      const period = periodKey(dates[i], rebalance);
      if (i > 0 && rebalance !== REBALANCE_NONE && period !== prevPeriod) {
        let value = 0;
        for (const code of codes) value += units[code] * closes[code][i];
        for (const code of codes) units[code] = (value * weights[code]) / closes[code][i];
      }
      let value = 0;
      for (const code of codes) value += units[code] * closes[code][i];
      curve.push({ date: dates[i], value });
      prevPeriod = period;
    }
    return curve;
  }

  // ---- risk/return stats -----------------------------------------------
  function cagr(startValue, endValue, years) {
    if (years <= 0 || startValue <= 0) return 0;
    return Math.pow(endValue / startValue, 1 / years) - 1;
  }

  function annualizedVol(returns) {
    return stdev(returns) * Math.sqrt(TRADING_DAYS_YEAR);
  }

  // Excess return over a constant risk-free rate has the same stdev as the
  // raw returns (subtracting a constant doesn't change dispersion), so the
  // denominator only needs computing once.
  function sharpeRatio(returns, riskFreeAnnual = 0) {
    const rfDaily = riskFreeAnnual / TRADING_DAYS_YEAR;
    const excessMean = mean(returns) - rfDaily;
    const sd = stdev(returns);
    if (sd === 0) return 0;
    return (excessMean / sd) * Math.sqrt(TRADING_DAYS_YEAR);
  }

  function maxDrawdown(curve) {
    if (curve.length === 0) return { pct: 0, peakDate: null, troughDate: null };
    let peak = curve[0].value;
    let peakDate = curve[0].date;
    let maxDD = 0;
    let ddPeakDate = peakDate;
    let troughDate = peakDate;
    for (const { date, value } of curve) {
      if (value > peak) {
        peak = value;
        peakDate = date;
      }
      const dd = value / peak - 1;
      if (dd < maxDD) {
        maxDD = dd;
        ddPeakDate = peakDate;
        troughDate = date;
      }
    }
    return { pct: maxDD, peakDate: ddPeakDate, troughDate };
  }

  // One row per calendar year covered by the curve; each year's return is
  // measured off the PRIOR year's closing value (off the initial value for
  // the first year), so partial first/last years are still meaningful.
  function calendarYearReturns(curve) {
    if (curve.length === 0) return [];
    const byYear = new Map();
    for (const point of curve) {
      const year = point.date.slice(0, 4);
      if (!byYear.has(year)) byYear.set(year, { first: point.value, last: point.value });
      byYear.get(year).last = point.value;
    }
    const years = Array.from(byYear.keys()).sort();
    const out = [];
    let prevLast = null;
    for (const year of years) {
      const { first, last } = byYear.get(year);
      const base = prevLast === null ? first : prevLast;
      out.push({ year, return: base > 0 ? last / base - 1 : 0 });
      prevLast = last;
    }
    return out;
  }

  function backtestStats(curve, { riskFreeAnnual = 0 } = {}) {
    const values = curve.map((p) => p.value);
    const returns = simpleReturns(values);
    const years = yearsBetween(curve[0].date, curve[curve.length - 1].date);
    return {
      cagr: cagr(values[0], values[values.length - 1], years),
      annualizedVol: annualizedVol(returns),
      sharpe: sharpeRatio(returns, riskFreeAnnual),
      maxDrawdown: maxDrawdown(curve),
      calendarYearReturns: calendarYearReturns(curve),
    };
  }

  // ---- risk/return scatter (mean-variance "poor-man's efficient frontier") --
  // Random portfolios are scored analytically from annualized mean returns +
  // covariance, not by re-running 2,000 full rebalanced backtests — that's
  // the standard mean-variance construct an efficient-frontier scatter is
  // built from, and it's what makes 2,000 points instant in the browser.
  function annualizedMeanReturns(returnsByCode) {
    const out = {};
    for (const code of Object.keys(returnsByCode)) out[code] = mean(returnsByCode[code]) * TRADING_DAYS_YEAR;
    return out;
  }

  function covarianceMatrix(returnsByCode) {
    const codes = Object.keys(returnsByCode);
    const means = {};
    for (const c of codes) means[c] = mean(returnsByCode[c]);
    const n = returnsByCode[codes[0]].length;
    const cov = {};
    for (const a of codes) {
      cov[a] = {};
      for (const b of codes) {
        let s = 0;
        for (let i = 0; i < n; i++) s += (returnsByCode[a][i] - means[a]) * (returnsByCode[b][i] - means[b]);
        cov[a][b] = (s / (n - 1)) * TRADING_DAYS_YEAR;
      }
    }
    return cov;
  }

  function portfolioStats(weights, meanReturns, covMatrix) {
    const codes = Object.keys(weights);
    let ret = 0;
    for (const c of codes) ret += weights[c] * meanReturns[c];
    let variance = 0;
    for (const a of codes) {
      for (const b of codes) variance += weights[a] * weights[b] * covMatrix[a][b];
    }
    return { return: ret, vol: Math.sqrt(Math.max(0, variance)) };
  }

  function randomWeights(codes, rng = Math.random) {
    const raw = codes.map(() => rng());
    const sum = raw.reduce((a, b) => a + b, 0);
    const w = {};
    codes.forEach((c, i) => {
      w[c] = raw[i] / sum;
    });
    return w;
  }

  function randomPortfolios(codes, meanReturns, covMatrix, count = 2000, rng = Math.random) {
    const out = [];
    for (let i = 0; i < count; i++) {
      const w = randomWeights(codes, rng);
      out.push(Object.assign({ weights: w }, portfolioStats(w, meanReturns, covMatrix)));
    }
    return out;
  }

  return {
    TRADING_DAYS_YEAR,
    REBALANCE_NONE,
    REBALANCE_MONTHLY,
    REBALANCE_QUARTERLY,
    REBALANCE_ANNUAL,
    mean,
    stdev,
    simpleReturns,
    yearsBetween,
    intersectDates,
    alignOnIntersection,
    partitionByStartDate,
    sliceFromDate,
    runBacktest,
    cagr,
    annualizedVol,
    sharpeRatio,
    maxDrawdown,
    calendarYearReturns,
    backtestStats,
    annualizedMeanReturns,
    covarianceMatrix,
    portfolioStats,
    randomWeights,
    randomPortfolios,
  };
});

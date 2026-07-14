/* risk.js — Risk tab's math core (correlation, rolling vol, historical VaR/CVaR).
   Pure functions only: no DOM, no fetch, no globals besides the module export
   itself — same "no build step" pattern as backtest.js. Loaded as a plain
   <script> in the browser (attaches window.Risk) and required directly by
   tests/risk.test.js under Node. Calendar alignment (intersectDates /
   alignOnIntersection) and daily returns (simpleReturns) are NOT duplicated
   here — callers reuse Backtest's copies so there is exactly one date-
   alignment implementation in the codebase. */
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    root.Risk = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const TRADING_DAYS_YEAR = 252;

  function mean(arr) {
    return arr.reduce((a, b) => a + b, 0) / arr.length;
  }

  // sample stdev (n-1) — same convention as Backtest.stdev, duplicated rather
  // than required so risk.js has no load-order dependency on backtest.js.
  function stdev(arr) {
    const m = mean(arr);
    const variance = arr.reduce((s, x) => s + (x - m) ** 2, 0) / (arr.length - 1);
    return Math.sqrt(variance);
  }

  // ---- correlation ----------------------------------------------------------
  // Returns 0 (not NaN) when either series has zero variance over the window
  // (e.g. a stale/flat feed) — correlation is mathematically undefined there,
  // and 0 renders as a neutral cell on the heatmap instead of breaking it.
  function pearsonCorrelation(x, y) {
    const n = Math.min(x.length, y.length);
    const mx = mean(x.slice(0, n));
    const my = mean(y.slice(0, n));
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) {
      const dx = x[i] - mx, dy = y[i] - my;
      sxy += dx * dy;
      sxx += dx * dx;
      syy += dy * dy;
    }
    if (sxx === 0 || syy === 0) return 0;
    return sxy / Math.sqrt(sxx * syy);
  }

  // returnsByCode: {code: number[]}, all same length (already date-aligned by
  // the caller via Backtest.alignOnIntersection + simpleReturns).
  // Returns {codes, matrix} where matrix[i][j] = corr(codes[i], codes[j]).
  function correlationMatrix(returnsByCode) {
    const codes = Object.keys(returnsByCode);
    const matrix = codes.map((a) =>
      codes.map((b) => (a === b ? 1 : pearsonCorrelation(returnsByCode[a], returnsByCode[b])))
    );
    return { codes, matrix };
  }

  // ---- rolling volatility -----------------------------------------------
  // Trailing-window annualized vol, one value per return; the first
  // (window - 1) entries are null (not enough history yet for that window) —
  // callers must skip nulls rather than treat them as zero vol.
  function rollingAnnualizedVol(returns, window) {
    const out = new Array(returns.length).fill(null);
    for (let i = window - 1; i < returns.length; i++) {
      out[i] = stdev(returns.slice(i - window + 1, i + 1)) * Math.sqrt(TRADING_DAYS_YEAR);
    }
    return out;
  }

  // ---- portfolio historical simulation -----------------------------------
  // Applies TODAY's fixed weights to each historical day's asset returns —
  // the standard "historical simulation" VaR construction (no rebalancing
  // drift, unlike Hindsight's compounding equity curve). returnsByCode
  // entries must already be date-aligned and the same length.
  function weightedPortfolioReturns(returnsByCode, weights) {
    const codes = Object.keys(weights).filter((c) => returnsByCode[c]);
    if (codes.length === 0) return [];
    const n = returnsByCode[codes[0]].length;
    const out = new Array(n).fill(0);
    for (const c of codes) {
      const w = weights[c];
      const r = returnsByCode[c];
      for (let i = 0; i < n; i++) out[i] += w * r[i];
    }
    return out;
  }

  // 1-day historical VaR/CVaR at the given confidence (e.g. 0.95, 0.99).
  // Loss-positive convention: a 3% loss day returns +0.03, not -0.03.
  // Uses the plain order-statistic method (sort losses, VaR = the Nth-worst
  // observation) rather than percentile interpolation — the textbook
  // "historical simulation" construction, and one that lands on exact
  // observations for round sample sizes instead of interpolating between two.
  // k is the number of tail observations at this confidence, rounded UP so a
  // small sample still gets at least one observation in the tail.
  function historicalVaR(returns, confidence) {
    if (returns.length === 0) return { var: 0, cvar: 0 };
    const losses = returns.map((r) => -r);
    const sorted = losses.slice().sort((a, b) => b - a); // worst (largest loss) first
    // subtract a small epsilon before ceil: (1-confidence)*n should often land
    // on an exact integer (e.g. 0.05*100 = 5), but float error can nudge it to
    // 5.000000000000004, which Math.ceil would otherwise round up to 6 —
    // silently pulling one extra day into the tail.
    const k = Math.max(1, Math.ceil((1 - confidence) * sorted.length - 1e-9));
    const tail = sorted.slice(0, k);
    return { var: tail[tail.length - 1], cvar: mean(tail) };
  }

  // ---- histogram (for the return-distribution chart behind the VaR stats) --
  // Fixed bin COUNT (not bin width) so the caller doesn't need to know the
  // data's range up front; degenerate all-identical-value input gets a
  // single wide bin instead of dividing by zero.
  function histogram(values, binCount = 20) {
    if (values.length === 0) return { min: 0, max: 0, width: 0, counts: [] };
    const min = Math.min.apply(null, values);
    const max = Math.max.apply(null, values);
    const width = (max - min) / binCount || 1;
    const counts = new Array(binCount).fill(0);
    values.forEach((v) => {
      let idx = Math.floor((v - min) / width);
      if (idx >= binCount) idx = binCount - 1;
      if (idx < 0) idx = 0;
      counts[idx]++;
    });
    return { min, max, width, counts };
  }

  return {
    TRADING_DAYS_YEAR,
    mean,
    stdev,
    pearsonCorrelation,
    correlationMatrix,
    rollingAnnualizedVol,
    weightedPortfolioReturns,
    historicalVaR,
    histogram,
  };
});

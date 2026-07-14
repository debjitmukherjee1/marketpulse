// tests/backtest.test.js — Node's built-in test runner (no deps): `node --test`
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Backtest = require("../site/js/backtest.js");

function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Two synthetic assets, 6 trading days spanning a Jan->Feb month boundary,
// so the same fixture exercises both "drifting" and "monthly rebalance".
const DATES = ["2024-01-29", "2024-01-30", "2024-01-31", "2024-02-01", "2024-02-02", "2024-02-05"];
const CLOSES = {
  A: [100, 102, 101, 105, 103, 108],
  B: [50, 49, 51, 52, 53, 51],
};

test("drifting weights (no rebalance) matches hand-computed equity curve", () => {
  // $500 into A at 100 = 5 units, $500 into B at 50 = 10 units, held fixed.
  // value[t] = 5*A[t] + 10*B[t]
  const curve = Backtest.runBacktest({
    dates: DATES, closes: CLOSES, weights: { A: 0.5, B: 0.5 }, initialAmount: 1000, rebalance: "none",
  });
  const expected = [1000, 1000, 1015, 1045, 1045, 1050];
  curve.forEach((p, i) => assert.ok(Math.abs(p.value - expected[i]) < 1e-9, `day ${i}: got ${p.value}, want ${expected[i]}`));
});

test("monthly rebalance matches the no-rebalance path until the month boundary, then diverges", () => {
  const none = Backtest.runBacktest({
    dates: DATES, closes: CLOSES, weights: { A: 0.5, B: 0.5 }, initialAmount: 1000, rebalance: "none",
  }).map((p) => p.value);
  const monthly = Backtest.runBacktest({
    dates: DATES, closes: CLOSES, weights: { A: 0.5, B: 0.5 }, initialAmount: 1000, rebalance: "monthly",
  }).map((p) => p.value);

  // Jan 29-31: no month change yet, both paths identical.
  assert.deepEqual(monthly.slice(0, 3), none.slice(0, 3));
  // Feb 1: the rebalance trigger day's OWN value is unaffected (reallocating
  // still sums to the same total) — only days AFTER it should differ.
  assert.ok(Math.abs(monthly[3] - none[3]) < 1e-9);
  assert.ok(Math.abs(monthly[3] - 1045) < 1e-9);
  // hand-computed: at Feb 1 (price A=105,B=52) rebalance to 50/50 gives
  // unitsA=1045*0.5/105, unitsB=1045*0.5/52; carried forward through Feb 2 & 5.
  const expectedMonthly = [1000, 1000, 1015, 1045, 1045.095695970696, 1049.8804945054944];
  monthly.forEach((v, i) => assert.ok(Math.abs(v - expectedMonthly[i]) < 1e-6, `day ${i}: got ${v}, want ${expectedMonthly[i]}`));
  assert.notEqual(monthly[4], none[4]);
  assert.notEqual(monthly[5], none[5]);
});

test("max drawdown finds the correct peak/trough on a known sequence", () => {
  const values = [100, 120, 90, 95, 130, 80, 110];
  const curve = values.map((v, i) => ({ date: `d${i}`, value: v }));
  const dd = Backtest.maxDrawdown(curve);
  // peak 130 (d4) -> trough 80 (d5): 80/130 - 1
  assert.ok(Math.abs(dd.pct - (80 / 130 - 1)) < 1e-9);
  assert.equal(dd.peakDate, "d4");
  assert.equal(dd.troughDate, "d5");
});

test("max drawdown is zero for a monotonically rising curve", () => {
  const curve = [1, 2, 3, 4].map((v, i) => ({ date: `d${i}`, value: v }));
  const dd = Backtest.maxDrawdown(curve);
  assert.equal(dd.pct, 0);
});

test("Sharpe ratio annualizes by sqrt(252)", () => {
  const returns = [0.01, -0.02, 0.015, -0.005, 0.02];
  // mean=0.004, sample stdev=0.016355427233796127 (hand-computed)
  const sharpe0 = Backtest.sharpeRatio(returns, 0);
  assert.ok(Math.abs(sharpe0 - 3.8823829275667388) < 1e-6, `got ${sharpe0}`);

  const sharpeRf = Backtest.sharpeRatio(returns, 0.03);
  assert.ok(Math.abs(sharpeRf - 3.766835816627253) < 1e-6, `got ${sharpeRf}`);

  // a nonzero risk-free rate must not change annualized VOLATILITY, only
  // the numerator — cross-check against annualizedVol directly.
  const vol = Backtest.annualizedVol(returns);
  assert.ok(Math.abs(vol - 0.016355427233796127 * Math.sqrt(252)) < 1e-9);
});

test("intersectDates keeps only dates common to every series", () => {
  const seriesByCode = {
    A: { dates: ["2024-01-01", "2024-01-02", "2024-01-03"], closes: [1, 2, 3] },
    B: { dates: ["2024-01-02", "2024-01-03", "2024-01-04"], closes: [10, 20, 30] },
  };
  const { dates, closes } = Backtest.alignOnIntersection(seriesByCode);
  assert.deepEqual(dates, ["2024-01-02", "2024-01-03"]);
  assert.deepEqual(closes.A, [2, 3]);
  assert.deepEqual(closes.B, [10, 20]);
});

test("partitionByStartDate excludes indices whose history starts after the chosen start date", () => {
  const seriesByCode = {
    A: { dates: ["2015-01-01", "2016-01-01"], closes: [1, 1] },
    B: { dates: ["2020-01-01", "2021-01-01"], closes: [1, 1] },
  };
  const { included, excluded } = Backtest.partitionByStartDate(seriesByCode, "2018-01-01");
  assert.deepEqual(included, ["A"]);
  assert.deepEqual(excluded, ["B"]);
});

test("calendarYearReturns bases each year's return off the prior year's last close", () => {
  const curve = [
    { date: "2023-01-01", value: 100 },
    { date: "2023-12-29", value: 110 },
    { date: "2024-01-02", value: 111 },
    { date: "2024-12-31", value: 120 },
  ];
  const rows = Backtest.calendarYearReturns(curve);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].year, "2023");
  assert.ok(Math.abs(rows[0].return - 0.10) < 1e-9); // 100 -> 110
  assert.equal(rows[1].year, "2024");
  assert.ok(Math.abs(rows[1].return - (120 / 110 - 1)) < 1e-9); // off 2023's LAST close, not Jan 2's
});

test("randomPortfolios: weights always sum to 1 and vol is non-negative", () => {
  const returnsByCode = {
    A: [0.01, -0.005, 0.008, 0.002, -0.01],
    B: [0.005, 0.01, -0.002, 0.004, 0.001],
  };
  const meanReturns = Backtest.annualizedMeanReturns(returnsByCode);
  const cov = Backtest.covarianceMatrix(returnsByCode);
  const portfolios = Backtest.randomPortfolios(["A", "B"], meanReturns, cov, 50, mulberry32(42));
  assert.equal(portfolios.length, 50);
  for (const p of portfolios) {
    assert.ok(Math.abs(p.weights.A + p.weights.B - 1) < 1e-9);
    assert.ok(p.vol >= 0);
  }
});

test("backtestStats CAGR matches hand-computed value for a simple 2-year doubling", () => {
  const curve = [
    { date: "2022-01-01", value: 1000 },
    { date: "2024-01-01", value: 4000 },
  ];
  const stats = Backtest.backtestStats(curve);
  // 4x over ~2 years -> CAGR = 4^(1/2) - 1 = 1.0 (100%)
  assert.ok(Math.abs(stats.cagr - 1.0) < 1e-2, `got ${stats.cagr}`);
});

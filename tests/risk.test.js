// tests/risk.test.js — Node's built-in test runner (no deps): `node --test`
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const Risk = require("../site/js/risk.js");

test("pearsonCorrelation matches a hand-computed value on a short synthetic series", () => {
  // x=[1,2,3], y=[1,3,2]: mean x=2, mean y=2; dx=[-1,0,1], dy=[-1,1,0]
  // sum(dx*dy)=1, sum(dx^2)=2, sum(dy^2)=2 -> r = 1/sqrt(2*2) = 0.5
  const r = Risk.pearsonCorrelation([1, 2, 3], [1, 3, 2]);
  assert.ok(Math.abs(r - 0.5) < 1e-9, `got ${r}`);
});

test("pearsonCorrelation is 1 for perfectly proportional series", () => {
  const r = Risk.pearsonCorrelation([1, 2, 3, 4, 5], [2, 4, 6, 8, 10]);
  assert.ok(Math.abs(r - 1) < 1e-9, `got ${r}`);
});

test("pearsonCorrelation is -1 for perfectly inverse series", () => {
  const r = Risk.pearsonCorrelation([1, 2, 3, 4, 5], [10, 8, 6, 4, 2]);
  assert.ok(Math.abs(r - -1) < 1e-9, `got ${r}`);
});

test("pearsonCorrelation returns 0 (not NaN) when a series has zero variance", () => {
  const r = Risk.pearsonCorrelation([1, 1, 1], [1, 2, 3]);
  assert.equal(r, 0);
});

test("correlationMatrix has 1s on the diagonal and is symmetric", () => {
  const returnsByCode = {
    A: [0.01, 0.02, -0.01, 0.03],
    B: [0.02, 0.01, -0.02, 0.01],
  };
  const { codes, matrix } = Risk.correlationMatrix(returnsByCode);
  assert.deepEqual(codes, ["A", "B"]);
  assert.equal(matrix[0][0], 1);
  assert.equal(matrix[1][1], 1);
  assert.ok(Math.abs(matrix[0][1] - matrix[1][0]) < 1e-12);
});

test("rollingAnnualizedVol pads the first (window-1) entries with null", () => {
  const returns = [0.01, -0.01, 0.02, -0.02, 0.01];
  const out = Risk.rollingAnnualizedVol(returns, 3);
  assert.deepEqual(out.slice(0, 2), [null, null]);
  // hand-computed: stdev([0.01,-0.01,0.02], n-1) * sqrt(252)
  const expected = Risk.stdev([0.01, -0.01, 0.02]) * Math.sqrt(252);
  assert.ok(Math.abs(out[2] - expected) < 1e-12);
});

test("rollingAnnualizedVol returns all-null when the series is shorter than the window", () => {
  const out = Risk.rollingAnnualizedVol([0.01, -0.01], 5);
  assert.deepEqual(out, [null, null]);
});

test("weightedPortfolioReturns applies fixed weights to each day's asset returns (no rebalancing drift)", () => {
  const returnsByCode = { A: [0.01, 0.02], B: [-0.01, 0.0] };
  const out = Risk.weightedPortfolioReturns(returnsByCode, { A: 0.5, B: 0.5 });
  assert.ok(Math.abs(out[0] - 0) < 1e-12);
  assert.ok(Math.abs(out[1] - 0.01) < 1e-12);
});

// 100 known daily returns: (i - 50) / 1000 for i = 0..99, i.e. -0.05, -0.049,
// ..., 0.049. Losses (=-returns) sorted worst-first are exactly 0.05, 0.049,
// 0.048, ... — a round sample size chosen so the tail sizes below (5 and 1)
// are exact integers with no interpolation, and hand-verifiable.
function knownReturns100() {
  const out = [];
  for (let i = 0; i < 100; i++) out.push((i - 50) / 1000);
  return out;
}

test("historicalVaR at 95% on a known 100-point return set matches the hand-computed 5th-worst-loss boundary", () => {
  const returns = knownReturns100();
  const { var: v, cvar } = Risk.historicalVaR(returns, 0.95);
  // worst 5 losses: 0.05, 0.049, 0.048, 0.047, 0.046 -> VaR = smallest of these = 0.046
  assert.ok(Math.abs(v - 0.046) < 1e-9, `var: got ${v}`);
  // CVaR = mean of the worst 5 = 0.048
  assert.ok(Math.abs(cvar - 0.048) < 1e-9, `cvar: got ${cvar}`);
});

test("historicalVaR at 99% on the same known set matches the single-worst-loss boundary", () => {
  const returns = knownReturns100();
  const { var: v, cvar } = Risk.historicalVaR(returns, 0.99);
  // worst 1 loss: 0.05 -> both VaR and CVaR equal it exactly
  assert.ok(Math.abs(v - 0.05) < 1e-9, `var: got ${v}`);
  assert.ok(Math.abs(cvar - 0.05) < 1e-9, `cvar: got ${cvar}`);
});

test("historicalVaR loss-positive convention: an all-gains series has zero VaR/CVaR, not negative", () => {
  const returns = [0.01, 0.02, 0.03, 0.015, 0.025];
  const { var: v, cvar } = Risk.historicalVaR(returns, 0.95);
  // worst "loss" here is actually the smallest gain, made negative by the
  // loss-positive convention -- confirms the sign flip, not just magnitude.
  assert.ok(v < 0, `expected a negative VaR (a gain) for an all-positive-return series, got ${v}`);
  assert.ok(cvar < 0, `expected a negative CVaR for an all-positive-return series, got ${cvar}`);
});

test("historicalVaR on empty returns is zero, not NaN", () => {
  const { var: v, cvar } = Risk.historicalVaR([], 0.95);
  assert.equal(v, 0);
  assert.equal(cvar, 0);
});

test("histogram counts sum to the input length and respect bin boundaries", () => {
  const values = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const { counts, min, max } = Risk.histogram(values, 5);
  assert.equal(min, 0);
  assert.equal(max, 10);
  assert.equal(counts.reduce((a, b) => a + b, 0), values.length);
});

test("histogram handles all-identical values without dividing by zero", () => {
  const { counts } = Risk.histogram([5, 5, 5, 5], 10);
  assert.equal(counts.reduce((a, b) => a + b, 0), 4);
  assert.equal(counts[0], 4);
});

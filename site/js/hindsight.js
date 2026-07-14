/* hindsight.js — "Backtester" tab UI wiring. DOM + Chart.js only; all
   portfolio math lives in backtest.js (pure, unit-tested separately).
   Mirrors app.js's fetch/cache pattern against the same site/data/*.json,
   but keeps its own local state so the two files stay decoupled (no
   modules/bundler in this project, so no shared imports between scripts). */
(function () {
  "use strict";

  const hState = {
    manifest: null,
    cache: {},     // code -> full index json ({series:[{d,c}], ...})
    weights: {},   // code -> integer percent, 0-100
    loaded: false,
  };
  let equityChart, scatterChart;

  const fmtMoney = (n) => "$" + Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 });
  const fmtPct = (n) => (n >= 0 ? "+" : "") + (n * 100).toFixed(2) + "%";
  const fmtPct1 = (n) => (n * 100).toFixed(1) + "%";

  // ---- boot (lazy: only fetches once the Backtester tab is first opened) --
  async function ensureLoaded() {
    if (hState.loaded) return;
    const [manifest] = await Promise.all([
      fetch("data/manifest.json").then((r) => r.json()),
    ]);
    hState.manifest = manifest;
    const codes = manifest.indices.map((m) => m.code);
    // equal weight, remainder spread over the first codes so it sums to exactly 100
    const base = Math.floor(100 / codes.length);
    let remainder = 100 - base * codes.length;
    codes.forEach((c) => {
      hState.weights[c] = base + (remainder-- > 0 ? 1 : 0);
    });
    buildWeightSliders(manifest.indices);
    buildBenchmarkSelect(manifest.indices);
    setDefaultStartDate();
    document.getElementById("hs-run").addEventListener("click", runBacktestFlow);
    hState.loaded = true;
  }

  async function getIndex(code) {
    if (hState.cache[code]) return hState.cache[code];
    const res = await fetch(`data/indices/${code}.json`);
    if (!res.ok) throw new Error(`Failed to load ${code} (HTTP ${res.status})`);
    const data = await res.json();
    hState.cache[code] = data;
    return data;
  }

  function toSeries(json) {
    return { dates: json.series.map((p) => p.d), closes: json.series.map((p) => p.c) };
  }

  // ---- controls -------------------------------------------------------------
  function buildWeightSliders(indices) {
    const grid = document.getElementById("hs-weight-grid");
    grid.innerHTML = "";
    indices.forEach((idx) => {
      const row = document.createElement("div");
      row.className = "weight-row";
      row.innerHTML = `
        <span class="weight-name" title="${idx.name}">${idx.name}</span>
        <input type="range" min="0" max="100" step="1" value="${hState.weights[idx.code]}" data-code="${idx.code}" />
        <span class="weight-val" id="hs-val-${idx.code}">${hState.weights[idx.code]}%</span>`;
      grid.appendChild(row);
    });
    grid.addEventListener("input", (e) => {
      const input = e.target.closest("input[type=range]");
      if (!input) return;
      hState.weights[input.dataset.code] = parseInt(input.value, 10);
      document.getElementById(`hs-val-${input.dataset.code}`).textContent = input.value + "%";
      updateWeightTotal();
    });
    updateWeightTotal();
  }

  function updateWeightTotal() {
    const total = Object.values(hState.weights).reduce((a, b) => a + b, 0);
    const el = document.getElementById("hs-weight-total");
    el.textContent = `Total: ${total}%`;
    el.className = "weight-total " + (total === 100 ? "balanced" : "unbalanced");
    document.getElementById("hs-run").disabled = total !== 100;
  }

  function buildBenchmarkSelect(indices) {
    const sel = document.getElementById("hs-benchmark");
    sel.innerHTML = "";
    indices.forEach((idx) => {
      const o = document.createElement("option");
      o.value = idx.code;
      o.textContent = idx.name;
      sel.appendChild(o);
    });
    sel.value = indices.some((i) => i.code === "GSPC") ? "GSPC" : indices[0].code;
  }

  function setDefaultStartDate() {
    const input = document.getElementById("hs-start-date");
    const today = new Date();
    const start = new Date(today);
    start.setFullYear(start.getFullYear() - 5);
    input.value = start.toISOString().slice(0, 10);
    input.max = today.toISOString().slice(0, 10);
  }

  // ---- run --------------------------------------------------------------
  async function runBacktestFlow() {
    const btn = document.getElementById("hs-run");
    const warnBox = document.getElementById("hs-warnings");
    btn.textContent = "Running…";
    btn.disabled = true;
    warnBox.innerHTML = "";
    try {
      const startDate = document.getElementById("hs-start-date").value;
      const initialAmount = Math.max(1, parseFloat(document.getElementById("hs-amount").value) || 10000);
      const rebalance = document.getElementById("hs-rebalance").value;
      const benchmarkCode = document.getElementById("hs-benchmark").value;
      const riskFreePct = parseFloat(document.getElementById("hs-rf").value) || 0;

      if (!startDate) throw new Error("Pick a start date.");

      const nonzeroCodes = Object.keys(hState.weights).filter((c) => hState.weights[c] > 0);
      if (nonzeroCodes.length === 0) throw new Error("At least one index needs a nonzero weight.");
      const codesNeeded = Array.from(new Set([...nonzeroCodes, benchmarkCode]));

      const jsons = await Promise.all(codesNeeded.map(getIndex));
      const seriesByCode = {};
      codesNeeded.forEach((c, i) => {
        seriesByCode[c] = toSeries(jsons[i]);
      });

      const { included, excluded } = Backtest.partitionByStartDate(seriesByCode, startDate);
      const includedSet = new Set(included);

      const alignInput = {};
      included.forEach((c) => {
        alignInput[c] = seriesByCode[c];
      });
      if (Object.keys(alignInput).length === 0) {
        throw new Error("None of the selected indices have data back to that start date. Pick a later start date.");
      }
      const aligned = Backtest.alignOnIntersection(alignInput);
      const sliced = Backtest.sliceFromDate(aligned.dates, aligned.closes, startDate);

      if (sliced.dates.length < 30) {
        throw new Error("Fewer than 30 overlapping trading days in this range — pick an earlier start date or a different mix of indices.");
      }

      const portfolioCodesIncluded = nonzeroCodes.filter((c) => includedSet.has(c));
      const portfolioCodesExcluded = nonzeroCodes.filter((c) => !includedSet.has(c));
      const benchmarkIncluded = includedSet.has(benchmarkCode);

      const weights = {};
      portfolioCodesIncluded.forEach((c) => {
        weights[c] = hState.weights[c] / 100;
      });
      const investedFraction = portfolioCodesIncluded.reduce((s, c) => s + weights[c], 0);
      const residual = 1 - investedFraction;
      const closes = Object.assign({}, sliced.closes);
      if (residual > 1e-9) {
        weights.CASH = residual;
        closes.CASH = sliced.dates.map(() => 1);
      }

      const portfolioCurve = Backtest.runBacktest({ dates: sliced.dates, closes, weights, initialAmount, rebalance });
      const stats = Backtest.backtestStats(portfolioCurve, { riskFreeAnnual: riskFreePct / 100 });

      let benchmarkCurve = null;
      if (benchmarkIncluded) {
        benchmarkCurve = Backtest.runBacktest({
          dates: sliced.dates, closes: sliced.closes, weights: { [benchmarkCode]: 1 }, initialAmount, rebalance: "none",
        });
      }

      renderWarnings(portfolioCodesExcluded, benchmarkIncluded ? null : benchmarkCode, seriesByCode, startDate, residual);
      renderEquityChart(portfolioCurve, benchmarkCurve, stats.maxDrawdown, benchmarkCode, benchmarkIncluded);
      renderStats(stats, initialAmount, portfolioCurve, riskFreePct);
      renderYearTable(stats.calendarYearReturns);
      renderScatter(portfolioCodesIncluded, weights, sliced, residual);
    } catch (e) {
      console.error(e);
      warnBox.innerHTML = `<div class="notice notice-bad">${e.message || "Could not run backtest."}</div>`;
    } finally {
      btn.textContent = "Run backtest";
      updateWeightTotal(); // restores correct disabled state
    }
  }

  function renderWarnings(excludedCodes, excludedBenchmarkCode, seriesByCode, startDate, residual) {
    const box = document.getElementById("hs-warnings");
    const lines = [];
    if (excludedCodes.length) {
      const names = excludedCodes.map((c) => {
        const first = seriesByCode[c].dates[0];
        const label = (hState.manifest.indices.find((i) => i.code === c) || {}).name || c;
        return `${label} (data starts ${first})`;
      });
      lines.push(
        `Excluded from this run — insufficient history before ${startDate}: ${names.join(", ")}. ` +
          `That allocated weight was left as uninvested cash (${(residual * 100).toFixed(1)}% of the portfolio), not redistributed to the other indices.`
      );
    }
    if (excludedBenchmarkCode) {
      const label = (hState.manifest.indices.find((i) => i.code === excludedBenchmarkCode) || {}).name || excludedBenchmarkCode;
      lines.push(`Benchmark "${label}" also lacks history before ${startDate} — not shown on the chart.`);
    }
    box.innerHTML = lines.map((l) => `<div class="notice">${l}</div>`).join("");
  }

  // ---- charts -------------------------------------------------------------
  function renderEquityChart(curve, benchCurve, dd, benchmarkCode, benchmarkIncluded) {
    const labels = curve.map((p) => p.date);
    const values = curve.map((p) => p.value);
    const benchValues = benchCurve ? benchCurve.map((p) => p.value) : [];
    const allVals = benchValues.length ? values.concat(benchValues) : values;
    const yMax = Math.max.apply(null, allVals) * 1.04;
    const yMin = Math.min.apply(null, allVals) * 0.96;

    const inBand = (d) => dd.peakDate != null && d >= dd.peakDate && d <= dd.troughDate;
    const datasets = [
      {
        label: "Drawdown", type: "bar", data: labels.map((d) => (inBand(d) ? yMax : null)),
        base: yMin, backgroundColor: "rgba(150,53,39,.12)", borderWidth: 0,
        barPercentage: 1.0, categoryPercentage: 1.0, order: 10,
      },
      {
        label: "Your portfolio", data: values, borderColor: "var(--accent)",
        backgroundColor: "rgba(156,107,46,.12)", borderWidth: 2.2, fill: true, pointRadius: 0, tension: .1, order: 1,
      },
    ];
    if (benchmarkIncluded) {
      const benchName = ((hState.manifest.indices.find((i) => i.code === benchmarkCode)) || {}).name || benchmarkCode;
      datasets.push({
        label: benchName, data: benchValues, borderColor: "var(--neutral)",
        borderWidth: 1.6, borderDash: [5, 3], fill: false, pointRadius: 0, tension: .1, order: 2,
      });
    }
    const opts = {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: true, position: "top",
          labels: { color: "#6b6153", font: { family: "EB Garamond", size: 11 }, boxWidth: 18,
            filter: (item) => item.text !== "Drawdown" } },
        tooltip: { enabled: true, filter: (item) => item.dataset.label !== "Drawdown" },
      },
      scales: {
        x: { ticks: { color: "#9a8f79", maxTicksLimit: 8, font: { family: "EB Garamond" } }, grid: { color: "rgba(43,36,26,.06)" } },
        y: { min: yMin, max: yMax, ticks: { color: "#9a8f79", font: { family: "EB Garamond" } }, grid: { color: "rgba(43,36,26,.08)" } },
      },
      animation: { duration: 450, easing: "easeOutQuart" },
    };
    const ctx = document.getElementById("hs-equity-chart");
    if (equityChart) { equityChart.data = { labels, datasets }; equityChart.options = opts; equityChart.update(); return; }
    equityChart = new Chart(ctx, { type: "line", data: { labels, datasets }, options: opts });
  }

  function renderStats(stats, initialAmount, curve, riskFreePct) {
    const finalValue = curve[curve.length - 1].value;
    const dd = stats.maxDrawdown;
    const items = [
      ["Final value", fmtMoney(finalValue), fmtPct(finalValue / initialAmount - 1)],
      ["CAGR", fmtPct(stats.cagr), ""],
      ["Annualized volatility", fmtPct1(stats.annualizedVol), ""],
      ["Sharpe", stats.sharpe.toFixed(2), `rf ${riskFreePct.toFixed(1)}%/yr`],
      ["Max drawdown", fmtPct(dd.pct), dd.peakDate ? `${dd.peakDate} → ${dd.troughDate}` : ""],
    ];
    const row = document.getElementById("hs-stats");
    row.innerHTML = items.map(([label, val, sub]) => {
      const subCls = sub.startsWith("+") ? "pos" : sub.startsWith("-") ? "neg" : "";
      return `<div class="stat">
        <div class="stat-label">${label}</div>
        <div class="stat-value">${val}${sub ? ` <span class="small ${subCls}">${sub}</span>` : ""}</div>
      </div>`;
    }).join("");
  }

  function renderYearTable(rows) {
    const wrap = document.getElementById("hs-year-table-wrap");
    if (!rows.length) { wrap.innerHTML = ""; return; }
    wrap.innerHTML = `
      <table class="year-table">
        <thead><tr><th>Year</th><th>Return</th></tr></thead>
        <tbody>
          ${rows.map((r) => `<tr><td>${r.year}</td><td class="${r.return >= 0 ? "pos" : "neg"}">${fmtPct(r.return)}</td></tr>`).join("")}
        </tbody>
      </table>`;
  }

  function renderScatter(portfolioCodes, weights, sliced, residual) {
    const note = document.getElementById("hs-scatter-note");
    if (portfolioCodes.length < 2) {
      note.textContent = "Pick at least two invested indices to see the risk/return scatter.";
      if (scatterChart) { scatterChart.destroy(); scatterChart = null; }
      return;
    }
    note.textContent = "A poor-man's efficient frontier: each faint dot is a random split across your invested indices; your portfolio is the highlighted one.";

    const returnsByCode = {};
    portfolioCodes.forEach((c) => { returnsByCode[c] = Backtest.simpleReturns(sliced.closes[c]); });
    const meanReturns = Backtest.annualizedMeanReturns(returnsByCode);
    const cov = Backtest.covarianceMatrix(returnsByCode);

    // the random cloud stays fully-invested across the chosen indices; the
    // user's own point additionally reflects any uninvested-cash residual
    // (0 return, 0 vol, 0 covariance) so it honestly sits lower/left when
    // an index got excluded rather than silently renormalized away.
    let meanForPoint = meanReturns, covForPoint = cov;
    if (residual > 1e-9) {
      meanForPoint = Object.assign({}, meanReturns, { CASH: 0 });
      covForPoint = {};
      const allCodes = portfolioCodes.concat(["CASH"]);
      allCodes.forEach((a) => {
        covForPoint[a] = {};
        allCodes.forEach((b) => {
          covForPoint[a][b] = (a === "CASH" || b === "CASH") ? 0 : cov[a][b];
        });
      });
    }

    const cloud = Backtest.randomPortfolios(portfolioCodes, meanReturns, cov, 2000);
    const userStats = Backtest.portfolioStats(weights, meanForPoint, covForPoint);

    const cloudPoints = cloud.map((p) => ({ x: p.vol * 100, y: p.return * 100 }));
    const datasets = [
      { label: "Random portfolios", data: cloudPoints, backgroundColor: "rgba(43,36,26,.16)",
        pointRadius: 2.5, pointHoverRadius: 3, order: 2 },
      { label: "Your portfolio", data: [{ x: userStats.vol * 100, y: userStats.return * 100 }],
        backgroundColor: "var(--accent)", borderColor: "var(--accent)", pointRadius: 7, pointHoverRadius: 8, order: 1 },
    ];
    const opts = {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: {
        legend: { display: true, position: "top", labels: { color: "#6b6153", font: { family: "EB Garamond", size: 11 }, boxWidth: 18 } },
        tooltip: { callbacks: { label: (c) => `vol ${c.parsed.x.toFixed(1)}%, return ${c.parsed.y.toFixed(1)}%` } },
      },
      scales: {
        x: { title: { display: true, text: "Annualized volatility", color: "#9a8f79", font: { family: "EB Garamond" } },
          ticks: { color: "#9a8f79", font: { family: "EB Garamond" }, callback: (v) => v + "%" }, grid: { color: "rgba(43,36,26,.06)" } },
        y: { title: { display: true, text: "Annualized return", color: "#9a8f79", font: { family: "EB Garamond" } },
          ticks: { color: "#9a8f79", font: { family: "EB Garamond" }, callback: (v) => v + "%" }, grid: { color: "rgba(43,36,26,.08)" } },
      },
    };
    const ctx = document.getElementById("hs-scatter-chart");
    if (scatterChart) { scatterChart.data = { datasets }; scatterChart.options = opts; scatterChart.update(); return; }
    scatterChart = new Chart(ctx, { type: "scatter", data: { datasets }, options: opts });
  }

  // ---- tab activation -------------------------------------------------------
  document.getElementById("tab-btn-hindsight").addEventListener("click", () => {
    ensureLoaded();
    if (equityChart) equityChart.resize();
    if (scatterChart) scatterChart.resize();
  });
})();

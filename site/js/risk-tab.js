/* risk-tab.js — "Risk" tab UI wiring. DOM + Chart.js only; all math lives in
   risk.js and backtest.js (pure, unit-tested separately). Mirrors
   hindsight.js's fetch/cache pattern against the same site/data/*.json, and
   keeps its own local state so tabs stay decoupled (no modules/bundler in
   this project, so no shared imports between scripts). */
(function () {
  "use strict";

  const CORR_WINDOWS = [90, 252, 756]; // 90D / 1Y / 3Y, in trading days

  const rState = {
    manifest: null,
    cache: {},              // code -> full index json ({series:[{d,c}], ...})
    loaded: false,
    corrReturnsByCode: null, // all-15-index date-aligned daily returns, full length
    volCache: {},            // code -> { dates, vol30, vol90 }
    volMiniCharts: {},
    corrWindow: 90,
    weights: null,           // code -> fraction (0-1), null until set
    weightsSource: "default",
  };
  let volChart, varChart;

  const fmtPct = (n) => (n >= 0 ? "+" : "") + (n * 100).toFixed(2) + "%";
  const fmtPct1 = (n) => (n >= 0 ? "+" : "") + (n * 100).toFixed(1) + "%";

  // Canvas 2D cannot resolve CSS custom properties (ctx.strokeStyle =
  // "var(--accent)" silently falls back to black) — unlike a DOM element's
  // style, a bare string handed to the canvas API has no cascade to resolve
  // against. Chart.js just forwards whatever string it's given straight to
  // the canvas context, so its color options need an already-resolved hex.
  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  // ---- boot (lazy: only fetches once the Risk tab is first opened) ---------
  async function ensureLoaded() {
    if (rState.loaded) return;
    const manifest = await fetch("data/manifest.json").then((r) => r.json());
    rState.manifest = manifest;
    const codes = manifest.indices.map((m) => m.code);
    const jsons = await Promise.all(codes.map(getIndex));
    codes.forEach((c, i) => {
      rState.cache[c] = jsons[i];
    });

    setDefaultWeights(codes);
    buildVolIndexSelect(manifest.indices);
    computeCorrReturns();
    renderCorrHeatmap(rState.corrWindow);
    renderVolSingle(document.getElementById("risk-vol-index").value);
    renderWeightsNote();

    document.getElementById("risk-corr-window").addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      document.querySelectorAll("#risk-corr-window button").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      rState.corrWindow = parseInt(btn.dataset.window, 10);
      renderCorrHeatmap(rState.corrWindow);
    });
    document.getElementById("risk-vol-index").addEventListener("change", (e) => {
      renderVolSingle(e.target.value);
    });
    document.getElementById("risk-vol-smallmult").addEventListener("change", (e) => {
      toggleVolSmallMultiples(e.target.checked);
    });
    // (the "use Backtester's weights" button's click listener is bound inside
    // renderWeightsNote() itself, since that function replaces the button node
    // via innerHTML every time it re-renders — binding it here too would double it up)
    document.getElementById("risk-run-var").addEventListener("click", runVaR);

    rState.loaded = true;
    // if this load was triggered by "Send weights to Risk" (weights arrived
    // before rState.loaded was true, so receiveWeightsFromHindsight's own
    // auto-run was skipped), run VaR now so that button's promise of showing
    // results immediately holds on a first-ever visit to this tab too.
    if (rState.weightsSource === "hindsight") runVaR();
  }

  async function getIndex(code) {
    if (rState.cache[code]) return rState.cache[code];
    const res = await fetch(`data/indices/${code}.json`);
    if (!res.ok) throw new Error(`Failed to load ${code} (HTTP ${res.status})`);
    const data = await res.json();
    rState.cache[code] = data;
    return data;
  }

  function toSeries(json) {
    return { dates: json.series.map((p) => p.d), closes: json.series.map((p) => p.c) };
  }

  // ---- weights (shared with Hindsight) --------------------------------------
  function setDefaultWeights(codes) {
    if (rState.weights) return; // don't clobber a weight mix already sent from Hindsight
    const w = {};
    codes.forEach((c) => {
      w[c] = 1 / codes.length;
    });
    rState.weights = w;
    rState.weightsSource = "default";
  }

  // hState.weights from Hindsight are integer percents (0-100); convert to
  // fractions here so risk.js's math functions only ever see 0-1 weights.
  function receiveWeightsFromHindsight(percentWeights) {
    const w = {};
    Object.keys(percentWeights).forEach((c) => {
      w[c] = percentWeights[c] / 100;
    });
    rState.weights = w;
    rState.weightsSource = "hindsight";
    renderWeightsNote();
    if (rState.loaded) runVaR();
  }

  function renderWeightsNote() {
    const el = document.getElementById("risk-var-weights-note");
    if (!el) return;
    const linkHtml = '<button type="button" class="link-btn" id="risk-use-hs-weights">Use the Backtester tab\'s current weights</button>';
    el.innerHTML = rState.weightsSource === "hindsight"
      ? `Using the Backtester tab's current weight mix. ${linkHtml}`
      : `Default: equal-weight across all fifteen indices. ${linkHtml}`;
    // innerHTML above replaces the button node, so its click listener (bound
    // once in ensureLoaded) is gone — rebind on the fresh node each render.
    document.getElementById("risk-use-hs-weights").addEventListener("click", async () => {
      if (window.Hindsight) {
        await window.Hindsight.ensureLoaded();
        receiveWeightsFromHindsight(window.Hindsight.getWeights());
      }
    });
  }

  // ---- correlation matrix -----------------------------------------------
  function computeCorrReturns() {
    const codes = rState.manifest.indices.map((m) => m.code);
    const seriesByCode = {};
    codes.forEach((c) => {
      seriesByCode[c] = toSeries(rState.cache[c]);
    });
    const aligned = Backtest.alignOnIntersection(seriesByCode);
    const returnsByCode = {};
    codes.forEach((c) => {
      returnsByCode[c] = Backtest.simpleReturns(aligned.closes[c]);
    });
    rState.corrReturnsByCode = returnsByCode;
  }

  // house diverging scale: bear (negative) <-> surface-2 (zero) <-> bull (positive)
  const CORR_BEAR = [150, 53, 39];
  const CORR_NEUTRAL = [243, 236, 220];
  const CORR_BULL = [38, 107, 67];
  function corrCellColor(v) {
    const t = Math.min(1, Math.abs(v));
    const pole = v < 0 ? CORR_BEAR : CORR_BULL;
    const rgb = CORR_NEUTRAL.map((c, i) => Math.round(c + (pole[i] - c) * t));
    const lum = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
    return { css: `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`, text: lum > 0.6 ? "var(--ink)" : "#fff" };
  }

  function getTooltip() {
    let el = document.getElementById("risk-tooltip");
    if (!el) {
      el = document.createElement("div");
      el.id = "risk-tooltip";
      el.className = "risk-tooltip";
      document.body.appendChild(el);
    }
    return el;
  }
  function showTooltip(x, y, text) {
    const el = getTooltip();
    el.textContent = text;
    el.style.left = `${x + 14}px`;
    el.style.top = `${y + 14}px`;
    el.classList.add("visible");
  }
  function hideTooltip() {
    getTooltip().classList.remove("visible");
  }

  function renderCorrHeatmap(window_) {
    const codes = Object.keys(rState.corrReturnsByCode);
    const sliced = {};
    codes.forEach((c) => {
      sliced[c] = rState.corrReturnsByCode[c].slice(-window_);
    });
    const actualDays = sliced[codes[0]].length;
    const note = document.getElementById("risk-corr-note");
    note.textContent = actualDays < window_
      ? `Only ${actualDays} overlapping trading days are available across all fifteen indices for this window (shorter than the ${window_}-day request) — showing everything available.`
      : `${actualDays.toLocaleString()} overlapping trading days across all fifteen indices.`;

    const { matrix } = Risk.correlationMatrix(sliced);
    const names = rState.manifest.indices.reduce((m, idx) => (m[idx.code] = idx.name, m), {});

    const grid = document.getElementById("risk-corr-heatmap");
    grid.innerHTML = "";
    grid.style.gridTemplateColumns = `90px repeat(${codes.length}, 54px)`;

    const corner = document.createElement("div");
    corner.className = "rh-corner";
    grid.appendChild(corner);
    codes.forEach((c) => {
      const h = document.createElement("div");
      h.className = "rh-colhead";
      h.textContent = c;
      h.title = names[c] || c;
      grid.appendChild(h);
    });

    codes.forEach((rowCode, i) => {
      const rh = document.createElement("div");
      rh.className = "rh-rowhead";
      rh.textContent = rowCode;
      rh.title = names[rowCode] || rowCode;
      grid.appendChild(rh);

      codes.forEach((colCode, j) => {
        const cell = document.createElement("div");
        const v = matrix[i][j];
        const isDiagonal = i === j;
        cell.className = "rh-cell" + (isDiagonal ? " rh-diagonal" : "");
        cell.textContent = v.toFixed(2);
        cell.tabIndex = 0;
        cell.setAttribute("role", "gridcell");
        if (!isDiagonal) {
          const { css, text } = corrCellColor(v);
          cell.style.background = css;
          cell.style.color = text;
        }
        const label = `${names[rowCode] || rowCode} vs ${names[colCode] || colCode}: ${v.toFixed(2)}`;
        cell.setAttribute("aria-label", label);
        cell.addEventListener("pointerenter", (e) => showTooltip(e.clientX, e.clientY, label));
        cell.addEventListener("pointermove", (e) => showTooltip(e.clientX, e.clientY, label));
        cell.addEventListener("pointerleave", hideTooltip);
        cell.addEventListener("focus", () => {
          const r = cell.getBoundingClientRect();
          showTooltip(r.left, r.top, label);
        });
        cell.addEventListener("blur", hideTooltip);
        grid.appendChild(cell);
      });
    });
  }

  // ---- rolling volatility -----------------------------------------------
  function buildVolIndexSelect(indices) {
    const sel = document.getElementById("risk-vol-index");
    sel.innerHTML = "";
    indices.forEach((idx) => {
      const o = document.createElement("option");
      o.value = idx.code;
      o.textContent = idx.name;
      sel.appendChild(o);
    });
    sel.value = indices.some((i) => i.code === "GSPC") ? "GSPC" : indices[0].code;
  }

  // Each index uses its OWN full trading calendar here (not the 15-way
  // intersection) — a single-series stat needs no cross-index alignment, and
  // aligning would needlessly truncate history to whichever index is shortest.
  function getVolSeries(code) {
    if (rState.volCache[code]) return rState.volCache[code];
    const s = toSeries(rState.cache[code]);
    const returns = Backtest.simpleReturns(s.closes);
    const dates = s.dates.slice(1); // returns[i] is the return INTO dates[i+1]
    const vol30 = Risk.rollingAnnualizedVol(returns, 30);
    const vol90 = Risk.rollingAnnualizedVol(returns, 90);
    const out = { dates, vol30, vol90 };
    rState.volCache[code] = out;
    return out;
  }

  function volChartData(code) {
    const { dates, vol30, vol90 } = getVolSeries(code);
    return {
      labels: dates,
      datasets: [
        { label: "30D", data: vol30, borderColor: cssVar("--accent"), borderWidth: 2, pointRadius: 0, tension: .1, spanGaps: false },
        { label: "90D", data: vol90, borderColor: cssVar("--neutral"), borderWidth: 1.6, borderDash: [5, 3], pointRadius: 0, tension: .1, spanGaps: false },
      ],
    };
  }

  function volChartOptions(showLegend) {
    return {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        // Chart.js's own legend stays off here — the shared HTML .legend
        // swatch row above the chart already names the two series (same
        // convention as the Monte Carlo Simulator tab's custom legend).
        legend: { display: false },
        tooltip: { enabled: showLegend, callbacks: { label: (c) => `${c.dataset.label}: ${fmtPct1(c.parsed.y)}` } },
      },
      scales: {
        x: { display: showLegend, ticks: { color: "#9a8f79", maxTicksLimit: 8, font: { family: "EB Garamond" } }, grid: { color: "rgba(43,36,26,.06)" } },
        y: { display: showLegend, ticks: { color: "#9a8f79", font: { family: "EB Garamond" }, callback: (v) => (v * 100).toFixed(0) + "%" }, grid: { color: "rgba(43,36,26,.08)" } },
      },
      animation: { duration: showLegend ? 400 : 0 },
    };
  }

  function renderVolSingle(code) {
    const data = volChartData(code);
    const opts = volChartOptions(true);
    const ctx = document.getElementById("risk-vol-chart");
    if (volChart) { volChart.data = data; volChart.options = opts; volChart.update(); return; }
    volChart = new Chart(ctx, { type: "line", data, options: opts });
  }

  function toggleVolSmallMultiples(on) {
    document.getElementById("risk-vol-single-wrap").hidden = on;
    document.getElementById("risk-vol-grid").hidden = !on;
    if (on) buildVolSmallMultiples();
  }

  function buildVolSmallMultiples() {
    const grid = document.getElementById("risk-vol-grid");
    if (grid.children.length > 0) { // already built — just resize in case it was hidden mid-layout
      Object.values(rState.volMiniCharts).forEach((c) => c.resize());
      return;
    }
    rState.manifest.indices.forEach((idx) => {
      const card = document.createElement("div");
      card.className = "risk-vol-mini";
      card.innerHTML = `
        <div class="risk-vol-mini-title" title="${idx.name}">${idx.name}</div>
        <div class="risk-vol-mini-canvas-wrap"><canvas></canvas></div>`;
      grid.appendChild(card);
      const canvas = card.querySelector("canvas");
      const data = volChartData(idx.code);
      const opts = volChartOptions(false);
      rState.volMiniCharts[idx.code] = new Chart(canvas, { type: "line", data, options: opts });
    });
  }

  // ---- portfolio VaR -------------------------------------------------------
  function renderVarWarnings(html) {
    document.getElementById("risk-var-warnings").innerHTML = html
      ? `<div class="notice notice-bad">${html}</div>` : "";
  }

  function runVaR() {
    renderVarWarnings("");
    const weights = rState.weights;
    const nonzeroCodes = Object.keys(weights).filter((c) => weights[c] > 0);
    if (nonzeroCodes.length === 0) {
      renderVarWarnings("No index has a nonzero weight — nothing to compute.");
      return;
    }

    const seriesByCode = {};
    nonzeroCodes.forEach((c) => {
      seriesByCode[c] = toSeries(rState.cache[c]);
    });
    const aligned = Backtest.alignOnIntersection(seriesByCode);
    if (aligned.dates.length < 30) {
      renderVarWarnings(
        "Fewer than 30 overlapping trading days across the weighted indices — VaR would not be meaningful. " +
        "Pick a different mix (or send a new mix from the Backtester tab)."
      );
      return;
    }

    const returnsByCode = {};
    nonzeroCodes.forEach((c) => {
      returnsByCode[c] = Backtest.simpleReturns(aligned.closes[c]);
    });
    const investedFraction = nonzeroCodes.reduce((s, c) => s + weights[c], 0);
    const residual = 1 - investedFraction;
    const weightsForCalc = Object.assign({}, weights);
    if (residual > 1e-9) {
      returnsByCode.CASH = returnsByCode[nonzeroCodes[0]].map(() => 0);
      weightsForCalc.CASH = residual;
    }

    const portfolioReturns = Risk.weightedPortfolioReturns(returnsByCode, weightsForCalc);
    const var95 = Risk.historicalVaR(portfolioReturns, 0.95);
    const var99 = Risk.historicalVaR(portfolioReturns, 0.99);

    if (residual > 1e-9) {
      renderVarWarnings(
        `${(residual * 100).toFixed(1)}% of the portfolio weight is uninvested and held as 0-return cash ` +
        `(the weighted indices' allocated weights summed to ${(investedFraction * 100).toFixed(1)}%), not redistributed to the others.`
      );
    }

    renderVarStats(var95, var99, portfolioReturns.length, aligned.dates);
    renderVarHistogram(portfolioReturns, var95.var);
  }

  function renderVarStats(var95, var99, n, dates) {
    // these four are always loss-oriented figures (negative, per fmtPct's
    // sign) except in the all-gains edge case the historicalVaR tests cover
    // (see risk.test.js) — color by actual sign rather than assuming negative.
    const items = [
      ["VaR, 95% (1-day)", -var95.var, "worst expected daily loss, 95% confidence"],
      ["CVaR, 95% (Expected Shortfall)", -var95.cvar, "average loss in the worst 5% of days"],
      ["VaR, 99% (1-day)", -var99.var, "worst expected daily loss, 99% confidence"],
      ["CVaR, 99% (Expected Shortfall)", -var99.cvar, "average loss in the worst 1% of days"],
    ];
    const row = document.getElementById("risk-var-stats");
    row.innerHTML = items.map(([label, pct, sub]) => `<div class="stat">
        <div class="stat-label">${label}</div>
        <div class="stat-value ${pct < 0 ? "neg" : "pos"}">${fmtPct(pct)}</div>
        <div class="small muted">${sub}</div>
      </div>`).join("")
      + `<div class="stat">
        <div class="stat-label">Sample</div>
        <div class="stat-value">${n.toLocaleString()} days</div>
        <div class="small muted">${dates[0]} → ${dates[dates.length - 1]}</div>
      </div>`;
  }

  function renderVarHistogram(returns, varThreshold) {
    const { min, width, counts } = Risk.histogram(returns, 30);
    const labels = counts.map((_, i) => fmtPct1(min + width * (i + 0.5)));
    // bins whose upper edge is at or beyond the 95% VaR loss threshold (i.e.
    // return <= -varThreshold) are shaded as the loss tail the VaR describes.
    const colors = counts.map((_, i) => {
      const binUpper = min + width * (i + 1);
      return binUpper <= -varThreshold ? "rgba(150,53,39,.55)" : "rgba(156,107,46,.55)";
    });
    const data = { labels, datasets: [{ label: "Days", data: counts, backgroundColor: colors, borderWidth: 0 }] };
    const opts = {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (c) => `${c.parsed.y} day${c.parsed.y === 1 ? "" : "s"}` } },
      },
      scales: {
        x: { title: { display: true, text: "Daily portfolio return", color: "#9a8f79", font: { family: "EB Garamond" } },
          ticks: { color: "#9a8f79", maxTicksLimit: 10, font: { family: "EB Garamond" } }, grid: { display: false } },
        y: { title: { display: true, text: "Days", color: "#9a8f79", font: { family: "EB Garamond" } },
          ticks: { color: "#9a8f79", font: { family: "EB Garamond" } }, grid: { color: "rgba(43,36,26,.08)" } },
      },
      animation: { duration: 350, easing: "easeOutQuart" },
    };
    const ctx = document.getElementById("risk-var-chart");
    if (varChart) { varChart.data = data; varChart.options = opts; varChart.update(); return; }
    varChart = new Chart(ctx, { type: "bar", data, options: opts });
  }

  // ---- tab activation -------------------------------------------------------
  document.getElementById("tab-btn-risk").addEventListener("click", () => {
    ensureLoaded();
    if (volChart) volChart.resize();
    if (varChart) varChart.resize();
  });

  window.RiskTab = { ensureLoaded, receiveWeightsFromHindsight };
})();

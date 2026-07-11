/* MarketPulse — 100% static. Reads pre-computed JSON; Monte Carlo runs in-browser.
   No API keys, no live server, no per-visitor cost. */

const state = {
  manifest: null, summary: null,
  cache: {},          // code -> full index json (series)
  selected: null,     // code for price chart
  range: 9999,        // days shown
  compare: false,
};
let priceChart, simChart;

// distinct-enough palette for the 15-way "compare all" overlay
const PALETTE = ["#963527","#9c6b2e","#b9902f","#266b43","#3f7d5c","#2f6f79",
  "#3d6a86","#5a5ba8","#7d4f9c","#a84d84","#8a6d3b","#4f7a3a","#b5713a","#556b8d","#93502e"];

// ---- boot -----------------------------------------------------------------
async function boot() {
  try {
    const [manifest, summary] = await Promise.all([
      fetch("data/manifest.json").then(r => r.json()),
      fetch("data/summary.json").then(r => r.json()),
    ]);
    state.manifest = manifest;
    state.summary = summary;
    state.selected = summary.cards[0].code;
    document.getElementById("updated-at").textContent = summary.updated_at || "—";
    renderCards();
    buildSimIndexSelect();
    await loadPriceChart();
    positionIndicatorToActive();
  } catch (e) {
    console.error(e);
    document.getElementById("index-grid").innerHTML =
      "<p class='muted'>Could not load data. If running locally, serve with <code>python -m http.server</code>.</p>";
  }
}

// ---- helpers --------------------------------------------------------------
const fmtNum = n => Number(n).toLocaleString(undefined, { maximumFractionDigits: 2, minimumFractionDigits: 2 });
const pct = n => (n >= 0 ? "+" : "") + Number(n).toFixed(2) + "%";
const cls = n => n > 0.001 ? "pos" : n < -0.001 ? "neg" : "flat";

async function getIndex(code) {
  if (state.cache[code]) return state.cache[code];
  const data = await fetch(`data/indices/${code}.json`).then(r => r.json());
  state.cache[code] = data;
  return data;
}

// ---- index cards ----------------------------------------------------------
function renderCards() {
  const grid = document.getElementById("index-grid");
  grid.innerHTML = "";
  state.summary.cards.forEach((c, i) => {
    const el = document.createElement("div");
    el.className = "index-card" + (c.code === state.selected ? " selected" : "");
    el.style.setProperty("--i", i);
    el.dataset.code = c.code;
    el.innerHTML = `
      <div class="index-name">${c.name} <span class="index-country">· ${c.country}</span></div>
      <div class="index-level">${fmtNum(c.level)}</div>
      <div class="index-changes">
        <span class="${cls(c.change_today)}">${pct(c.change_today)}</span> today
        <span class="sep">·</span>
        <span class="${cls(c.ytd)}">${pct(c.ytd)}</span> YTD
      </div>`;
    el.addEventListener("click", () => selectIndex(c.code));
    grid.appendChild(el);
  });
}

async function selectIndex(code) {
  state.selected = code;
  document.querySelectorAll(".index-card").forEach(el =>
    el.classList.toggle("selected", el.dataset.code === code));
  if (!state.compare) await loadPriceChart();
}

// ---- price history chart --------------------------------------------------
function sliceByRange(series, days) {
  return days >= 9999 ? series : series.slice(-days);
}

async function loadPriceChart() {
  if (state.compare) return loadCompareChart();
  const idx = await getIndex(state.selected);
  const s = sliceByRange(idx.series, state.range);
  document.getElementById("chart-title").textContent = `${idx.name} — Price History`;
  drawPrice({
    labels: s.map(p => p.d),
    datasets: [{
      label: idx.name,
      data: s.map(p => p.c),
      borderColor: "var(--accent)",
      backgroundColor: "rgba(156,107,46,.12)",
      borderWidth: 2, fill: true, pointRadius: 0, tension: .12,
    }]
  }, false);
}

async function loadCompareChart() {
  document.getElementById("chart-title").textContent = "All Indices — rebased to 100";
  const all = await Promise.all(state.manifest.indices.map(m => getIndex(m.code)));
  const datasets = all.map((idx, i) => {
    const s = sliceByRange(idx.series, state.range);
    const base = s[0] ? s[0].c : 1;
    return {
      label: idx.name,
      data: s.map(p => +(p.c / base * 100).toFixed(2)),
      borderColor: PALETTE[i % PALETTE.length],
      borderWidth: 1.4, fill: false, pointRadius: 0, tension: .12,
    };
  });
  // use the longest label set for the x axis
  const longest = all.reduce((a, b) =>
    sliceByRange(b.series, state.range).length > a.length
      ? sliceByRange(b.series, state.range).map(p => p.d) : a, []);
  drawPrice({ labels: longest, datasets }, true);
}

function drawPrice(data, showLegend) {
  const ctx = document.getElementById("price-chart");
  const opts = {
    responsive: true, maintainAspectRatio: false,
    interaction: { mode: "index", intersect: false },
    plugins: {
      legend: { display: showLegend, position: "top",
        labels: { color: "#6b6153", font: { family: "EB Garamond", size: 11 }, boxWidth: 18, usePointStyle: false } },
      tooltip: { enabled: true }
    },
    scales: {
      x: { ticks: { color: "#9a8f79", maxTicksLimit: 8, font: { family: "EB Garamond" } }, grid: { color: "rgba(43,36,26,.06)" } },
      y: { ticks: { color: "#9a8f79", font: { family: "EB Garamond" } }, grid: { color: "rgba(43,36,26,.08)" } }
    },
    animation: { duration: 500, easing: "easeOutQuart" }
  };
  if (priceChart) { priceChart.data = data; priceChart.options = opts; priceChart.update(); return; }
  priceChart = new Chart(ctx, { type: "line", data, options: opts });
}

// ---- Monte Carlo (in-browser) --------------------------------------------
function gaussian() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function quantile(sortedArr, q) {
  const pos = (sortedArr.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  if (lo === hi) return sortedArr[lo];
  return sortedArr[lo] + (sortedArr[hi] - sortedArr[lo]) * (pos - lo);
}

function simulate(spot, mu, sigma, years, paths) {
  const steps = Math.max(2, Math.round(years * 252));
  const dt = 1 / 252;
  const drift = (mu - 0.5 * sigma * sigma) * dt;
  const vol = sigma * Math.sqrt(dt);

  const matrix = new Array(paths);
  const finals = new Float64Array(paths);
  for (let p = 0; p < paths; p++) {
    const row = new Float64Array(steps + 1);
    row[0] = spot;
    let s = spot;
    for (let t = 1; t <= steps; t++) { s *= Math.exp(drift + vol * gaussian()); row[t] = s; }
    matrix[p] = row;
    finals[p] = s;
  }
  const p5 = new Float64Array(steps + 1), p50 = new Float64Array(steps + 1), p95 = new Float64Array(steps + 1);
  const col = new Float64Array(paths);
  for (let t = 0; t <= steps; t++) {
    for (let p = 0; p < paths; p++) col[p] = matrix[p][t];
    col.sort();
    p5[t] = quantile(col, 0.05); p50[t] = quantile(col, 0.50); p95[t] = quantile(col, 0.95);
  }
  let losses = 0;
  for (let p = 0; p < paths; p++) if (finals[p] < spot) losses++;
  // a dozen faint sample paths for texture
  const samples = [];
  for (let k = 0; k < 12; k++) samples.push(matrix[Math.floor(Math.random() * paths)]);
  return { steps, p5, p50, p95, samples, spot,
    pLoss: losses / paths,
    medianEnd: p50[steps], var5: p5[steps], p95End: p95[steps] };
}

async function runSimulation() {
  const code = document.getElementById("sim-index").value;
  const years = parseFloat(document.getElementById("sim-horizon").value);
  const paths = parseInt(document.getElementById("sim-paths").value, 10);
  const idx = await getIndex(code);
  const { mu, sigma } = idx.calibration;
  const spot = idx.level;

  const btn = document.getElementById("run-sim");
  btn.textContent = "Running…"; btn.disabled = true;
  // let the button repaint before the heavy loop
  await new Promise(r => setTimeout(r, 20));
  const res = simulate(spot, mu, sigma, years, paths);
  btn.textContent = "Run simulation"; btn.disabled = false;

  drawSim(res, idx);
  renderSimStats(res, idx, mu, sigma);
}

function drawSim(res, idx) {
  const labels = Array.from({ length: res.steps + 1 }, (_, i) => i);
  const faint = "rgba(43,36,26,.10)";
  const sampleSets = res.samples.map(row => ({
    data: Array.from(row), borderColor: faint, borderWidth: .7,
    pointRadius: 0, fill: false, tension: 0, order: 5 }));
  const datasets = [
    { label: "95th percentile", data: Array.from(res.p95), borderColor: "var(--bull)",
      borderWidth: 1.8, borderDash: [6, 4], pointRadius: 0, fill: false, tension: .1, order: 1 },
    { label: "Median", data: Array.from(res.p50), borderColor: "var(--accent)",
      borderWidth: 2.4, pointRadius: 0, fill: false, tension: .1, order: 0 },
    { label: "5th percentile", data: Array.from(res.p5), borderColor: "var(--bear)",
      borderWidth: 1.8, borderDash: [6, 4], pointRadius: 0, fill: false, tension: .1, order: 1 },
    ...sampleSets,
  ];
  const opts = {
    responsive: true, maintainAspectRatio: false,
    plugins: {
      legend: { display: false },
      tooltip: { filter: item => item.datasetIndex < 3 }
    },
    scales: {
      x: { title: { display: true, text: "Trading days ahead", color: "#9a8f79", font: { family: "EB Garamond" } },
           ticks: { color: "#9a8f79", maxTicksLimit: 10, font: { family: "EB Garamond" } }, grid: { color: "rgba(43,36,26,.06)" } },
      y: { ticks: { color: "#9a8f79", font: { family: "EB Garamond" } }, grid: { color: "rgba(43,36,26,.08)" } }
    },
    animation: { duration: 400, easing: "easeOutQuart" }
  };
  const ctx = document.getElementById("sim-chart");
  if (simChart) { simChart.data = { labels, datasets }; simChart.options = opts; simChart.update(); return; }
  simChart = new Chart(ctx, { type: "line", data: { labels, datasets }, options: opts });
}

function renderSimStats(res, idx, mu, sigma) {
  const chg = v => `${v >= 0 ? "+" : ""}${((v / res.spot - 1) * 100).toFixed(2)}%`;
  const stats = [
    ["Index", idx.name, ""],
    ["Spot", fmtNum(res.spot), ""],
    ["Median outcome", fmtNum(res.medianEnd), chg(res.medianEnd)],
    ["5% VaR level", fmtNum(res.var5), chg(res.var5)],
    ["95th percentile", fmtNum(res.p95End), chg(res.p95End)],
    ["P(loss)", (res.pLoss * 100).toFixed(0) + "%", ""],
    ["Calibration", `μ ${(mu * 100).toFixed(1)}% · σ ${(sigma * 100).toFixed(1)}%`, ""],
  ];
  const row = document.getElementById("sim-stats");
  row.innerHTML = stats.map(([label, val, sub]) => {
    const subCls = sub.startsWith("+") ? "pos" : sub.startsWith("-") ? "neg" : "";
    return `<div class="stat">
      <div class="stat-label">${label}</div>
      <div class="stat-value">${val}${sub ? ` <span class="small ${subCls}">${sub}</span>` : ""}</div>
    </div>`;
  }).join("");
}

function buildSimIndexSelect() {
  const sel = document.getElementById("sim-index");
  sel.innerHTML = "";
  state.summary.cards.forEach(c => {
    const o = document.createElement("option");
    o.value = c.code; o.textContent = `${c.name} · ${c.country}`;
    sel.appendChild(o);
  });
}

// ---- interactions ---------------------------------------------------------
document.getElementById("range-toggle").addEventListener("click", e => {
  const btn = e.target.closest("button"); if (!btn) return;
  document.querySelectorAll("#range-toggle button").forEach(b => b.classList.remove("active"));
  btn.classList.add("active");
  state.range = parseInt(btn.dataset.range, 10);
  loadPriceChart();
});
document.getElementById("compare-all").addEventListener("change", e => {
  state.compare = e.target.checked;
  loadPriceChart();
});
document.getElementById("run-sim").addEventListener("click", runSimulation);

// tabs + sliding indicator
const indicator = document.getElementById("tab-indicator");
function moveIndicator(tab) {
  indicator.style.left = tab.offsetLeft + "px";
  indicator.style.width = tab.offsetWidth + "px";
}
function positionIndicatorToActive() {
  const a = document.querySelector(".tab.active"); if (a) moveIndicator(a);
}
document.querySelectorAll(".tab").forEach(t => {
  t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(x => x.classList.remove("active"));
    document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
    t.classList.add("active");
    document.getElementById(t.dataset.tab).classList.add("active");
    moveIndicator(t);
    // charts need a resize nudge when their panel becomes visible
    if (t.dataset.tab === "overview" && priceChart) priceChart.resize();
    if (t.dataset.tab === "simulator" && simChart) simChart.resize();
  });
});
window.addEventListener("resize", positionIndicatorToActive);

boot();

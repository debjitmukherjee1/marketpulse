# MarketPulse — Executable Plan

**Name:** MarketPulse *("Global index monitor & Monte Carlo simulator.")*
**Author:** Debjit Mukherjee
**Origin:** Turning the MarketPulse dashboard from your LinkedIn post into a real, self-updating GitHub tool — same zero-cost architecture as Meridian, styled as a matching pair.
**Status:** Working scaffold (this repo)

---

## 0. Cost & tokens (read first)

- **$0/day to run.** Hosting is GitHub Pages; the daily refresh runs on GitHub Actions (unlimited minutes for public repos); index data comes from Yahoo Finance's free endpoint (no key, no secrets).
- **Zero Claude/Anthropic tokens in operation.** Unlike Meridian, MarketPulse has **no LLM at all** — it's pure market data plus math. Nothing calls any AI service daily.
- **The simulator is free to re-run infinitely** because the Monte Carlo runs **in the visitor's browser**, not on a server. Every extra visitor and every extra "Run simulation" click costs nothing.

---

## 1. What it is

Three things, faithful to your original screenshots:

1. **Global Index Monitor** — fifteen headline indices as cards (level, today %, YTD %). Click a card to load its history.
2. **Price History** — one index over 1M / 3M / 6M / 1Y / Max, plus a **"Compare all (rebased to 100)"** overlay that normalizes every index to a common start so relative performance is directly comparable.
3. **Monte Carlo Market Simulator** — projects a chosen index forward with Geometric Brownian Motion calibrated to its trailing-1-year drift and volatility, showing 5th / median / 95th percentile bands, a Value-at-Risk downside, and P(loss). Fully interactive: change horizon and path count and re-run live.

The two tools it grew out of are the same in spirit as Meridian — a static site fed by a once-a-day Python job — so the two projects present as a suite.

---

## 2. Why it stays free (the numbers)

| Component | Provider | Free limit | Our use |
|---|---|---|---|
| Hosting | GitHub Pages | 100 GB/mo bandwidth, unlimited static | a few hundred KB of JSON |
| Daily job | GitHub Actions | **Unlimited minutes (public repos)** | ~1–2 min/day |
| Index data | Yahoo Finance chart endpoint | Free, no key | ~15 requests/day |
| Simulation | **Browser (JavaScript)** | Free | runs client-side |

The website never calls an API at runtime — it reads pre-computed JSON — and the simulator is client-side, so **marginal cost per visitor ≈ $0**.

---

## 3. Architecture

```
        ┌──────────────────────────────────────────────┐
        │  GitHub Actions (cron, daily, free)          │
Yahoo ─▶│  fetch_indices.py → daily closes per index   │
        │  run_all.py → level, today%, YTD%,           │
        │               trailing-1yr μ & σ calibration │
        │        writes ▼                              │
        │  site/data/summary.json  (cards)             │
        │  site/data/indices/<CODE>.json  (series+calib)│
        └───────────────────┬──────────────────────────┘
                            │ git push
                            ▼
        ┌──────────────────────────────────────────────┐
        │  GitHub Pages (static, free)                 │
        │  app.js → cards, price chart, compare-all    │
        │        → Monte Carlo GBM runs IN THE BROWSER │
        └──────────────────────────────────────────────┘
```

**Split of labour:** the daily job does the slow, networked part (fetch + calibrate) and freezes it to JSON. The browser does the interactive part (charts + simulation) with zero backend. This is why it's both free and instant for visitors.

---

## 4. The Monte Carlo model (methodology)

Geometric Brownian Motion, one step per trading day:

```
S(t+1) = S(t) · exp( (μ − ½σ²)·dt + σ·√dt·Z ),   Z ~ N(0,1),  dt = 1/252
```

- **μ, σ** are the **annualized** mean and standard deviation of the index's trailing ~252 daily log-returns, recomputed every day by `run_all.py` (`_calibrate`).
- The browser draws `paths` independent trajectories, then at each step takes the 5th / 50th / 95th percentiles → the bands.
- **Reported stats:** median outcome, 5% VaR level (5th-percentile terminal value), 95th percentile, and P(loss) = share of paths ending below spot.
- **Verified:** the simulated terminal median matches the closed-form lognormal median `S·exp((μ−½σ²)T)` within ~3%, percentile ordering always holds, and P(loss) ∈ [0,1]. 1000 paths × 1 year runs in tens of milliseconds.

**Honest limits (stated on the Methodology tab):** GBM assumes constant μ/σ and normal returns; real markets have fat tails and regime shifts. The bands are a calibrated illustration of dispersion, **not a forecast**.

---

## 5. Indices tracked (15)

Original ten — S&P 500, Nasdaq Composite, Dow Jones, FTSE 100, DAX 40, CAC 40, Nikkei 225, Hang Seng, Shanghai Composite, Nifty 50 — plus five additions for wider spread: **Euro Stoxx 50, KOSPI, S&P/ASX 200, S&P/TSX Composite, BSE Sensex**. Edit the list in `pipeline/config.py → INDICES`.

---

## 6. Build phases

- **Phase 0 — repo:** push public repo, enable Pages, done (no keys to configure — Yahoo needs none).
- **Phase 1 — data:** `python run_all.py` generates all JSON. Runs in mock mode offline; set `MARKETPULSE_LIVE=1` for real Yahoo data.
- **Phase 2 — automate:** the `daily-update.yml` cron refreshes and commits daily.
- **Phase 3 — polish:** OpenGraph card, custom domain (optional), LinkedIn launch post that links back to the original screenshots ("I turned this into a live tool").

---

## 7. What's in this scaffold

```
marketpulse/
├── docs/EXECUTABLE_PLAN.md      ← this file
├── site/                        ← GitHub Pages root
│   ├── index.html               ← 3 tabs: Monitor, Simulator, Methodology
│   ├── css/styles.css           ← warm old-money theme (matches Meridian)
│   ├── js/app.js                ← cards, charts, compare-all, in-browser GBM
│   ├── favicon.svg
│   └── data/                    ← sample JSON so it runs NOW
│       ├── manifest.json
│       ├── summary.json         ← the monitor cards
│       └── indices/<CODE>.json  ← per-index series + μ/σ calibration
├── pipeline/
│   ├── config.py                ← the 15 indices, history window
│   ├── fetch_indices.py         ← Yahoo (no key) + mock fallback
│   ├── run_all.py               ← calibrate + write JSON
│   ├── requirements.txt
│   └── SOURCES.md
├── .github/workflows/daily-update.yml
└── README.md
```

Everything runs offline in mock mode: `cd pipeline && python run_all.py`, then serve `site/`. Verified end-to-end — 15 indices, correct calibration, and the Monte Carlo math reconciles with the analytic lognormal median.

---

## 8. Sources (verified July 2026)

- Yahoo Finance chart endpoint (free, no key): https://query1.finance.yahoo.com/v8/finance/chart/^GSPC
- GitHub Pages limits: https://docs.github.com/en/pages/getting-started-with-github-pages/github-pages-limits
- GitHub Actions free & unlimited for public repos: https://docs.github.com/en/actions/concepts/billing-and-usage

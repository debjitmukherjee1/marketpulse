# MarketPulse — Global Index Monitor & Simulator

*Global index monitor & Monte Carlo simulator.*

Fifteen world indices (level, today %, YTD %), a price-history chart with a
"compare all rebased to 100" overlay, and a **live in-browser Monte Carlo
simulator** (GBM calibrated to each index's trailing-1yr drift & volatility).
Refreshed daily. Runs entirely on free tiers.

> Rebuilt from the MarketPulse dashboard on my LinkedIn into a real,
> self-updating GitHub tool — same zero-cost architecture as **Meridian**, and
> styled to match it as a pair.

**→ Full plan & methodology:** [`docs/EXECUTABLE_PLAN.md`](docs/EXECUTABLE_PLAN.md)

## Cost: $0/day, zero Claude tokens
The daily refresh runs on **GitHub's servers** (Actions cron) and pulls from
**Yahoo Finance** (no key). There is **no LLM in this tool at all** — it's pure
market data and math — so nothing calls any AI service, and the Monte Carlo
runs **in your browser**, free to re-run infinitely. Claude was only used to
build it.

## How it stays free
- **Hosting:** GitHub Pages (static)
- **Daily job:** GitHub Actions (unlimited minutes for public repos)
- **Data:** Yahoo Finance chart endpoint — no API key, no secrets
- **Simulation:** Geometric Brownian Motion computed client-side in JavaScript

## Run it locally (no keys needed)
```bash
# 1. generate sample data (mock mode, offline)
cd pipeline
pip install -r requirements.txt
python run_all.py
#    for real data instead:  MARKETPULSE_LIVE=1 python run_all.py

# 2. serve the site
cd ../site
python -m http.server 8000
# open http://localhost:8000
```

## Go live
1. Push this repo to GitHub (public). **No secrets to configure.**
2. Settings → Pages → deploy from `main` → `/site`.
3. `daily-update.yml` refreshes all indices every morning (runs with `MARKETPULSE_LIVE=1`).

## Structure
```
docs/    → the executable plan
site/    → static website (GitHub Pages root); data/ holds per-index JSON
pipeline/→ the daily Python job (Yahoo fetch + μ/σ calibration)
.github/ → the free cron automation
```

⚠️ Educational / research tool. Data is daily, not real-time, from an unofficial
free endpoint. Simulations are illustrative, not forecasts. **Not financial advice.**

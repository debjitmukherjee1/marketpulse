# Data source & cost (MarketPulse)

| Need | Source | Cost | Key? |
|---|---|---|---|
| Index levels + daily history | **Yahoo Finance** chart endpoint | Free, no key | No |
| Hosting | GitHub Pages | Free | No |
| Daily refresh | GitHub Actions (public repo) | Free, unlimited minutes | No |
| Monte Carlo simulation | Runs **in the browser** (JavaScript) | Free | No |

## Notes
- **No API key, no secrets.** Yahoo's chart endpoint (`query1.finance.yahoo.com/v8/finance/chart/<symbol>`) returns daily closes without authentication. We send a normal User-Agent and make ~15 requests once per day — trivially within fair use. It is an *unofficial* endpoint, so the pipeline has a mock fallback and the site keeps yesterday's JSON if a fetch fails.
- **The simulator costs nothing to run repeatedly**: Geometric Brownian Motion is computed client-side from each index's daily-updated `mu`/`sigma` calibration. Users can re-run with different horizons/paths as much as they like — no server, no per-run cost.
- **Zero Claude/Anthropic tokens** in daily operation: there is no LLM in this tool at all. It's pure market data + math.

## Index symbols tracked
^GSPC, ^IXIC, ^DJI, ^FTSE, ^GDAXI, ^FCHI, ^STOXX50E, ^N225, ^HSI, 000001.SS,
^KS11, ^AXJO, ^GSPTSE, ^NSEI, ^BSESN

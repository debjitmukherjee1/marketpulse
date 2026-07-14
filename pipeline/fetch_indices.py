"""
fetch_indices.py — pull daily closes per index.

LIVE:  Yahoo Finance chart endpoint (no API key). One lightweight request per
       index; ~15 requests total, once a day — trivially within fair use.
MOCK:  deterministic synthetic GBM series so the site builds fully offline.

Yahoo chart endpoint:
  https://query1.finance.yahoo.com/v8/finance/chart/^GSPC?range=10y&interval=1d

Note: range=max is NOT used, despite the name suggesting "everything." Yahoo
silently overrides interval=1d for symbols with decades of history (verified:
^GSPC's max-range response comes back with meta.dataGranularity="3mo",
i.e. quarterly bars, silently — same HTTP 200, no error) which corrupts the
trailing-1yr Monte Carlo calibration and the backtester's daily-return math
alike. range=10y is the longest range confirmed (empirically, via
meta.dataGranularity) to still return true daily bars, and 10 years is
comfortably enough history for Hindsight's backtester.
"""
import math
import random
from datetime import datetime, timedelta, timezone

import config

try:
    import requests
except ImportError:
    requests = None

CHART = "https://query1.finance.yahoo.com/v8/finance/chart/{sym}"

# Rough starting levels so the mock data looks plausible per index.
_MOCK_ANCHOR = {
    "^GSPC": 7900, "^IXIC": 36000, "^DJI": 48000, "^FTSE": 8300, "^GDAXI": 27000,
    "^FCHI": 10700, "^STOXX50E": 5300, "^N225": 37000, "^HSI": 21900,
    "000001.SS": 3200, "^KS11": 2700, "^AXJO": 8300, "^GSPTSE": 25000,
    "^NSEI": 16000, "^BSESN": 53000,
}


def _weekday_dates_ending_today(n):
    """n weekday (Mon-Fri) dates ending today, oldest first — approximates a
    trading calendar (no holiday calendar, but skips weekends) so mock series
    span roughly the same ~2yr window as _live_series's n trading-day slice,
    rather than n calendar days (~n/365yr, materially shorter)."""
    dates, d = [], datetime.now(timezone.utc).date()
    while len(dates) < n:
        if d.weekday() < 5:
            dates.append(d)
        d -= timedelta(days=1)
    return list(reversed(dates))


def _mock_series(symbol):
    """Deterministic multi-year daily close series via geometric random walk.
    Spans MOCK_HISTORY_YEARS so run_all.py's weekly-thinning path (for data
    older than DAILY_YEARS) is exercised offline, same as it would be against
    Yahoo's range=max history."""
    rng = random.Random(symbol)
    n = round(config.MOCK_HISTORY_YEARS * config.TRADING_DAYS_YEAR)
    start = _MOCK_ANCHOR.get(symbol, 10000)
    # give each index its own gentle drift + vol so "compare all" looks varied
    mu_d = rng.uniform(-0.0004, 0.0009)     # daily drift
    sig_d = rng.uniform(0.007, 0.016)       # daily vol
    closes, price = [], start
    dates = _weekday_dates_ending_today(n)
    for _ in range(n):
        shock = rng.gauss(mu_d, sig_d)
        price *= math.exp(shock)
        closes.append(round(price, 2))
    return [d.isoformat() for d in dates], closes


def _live_series(symbol):
    params = {"range": "10y", "interval": "1d"}
    headers = {"User-Agent": "Mozilla/5.0 (MarketPulse research tool)"}
    r = requests.get(CHART.format(sym=symbol), params=params, headers=headers, timeout=20)
    r.raise_for_status()
    res = r.json()["chart"]["result"][0]
    ts = res["timestamp"]
    closes = res["indicators"]["quote"][0]["close"]
    dates, out = [], []
    for t, c in zip(ts, closes):
        if c is None:
            continue
        dates.append(datetime.fromtimestamp(t, tz=timezone.utc).date().isoformat())
        out.append(round(c, 2))
    return dates, out


def fetch_series(symbol):
    """Raises on a live-fetch failure — the caller decides the fallback
    (reuse yesterday's committed JSON if one exists, else bootstrap mock),
    so a Yahoo outage can never silently overwrite real data with fabricated
    numbers with no trace of what happened."""
    if config.MOCK_MODE:
        return _mock_series(symbol)
    return _live_series(symbol)

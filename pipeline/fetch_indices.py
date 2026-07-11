"""
fetch_indices.py — pull daily closes per index.

LIVE:  Yahoo Finance chart endpoint (no API key). One lightweight request per
       index; ~15 requests total, once a day — trivially within fair use.
MOCK:  deterministic synthetic GBM series so the site builds fully offline.

Yahoo chart endpoint:
  https://query1.finance.yahoo.com/v8/finance/chart/^GSPC?range=2y&interval=1d
"""
import math
import random
from datetime import datetime, timedelta

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


def _mock_series(symbol):
    """Deterministic ~18-month daily close series via geometric random walk."""
    rng = random.Random(symbol)
    n = config.HISTORY_DAYS
    start = _MOCK_ANCHOR.get(symbol, 10000)
    # give each index its own gentle drift + vol so "compare all" looks varied
    mu_d = rng.uniform(-0.0004, 0.0009)     # daily drift
    sig_d = rng.uniform(0.007, 0.016)       # daily vol
    closes, price = [], start
    today = datetime.utcnow().date()
    dates = [today - timedelta(days=(n - 1 - i)) for i in range(n)]
    for _ in range(n):
        shock = rng.gauss(mu_d, sig_d)
        price *= math.exp(shock)
        closes.append(round(price, 2))
    return [d.isoformat() for d in dates], closes


def _live_series(symbol):
    params = {"range": "2y", "interval": "1d"}
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
        dates.append(datetime.utcfromtimestamp(t).date().isoformat())
        out.append(round(c, 2))
    return dates[-config.HISTORY_DAYS:], out[-config.HISTORY_DAYS:]


def fetch_series(symbol):
    if config.MOCK_MODE:
        return _mock_series(symbol)
    try:
        return _live_series(symbol)
    except Exception as e:
        print(f"[indices] {symbol} live fetch failed ({e}); mock fallback")
        return _mock_series(symbol)

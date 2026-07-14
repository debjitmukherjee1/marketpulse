"""
MarketPulse configuration — global index monitor + Monte Carlo simulator.

Data comes from Yahoo Finance (unofficial chart endpoint, no API key), matching
the zero-cost, no-secrets approach. In MOCK_MODE (default when offline) the
pipeline generates realistic synthetic series so the whole site runs without
any network access.
"""
import os

# --- Indices: (yahoo_symbol, display_name, country) ------------------------
# The original ten from the LinkedIn build, plus five sensible additions
# (Sensex, Euro Stoxx 50, KOSPI, ASX 200, TSX) for wider regional spread.
INDICES = [
    ("^GSPC",     "S&P 500",            "United States"),
    ("^IXIC",     "Nasdaq Composite",   "United States"),
    ("^DJI",      "Dow Jones Industrial","United States"),
    ("^FTSE",     "FTSE 100",           "United Kingdom"),
    ("^GDAXI",    "DAX 40",             "Germany"),
    ("^FCHI",     "CAC 40",             "France"),
    ("^STOXX50E", "Euro Stoxx 50",      "Europe"),
    ("^N225",     "Nikkei 225",         "Japan"),
    ("^HSI",      "Hang Seng",          "Hong Kong"),
    ("000001.SS", "Shanghai Composite", "China"),
    ("^KS11",     "KOSPI",              "South Korea"),
    ("^AXJO",     "S&P/ASX 200",        "Australia"),
    ("^GSPTSE",   "S&P/TSX Composite",  "Canada"),
    ("^NSEI",     "Nifty 50",           "India"),
    ("^BSESN",    "BSE Sensex",         "India"),
]

# --- History window --------------------------------------------------------
# Fetch 10 years of daily closes so Hindsight's backtester has several years
# to work with. NOT range=max: Yahoo silently serves quarterly bars instead
# of daily ones once a symbol's full history gets long (see fetch_indices.py
# for the verified behavior) — range=10y is the longest range confirmed to
# still return true daily bars. To keep repo size bounded, run_all.py thins
# anything older than DAILY_YEARS to one point/week; the trailing DAILY_YEARS
# window stays at full daily resolution (needed by the Monte Carlo
# trailing-1yr calibration and by the backtester).
DAILY_YEARS = 5
TRADING_DAYS_YEAR = 252     # for annualizing drift/vol (Monte Carlo calibration)
MOCK_HISTORY_YEARS = 10     # mock series span, matches the real range=10y fetch

# --- Output ----------------------------------------------------------------
DATA_DIR = os.path.join(os.path.dirname(__file__), "..", "site", "data")

# --- Mode ------------------------------------------------------------------
# Yahoo needs no key; we go "live" whenever network is intended. Set
# MARKETPULSE_LIVE=1 in the GitHub Action; default here is mock for safe
# offline runs.
MOCK_MODE = os.environ.get("MARKETPULSE_LIVE") != "1"

"""
run_all.py — builds site/data for MarketPulse.

For each index it computes, from the daily closes:
  - level        : latest close
  - change_today : latest vs previous close (%)
  - ytd          : latest vs last close of the prior calendar year (%)
  - mu, sigma    : ANNUALIZED trailing-1yr log-return drift & volatility
                   (these calibrate the in-browser Monte Carlo simulator)
and thins history older than DAILY_YEARS to weekly points (see
_thin_history) before writing the series the frontend charts.

Writes:
  site/data/manifest.json          -> index list + updated_at
  site/data/indices/<CODE>.json    -> {meta, series[], calibration}
  site/data/summary.json           -> compact cards payload for the monitor

Usage:  python run_all.py            (mock, offline)
        MARKETPULSE_LIVE=1 python run_all.py   (live, Yahoo)
"""
import json
import math
import os
import re
from datetime import datetime, timezone

import config
import fetch_indices


def _safe_code(symbol):
    """Filesystem/URL-safe id from a Yahoo symbol, e.g. ^GSPC -> GSPC, 000001.SS."""
    return re.sub(r"[^A-Za-z0-9]", "_", symbol).strip("_")


def _thin_history(dates, closes):
    """Keep full daily resolution for the trailing DAILY_YEARS; thin anything
    older (within the fetched 10y window) to one point per ISO week (last
    trading day seen in that week), roughly halving repo size for the older
    half of the window. Leaves the calibration window, change_today, and YTD
    baseline — all within the trailing daily section — untouched."""
    if not dates:
        return dates, closes
    last = datetime.fromisoformat(dates[-1]).date()
    try:
        cutoff = last.replace(year=last.year - config.DAILY_YEARS)
    except ValueError:  # last is Feb 29 and cutoff year isn't a leap year
        cutoff = last.replace(month=2, day=28, year=last.year - config.DAILY_YEARS)

    split = next((i for i, d in enumerate(dates) if datetime.fromisoformat(d).date() >= cutoff), len(dates))
    old_dates, old_closes = dates[:split], closes[:split]
    recent_dates, recent_closes = dates[split:], closes[split:]

    weekly = {}
    for d, c in zip(old_dates, old_closes):
        wk = datetime.fromisoformat(d).isocalendar()[:2]
        weekly[wk] = (d, c)  # later date within the week overwrites, so this keeps the last
    thinned = sorted(weekly.values())

    out_dates = [d for d, _ in thinned] + recent_dates
    out_closes = [c for _, c in thinned] + recent_closes
    return out_dates, out_closes


def _log_returns(closes):
    out = []
    for i in range(1, len(closes)):
        if closes[i - 1] > 0 and closes[i] > 0:
            out.append(math.log(closes[i] / closes[i - 1]))
    return out


def _calibrate(closes):
    """Annualized drift (mu) and volatility (sigma) from trailing ~1yr."""
    window = closes[-(config.TRADING_DAYS_YEAR + 1):]
    r = _log_returns(window)
    if len(r) < 2:
        return 0.0, 0.15
    mean = sum(r) / len(r)
    var = sum((x - mean) ** 2 for x in r) / (len(r) - 1)
    sd = math.sqrt(var)
    mu = mean * config.TRADING_DAYS_YEAR
    sigma = sd * math.sqrt(config.TRADING_DAYS_YEAR)
    return round(mu, 4), round(sigma, 4)


def _ytd_pct(dates, closes):
    latest = closes[-1]
    this_year = datetime.fromisoformat(dates[-1]).year
    # last close of the previous calendar year = baseline
    baseline = None
    for d, c in zip(dates, closes):
        if datetime.fromisoformat(d).year < this_year:
            baseline = c
        else:
            break
    if baseline is None:
        baseline = closes[0]
    return round((latest / baseline - 1) * 100, 2)


def main():
    mode = "MOCK" if config.MOCK_MODE else "LIVE"
    print(f"=== MarketPulse pipeline ({mode}) ===")
    updated = datetime.now(timezone.utc).strftime("%d %b %Y %H:%M UTC")

    idx_dir = os.path.join(config.DATA_DIR, "indices")
    os.makedirs(idx_dir, exist_ok=True)

    manifest = {"updated_at": updated, "indices": []}
    summary = {"updated_at": updated, "cards": []}

    for symbol, name, country in config.INDICES:
        code = _safe_code(symbol)
        prev_path = os.path.join(idx_dir, f"{code}.json")
        source = "mock" if config.MOCK_MODE else "live"

        try:
            dates, closes = fetch_indices.fetch_series(symbol)
            if len(closes) < 30:
                raise ValueError(f"too few points ({len(closes)})")
        except Exception as e:
            # Live fetch failed (or returned too little data): keep yesterday's
            # committed JSON rather than silently overwriting real numbers with
            # a fabricated mock series. Only bootstrap with mock if there is no
            # prior file yet (e.g. very first run).
            if os.path.exists(prev_path):
                print(f"  ! {symbol}: fetch failed ({e}); keeping previous data, marked stale")
                with open(prev_path) as f:
                    prev = json.load(f)
                prev["source"] = "stale"
                with open(prev_path, "w") as f:
                    json.dump(prev, f, separators=(",", ":"))
                manifest["indices"].append({"code": code, "name": name, "country": country})
                summary["cards"].append({
                    "code": code, "name": prev["name"], "country": prev["country"],
                    "level": prev["level"], "change_today": prev["change_today"], "ytd": prev["ytd"],
                    "mu": prev["calibration"]["mu"], "sigma": prev["calibration"]["sigma"],
                    "source": "stale",
                })
                continue
            print(f"  ! {symbol}: fetch failed ({e}); no previous data, bootstrapping with mock")
            dates, closes = fetch_indices._mock_series(symbol)
            source = "mock"

        dates, closes = _thin_history(dates, closes)
        level = closes[-1]
        change_today = round((closes[-1] / closes[-2] - 1) * 100, 2)
        ytd = _ytd_pct(dates, closes)
        mu, sigma = _calibrate(closes)

        series = [{"d": d, "c": c} for d, c in zip(dates, closes)]
        with open(prev_path, "w") as f:
            json.dump({
                "code": code, "symbol": symbol, "name": name, "country": country,
                "level": level, "change_today": change_today, "ytd": ytd,
                "calibration": {"mu": mu, "sigma": sigma},
                "series": series, "source": source,
            }, f, separators=(",", ":"))

        manifest["indices"].append({"code": code, "name": name, "country": country})
        summary["cards"].append({
            "code": code, "name": name, "country": country,
            "level": level, "change_today": change_today, "ytd": ytd,
            "mu": mu, "sigma": sigma, "source": source,
        })
        print(f"  {name:22s} {level:>12,.2f}  today {change_today:+.2f}%  ytd {ytd:+.2f}%  "
              f"mu {mu:+.1%} sigma {sigma:.1%}")

    os.makedirs(config.DATA_DIR, exist_ok=True)
    with open(os.path.join(config.DATA_DIR, "manifest.json"), "w") as f:
        json.dump(manifest, f, indent=2)
    with open(os.path.join(config.DATA_DIR, "summary.json"), "w") as f:
        json.dump(summary, f, indent=2)

    print(f"Wrote {len(manifest['indices'])} indices -> {os.path.normpath(config.DATA_DIR)}")


if __name__ == "__main__":
    main()

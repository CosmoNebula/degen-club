#!/usr/bin/env python3
"""Wallet skill scoring — V2, behavioral + anti-bot-flipper.

Run periodically (cron, every 4-6hr). Computes per-wallet skill scores from
the trades firehose with deliberate filters:

  - HIGH-FREQ filter:    wallets with > 100 trades/day are flagged is_high_freq.
                          These are usually arbitrage/MEV bots. They might pick
                          winners but they enter+exit on a different timescale
                          than our bot, so following them produces noise.
  - FLIPPER filter:      wallets whose MEDIAN hold time is < 60 seconds are
                          flagged is_flipper. They flip for tiny gains we can't
                          replicate at our scale.
  - UNPROFITABLE filter: total_pnl_sol <= 0 → is_unprofitable. Self-evident.

Wallets that pass all three filters AND have skill_score >= 2.0 = "smart money"
candidates we want to track at mint snapshot time.

Score formula:
  skill_score = win_rate * sqrt(min(mints_completed, 200))

The min(n, 200) cap prevents pure-volume bots from dominating the leaderboard.
A bot with 90K trades at 71% win rate now scores 71*14.1 / 100 = ~10 instead
of ~213.

Outlier handling:
  - avg_pnl_pct → median_pnl_pct (one moonshot mint can't inflate the average)
  - We keep total_pnl_sol AS-IS because raw SOL profit IS the actual outcome
    we care about, outliers and all.
"""

import sqlite3
import sys
import time
import math
from pathlib import Path
import numpy as np
import pandas as pd

DB_PATH = Path('/opt/degen-club/data/degen.db')
WINDOW_DAYS = 30
FRESHNESS_HOURS = 6                 # exclude mints last-traded < N hrs ago
MIN_TRADES_FOR_SCORE = 5
SAMPLE_SIZE_CAP = 200               # cap sqrt() benefit at this many mints
HIGH_FREQ_TRADES_PER_DAY = 100
FLIPPER_MEDIAN_HOLD_SEC = 60

def log(msg):
    print(f"[wallet-skill-py] {msg}", flush=True)

def main():
    t0 = time.time()
    now_ms = int(time.time() * 1000)
    since_ms = now_ms - WINDOW_DAYS * 86400 * 1000
    cutoff_ms = now_ms - FRESHNESS_HOURS * 3600 * 1000

    log(f"window={WINDOW_DAYS}d freshness_excl={FRESHNESS_HOURS}h cap={SAMPLE_SIZE_CAP}")
    log("connecting to db")
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("PRAGMA temp_store = FILE")
    conn.execute("PRAGMA cache_size = -262144")

    # Step 1: per-(wallet, mint) round-trip aggregates. SAME SQL as before
    # (proven works, ~30min runtime — we live with it for a recurring 4-6hr job).
    log("aggregating per-(wallet,mint) pairs from 25M trades (this takes ~25min)")
    pairs = pd.read_sql_query(f"""
        SELECT
          wallet,
          mint_address,
          SUM(CASE WHEN is_buy = 1 THEN sol_amount ELSE 0 END) AS sol_in,
          SUM(CASE WHEN is_buy = 0 THEN sol_amount ELSE 0 END) AS sol_out,
          MIN(CASE WHEN is_buy = 1 THEN timestamp END)         AS first_buy_ts,
          MAX(CASE WHEN is_buy = 0 THEN timestamp END)         AS last_sell_ts,
          MAX(timestamp)                                        AS last_ts
        FROM trades
        WHERE is_junk = 0
          AND timestamp > {since_ms}
        GROUP BY wallet, mint_address
        HAVING sol_in > 0
           AND sol_out > 0
           AND last_ts < {cutoff_ms}
    """, conn)
    log(f"pairs loaded: {len(pairs):,}")

    if len(pairs) == 0:
        log("no pairs — nothing to do")
        return

    # Per-pair derived quantities
    pairs['pnl_pct'] = (pairs['sol_out'] - pairs['sol_in']) / pairs['sol_in'] * 100
    pairs['hold_sec'] = (pairs['last_sell_ts'] - pairs['first_buy_ts']) / 1000.0
    pairs['profitable'] = (pairs['sol_out'] > pairs['sol_in']).astype(int)

    # Step 2: per-wallet rollup. pandas median() ignores NaN.
    log("rolling up per-wallet")
    agg = pairs.groupby('wallet').agg(
        mints_completed=('mint_address', 'count'),
        mints_profitable=('profitable', 'sum'),
        total_sol_in=('sol_in', 'sum'),
        total_sol_out=('sol_out', 'sum'),
        median_pnl_pct=('pnl_pct', 'median'),
        median_hold_sec=('hold_sec', 'median'),
    ).reset_index()

    # Filter: must have at least MIN_TRADES_FOR_SCORE completed pairs
    agg = agg[agg['mints_completed'] >= MIN_TRADES_FOR_SCORE].copy()
    log(f"wallets meeting min {MIN_TRADES_FOR_SCORE} trades: {len(agg):,}")

    # Derived
    agg['win_rate'] = agg['mints_profitable'] / agg['mints_completed']
    agg['total_pnl_sol'] = agg['total_sol_out'] - agg['total_sol_in']
    agg['trades_per_day'] = agg['mints_completed'] / WINDOW_DAYS
    agg['skill_score'] = agg['win_rate'] * np.sqrt(np.minimum(agg['mints_completed'], SAMPLE_SIZE_CAP))

    # Behavioral flags (Kara: keep slow disciplined bots, drop fast flippers + high-vol)
    agg['is_high_freq']    = (agg['trades_per_day'] > HIGH_FREQ_TRADES_PER_DAY).astype(int)
    agg['is_flipper']      = (agg['median_hold_sec'] < FLIPPER_MEDIAN_HOLD_SEC).astype(int)
    agg['is_unprofitable'] = (agg['total_pnl_sol'] <= 0).astype(int)

    agg['computed_at'] = now_ms
    agg['window_days'] = WINDOW_DAYS

    log(f"flag counts: high_freq={agg.is_high_freq.sum():,}, flipper={agg.is_flipper.sum():,}, unprofitable={agg.is_unprofitable.sum():,}")

    # Smart-money pool = passes ALL filters AND skill >= 2.0
    smart_money = agg[
        (agg.is_high_freq == 0) &
        (agg.is_flipper == 0) &
        (agg.is_unprofitable == 0) &
        (agg.skill_score >= 2.0)
    ]
    log(f"SMART MONEY POOL: {len(smart_money):,} wallets")
    log(f"  median trades/day: {smart_money.trades_per_day.median():.1f}")
    log(f"  median hold time:  {smart_money.median_hold_sec.median():.0f}s")
    log(f"  median win rate:   {smart_money.win_rate.median()*100:.0f}%")
    log(f"  median net PnL:    {smart_money.total_pnl_sol.median():.2f} SOL")

    # Step 3: rebuild wallet_stats table atomically
    log("rebuilding wallet_stats table")
    cols = ['wallet', 'mints_completed', 'mints_profitable', 'win_rate', 'skill_score',
            'total_sol_in', 'total_sol_out', 'total_pnl_sol',
            'median_pnl_pct', 'median_hold_sec', 'trades_per_day',
            'is_high_freq', 'is_flipper', 'is_unprofitable',
            'computed_at', 'window_days']
    out = agg[cols].copy()

    with conn:
        # Drop+recreate with new schema (idempotent — handles both first-run + re-run)
        conn.execute("DROP TABLE IF EXISTS wallet_stats")
        conn.execute("""
            CREATE TABLE wallet_stats (
                wallet TEXT PRIMARY KEY,
                mints_completed INTEGER NOT NULL,
                mints_profitable INTEGER NOT NULL,
                win_rate REAL,
                skill_score REAL,
                total_sol_in REAL NOT NULL,
                total_sol_out REAL NOT NULL,
                total_pnl_sol REAL,
                median_pnl_pct REAL,
                median_hold_sec REAL,
                trades_per_day REAL,
                is_high_freq INTEGER NOT NULL,
                is_flipper INTEGER NOT NULL,
                is_unprofitable INTEGER NOT NULL,
                computed_at INTEGER NOT NULL,
                window_days INTEGER NOT NULL
            )
        """)
        conn.execute("CREATE INDEX idx_wallet_stats_skill ON wallet_stats(skill_score DESC)")
        conn.execute("CREATE INDEX idx_wallet_stats_flags ON wallet_stats(is_high_freq, is_flipper, is_unprofitable)")
        out.to_sql('wallet_stats', conn, if_exists='append', index=False, chunksize=5000)

    log(f"wrote {len(out):,} wallets to wallet_stats")
    log(f"done in {time.time() - t0:.1f}s")

    # Quick verification: top 10 SMART MONEY (post-filter) by skill_score
    log("\nTOP 10 SMART MONEY (high_freq=0, flipper=0, profitable, skill>=2.0):")
    top10 = smart_money.nlargest(10, 'skill_score')[
        ['wallet', 'mints_completed', 'win_rate', 'skill_score',
         'total_pnl_sol', 'median_pnl_pct', 'median_hold_sec', 'trades_per_day']
    ]
    print(top10.to_string(index=False))

    log("\nTOP 5 BY NET SOL PROFIT (any filter — for comparison):")
    top5_pnl = agg.nlargest(5, 'total_pnl_sol')[
        ['wallet', 'mints_completed', 'win_rate', 'total_pnl_sol',
         'trades_per_day', 'is_high_freq', 'is_flipper']
    ]
    print(top5_pnl.to_string(index=False))

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"ERROR: {e}")
        raise

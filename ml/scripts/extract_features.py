"""
Phase 2B — Feature extraction pipeline.

Reads sqlite (degen.db) and produces training rows: one row per (mint, decision moment).
Each row has features computed from data AVAILABLE AT THAT MOMENT (no look-ahead) and
labels computed from data AFTER that moment.

Decision moments: 60s, 300s (5m), 900s (15m), 3600s (60m) of mint age.

Usage:
    .venv/bin/python scripts/extract_features.py
    .venv/bin/python scripts/extract_features.py --days 7   # only last 7 days of mints
    .venv/bin/python scripts/extract_features.py --out data/features_v2.csv
"""

import argparse
import sqlite3
import time
from collections import Counter
from pathlib import Path

import numpy as np
import pandas as pd

DB_PATH = Path('/Users/karaclaycomb/Desktop/degen-club/data/degen.db')

# Decision moments — age in seconds at which we snapshot the mint
DECISION_MOMENTS_SEC = [60, 300, 900, 3600]

# Mints must be at least this old (so post-snapshot trajectory is fully observed)
MIN_MINT_AGE_HR = 6

# No trade-count filter — dead mints are valid negative training examples.
# (Earlier MIN_TRADES filter biased toward migrators; baseline migration rate
# is ~1.1%, so we want all of those negative cases for the classifier to learn.)


def load_mints(conn, since_ms, until_ms):
    """Load all candidate mints (created in window, old enough)."""
    q = """
        SELECT mint_address, creator_wallet, name, symbol, twitter, telegram, website,
               initial_buy_sol, migrated, rugged, peak_market_cap_sol, created_at
        FROM mints
        WHERE created_at BETWEEN ? AND ?
          AND created_at <= ?  -- min age filter
        ORDER BY created_at ASC
    """
    cutoff_old_enough = int(time.time() * 1000) - MIN_MINT_AGE_HR * 3600 * 1000
    return pd.read_sql_query(q, conn, params=(since_ms, until_ms, cutoff_old_enough))


def load_trades_for_mint(conn, mint_address):
    """Load all trades for one mint, oldest-first."""
    q = """
        SELECT t.timestamp, t.wallet, t.is_buy, t.sol_amount, t.token_amount,
               t.price_sol, t.market_cap_sol,
               COALESCE(w.tracked, 0) AS tracked, COALESCE(w.is_kol, 0) AS is_kol,
               COALESCE(w.bundle_cluster_id, '') AS bundle_id
        FROM trades t LEFT JOIN wallets w ON w.address = t.wallet
        WHERE t.mint_address = ? ORDER BY t.timestamp ASC
    """
    return pd.read_sql_query(q, conn, params=(mint_address,))


def load_creator_stats_at(conn, creator_wallet, before_ms):
    """Creator's track record AT a point in time (no look-ahead)."""
    if not creator_wallet:
        return {'launch_count': 0, 'migrated_count': 0}
    q = """
        SELECT
          (SELECT COUNT(*) FROM mints m
            WHERE m.creator_wallet = ? AND m.created_at < ?) AS launches,
          (SELECT COUNT(*) FROM mints m
            WHERE m.creator_wallet = ? AND m.migrated = 1
              AND COALESCE(m.migrated_at, m.created_at) < ?) AS migrations
    """
    row = conn.execute(q, (creator_wallet, before_ms, creator_wallet, before_ms)).fetchone()
    return {'launch_count': row[0] or 0, 'migrated_count': row[1] or 0}


def compute_snapshot(trades_df, snapshot_ts):
    """Compute features from trades up to (and including) snapshot_ts."""
    sub = trades_df[trades_df['timestamp'] <= snapshot_ts]
    if len(sub) == 0:
        return None
    buys = sub[sub['is_buy'] == 1]
    sells = sub[sub['is_buy'] == 0]
    sol_in = float(buys['sol_amount'].sum())
    sol_out = float(sells['sol_amount'].sum())
    buy_count = int(len(buys))
    sell_count = int(len(sells))
    unique_buyers = int(buys['wallet'].nunique())
    tracked_buyers = int(buys[buys['tracked'] == 1]['wallet'].nunique())
    kol_buyers = int(buys[buys['is_kol'] == 1]['wallet'].nunique())
    bundle_buyers = int(buys[buys['bundle_id'] != '']['wallet'].nunique())
    last_price = float(sub['price_sol'].iloc[-1] or 0)
    last_mcap = float(sub['market_cap_sol'].iloc[-1] or 0)
    peak_mcap = float(sub['market_cap_sol'].max() or 0)
    peak_price = float(sub['price_sol'].max() or 0)
    return {
        'last_price_sol': last_price,
        'last_mcap_sol': last_mcap,
        'peak_mcap_sol_so_far': peak_mcap,
        'peak_price_so_far': peak_price,
        'sol_inflow': sol_in,
        'sol_outflow': sol_out,
        'buy_count': buy_count,
        'sell_count': sell_count,
        'buy_sell_ratio': (buy_count / sell_count) if sell_count > 0 else 99.0,
        'unique_buyers': unique_buyers,
        'tracked_buyers': tracked_buyers,
        'kol_buyers': kol_buyers,
        'bundle_buyers': bundle_buyers,
        'trade_count': buy_count + sell_count,
    }


def compute_labels(trades_df, snapshot_ts, snapshot_price, mint_row):
    """Labels are computed from trades AFTER snapshot_ts."""
    after = trades_df[trades_df['timestamp'] > snapshot_ts]
    migrated = int(mint_row['migrated'] or 0)
    if len(after) == 0 or snapshot_price <= 0:
        return {
            'migrated': migrated,
            'peaked_30': 0,
            'peaked_100': 0,
            'peaked_500': 0,
            'peak_pct_max': 0.0,
        }
    max_price_after = float(after['price_sol'].max() or 0)
    peak_pct = (max_price_after - snapshot_price) / snapshot_price if snapshot_price > 0 else 0.0
    return {
        'migrated': migrated,
        'peaked_30': int(peak_pct >= 0.30),
        'peaked_100': int(peak_pct >= 1.00),
        'peaked_500': int(peak_pct >= 5.00),
        'peak_pct_max': peak_pct,
    }


def extract_one_mint(conn, mint_row, trades_df):
    """For one mint, produce up to len(DECISION_MOMENTS_SEC) feature rows."""
    rows = []
    if len(trades_df) < MIN_TRADES:
        return rows
    created_at = int(mint_row['created_at'])
    creator = mint_row['creator_wallet']
    creator_stats = load_creator_stats_at(conn, creator, created_at)
    name = mint_row['name'] or ''
    symbol = mint_row['symbol'] or ''
    has_twitter = int(bool(mint_row['twitter']))
    has_telegram = int(bool(mint_row['telegram']))
    has_website = int(bool(mint_row['website']))
    initial_buy_sol = float(mint_row['initial_buy_sol'] or 0)
    created_hour_utc = pd.to_datetime(created_at, unit='ms').hour
    created_dow = pd.to_datetime(created_at, unit='ms').dayofweek

    for t_sec in DECISION_MOMENTS_SEC:
        snapshot_ts = created_at + t_sec * 1000
        snap = compute_snapshot(trades_df, snapshot_ts)
        if snap is None:
            continue  # mint didn't have any trades by this moment
        labels = compute_labels(trades_df, snapshot_ts, snap['last_price_sol'], mint_row)
        rows.append({
            'mint_address': mint_row['mint_address'],
            'decision_moment_sec': t_sec,
            'snapshot_ts': snapshot_ts,
            # Static features
            'initial_buy_sol': initial_buy_sol,
            'creator_launch_count': creator_stats['launch_count'],
            'creator_migrated_count': creator_stats['migrated_count'],
            'has_twitter': has_twitter,
            'has_telegram': has_telegram,
            'has_website': has_website,
            'name_length': len(name),
            'symbol_length': len(symbol),
            'created_hour_utc': created_hour_utc,
            'created_dow': created_dow,
            # Dynamic at snapshot
            'age_sec': t_sec,
            'last_price_sol': snap['last_price_sol'],
            'last_mcap_sol': snap['last_mcap_sol'],
            'peak_mcap_sol_so_far': snap['peak_mcap_sol_so_far'],
            'sol_inflow': snap['sol_inflow'],
            'sol_outflow': snap['sol_outflow'],
            'buy_sell_ratio': snap['buy_sell_ratio'],
            'unique_buyers': snap['unique_buyers'],
            'tracked_buyers': snap['tracked_buyers'],
            'kol_buyers': snap['kol_buyers'],
            'bundle_buyers': snap['bundle_buyers'],
            'trade_count': snap['trade_count'],
            'trades_per_min': snap['trade_count'] / max(1, t_sec / 60),
            # Labels
            'migrated': labels['migrated'],
            'peaked_30': labels['peaked_30'],
            'peaked_100': labels['peaked_100'],
            'peaked_500': labels['peaked_500'],
            'peak_pct_max': labels['peak_pct_max'],
        })
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--days', type=int, default=14, help='look-back window in days')
    ap.add_argument('--out', type=str, default='data/features.csv')
    ap.add_argument('--limit', type=int, default=0, help='cap mints (0 = no cap)')
    args = ap.parse_args()

    out_path = Path(__file__).parent.parent / args.out
    out_path.parent.mkdir(parents=True, exist_ok=True)

    now_ms = int(time.time() * 1000)
    since_ms = now_ms - args.days * 24 * 3600 * 1000
    until_ms = now_ms

    print(f'[extract] DB: {DB_PATH}')
    print(f'[extract] window: last {args.days} days')
    print(f'[extract] decision moments: {DECISION_MOMENTS_SEC}s')
    print(f'[extract] min mint age: {MIN_MINT_AGE_HR}h')

    conn = sqlite3.connect(str(DB_PATH))
    conn.row_factory = sqlite3.Row

    print('[extract] loading mints...')
    mints = load_mints(conn, since_ms, until_ms)
    print(f'[extract] {len(mints)} candidate mints')

    if args.limit > 0:
        mints = mints.head(args.limit)
        print(f'[extract] capped to {len(mints)}')

    all_rows = []
    t0 = time.time()
    for i, mint_row in mints.iterrows():
        try:
            trades_df = load_trades_for_mint(conn, mint_row['mint_address'])
            rows = extract_one_mint(conn, mint_row, trades_df)
            all_rows.extend(rows)
        except Exception as e:
            print(f'[extract] err on {mint_row["mint_address"][:8]}…: {e}')
        if (i + 1) % 500 == 0:
            elapsed = time.time() - t0
            rate = (i + 1) / elapsed
            eta = (len(mints) - i - 1) / rate
            print(f'[extract] {i+1}/{len(mints)} mints · {len(all_rows)} rows · {rate:.0f}/s · ETA {eta:.0f}s')

    conn.close()
    df = pd.DataFrame(all_rows)
    print(f'\n[extract] DONE: {len(df)} feature rows from {len(mints)} mints in {time.time()-t0:.1f}s')

    if len(df) == 0:
        print('[extract] no rows to write — exiting')
        return

    df.to_csv(out_path, index=False)
    print(f'[extract] saved → {out_path}')

    # Quick sanity prints
    print('\n=== summary ===')
    print(f"rows: {len(df)} · mints: {df['mint_address'].nunique()}")
    print('\nlabel rates:')
    for col in ['migrated', 'peaked_30', 'peaked_100', 'peaked_500']:
        rate = df[col].mean() * 100
        print(f'  {col:14s}: {rate:5.1f}%')
    print('\nfeature stats (top 5 means):')
    static_features = ['initial_buy_sol', 'creator_launch_count', 'creator_migrated_count',
                       'unique_buyers', 'trade_count', 'trades_per_min', 'sol_inflow']
    print(df[static_features].describe().round(2).T[['mean', 'std', 'min', 'max']])


if __name__ == '__main__':
    main()

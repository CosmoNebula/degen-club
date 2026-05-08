"""
Phase 2B (revised) — Extract labeled training data from ml_mint_snapshots.

Reads the forward-collected snapshot table (populated by the bot's snapshot
sweeper + label resolver), writes a CSV ready for training.

Only rows with labels_resolved_at IS NOT NULL are exported by default — those
are snapshots whose mint trajectory has played out enough to know the outcome.

Usage:
    .venv/bin/python scripts/extract_from_snapshots.py
    .venv/bin/python scripts/extract_from_snapshots.py --target migrated
    .venv/bin/python scripts/extract_from_snapshots.py --include-unresolved
    .venv/bin/python scripts/extract_from_snapshots.py --age 60 300  # only specific snapshot ages
"""

import argparse
import sqlite3
from pathlib import Path

import pandas as pd

DB_PATH = Path('/Users/karaclaycomb/Desktop/degen-club/data/degen.db')

FEATURE_COLS = [
    'snapshot_age_sec',  # which decision moment (60/300/900/3600)
    # Static features (per mint)
    'initial_buy_sol',
    'creator_launch_count',
    'creator_migrated_count',
    'has_twitter',
    'has_telegram',
    'has_website',
    'name_length',
    'symbol_length',
    'created_hour_utc',
    'created_dow',
    # Dynamic features (per snapshot)
    'last_price_sol',
    'last_mcap_sol',
    'peak_mcap_sol_so_far',
    'v_sol_in_curve',
    'sol_inflow',
    'sol_outflow',
    'buy_count',
    'sell_count',
    'buy_sell_ratio',
    'unique_buyers',
    'tracked_buyers',
    'kol_buyers',
    'bundle_buyers',
    'trade_count',
    'trades_per_min',
    'volatility_pct',
    'sandwich_risk',
    'reaction_speed_ms',
    # Network features (per snapshot)
    'rpc_latency_p90_ms',
    'priority_fee_p90',
]

LABEL_COLS = [
    'migrated',
    'peaked_30', 'peaked_100', 'peaked_300', 'peaked_500',
    'peak_pct_max',
    'time_to_peak_sec',
    'will_die_fast',
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', type=str, default='data/training.csv')
    ap.add_argument('--include-unresolved', action='store_true',
                    help='Include snapshots with no labels yet (NaN labels)')
    ap.add_argument('--age', type=int, nargs='+', default=None,
                    help='Filter by snapshot_age_sec (default: all)')
    ap.add_argument('--target', type=str, default=None,
                    help='Filter to specific label (drops rows where target is null)')
    args = ap.parse_args()

    out_path = Path(__file__).parent.parent / args.out
    out_path.parent.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(str(DB_PATH))
    cols = ['mint_address', 'snapshot_ts'] + FEATURE_COLS + LABEL_COLS + ['labels_resolved_at']
    where = []
    params = []
    if not args.include_unresolved:
        where.append('labels_resolved_at IS NOT NULL')
    if args.age:
        where.append(f'snapshot_age_sec IN ({",".join("?" * len(args.age))})')
        params.extend(args.age)
    where_clause = ' WHERE ' + ' AND '.join(where) if where else ''
    q = f"SELECT {','.join(cols)} FROM ml_mint_snapshots{where_clause} ORDER BY snapshot_ts ASC"
    print(f'[extract] reading: {DB_PATH}')
    print(f'[extract] query: {q}')
    df = pd.read_sql_query(q, conn, params=params)
    conn.close()

    print(f'[extract] rows: {len(df)}')
    if len(df) == 0:
        print('[extract] no rows — exiting (write empty file for smoke test)')
        df.to_csv(out_path, index=False)
        return

    if args.target:
        before = len(df)
        df = df.dropna(subset=[args.target])
        print(f'[extract] filtered to non-null {args.target}: {before} -> {len(df)}')

    df.to_csv(out_path, index=False)
    print(f'[extract] saved → {out_path}')

    print('\n=== summary ===')
    print(f"snapshots: {len(df)}  ·  unique mints: {df['mint_address'].nunique()}")
    print(f"date range: {pd.to_datetime(df['snapshot_ts'].min(), unit='ms')} → {pd.to_datetime(df['snapshot_ts'].max(), unit='ms')}")
    if 'snapshot_age_sec' in df:
        print('\nby age:')
        print(df['snapshot_age_sec'].value_counts().sort_index().to_string())
    print('\nlabel rates:')
    for col in LABEL_COLS:
        if col in df.columns and not df[col].isna().all():
            if col in ('peak_pct_max', 'time_to_peak_sec'):
                vals = df[col].dropna()
                print(f'  {col:18s}: mean={vals.mean():.3f}  median={vals.median():.3f}  max={vals.max():.2f}  n={len(vals)}')
            else:
                rate = df[col].mean() * 100
                print(f'  {col:18s}: {rate:5.2f}%  (n_pos={int(df[col].sum())})')
    print('\nfeature null counts (highest):')
    nulls = df[FEATURE_COLS].isna().sum()
    nulls = nulls[nulls > 0].sort_values(ascending=False)
    if len(nulls) > 0:
        print(nulls.to_string())
    else:
        print('  (none)')


if __name__ == '__main__':
    main()

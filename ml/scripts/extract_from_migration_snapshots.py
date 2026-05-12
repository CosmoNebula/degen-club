"""
Extract labeled training data from ml_migration_snapshots — the POST-MIGRATION
ML domain. This is a separate game from pre-mig (different features, different
labels, different time horizons).

Snapshot ages captured: 0, 30, 60, 360, 720, 1440 min after migration.
Labels resolve at 24h+ post-migration (the migration-snapshot resolver writes
the same labels to all age rows of the same mint — features differ by age,
labels do not).

Usage:
    .venv/bin/python scripts/extract_from_migration_snapshots.py
    .venv/bin/python scripts/extract_from_migration_snapshots.py --target post_mig_hits_2x
    .venv/bin/python scripts/extract_from_migration_snapshots.py --age 0   # only at-migration snapshots
"""

import argparse
import sqlite3
from pathlib import Path

import os
import pandas as pd

DB_PATH = Path(os.environ.get('DEGEN_DB_PATH', '/Users/karaclaycomb/dev/degen-club/data/degen.db'))

FEATURE_COLS = [
    'snapshot_age_min',
    'current_mcap_sol', 'current_price_sol', 'liquidity_usd',
    'amm_volume_h1_usd', 'amm_volume_h24_usd',
    'amm_buys_h24', 'amm_sells_h24',
    'amm_price_change_h1', 'amm_price_change_h24',
    'window_buys', 'window_sells', 'window_unique_buyers',
    'window_tracked_buyers', 'window_kol_buyers',
    'pct_from_migration', 'peak_pct_so_far',
    'pre_mig_age_min',
    'pre_mig_peak_mcap_sol',
    'pre_mig_unique_buyers', 'pre_mig_trade_count',
    'pre_mig_buy_count', 'pre_mig_sell_count', 'pre_mig_buy_sell_ratio',
    'pre_mig_tracked_buyers', 'pre_mig_kol_buyers', 'pre_mig_bundle_buyers',
    'pre_mig_volatility_pct', 'pre_mig_sandwich_risk',
    'pre_mig_creator_launches', 'pre_mig_creator_migrations',
    'has_twitter', 'has_telegram', 'has_website',
    'name_length', 'symbol_length',
    'migration_hour_utc', 'migration_dow',
    'amm_initial_liquidity_usd',
]

LABEL_COLS = [
    'post_mig_peak_mcap_sol', 'post_mig_peak_pct',
    'post_mig_hits_2x', 'post_mig_hits_5x', 'post_mig_hits_10x',
    'post_mig_hits_1m_usd',
    'post_mig_rugs_1h',
    'post_mig_alive_24h', 'post_mig_alive_72h',
    'post_mig_volume_24h_usd', 'post_mig_max_liquidity_usd',
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', type=str, default='data/training_postmig.csv')
    ap.add_argument('--include-unresolved', action='store_true',
                    help='Include rows where labels_resolved_at IS NULL')
    ap.add_argument('--age', type=int, nargs='+', default=None,
                    help='Filter by snapshot_age_min (default: all)')
    ap.add_argument('--target', type=str, default=None,
                    help='Filter to non-null target rows')
    args = ap.parse_args()

    out_path = Path(__file__).parent.parent / args.out
    out_path.parent.mkdir(parents=True, exist_ok=True)

    # Read-only WAL mode — non-blocking vs live bot writes
    conn = sqlite3.connect(f'file:{DB_PATH}?mode=ro', uri=True)
    cols = ['mint_address', 'migrated_at', 'snapshot_ts'] + FEATURE_COLS + LABEL_COLS + ['labels_resolved_at']

    # Forward-fill pre-mig features from the age=0 anchor row to all later ages
    # of the same mint. This way every row sees the at-migration context — the
    # model isn't forced to learn "post-mig features only" for non-anchor rows.
    # We do this via a self-JOIN to the age=0 row.
    pre_mig_cols = [c for c in FEATURE_COLS if c.startswith('pre_mig_') or c in (
        'has_twitter', 'has_telegram', 'has_website', 'name_length',
        'symbol_length', 'migration_hour_utc', 'migration_dow',
        'amm_initial_liquidity_usd',
    )]
    other_cols = [c for c in FEATURE_COLS if c not in pre_mig_cols]

    cols_select = ['s.mint_address', 's.migrated_at', 's.snapshot_ts']
    for c in other_cols:
        cols_select.append(f's.{c}')
    for c in pre_mig_cols:
        # Take from anchor row (age=0) if it exists, else from this row
        cols_select.append(f'COALESCE(a.{c}, s.{c}) AS {c}')
    for c in LABEL_COLS + ['labels_resolved_at']:
        cols_select.append(f's.{c}')

    where = []
    params = []
    if not args.include_unresolved:
        where.append('s.labels_resolved_at IS NOT NULL')
    if args.age:
        where.append(f's.snapshot_age_min IN ({",".join("?" * len(args.age))})')
        params.extend(args.age)
    where_clause = ' WHERE ' + ' AND '.join(where) if where else ''
    q = f"""
        SELECT {','.join(cols_select)}
        FROM ml_migration_snapshots s
        LEFT JOIN ml_migration_snapshots a
          ON a.mint_address = s.mint_address AND a.snapshot_age_min = 0
        {where_clause}
        ORDER BY s.snapshot_ts ASC
    """
    print(f'[postmig-extract] reading: {DB_PATH}')
    print(f'[postmig-extract] query (truncated): {q[:200]}…')

    df = pd.read_sql_query(q, conn, params=params)
    conn.close()
    print(f'[postmig-extract] rows: {len(df)}')

    if len(df) == 0:
        df.to_csv(out_path, index=False)
        print('[postmig-extract] no rows — wrote empty file')
        return

    # Cap post_mig_peak_pct at 1000 (100,000%) — same sanity guard as pre-mig
    # peak_pct_max. We've seen post-mig snapshots with 32M% peaks which is a
    # data artifact (near-zero anchor price or precision error). Without this
    # cap, the regression target is dominated by 2-3 outlier rows.
    POSTMIG_PEAK_PCT_CAP = 1000.0
    if 'post_mig_peak_pct' in df.columns:
        n_capped = (df['post_mig_peak_pct'] > POSTMIG_PEAK_PCT_CAP).sum()
        df.loc[df['post_mig_peak_pct'] > POSTMIG_PEAK_PCT_CAP, 'post_mig_peak_pct'] = POSTMIG_PEAK_PCT_CAP
        if n_capped > 0:
            print(f'[postmig-extract] capped {n_capped} bogus post_mig_peak_pct values at {POSTMIG_PEAK_PCT_CAP}')

    if args.target:
        before = len(df)
        df = df.dropna(subset=[args.target])
        print(f'[postmig-extract] filtered to non-null {args.target}: {before} -> {len(df)}')

    df.to_csv(out_path, index=False)
    print(f'[postmig-extract] saved → {out_path}')

    print('\n=== summary ===')
    print(f"snapshots: {len(df)}  ·  unique mints: {df['mint_address'].nunique()}")
    if 'snapshot_age_min' in df:
        print('\nby age:')
        print(df['snapshot_age_min'].value_counts().sort_index().to_string())
    print('\nlabel rates:')
    for col in LABEL_COLS:
        if col in df.columns and not df[col].isna().all():
            if col in ('post_mig_peak_pct', 'post_mig_peak_mcap_sol',
                       'post_mig_volume_24h_usd', 'post_mig_max_liquidity_usd'):
                vals = df[col].dropna()
                print(f'  {col:28s}: mean={vals.mean():.3f}  median={vals.median():.3f}  max={vals.max():.2f}  n={len(vals)}')
            else:
                rate = df[col].mean() * 100
                print(f'  {col:28s}: {rate:5.2f}%  (n_pos={int(df[col].sum())})')


if __name__ == '__main__':
    main()

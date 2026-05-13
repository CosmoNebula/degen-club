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

import os
DB_PATH = Path(os.environ.get('DEGEN_DB_PATH', str(Path(__file__).resolve().parent.parent.parent / 'data' / 'degen.db')))

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
    'top10_buyers',
    'top50_buyers',
    'weighted_buyer_quality',
    'avg_buy_sol',
    'median_buy_sol',
    'p90_buy_sol',
    'max_buy_sol',
    'std_buy_sol',
    'avg_sell_sol',
    'median_sell_sol',
    'p90_sell_sol',
    'max_sell_sol',
    'std_sell_sol',
    'top1_buyer_sol_pct',
    'top3_buyer_sol_pct',
    'top5_buyer_sol_pct',
    'buyer_hhi',
    'top1_seller_sol_pct',
    'top3_seller_sol_pct',
    'top5_seller_sol_pct',
    'seller_hhi',
    'sniper_buyer_count',
    'pct_sniper_buys',
    'first_block_buyer_count',
    'pct_first_block_buys',
    'avg_buyer_rank',
    'median_buyer_rank',
    'pct_buyers_in_first_10',
    'tracked_first_seen_sec',
    'kol_first_seen_sec',
    'seconds_to_5_unique_buyers',
    'seconds_to_10_unique_buyers',
    'n_reversals_in_window',
    'longest_up_run_pct',
    'longest_down_run_pct',
    'max_30s_buy_sol',
    'max_30s_buy_count',
    'max_30s_buy_sell_ratio',
    'creator_buys_post_launch',
    'creator_sells_post_launch',
    'creator_sol_to_sidewallets',
    'creator_sidewallet_buyer_count',
    'inflow_accel_pct',
    'buy_count_accel_pct',
    'top10_buy_timing_std_sec',
    'max_30s_sell_sol',
    'max_30s_sell_count',
    'max_30s_unique_sellers',
    'creator_recent_launch_siblings',
    'trend_signal_match',
    'narrative_match_count',
    'pressure_60_buy_pct',
    'pressure_60_net',
    'telegram_member_count',
    'buyer_hhi_delta',
    'seller_hhi_delta',
    'bot_sniper_buyer_count',
    'fast_human_sniper_count',
    'seconds_since_prev_creator_death',
    'trade_count',
    'trades_per_min',
    'volatility_pct',
    'sandwich_risk',
    'reaction_speed_ms',
    # Network features (per snapshot)
    'rpc_latency_p90_ms',
    'priority_fee_p90',
    # Phase C sentiment features (per snapshot, 4h-window)
    'sentiment_bull_4h',
    'sentiment_bear_4h',
    'sentiment_shill_4h',
    'sentiment_total_4h',
    'sentiment_avg_confidence',
]

LABEL_COLS = [
    'migrated',
    'peaked_30', 'peaked_100', 'peaked_300', 'peaked_500',
    'peak_pct_max',
    'time_to_peak_sec',
    'will_die_fast',
    'rug_within_5min',
    'migrates_within_15min',
    'drawdown_from_peak_pct',
    'hits_2x_within_1h',
    'time_to_peak_5x_sec',
    # Long-horizon "hold-to-maturity" labels (added 2026-05-12). Pre-mig labels
    # above all resolve within 1h — these answer "is this worth holding?".
    # Resolved 25h+ after snapshot via the label resolver's stale-backfill pass.
    'alive_at_1h', 'alive_at_4h', 'alive_at_24h',
    'hits_5x_within_24h', 'hits_10x_within_24h',
    'hold_1h_pct', 'hold_4h_pct', 'hold_24h_pct',
    'peak_pct_within_24h', 'max_drawdown_within_24h_pct',
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
    ap.add_argument('--include-zero-price', action='store_true',
                    help='Include snapshots with last_price_sol <= 1e-9 (debug only — adds noise)')
    args = ap.parse_args()

    out_path = Path(__file__).parent.parent / args.out
    out_path.parent.mkdir(parents=True, exist_ok=True)

    # Read-only WAL mode — non-blocking vs live bot writes
    conn = sqlite3.connect(f'file:{DB_PATH}?mode=ro', uri=True)
    cols = ['mint_address', 'snapshot_ts'] + FEATURE_COLS + LABEL_COLS + ['labels_resolved_at']
    where = []
    params = []
    if not args.include_unresolved:
        where.append('labels_resolved_at IS NOT NULL')
    # Exclude snapshots with junk price (last_price_sol <= 1e-9). These are
    # mints with NO trades at snapshot time — peak_pct ratios are ungroundable
    # and several labels (rug_within_5min, drawdown_from_peak_pct) end up NULL.
    # ~15% of historical snapshots fall in this bucket; including them adds
    # noise without information. --include-zero-price overrides for debugging.
    if not args.include_zero_price:
        where.append('last_price_sol > 1e-9')
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

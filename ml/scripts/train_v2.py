#!/usr/bin/env python3
"""V2 ML training — uses ONLY features the V2 snapshot worker populates.

V1 features that V2 leaves at 0 (and would cause distribution shift if used):
- tracked_buyers, kol_buyers, bundle_buyers, weighted_buyer_quality
- tracked_first_seen_sec, kol_first_seen_sec
- creator_sol_to_sidewallets, creator_sidewallet_buyer_count
- trend_signal_match, narrative_match_count, telegram_member_count
- buyer_hhi_delta, seller_hhi_delta
- bot_sniper_buyer_count (also default 0 in V2)
- sandwich_risk, reaction_speed_ms, rpc_latency_p90_ms, priority_fee_p90, network_status
- sentiment_bull_4h, sentiment_bear_4h, sentiment_shill_4h, sentiment_total_4h, sentiment_avg_confidence

Reads labeled historical snapshots from ml_mint_snapshots, trains
HistGradientBoosting (classifier or regressor based on --target), saves to
ml/models/<target>_v2_lean.pkl.

Usage:
  python3 train_v2.py --target hits_5x_within_24h
  python3 train_v2.py --target hits_5x_within_24h --age 60   # only 60s snapshots
"""

import argparse
import json
import os
import sqlite3
import time
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.metrics import roc_auc_score, r2_score, average_precision_score, mean_absolute_error

ML_ROOT = Path('/opt/degen-club/ml')
DB_PATH = Path('/opt/degen-club/data/degen.db')
MODELS_DIR = ML_ROOT / 'models'

# Features available + populated in V2 production. Order matters: train.py
# stores feature_cols in this order; serve.py rebuilds the input row in the
# same order at predict time.
V2_FEATURES = [
    'snapshot_age_sec',
    'initial_buy_sol',
    'creator_launch_count', 'creator_migrated_count',
    'has_twitter', 'has_telegram', 'has_website',
    'name_length', 'symbol_length',
    'created_hour_utc', 'created_dow',
    'last_price_sol', 'last_mcap_sol', 'peak_mcap_sol_so_far',
    'v_sol_in_curve',
    'sol_inflow', 'sol_outflow',
    'buy_count', 'sell_count', 'buy_sell_ratio',
    'unique_buyers',
    'top10_buyers', 'top50_buyers',
    'avg_buy_sol', 'median_buy_sol', 'p90_buy_sol', 'max_buy_sol', 'std_buy_sol',
    'avg_sell_sol', 'median_sell_sol', 'p90_sell_sol', 'max_sell_sol', 'std_sell_sol',
    'top1_buyer_sol_pct', 'top3_buyer_sol_pct', 'top5_buyer_sol_pct', 'buyer_hhi',
    'top1_seller_sol_pct', 'top3_seller_sol_pct', 'top5_seller_sol_pct', 'seller_hhi',
    'sniper_buyer_count', 'pct_sniper_buys',
    'first_block_buyer_count', 'pct_first_block_buys',
    'avg_buyer_rank', 'median_buyer_rank', 'pct_buyers_in_first_10',
    'seconds_to_5_unique_buyers', 'seconds_to_10_unique_buyers',
    'n_reversals_in_window', 'longest_up_run_pct', 'longest_down_run_pct',
    'max_30s_buy_sol', 'max_30s_buy_count', 'max_30s_buy_sell_ratio',
    'creator_buys_post_launch', 'creator_sells_post_launch',
    'inflow_accel_pct', 'buy_count_accel_pct', 'top10_buy_timing_std_sec',
    'max_30s_sell_sol', 'max_30s_sell_count', 'max_30s_unique_sellers',
    'creator_recent_launch_siblings',
    'pressure_60_buy_pct', 'pressure_60_net',
    'seconds_since_prev_creator_death',
    'trade_count', 'trades_per_min', 'volatility_pct',
    'migrated',  # whether mint is migrated at snapshot time (state, not look-ahead)
    # Wallet-skill features (2026-05-28). Computed at snapshot time by joining
    # buyer/seller wallets against wallet_stats (scripts/wallet-skill-compute.py).
    # Smart-money signal — see workers/wallet-skill-tracker.js for philosophy.
    'top_buyer_skill_p90', 'smart_buyer_count', 'whale_buyer_count',
    'avg_buyer_hold_sec',
    'top_seller_skill_p90', 'smart_seller_count',
]

# Targets we can train as regression (rest are classification)
REGRESSION_TARGETS = {
    'drawdown_from_peak_pct',
    'hold_1h_pct', 'hold_4h_pct', 'hold_24h_pct',
    'peak_pct_within_24h', 'max_drawdown_within_24h_pct',
    'pump_durability_5min',
    'pnl_pct_60s', 'pnl_pct_300s',
    'unique_buyers_next_60s', 'unique_sellers_next_60s',
    'peak_pct_max', 'time_to_peak_sec', 'time_to_peak_5x_sec',
}

# Heavy-tailed signed targets get signed log1p transform
SIGNED_LOG_TARGETS = {
    'hold_1h_pct', 'hold_4h_pct', 'hold_24h_pct',
    'pnl_pct_60s', 'pnl_pct_300s',
}
POISSON_TARGETS = {'unique_buyers_next_60s', 'unique_sellers_next_60s'}


def signed_log1p(y):
    return np.sign(y) * np.log1p(np.abs(y))


def load_labeled(conn, target, ages=None, max_rows=300000):
    feat_cols = ','.join(V2_FEATURES)
    sql = f"""
        SELECT {feat_cols}, {target} AS y, snapshot_ts
        FROM ml_mint_snapshots
        WHERE labels_resolved_at IS NOT NULL AND {target} IS NOT NULL
    """
    if ages:
        sql += f' AND snapshot_age_sec IN ({",".join(str(int(a)) for a in ages)})'
    sql += f' ORDER BY snapshot_ts ASC LIMIT {int(max_rows)}'
    return pd.read_sql_query(sql, conn)


def train_one(target, ages=None, max_rows=300000):
    conn = sqlite3.connect(str(DB_PATH))
    print(f'[train] target={target}, ages={ages}, max_rows={max_rows}')
    t0 = time.time()
    df = load_labeled(conn, target, ages=ages, max_rows=max_rows)
    print(f'[train] loaded {len(df)} labeled rows in {time.time()-t0:.1f}s')
    if len(df) < 1000:
        raise SystemExit(f'insufficient data ({len(df)} rows)')

    # Time-based split: oldest 85% train, newest 15% val
    split = int(len(df) * 0.85)
    train_df = df.iloc[:split].copy()
    val_df = df.iloc[split:].copy()
    X_train = train_df[V2_FEATURES].fillna(-1).values
    X_val = val_df[V2_FEATURES].fillna(-1).values
    y_train = train_df['y'].astype(float).values
    y_val = val_df['y'].astype(float).values

    is_reg = target in REGRESSION_TARGETS
    log_xform = target in SIGNED_LOG_TARGETS
    poisson = target in POISSON_TARGETS

    if is_reg:
        if log_xform:
            y_train_fit = signed_log1p(y_train)
        else:
            y_train_fit = y_train
        kwargs = dict(max_iter=300, learning_rate=0.05, max_depth=8, l2_regularization=1.0, random_state=42)
        if poisson:
            kwargs['loss'] = 'poisson'
            # Poisson requires non-negative
            y_train_fit = np.clip(y_train_fit, 0, None)
        model = HistGradientBoostingRegressor(**kwargs)
        t1 = time.time()
        model.fit(X_train, y_train_fit)
        print(f'[train] fit in {time.time()-t1:.1f}s')
        pred = model.predict(X_val)
        if log_xform:
            pred = np.sign(pred) * (np.expm1(np.abs(pred)))
        r2 = r2_score(y_val, pred)
        mae = mean_absolute_error(y_val, pred)
        metrics = {'r2': r2, 'mae': mae, 'mode': 'regression'}
        print(f'[train] R²={r2:.4f}  MAE={mae:.4f}  n_val={len(y_val)}')
    else:
        n_pos = int((y_train > 0.5).sum())
        n_neg = int(len(y_train) - n_pos)
        if n_pos < 50 or n_neg < 50:
            raise SystemExit(f'class imbalance: {n_neg} neg / {n_pos} pos')
        base = HistGradientBoostingClassifier(
            max_iter=300, learning_rate=0.05, max_depth=8,
            l2_regularization=1.0,
            class_weight='balanced',
            random_state=42,
        )
        t1 = time.time()
        # Calibrated probabilities — important for our composite scoring
        model = CalibratedClassifierCV(base, cv=3, method='isotonic')
        model.fit(X_train, y_train)
        print(f'[train] fit in {time.time()-t1:.1f}s')
        pred = model.predict_proba(X_val)[:, 1]
        try:
            auc = roc_auc_score(y_val, pred)
            ap = average_precision_score(y_val, pred)
        except ValueError:
            auc, ap = None, None
        metrics = {'auc': auc, 'ap': ap, 'n_pos_train': n_pos, 'n_neg_train': n_neg, 'mode': 'classification'}
        print(f'[train] AUC={auc:.4f}  AP={ap:.4f}  n_val={len(y_val)} (pos={int(y_val.sum())})')

    bundle = {
        'target': target,
        'model': model,
        'feature_cols': V2_FEATURES,
        'mode': 'regression' if is_reg else 'classification',
        'signed_log_transform': log_xform,
        'log_transform': False,
        'trained_at_ms': int(time.time() * 1000),
        'n_train': len(X_train),
        'n_val': len(X_val),
        'metrics': metrics,
        'features_v2_lean': True,
        'trained_with_ages': ages or 'all',
    }
    out = MODELS_DIR / f'{target}_v2_lean.pkl'
    joblib.dump(bundle, out)
    print(f'[train] saved {out}')
    print(f'[train] total {time.time()-t0:.1f}s')
    return bundle, metrics


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--target', required=True)
    ap.add_argument('--ages', nargs='+', type=int, default=None)
    ap.add_argument('--max-rows', type=int, default=300000)
    args = ap.parse_args()
    train_one(args.target, ages=args.ages, max_rows=args.max_rows)

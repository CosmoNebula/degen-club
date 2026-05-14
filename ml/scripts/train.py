"""
Phase 2C — Train migration probability classifier.

Reads training CSV from extract_from_snapshots.py, trains a HistGradientBoostingClassifier
with calibrated probabilities, time-based train/val split, class weighting for imbalance.

Usage:
    .venv/bin/python scripts/train.py
    .venv/bin/python scripts/train.py --target peaked_100 --out models/peaked_100_v1.pkl
    .venv/bin/python scripts/train.py --csv data/training.csv --target migrated
"""

import argparse
import json
import time
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
from sklearn.calibration import CalibratedClassifierCV
from sklearn.ensemble import HistGradientBoostingClassifier, HistGradientBoostingRegressor
from sklearn.metrics import (
    average_precision_score,
    confusion_matrix,
    mean_absolute_error,
    median_absolute_error,
    r2_score,
    roc_auc_score,
)

# Targets that should be trained as regression (continuous outputs).
# Everything else is binary classification.
REGRESSION_TARGETS = {
    # Active regressions kept post-2026-05-14 prune:
    'drawdown_from_peak_pct',
    'hold_1h_pct', 'hold_4h_pct', 'hold_24h_pct',
    'peak_pct_within_24h', 'max_drawdown_within_24h_pct',
    'pump_durability_5min',                   # 2026-05-14 timing-aware
    # Legacy names (still in some pipelines) — kept for routing-correctness
    # even if dropped from the training set in retrain_all.py.
    'peak_pct_max', 'time_to_peak_sec', 'time_to_peak_5x_sec',
    'post_mig_peak_pct',
}

# Regression targets with heavy-tailed distributions get log1p-transformed
# during training. Inverse (expm1) applied at predict time. Critical for
# targets where the bulk is near 0 but a long tail of huge values exists
# (e.g. peak_pct_max: median=0, max=138 → log compresses to learnable range).
LOG_TRANSFORM_TARGETS = {'peak_pct_max', 'time_to_peak_sec', 'time_to_peak_5x_sec'}

# Same feature list as extract — keep in sync
FEATURE_COLS = [
    'snapshot_age_sec',
    'initial_buy_sol', 'creator_launch_count', 'creator_migrated_count',
    'has_twitter', 'has_telegram', 'has_website',
    'name_length', 'symbol_length', 'created_hour_utc', 'created_dow',
    'last_price_sol', 'last_mcap_sol', 'peak_mcap_sol_so_far',
    'v_sol_in_curve', 'sol_inflow', 'sol_outflow',
    'buy_count', 'sell_count', 'buy_sell_ratio',
    'unique_buyers', 'tracked_buyers', 'kol_buyers', 'bundle_buyers',
    'top10_buyers', 'top50_buyers', 'weighted_buyer_quality',
    'avg_buy_sol', 'median_buy_sol', 'p90_buy_sol', 'max_buy_sol', 'std_buy_sol',
    'avg_sell_sol', 'median_sell_sol', 'p90_sell_sol', 'max_sell_sol', 'std_sell_sol',
    'top1_buyer_sol_pct', 'top3_buyer_sol_pct', 'top5_buyer_sol_pct', 'buyer_hhi',
    'top1_seller_sol_pct', 'top3_seller_sol_pct', 'top5_seller_sol_pct', 'seller_hhi',
    'sniper_buyer_count', 'pct_sniper_buys', 'first_block_buyer_count', 'pct_first_block_buys',
    'avg_buyer_rank', 'median_buyer_rank', 'pct_buyers_in_first_10',
    'tracked_first_seen_sec', 'kol_first_seen_sec',
    'seconds_to_5_unique_buyers', 'seconds_to_10_unique_buyers',
    'n_reversals_in_window', 'longest_up_run_pct', 'longest_down_run_pct',
    'max_30s_buy_sol', 'max_30s_buy_count', 'max_30s_buy_sell_ratio',
    'creator_buys_post_launch', 'creator_sells_post_launch',
    'creator_sol_to_sidewallets', 'creator_sidewallet_buyer_count',
    'inflow_accel_pct', 'buy_count_accel_pct', 'top10_buy_timing_std_sec',
    'max_30s_sell_sol', 'max_30s_sell_count', 'max_30s_unique_sellers',
    'creator_recent_launch_siblings',
    'trend_signal_match', 'narrative_match_count',
    'pressure_60_buy_pct', 'pressure_60_net',
    'telegram_member_count',
    'buyer_hhi_delta', 'seller_hhi_delta',
    'bot_sniper_buyer_count', 'fast_human_sniper_count',
    'seconds_since_prev_creator_death',
    'trade_count', 'trades_per_min',
    'volatility_pct', 'sandwich_risk', 'reaction_speed_ms',
    'rpc_latency_p90_ms', 'priority_fee_p90',
]

# Post-migration feature set — used for models that predict POST-AMM behavior.
# Triggered via `--features-mode post`. Reads from ml_migration_snapshots-derived
# CSV (different feature names than pre-mig). Includes both at-migration anchor
# state AND any window/cumulative features captured at later snapshot ages.
POSTMIG_FEATURE_COLS = [
    'snapshot_age_min',  # which age of snapshot (0, 30, 60, 360, 720, 1440)
    # Current state at this age
    'current_mcap_sol', 'current_price_sol', 'liquidity_usd',
    'amm_volume_h1_usd', 'amm_volume_h24_usd',
    'amm_buys_h24', 'amm_sells_h24',
    'amm_price_change_h1', 'amm_price_change_h24',
    # Window aggregates (since previous snapshot age)
    'window_buys', 'window_sells', 'window_unique_buyers',
    'window_tracked_buyers', 'window_kol_buyers',
    # Cumulative since migration
    'pct_from_migration', 'peak_pct_so_far',
    # Pre-mig features (only populated on age=0 anchor rows; NULL on later ages)
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

DEFAULT_TARGET = 'migrated'
TRAIN_FRAC = 0.80  # oldest 80% by time
# 24h gap between train and val sets. Labels resolve 6h after snapshot, so
# without a gap a row whose label resolves AFTER its snapshot can still leak
# into the val set's evaluation while the model was trained on a directly
# correlated outcome. 24h is comfortably > 6h resolution window AND covers
# clustered-launch dynamics where related mints have correlated outcomes.
# A full week would be overkill for memecoin lifecycles (most mints resolve
# within hours, not weeks).
TRAIN_VAL_GAP_HOURS = 24


def time_based_split(df, train_frac=TRAIN_FRAC, gap_hours=TRAIN_VAL_GAP_HOURS):
    """Split chronologically — train on oldest, validate on newest, with a
    gap between them to prevent label leakage. Rows inside the gap are
    dropped entirely. If the dataset is too small to support the gap (val
    would have <50 rows), falls back to no-gap split with a warning."""
    df = df.sort_values('snapshot_ts').reset_index(drop=True)
    cutoff = int(len(df) * train_frac)
    train = df.iloc[:cutoff]
    val = df.iloc[cutoff:]
    if gap_hours > 0 and len(train) > 0 and len(val) > 0:
        gap_ms = gap_hours * 3600 * 1000
        train_max_ts = train['snapshot_ts'].max()
        val_filtered = val[val['snapshot_ts'] >= train_max_ts + gap_ms]
        if len(val_filtered) < 50:
            print(f'[split] WARN: {gap_hours}h gap leaves only {len(val_filtered)} val rows — falling back to no-gap split')
        else:
            dropped = len(val) - len(val_filtered)
            val = val_filtered
            print(f'[split] applied {gap_hours}h gap · dropped {dropped} val rows inside gap · final: {len(train)} train + {len(val)} val')
    return train, val


def train_regression(X_train, y_train, X_val, y_val, target_name, args):
    print(f'[train] regression target={target_name}  rows={len(y_train)} train + {len(y_val)} val')
    if len(y_train) < 100:
        print('[train] skipping — need ≥100 rows for regression')
        return None
    print(f'[train] target stats (raw) · mean={y_train.mean():.3f} · median={y_train.median():.3f} · max={y_train.max():.2f}')

    use_log = target_name in LOG_TRANSFORM_TARGETS
    if use_log:
        # log1p handles 0s safely (log1p(0) = 0). Inverse is expm1.
        y_train_t = np.log1p(np.clip(y_train, a_min=0, a_max=None))
        y_val_t = np.log1p(np.clip(y_val, a_min=0, a_max=None))
        print(f'[train] log-transformed · mean={y_train_t.mean():.3f} · median={y_train_t.median():.3f} · max={y_train_t.max():.3f}')
    else:
        y_train_t = y_train
        y_val_t = y_val

    base = HistGradientBoostingRegressor(
        max_iter=args.iters,
        learning_rate=args.lr,
        max_depth=args.depth,
        l2_regularization=0.5,
        random_state=0,
        early_stopping=True,
        n_iter_no_change=20,
    )
    t = time.time()
    base.fit(X_train, y_train_t)
    elapsed = time.time() - t
    print(f'[train] training time: {elapsed:.1f}s')

    y_val_pred_t = base.predict(X_val)
    # Compute metrics in original (un-transformed) space — that's what users care about
    if use_log:
        y_val_pred = np.expm1(y_val_pred_t)
        # Also report log-space metrics for comparison
        r2_log = float(r2_score(y_val_t, y_val_pred_t)) if len(y_val) > 1 else 0.0
    else:
        y_val_pred = y_val_pred_t
        r2_log = None
    y_val_pred = np.clip(y_val_pred, 0, None)  # nothing negative
    mae = float(mean_absolute_error(y_val, y_val_pred))
    medae = float(median_absolute_error(y_val, y_val_pred))
    r2 = float(r2_score(y_val, y_val_pred)) if len(y_val) > 1 else 0.0
    print(f'\n[train] === regression validation metrics (original scale) ===')
    print(f'  MAE             : {mae:.4f}')
    print(f'  Median AE       : {medae:.4f}')
    print(f'  R²              : {r2:.4f}  (1.0 = perfect, 0.0 = naive mean, <0 = worse than mean)')
    if r2_log is not None:
        print(f'  R² (log space)  : {r2_log:.4f}')

    fi = None
    try:
        from sklearn.inspection import permutation_importance
        sample = min(500, len(X_val))
        idx = np.random.choice(len(X_val), sample, replace=False)
        perm = permutation_importance(base, X_val.iloc[idx], y_val.iloc[idx],
                                       n_repeats=3, random_state=0)
        fi = pd.Series(perm.importances_mean, index=X_val.columns).sort_values(ascending=False)
        print('\n[train] === feature importances (top 10) ===')
        print(fi.head(10).to_string())
    except Exception as e:
        print(f'[train] feature importance unavailable: {e}')

    return {
        'model': base,
        'metrics': {'mae': mae, 'median_ae': medae, 'r2': r2, 'mode': 'regression'},
        'feature_importances': fi.to_dict() if fi is not None else None,
    }


def train_one(X_train, y_train, X_val, y_val, target_name, args):
    if target_name in REGRESSION_TARGETS:
        return train_regression(X_train, y_train, X_val, y_val, target_name, args)
    n_pos = int(y_train.sum())
    n_neg = int(len(y_train) - n_pos)
    print(f'[train] target={target_name}  rows={len(y_train)} train + {len(y_val)} val')
    print(f'[train] class balance: {n_neg} neg / {n_pos} pos ({100*n_pos/len(y_train):.1f}% positive)')

    if n_pos < 5 or n_neg < 5:
        print('[train] skipping — need ≥5 of each class')
        return None

    # NO class_weight='balanced' — it distorts probabilities and isotonic can't
    # fully correct it. With imbalanced data, let the model output its natural
    # (low) probabilities and let calibration do the lifting.
    base = HistGradientBoostingClassifier(
        max_iter=args.iters,
        learning_rate=args.lr,
        max_depth=args.depth,
        l2_regularization=0.5,
        random_state=0,
        early_stopping=True,
        n_iter_no_change=20,
    )
    # CHRONOLOGICAL calibration holdout — split off the latest 25% of training
    # data, fit base on the rest, then fit isotonic calibration on the holdout.
    # Using random CV folds calibrates on temporally-mixed data and produces
    # systematic under/over-confidence on out-of-time inference. The
    # most-recent slice is closest to the distribution we'll predict on.
    # 25% (was 15%, raised 2026-05-11): rare-positive labels like
    # hits_2x_within_1h have ~0.8% base rate, so 15% of training data left
    # only ~25 positives in the holdout — barely enough for isotonic to fit.
    # 25% gives ~40+ positives while still leaving 75% for the base model.
    holdout_pct = 0.25
    cutoff = int(len(X_train) * (1 - holdout_pct))
    X_inner, X_calib = X_train.iloc[:cutoff], X_train.iloc[cutoff:]
    y_inner, y_calib = y_train.iloc[:cutoff], y_train.iloc[cutoff:]
    n_pos_calib = int(y_calib.sum())
    if n_pos_calib < 5:
        # Not enough positives in the calibration holdout — fall back to CV
        cv = min(3, max(2, n_pos // 2))
        print(f'[train] only {n_pos_calib} positives in chronological holdout — falling back to {cv}-fold CV')
        t = time.time()
        model = CalibratedClassifierCV(base, method='isotonic', cv=cv)
        model.fit(X_train, y_train)
    else:
        print(f'[train] chronological holdout: train={len(y_inner)} (pos={int(y_inner.sum())}) · calib={len(y_calib)} (pos={n_pos_calib})')
        t = time.time()
        base.fit(X_inner, y_inner)
        from sklearn.frozen import FrozenEstimator
        model = CalibratedClassifierCV(FrozenEstimator(base), method='isotonic')
        model.fit(X_calib, y_calib)
    elapsed = time.time() - t
    print(f'[train] training time: {elapsed:.1f}s')

    # Validation metrics
    y_val_prob = model.predict_proba(X_val)[:, 1]
    y_val_pred = (y_val_prob >= 0.5).astype(int)
    auc_pr = average_precision_score(y_val, y_val_prob) if y_val.sum() > 0 else 0.0
    auc_roc = roc_auc_score(y_val, y_val_prob) if y_val.sum() > 0 and y_val.sum() < len(y_val) else 0.0
    cm = confusion_matrix(y_val, y_val_pred).tolist() if len(np.unique(y_val)) > 1 else [[0, 0], [0, 0]]
    # Precision @ top-decile
    threshold_top10 = np.quantile(y_val_prob, 0.90) if len(y_val_prob) > 10 else 0.5
    top_mask = y_val_prob >= threshold_top10
    precision_at_top10 = float(y_val[top_mask].mean()) if top_mask.sum() > 0 else 0.0
    baseline_rate = float(y_val.mean())
    lift = precision_at_top10 / baseline_rate if baseline_rate > 0 else 0.0
    print(f'\n[train] === validation metrics ===')
    print(f'  AUC-PR              : {auc_pr:.4f}  (random ≈ {baseline_rate:.4f})')
    print(f'  AUC-ROC             : {auc_roc:.4f}  (random = 0.5)')
    print(f'  precision @ top-10% : {precision_at_top10:.4f}  (baseline = {baseline_rate:.4f}, lift = {lift:.2f}x)')
    print(f'  confusion matrix    : {cm}')

    # Feature importances (from base model — calibrated wrapper exposes them via .estimator_)
    fi = None
    try:
        # Use HGB's .feature_importances_ via permutation on the underlying base.
        # With FrozenEstimator path, the base is frozen but still accessible.
        cc0 = model.calibrated_classifiers_[0]
        base_fitted = getattr(cc0.estimator, 'estimator', cc0.estimator)
        from sklearn.inspection import permutation_importance
        # Use sample to keep it fast
        sample = min(500, len(X_val))
        idx = np.random.choice(len(X_val), sample, replace=False)
        perm = permutation_importance(base_fitted, X_val.iloc[idx], y_val.iloc[idx],
                                       n_repeats=3, random_state=0, scoring='roc_auc')
        fi = pd.Series(perm.importances_mean, index=X_val.columns).sort_values(ascending=False)
        print('\n[train] === feature importances (top 10) ===')
        print(fi.head(10).to_string())
    except Exception as e:
        print(f'[train] feature importance unavailable: {e}')

    # Brier on val set — apples-to-apples with the agent's calibration check
    from sklearn.metrics import brier_score_loss
    brier = float(brier_score_loss(y_val, y_val_prob))
    print(f'  Brier score         : {brier:.4f}')

    return {
        'model': model,
        'metrics': {
            'auc_pr': auc_pr, 'auc_roc': auc_roc,
            'precision_top10': precision_at_top10,
            'baseline_rate': baseline_rate, 'lift': lift,
            'brier': brier,
            'confusion_matrix': cm,
        },
        'feature_importances': fi.to_dict() if fi is not None else None,
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--csv', type=str, default='data/training.csv')
    ap.add_argument('--target', type=str, default=DEFAULT_TARGET)
    ap.add_argument('--out', type=str, default=None,
                    help='Output model path (default: models/<target>_v1.pkl)')
    ap.add_argument('--features-mode', type=str, default='pre',
                    choices=['pre', 'post'],
                    help='pre = pre-migration feature set (default), post = post-migration')
    ap.add_argument('--iters', type=int, default=300, help='max_iter for HGB')
    ap.add_argument('--lr', type=float, default=0.05)
    ap.add_argument('--depth', type=int, default=8)
    args = ap.parse_args()

    # Pick the feature column set based on mode
    feature_cols = POSTMIG_FEATURE_COLS if args.features_mode == 'post' else FEATURE_COLS

    csv_path = Path(__file__).parent.parent / args.csv
    out_path = Path(__file__).parent.parent / (args.out or f'models/{args.target}_v1.pkl')
    meta_path = out_path.with_suffix('.json')

    print(f'[train] csv: {csv_path}')
    print(f'[train] target: {args.target}')

    df = pd.read_csv(csv_path)
    print(f'[train] loaded {len(df)} rows')
    if len(df) == 0 or args.target not in df.columns:
        print(f'[train] no usable data for {args.target} — exiting')
        return

    df = df.dropna(subset=[args.target])
    print(f'[train] after dropping null {args.target}: {len(df)} rows')
    if len(df) < 100:
        print('[train] too few rows for training (<100). Need more data.')
        return
    # For regression, also drop infinite values
    if args.target in REGRESSION_TARGETS:
        df = df[np.isfinite(df[args.target])]

    train, val = time_based_split(df)
    X_cols = [c for c in feature_cols if c in train.columns]
    X_train = train[X_cols]
    X_val = val[X_cols]
    # Regression targets stay float; binary targets cast to int.
    if args.target in REGRESSION_TARGETS:
        y_train = train[args.target].astype(float)
        y_val = val[args.target].astype(float)
    else:
        y_train = train[args.target].astype(int)
        y_val = val[args.target].astype(int)

    result = train_one(X_train, y_train, X_val, y_val, args.target, args)
    if not result:
        return

    # Persist
    out_path.parent.mkdir(parents=True, exist_ok=True)
    is_regression = args.target in REGRESSION_TARGETS
    joblib.dump({
        'model': result['model'],
        'feature_cols': X_cols,
        'target': args.target,
        'mode': 'regression' if is_regression else 'classification',
        'log_transform': is_regression and args.target in LOG_TRANSFORM_TARGETS,
        'trained_at_ms': int(time.time() * 1000),
        'n_train': len(y_train),
        'n_val': len(y_val),
        'metrics': result['metrics'],
    }, out_path)
    with open(meta_path, 'w') as f:
        json.dump({
            'target': args.target,
            'feature_cols': X_cols,
            'n_train': len(y_train),
            'n_val': len(y_val),
            'metrics': result['metrics'],
            'feature_importances': result['feature_importances'],
        }, f, indent=2, default=float)
    print(f'\n[train] saved model → {out_path}')
    print(f'[train] saved meta  → {meta_path}')


if __name__ == '__main__':
    main()

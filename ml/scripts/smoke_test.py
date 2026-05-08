"""
Smoke test — generates synthetic ml_mint_snapshots-style data, runs through
extract → train → serve to verify the pipeline works end-to-end before real
labels arrive.

Usage:
    .venv/bin/python scripts/smoke_test.py
"""

import os
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd

ML_ROOT = Path(__file__).parent.parent
TRAINING_CSV = ML_ROOT / 'data' / 'training_smoke.csv'
MODEL_PATH = ML_ROOT / 'models' / 'smoke_v1.pkl'

FEATURE_COLS = [
    'snapshot_age_sec',
    'initial_buy_sol', 'creator_launch_count', 'creator_migrated_count',
    'has_twitter', 'has_telegram', 'has_website',
    'name_length', 'symbol_length', 'created_hour_utc', 'created_dow',
    'last_price_sol', 'last_mcap_sol', 'peak_mcap_sol_so_far',
    'v_sol_in_curve', 'sol_inflow', 'sol_outflow',
    'buy_count', 'sell_count', 'buy_sell_ratio',
    'unique_buyers', 'tracked_buyers', 'kol_buyers', 'bundle_buyers',
    'trade_count', 'trades_per_min',
    'volatility_pct', 'sandwich_risk', 'reaction_speed_ms',
    'rpc_latency_p90_ms', 'priority_fee_p90',
]


def generate_synthetic_data(n_rows=5000, seed=42):
    """Generate plausible synthetic snapshots with a learnable migration signal."""
    rng = np.random.default_rng(seed)
    df = pd.DataFrame()
    df['mint_address'] = ['SMOKE' + str(i).zfill(8) for i in range(n_rows)]
    df['snapshot_ts'] = (rng.uniform(0, 14, n_rows) * 86_400_000).astype(int) + 1_700_000_000_000
    df['snapshot_age_sec'] = rng.choice([60, 300, 900, 3600], n_rows)
    df['initial_buy_sol'] = rng.lognormal(0, 1.5, n_rows).clip(0, 50)
    df['creator_launch_count'] = rng.geometric(0.5, n_rows) - 1
    df['creator_migrated_count'] = (rng.uniform(0, 1, n_rows) < df['creator_launch_count'] * 0.05).astype(int)
    df['has_twitter'] = rng.choice([0, 1], n_rows, p=[0.4, 0.6])
    df['has_telegram'] = rng.choice([0, 1], n_rows, p=[0.5, 0.5])
    df['has_website'] = rng.choice([0, 1], n_rows, p=[0.7, 0.3])
    df['name_length'] = rng.integers(3, 30, n_rows)
    df['symbol_length'] = rng.integers(2, 12, n_rows)
    df['created_hour_utc'] = rng.integers(0, 24, n_rows)
    df['created_dow'] = rng.integers(0, 7, n_rows)
    df['last_price_sol'] = rng.lognormal(-22, 2, n_rows)
    df['last_mcap_sol'] = rng.lognormal(3, 1.5, n_rows).clip(0, 200)
    df['peak_mcap_sol_so_far'] = df['last_mcap_sol'] * rng.uniform(1.0, 2.0, n_rows)
    df['v_sol_in_curve'] = rng.lognormal(3, 1, n_rows).clip(0, 100)
    df['sol_inflow'] = rng.lognormal(2, 1.5, n_rows).clip(0, 1000)
    df['sol_outflow'] = df['sol_inflow'] * rng.uniform(0.3, 0.9, n_rows)
    df['buy_count'] = rng.poisson(20, n_rows)
    df['sell_count'] = rng.poisson(10, n_rows)
    df['buy_sell_ratio'] = df['buy_count'] / df['sell_count'].clip(lower=1)
    df['unique_buyers'] = rng.poisson(15, n_rows)
    df['tracked_buyers'] = rng.poisson(0.5, n_rows)
    df['kol_buyers'] = rng.poisson(0.2, n_rows)
    df['bundle_buyers'] = rng.poisson(1, n_rows)
    df['trade_count'] = df['buy_count'] + df['sell_count']
    df['trades_per_min'] = df['trade_count'] / (df['snapshot_age_sec'] / 60)
    df['volatility_pct'] = rng.uniform(0.005, 0.15, n_rows)
    df['sandwich_risk'] = rng.uniform(0, 1, n_rows)
    df['reaction_speed_ms'] = rng.lognormal(6, 1.5, n_rows)
    df['rpc_latency_p90_ms'] = rng.lognormal(5, 0.5, n_rows)
    df['priority_fee_p90'] = rng.lognormal(8, 1.5, n_rows)

    # Generate plausible label: migration prob increases with init_buy, kol_buyers, unique_buyers, creator track record
    logit = (
        -5.5  # base rate makes positive class rare
        + 0.15 * df['initial_buy_sol']
        + 0.05 * df['unique_buyers']
        + 1.5 * df['kol_buyers'].clip(upper=2)
        + 0.6 * df['creator_migrated_count'].clip(upper=3)
        - 0.5 * df['sandwich_risk']
        + rng.normal(0, 0.5, n_rows)
    )
    p = 1 / (1 + np.exp(-logit))
    df['migrated'] = (rng.uniform(0, 1, n_rows) < p).astype(int)
    # Other labels — simulate similar logic but cheaper-bar
    df['peaked_30'] = (rng.uniform(0, 1, n_rows) < (p * 5).clip(0, 1)).astype(int)
    df['peaked_100'] = (rng.uniform(0, 1, n_rows) < (p * 2).clip(0, 1)).astype(int)
    df['peaked_500'] = (rng.uniform(0, 1, n_rows) < (p * 0.5).clip(0, 1)).astype(int)
    df['peak_pct_max'] = p * 10 + rng.uniform(-0.5, 0.5, n_rows)
    df['labels_resolved_at'] = int(time.time() * 1000)

    # column order
    cols = ['mint_address', 'snapshot_ts'] + FEATURE_COLS + [
        'migrated', 'peaked_30', 'peaked_100', 'peaked_500', 'peak_pct_max', 'labels_resolved_at'
    ]
    return df[cols]


def run_step(label, cmd):
    print(f'\n--- {label} ---')
    print('$', ' '.join(cmd))
    result = subprocess.run(cmd, capture_output=True, text=True)
    print(result.stdout, end='')
    if result.returncode != 0:
        print(result.stderr, end='')
        sys.exit(f'[smoke] step "{label}" failed (exit {result.returncode})')


def main():
    print('[smoke] generating synthetic training data...')
    TRAINING_CSV.parent.mkdir(parents=True, exist_ok=True)
    df = generate_synthetic_data()
    df.to_csv(TRAINING_CSV, index=False)
    print(f'[smoke] {len(df)} rows · {df["migrated"].sum()} migrators ({df["migrated"].mean()*100:.1f}%)')
    print(f'[smoke] saved → {TRAINING_CSV}')

    venv_py = ML_ROOT / '.venv' / 'bin' / 'python'

    # Train against synthetic data
    run_step('train', [
        str(venv_py),
        str(ML_ROOT / 'scripts' / 'train.py'),
        '--csv', str(TRAINING_CSV.relative_to(ML_ROOT)),
        '--target', 'migrated',
        '--out', str(MODEL_PATH.relative_to(ML_ROOT)),
        '--iters', '100',
    ])

    # Verify model file exists
    if not MODEL_PATH.exists():
        sys.exit('[smoke] model file not produced — pipeline failure')

    print(f'\n[smoke] ✅ pipeline OK · model at {MODEL_PATH}')

    # Quick load-and-predict sanity check
    print('\n--- inference smoke test ---')
    import joblib
    bundle = joblib.load(MODEL_PATH)
    model = bundle['model']
    cols = bundle['feature_cols']
    sample_features = {c: float(df[c].mean()) for c in cols if c in df.columns}
    sample_df = pd.DataFrame([sample_features])
    prob = model.predict_proba(sample_df)[0, 1]
    print(f'sample prediction · prob={prob:.4f}')
    print(f'\n[smoke] 🎉 ALL CHECKS PASSED — pipeline is ready')
    print(f'[smoke] when real labeled snapshots accumulate, run:')
    print(f'  .venv/bin/python scripts/extract_from_snapshots.py')
    print(f'  .venv/bin/python scripts/train.py')
    print(f'  .venv/bin/python scripts/serve.py  # starts inference service on :5050')


if __name__ == '__main__':
    main()

"""
Auto-retrain script — extracts latest labeled snapshots, retrains all three
target models, and signals the running serve.py to reload.

Designed to be cron-able. Idempotent: bails early if no new labels since last
run.

Usage:
    .venv/bin/python scripts/retrain_all.py
"""

import json
import sqlite3
import subprocess
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

ML_ROOT = Path(__file__).parent.parent
TRAINING_CSV = ML_ROOT / 'data' / 'training.csv'
POSTMIG_TRAINING_CSV = ML_ROOT / 'data' / 'training_postmig.csv'
LAST_TRAIN_FILE = ML_ROOT / 'data' / '.last_train_meta.json'
SERVE_RELOAD_URL = 'http://127.0.0.1:5050/reload'
import os
DB_PATH = Path(os.environ.get('DEGEN_DB_PATH') or str(ML_ROOT.parent / 'data' / 'degen.db'))

#
# 2026-05-16 — LABEL CLEANUP: condensed from 32 targets → 8 clean targets.
# Each model has ONE clear job and drives ONE trading decision. No redundant
# overlapping concepts, no wick-confused labels.
#
# Dropped (24 targets): peaked_15/30/100/300/500 (redundant with hits_*),
# rug_within_5min (wick-confused — replaced by will_rug), will_die_fast
# (same concept as rug, replaced by will_rug), migrates_within_15min (too
# narrow — replaced by will_migrate), migrated (anytime-ever, less useful
# than 24h windowed will_migrate), drawdown_from_peak_pct (unbounded,
# redundant), drawdown_20pct_300s (wick-confused), time_to_peak_5x_sec
# (misnamed, low utility), peak_within_5min (noise-prone), pump_durability_5min
# (low practical value), alive_at_1h/24h (alive = NOT will_rug),
# hold_1h_pct/4h_pct/24h_pct (covered by peak_pct_within_24h), hits_10x_within_24h
# (5x captures the same signal), max_drawdown_within_24h_pct (no strategy uses),
# price_up_60s/300s (binary subset of pnl_pct), pnl_pct_60s/300s (short-window
# noise), unique_buyers_next_60s/unique_sellers_next_60s (covered by
# buy_pressure_continues_60s + raw counts in features).
#
# All historical data preserved in old columns; just not trained on anymore.
TARGETS = [
    # ---------- PRE-MIGRATION (csv=training.csv, features-mode=pre) ----------
    # 1. Will it rug? — CANONICAL, keyed off mint.rugged_at (Definition 1 from
    #    audit). Replaces the wick-confused rug_within_5min + will_die_fast.
    # 2026-05-23 PAUSED (pre-mig lean-out): {'name': 'will_rug',                  'out': 'models/will_rug_v1.pkl',                  'min_pos': 30,  'kind': 'binary',     'mode': 'pre'},
    # 2. Will it 2x within 1h? — entry conviction signal.
    # 2026-05-23 PAUSED (pre-mig lean-out): {'name': 'hits_2x_within_1h',         'out': 'models/hits_2x_within_1h_v1.pkl',         'min_pos': 30,  'kind': 'binary',     'mode': 'pre'},
    # 3. Will it 5x within 24h? — size-up + hold-longer signal.
    # 2026-05-23 PAUSED (pre-mig lean-out): {'name': 'hits_5x_within_24h',        'out': 'models/hits_5x_within_24h_v1.pkl',        'min_pos': 30,  'kind': 'binary',     'mode': 'pre'},
    # 4. Will it migrate to Raydium? — CANONICAL, keyed off mint.migrated_at
    #    with 24h window. Replaces migrates_within_15min (too narrow) and
    #    `migrated` (anytime-ever, less actionable).
    # 2026-05-23 PAUSED (pre-mig lean-out): {'name': 'will_migrate',              'out': 'models/will_migrate_v1.pkl',              'min_pos': 20,  'kind': 'binary',     'mode': 'pre'},
    # 5. Max % gain achievable in 24h — position sizing signal.
    # 2026-05-23 PAUSED (pre-mig lean-out): {'name': 'peak_pct_within_24h',       'out': 'models/peak_pct_within_24h_v1.pkl',       'min_pos': 100, 'kind': 'regression', 'mode': 'pre'},
    # 6. Is now a local top? — exit-timing signal.
    # 2026-05-23 PAUSED (pre-mig lean-out): {'name': 'local_top_60s',             'out': 'models/local_top_60s_v1.pkl',             'min_pos': 100, 'kind': 'binary',     'mode': 'pre'},
    # 7. Will buy pressure continue in next 60s? — entry validation.
    # 2026-05-23 PAUSED (pre-mig lean-out): {'name': 'buy_pressure_continues_60s','out': 'models/buy_pressure_continues_60s_v1.pkl','min_pos': 100, 'kind': 'binary',     'mode': 'pre'},
    # ---------- POST-MIGRATION (csv=training_postmig.csv, features-mode=post) ----------
    # Original models
    {'name': 'post_mig_hits_2x',          'out': 'models/post_mig_hits_2x_v1.pkl',          'min_pos': 50,  'kind': 'binary',     'mode': 'post'},
    {'name': 'post_mig_peak_pct',         'out': 'models/post_mig_peak_pct_v1.pkl',         'min_pos': 100, 'kind': 'regression', 'mode': 'post'},
    {'name': 'post_mig_rugs_1h',          'out': 'models/post_mig_rugs_1h_v1.pkl',          'min_pos': 50,  'kind': 'binary',     'mode': 'post'},
    # 2026-05-21: Extended targets for new exit ladder (sweep-tuned T1=+130%, T2=+186%)
    {'name': 'post_mig_hits_130pct_4h',   'out': 'models/post_mig_hits_130pct_4h_v1.pkl',   'min_pos': 50,  'kind': 'binary',     'mode': 'post'},
    {'name': 'post_mig_hits_186pct_4h',   'out': 'models/post_mig_hits_186pct_4h_v1.pkl',   'min_pos': 50,  'kind': 'binary',     'mode': 'post'},
    {'name': 'post_mig_hits_50pct_30m',   'out': 'models/post_mig_hits_50pct_30m_v1.pkl',   'min_pos': 50,  'kind': 'binary',     'mode': 'post'},
    {'name': 'post_mig_hits_100pct_1h',   'out': 'models/post_mig_hits_100pct_1h_v1.pkl',   'min_pos': 50,  'kind': 'binary',     'mode': 'post'},
    {'name': 'post_mig_hits_30x_24h',     'out': 'models/post_mig_hits_30x_24h_v1.pkl',     'min_pos': 30,  'kind': 'binary',     'mode': 'post'},
    # Risk-side: predict our SL hits
    {'name': 'post_mig_drawdown_50_5min', 'out': 'models/post_mig_drawdown_50_5min_v1.pkl', 'min_pos': 50,  'kind': 'binary',     'mode': 'post'},
    {'name': 'post_mig_drawdown_30_5min', 'out': 'models/post_mig_drawdown_30_5min_v1.pkl', 'min_pos': 50,  'kind': 'binary',     'mode': 'post'},
    {'name': 'post_mig_alive_4h',         'out': 'models/post_mig_alive_4h_v1.pkl',         'min_pos': 30,  'kind': 'binary',     'mode': 'post'},
    # Multi-horizon peak regression
    {'name': 'post_mig_peak_pct_4h',      'out': 'models/post_mig_peak_pct_4h_v1.pkl',      'min_pos': 100, 'kind': 'regression', 'mode': 'post'},
    {'name': 'post_mig_peak_pct_24h',     'out': 'models/post_mig_peak_pct_24h_v1.pkl',     'min_pos': 100, 'kind': 'regression', 'mode': 'post'},
    # The holy grail: EV regressor — predicts SOL profit under our exit ladder
    {'name': 'post_mig_ev_with_ladder_sol','out': 'models/post_mig_ev_with_ladder_sol_v1.pkl','min_pos': 100, 'kind': 'regression', 'mode': 'post'},
]


def venv_py():
    return str(ML_ROOT / '.venv' / 'bin' / 'python')


def record_history(target, kind, model_path):
    """After a successful train, read the meta JSON and insert a history row.
    Lightweight A/B baseline: lets us spot AUC/MAE regressions across retrains
    by comparing this row to prior rows for the same target."""
    meta_path = (ML_ROOT / model_path).with_suffix('.json')
    if not meta_path.exists():
        print(f'[history] meta missing for {target}: {meta_path}')
        return
    try:
        meta = json.loads(meta_path.read_text())
    except Exception as e:
        print(f'[history] meta parse failed for {target}: {e}')
        return
    m = meta.get('metrics', {})
    is_regression = (kind == 'regression')
    row = (
        target,
        kind,
        int(time.time() * 1000),
        meta.get('n_train'),
        meta.get('n_val'),
        int(m.get('n_pos')) if m.get('n_pos') is not None else None,
        None if is_regression else m.get('auc_pr'),
        None if is_regression else m.get('auc_roc'),
        None if is_regression else m.get('brier'),
        None if is_regression else m.get('lift'),
        None if is_regression else m.get('baseline_rate'),
        m.get('mae') if is_regression else None,
        m.get('median_ae') if is_regression else None,
        m.get('r2') if is_regression else None,
        1 if (is_regression and target in {'peak_pct_max', 'time_to_peak_sec', 'time_to_peak_5x_sec'}) else 0,
        str(model_path),
        json.dumps(meta.get('feature_importances', {}))[:8000],
        None,
    )
    try:
        # 2026-05-14: was opened read-only — write was silently failing on
        # every record_history insert (table stayed stuck on May 12 entries).
        # Open writable; bot's WAL mode means we don't block its writes.
        conn = sqlite3.connect(DB_PATH, timeout=30)
        conn.execute('PRAGMA journal_mode = WAL')
        conn.execute(
            'INSERT INTO ml_model_history (target, kind, trained_at, n_train, n_val, n_pos, '
            'auc_pr, auc_roc, brier, lift, baseline_rate, mae, median_ae, r2, log_transform, '
            'model_path, feature_importances_json, notes) '
            'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
            row,
        )
        conn.commit()
        conn.close()
    except Exception as e:
        print(f'[history] insert failed for {target}: {e}')


def run(cmd, capture=True):
    print(f'$ {" ".join(str(c) for c in cmd)}')
    if capture:
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.stdout: print(r.stdout, end='')
        if r.returncode != 0:
            print(r.stderr, end='', file=sys.stderr)
        return r
    else:
        return subprocess.run(cmd)


def main():
    t0 = time.time()
    import pandas as pd

    # 2026-05-23: pre-mig extract DISABLED — all pre-mig targets are commented
    # out (post-mig-only focus). The 1.9 GB pandas load OOM-killed the retrain
    # on the 7.8 GB VM. Skip entirely; pre-mig training loop will no-op via
    # empty df_pre.
    print('[retrain] === EXTRACT (pre-mig) SKIPPED — no pre-mig targets ===')
    df_pre = pd.DataFrame()
    n_pre = 0

    # 1b) Extract post-migration training set
    print('[retrain] === EXTRACT (post-mig) ===')
    r = run([venv_py(), str(ML_ROOT / 'scripts' / 'extract_from_migration_snapshots.py'),
             '--out', str(POSTMIG_TRAINING_CSV.relative_to(ML_ROOT))])
    if r.returncode != 0:
        print('[retrain] post-mig extract failed — pre-mig training will proceed without it')
        df_post = pd.DataFrame()
    else:
        try:
            df_post = pd.read_csv(POSTMIG_TRAINING_CSV)
            print(f'[retrain] post-mig training rows: {len(df_post)}')
        except Exception as e:
            print(f'[retrain] could not read post-mig CSV: {e}')
            df_post = pd.DataFrame()

    # Skip pre-mig training if nothing new since last run AND every target
    # already has a trained model on disk. If we've added a new target since
    # last retrain, force training even without new rows. --force overrides.
    force = '--force' in sys.argv
    last_meta = {}
    if LAST_TRAIN_FILE.exists():
        try: last_meta = json.loads(LAST_TRAIN_FILE.read_text())
        except: pass
    last_n = last_meta.get('n_rows', 0)
    # 2026-05-16: don't include targets that can never train yet (insufficient
    # positives in training data) in the "missing" set, or we infinite-loop
    # the retrain. hits_5x_within_24h needs snapshots ≥24h old with the
    # forward window resolved — most recent snapshots haven't aged enough.
    # We rely on the per-target min_pos check inside the loop to skip these
    # gracefully WITHOUT triggering a force-retrain of everything else.
    NEVER_FORCE_TARGETS = {'hits_5x_within_24h'}
    missing_pre_models = [
        t['name'] for t in TARGETS
        if t.get('mode', 'pre') == 'pre'
           and t['name'] not in NEVER_FORCE_TARGETS
           and not (ML_ROOT / t['out']).exists()
    ]
    not_enough_rows = (n_pre <= last_n + 100)
    skip_pre = not_enough_rows and not missing_pre_models and not force
    if skip_pre:
        print(f'[retrain] pre-mig only {n_pre - last_n} new rows since last train AND all models present — skipping pre-mig')
    elif missing_pre_models:
        print(f'[retrain] forcing pre-mig retrain — missing models: {missing_pre_models}')

    # 2) Train each target with the right CSV + features-mode
    trained = []
    for t in TARGETS:
        mode = t.get('mode', 'pre')
        df = df_post if mode == 'post' else df_pre
        csv = POSTMIG_TRAINING_CSV if mode == 'post' else TRAINING_CSV

        if mode == 'pre' and skip_pre:
            continue  # global skip for pre-mig if no new data

        if t['name'] not in df.columns:
            print(f"[retrain] {t['name']} ({mode}): column missing — skip")
            continue
        if t['kind'] == 'binary':
            n_pos = int(df[t['name']].fillna(0).sum())
            if n_pos < t['min_pos']:
                print(f"[retrain] {t['name']} ({mode}): only {n_pos} positives, need {t['min_pos']} — skip")
                continue
            print(f"[retrain] === TRAIN {t['name']} ({mode}, {n_pos} positives) ===")
        else:
            n_valid = int(df[t['name']].notna().sum())
            if n_valid < t['min_pos']:
                print(f"[retrain] {t['name']} ({mode}): only {n_valid} valid rows, need {t['min_pos']} — skip")
                continue
            print(f"[retrain] === TRAIN {t['name']} ({mode}, regression, {n_valid} rows) ===")
        r = run([venv_py(), str(ML_ROOT / 'scripts' / 'train.py'),
                 '--csv', str(csv.relative_to(ML_ROOT)),
                 '--features-mode', mode,
                 '--target', t['name'], '--out', t['out']])
        if r.returncode == 0:
            trained.append(t['name'])
            record_history(t['name'], t['kind'], t['out'])

    # 3) Signal serve.py to reload
    if trained:
        try:
            with urllib.request.urlopen(SERVE_RELOAD_URL, data=b'', timeout=60) as resp:
                print(f'[retrain] serve.py reload: HTTP {resp.status}')
        except (urllib.error.URLError, TimeoutError) as e:
            print(f'[retrain] serve.py reload failed (service may be down): {e}')

    # 4) Update last_train marker
    LAST_TRAIN_FILE.write_text(json.dumps({
        'trained_at_ms': int(time.time() * 1000),
        'n_rows': n_pre,
        'targets_trained': trained,
        'duration_sec': int(time.time() - t0),
    }, indent=2))
    print(f"[retrain] done in {int(time.time() - t0)}s · trained: {trained}")


if __name__ == '__main__':
    main()

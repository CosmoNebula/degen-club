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
DB_PATH = ML_ROOT.parent / 'data' / 'degen.db'

TARGETS = [
    # ---------- PRE-MIGRATION (csv=training.csv, features-mode=pre) ----------
    # Binary classifiers
    {'name': 'peaked_30',             'out': 'models/peaked_30_v1.pkl',             'min_pos': 50,  'kind': 'binary',     'mode': 'pre'},
    {'name': 'peaked_100',            'out': 'models/peaked_100_v1.pkl',            'min_pos': 30,  'kind': 'binary',     'mode': 'pre'},
    {'name': 'peaked_300',            'out': 'models/peaked_300_v1.pkl',            'min_pos': 20,  'kind': 'binary',     'mode': 'pre'},
    {'name': 'migrated',              'out': 'models/migrated_v1.pkl',              'min_pos': 20,  'kind': 'binary',     'mode': 'pre'},
    {'name': 'will_die_fast',         'out': 'models/will_die_fast_v1.pkl',         'min_pos': 50,  'kind': 'binary',     'mode': 'pre'},
    {'name': 'rug_within_5min',       'out': 'models/rug_within_5min_v1.pkl',       'min_pos': 30,  'kind': 'binary',     'mode': 'pre'},
    {'name': 'migrates_within_15min', 'out': 'models/migrates_within_15min_v1.pkl', 'min_pos': 20,  'kind': 'binary',     'mode': 'pre'},
    # hits_2x_within_1h: time-bounded version of peaked_100 — catches medium
    # runners (2-5x within an hour) that the "ever" peaked_100 lumps in with
    # mints that take 6h to reach 2x. Direct entry-signal for short-horizon
    # strategies.
    {'name': 'hits_2x_within_1h',     'out': 'models/hits_2x_within_1h_v1.pkl',     'min_pos': 30,  'kind': 'binary',     'mode': 'pre'},
    # Regressions
    {'name': 'peak_pct_max',           'out': 'models/peak_pct_max_v1.pkl',           'min_pos': 100, 'kind': 'regression', 'mode': 'pre'},
    {'name': 'time_to_peak_sec',       'out': 'models/time_to_peak_sec_v1.pkl',       'min_pos': 100, 'kind': 'regression', 'mode': 'pre'},
    {'name': 'drawdown_from_peak_pct', 'out': 'models/drawdown_from_peak_pct_v1.pkl', 'min_pos': 100, 'kind': 'regression', 'mode': 'pre'},
    # time_to_peak_5x_sec: seconds from "+50% milestone" to "peak after". Drives
    # WHEN to tighten trailing stop on a running position. Existing
    # time_to_peak_sec is from snapshot — different semantics, different use.
    {'name': 'time_to_peak_5x_sec',    'out': 'models/time_to_peak_5x_sec_v1.pkl',    'min_pos': 100, 'kind': 'regression', 'mode': 'pre'},
    # ---------- POST-MIGRATION (csv=training_postmig.csv, features-mode=post) ----------
    {'name': 'post_mig_hits_2x',  'out': 'models/post_mig_hits_2x_v1.pkl',  'min_pos': 50,  'kind': 'binary',     'mode': 'post'},
    {'name': 'post_mig_rugs_1h',  'out': 'models/post_mig_rugs_1h_v1.pkl',  'min_pos': 30,  'kind': 'binary',     'mode': 'post'},
    {'name': 'post_mig_peak_pct', 'out': 'models/post_mig_peak_pct_v1.pkl', 'min_pos': 100, 'kind': 'regression', 'mode': 'post'},
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
        conn = sqlite3.connect(str(DB_PATH), timeout=10)
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

    # 1a) Extract pre-migration training set
    print('[retrain] === EXTRACT (pre-mig) ===')
    r = run([venv_py(), str(ML_ROOT / 'scripts' / 'extract_from_snapshots.py'),
             '--out', str(TRAINING_CSV.relative_to(ML_ROOT))])
    if r.returncode != 0:
        sys.exit('[retrain] pre-mig extract failed')
    try:
        df_pre = pd.read_csv(TRAINING_CSV)
        n_pre = len(df_pre)
    except Exception as e:
        sys.exit(f'[retrain] could not read pre-mig CSV: {e}')
    print(f'[retrain] pre-mig training rows: {n_pre}')

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
    missing_pre_models = [
        t['name'] for t in TARGETS
        if t.get('mode', 'pre') == 'pre' and not (ML_ROOT / t['out']).exists()
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
            with urllib.request.urlopen(SERVE_RELOAD_URL, data=b'', timeout=5) as resp:
                print(f'[retrain] serve.py reload: HTTP {resp.status}')
        except urllib.error.URLError as e:
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

"""
Auto-retrain script — extracts latest labeled snapshots, retrains all three
target models, and signals the running serve.py to reload.

Designed to be cron-able. Idempotent: bails early if no new labels since last
run.

Usage:
    .venv/bin/python scripts/retrain_all.py
"""

import json
import subprocess
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

ML_ROOT = Path(__file__).parent.parent
TRAINING_CSV = ML_ROOT / 'data' / 'training.csv'
LAST_TRAIN_FILE = ML_ROOT / 'data' / '.last_train_meta.json'
SERVE_RELOAD_URL = 'http://127.0.0.1:5050/reload'

TARGETS = [
    # Binary classifiers
    {'name': 'peaked_30',     'out': 'models/peaked_30_v1.pkl',     'min_pos': 50, 'kind': 'binary'},
    {'name': 'peaked_100',    'out': 'models/peaked_100_v1.pkl',    'min_pos': 30, 'kind': 'binary'},
    {'name': 'peaked_300',    'out': 'models/peaked_300_v1.pkl',    'min_pos': 20, 'kind': 'binary'},
    {'name': 'migrated',      'out': 'models/migrated_v1.pkl',      'min_pos': 20, 'kind': 'binary'},
    {'name': 'will_die_fast', 'out': 'models/will_die_fast_v1.pkl', 'min_pos': 50, 'kind': 'binary'},
    # Regressions (min_pos = min total rows since no class concept)
    {'name': 'peak_pct_max',     'out': 'models/peak_pct_max_v1.pkl',     'min_pos': 100, 'kind': 'regression'},
    {'name': 'time_to_peak_sec', 'out': 'models/time_to_peak_sec_v1.pkl', 'min_pos': 100, 'kind': 'regression'},
]


def venv_py():
    return str(ML_ROOT / '.venv' / 'bin' / 'python')


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
    # 1) Extract
    print('[retrain] === EXTRACT ===')
    r = run([venv_py(), str(ML_ROOT / 'scripts' / 'extract_from_snapshots.py'),
             '--out', str(TRAINING_CSV.relative_to(ML_ROOT))])
    if r.returncode != 0:
        sys.exit('[retrain] extract failed')

    # Check row count
    try:
        import pandas as pd
        df = pd.read_csv(TRAINING_CSV)
        n_rows = len(df)
    except Exception as e:
        sys.exit(f'[retrain] could not read training CSV: {e}')
    print(f'[retrain] training rows: {n_rows}')

    # Skip if nothing new
    last_meta = {}
    if LAST_TRAIN_FILE.exists():
        try: last_meta = json.loads(LAST_TRAIN_FILE.read_text())
        except: pass
    last_n = last_meta.get('n_rows', 0)
    if n_rows <= last_n + 100:
        print(f'[retrain] only {n_rows - last_n} new rows since last train — skipping')
        return

    # 2) Train each target
    trained = []
    for t in TARGETS:
        if t['name'] not in df.columns:
            print(f"[retrain] {t['name']}: column missing — skip")
            continue
        # Different feasibility check for regression vs binary
        if t['kind'] == 'binary':
            n_pos = int(df[t['name']].fillna(0).sum())
            if n_pos < t['min_pos']:
                print(f"[retrain] {t['name']}: only {n_pos} positives, need {t['min_pos']} — skip")
                continue
            print(f"[retrain] === TRAIN {t['name']} ({n_pos} positives) ===")
        else:
            n_valid = int(df[t['name']].notna().sum())
            if n_valid < t['min_pos']:
                print(f"[retrain] {t['name']}: only {n_valid} valid rows, need {t['min_pos']} — skip")
                continue
            print(f"[retrain] === TRAIN {t['name']} (regression, {n_valid} rows) ===")
        r = run([venv_py(), str(ML_ROOT / 'scripts' / 'train.py'),
                 '--target', t['name'], '--out', t['out']])
        if r.returncode == 0:
            trained.append(t['name'])

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
        'n_rows': n_rows,
        'targets_trained': trained,
        'duration_sec': int(time.time() - t0),
    }, indent=2))
    print(f"[retrain] done in {int(time.time() - t0)}s · trained: {trained}")


if __name__ == '__main__':
    main()

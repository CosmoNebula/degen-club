"""
Phase 2D — FastAPI inference service · multi-target.

Loads ALL trained model files in models/ at startup, keyed by target.
Routes:
  POST /predict           body: { features: {...}, target: "peaked_30" }
  POST /predict-all       body: { features: {...} } returns { predictions: { target: prob, ... } }
  POST /predict-mint      body: { mint: "..." } looks up snapshot + predicts ALL targets
  POST /reload            re-reads all model files
  GET  /health            service health
  GET  /info              model metadata for all loaded models

Run:
    .venv/bin/python scripts/serve.py
"""

import os
import time
from pathlib import Path
from typing import Any, Dict, Optional

import joblib
import numpy as np
import pandas as pd
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

ML_ROOT = Path(__file__).parent.parent
MODELS_DIR = ML_ROOT / 'models'

app = FastAPI(title='degen-club ML inference', version='0.2.0')

# State: dict of target_name -> { model, feature_cols, meta }
_models: Dict[str, Dict[str, Any]] = {}


def _model_files():
    """Find all .pkl files in models/ excluding smoke/test."""
    if not MODELS_DIR.exists():
        return []
    files = []
    for p in MODELS_DIR.glob('*.pkl'):
        if 'smoke' in p.name.lower():
            continue
        files.append(p)
    return files


def load_all_models():
    """Load every .pkl in models/ and key by target."""
    global _models
    _models = {}
    files = _model_files()
    if not files:
        print(f'[serve] no models in {MODELS_DIR}')
        return
    for f in files:
        try:
            bundle = joblib.load(f)
            target = bundle.get('target')
            if not target:
                print(f'[serve] {f.name}: no target — skipping')
                continue
            mode = bundle.get('mode')
            if not mode:
                # back-compat: infer from metrics shape
                metrics = bundle.get('metrics') or {}
                mode = metrics.get('mode') or ('regression' if 'r2' in metrics else 'classification')
            _models[target] = {
                'model': bundle['model'],
                'feature_cols': bundle['feature_cols'],
                'target': target,
                'mode': mode,
                'log_transform': bool(bundle.get('log_transform', False)),
                'meta': {
                    'trained_at_ms': bundle.get('trained_at_ms'),
                    'n_train': bundle.get('n_train'),
                    'n_val': bundle.get('n_val'),
                    'metrics': bundle.get('metrics'),
                    'mode': mode,
                    'log_transform': bool(bundle.get('log_transform', False)),
                    'file': f.name,
                },
            }
            print(f'[serve] loaded {target} ({f.name}) · mode={mode} · log={bundle.get("log_transform", False)} · {bundle.get("n_train")} train rows')
        except Exception as e:
            print(f'[serve] {f.name}: load failed — {e}')
    print(f'[serve] {len(_models)} models loaded · targets: {list(_models.keys())}')


load_all_models()


class FeaturesPayload(BaseModel):
    # Allow null values for sparse features (passed through as NaN to the model).
    features: Dict[str, Optional[float]]
    target: Optional[str] = None  # default = peaked_30 if available, else first


class MintPayload(BaseModel):
    mint: str


def _default_target():
    if 'peaked_30' in _models: return 'peaked_30'
    if _models: return next(iter(_models.keys()))
    return None


def _predict(target: str, features: Dict[str, float]) -> float:
    if target not in _models:
        raise HTTPException(404, f'no model for target "{target}". Available: {list(_models.keys())}')
    m = _models[target]
    cols = m['feature_cols']
    # Default missing/null to NaN, not 0. HistGradientBoosting was trained on
    # genuine NaNs (sparse features like reaction_speed_ms are null for ~80%
    # of mints) and learns "missing" as its own split. Defaulting to 0 would
    # falsely tell the model "tracked wallets reacted in 0ms" — train/serve
    # skew that silently corrupts predictions on sparse-feature mints.
    row = {}
    for c in cols:
        v = features.get(c)
        row[c] = np.nan if v is None else v
    df = pd.DataFrame([row])
    if m['mode'] == 'regression':
        y = float(m['model'].predict(df)[0])
        if m['log_transform']:
            y = float(np.expm1(y))
        return max(0.0, y)  # nothing negative
    return float(m['model'].predict_proba(df)[0, 1])


@app.get('/health')
def health():
    return {
        'ok': True,
        'model_loaded': len(_models) > 0,
        'models_count': len(_models),
        'targets': list(_models.keys()),
        'target': _default_target(),  # back-compat
    }


@app.get('/info')
def info():
    return {
        'models_count': len(_models),
        'models': {t: m['meta'] for t, m in _models.items()},
        'feature_cols': next(iter(_models.values()))['feature_cols'] if _models else [],
    }


@app.post('/predict')
def predict(payload: FeaturesPayload):
    target = payload.target or _default_target()
    if target is None:
        raise HTTPException(503, 'no models loaded')
    prob = _predict(target, payload.features)
    return {'prob': prob, 'target': target, 'features_used': len(_models[target]['feature_cols'])}


@app.post('/predict-all')
def predict_all(payload: FeaturesPayload):
    if not _models:
        raise HTTPException(503, 'no models loaded')
    out = {}
    for target in _models.keys():
        try: out[target] = _predict(target, payload.features)
        except Exception: out[target] = None
    return {'predictions': out, 'targets': list(_models.keys())}


@app.post('/reload')
def reload_models():
    try:
        load_all_models()
        return {'reloaded': True, 'targets': list(_models.keys()), 'count': len(_models)}
    except Exception as e:
        raise HTTPException(500, f'reload failed: {e}')


@app.post('/predict-mint')
def predict_mint(payload: MintPayload):
    if not _models:
        raise HTTPException(503, 'no models loaded')
    import sqlite3
    cols = next(iter(_models.values()))['feature_cols']
    import os
    db = Path(os.environ.get('DEGEN_DB_PATH', str(Path(__file__).resolve().parent.parent.parent / 'data' / 'degen.db')))
    conn = sqlite3.connect(str(db))
    q = f"SELECT {','.join(cols)} FROM ml_mint_snapshots WHERE mint_address = ? ORDER BY snapshot_age_sec DESC LIMIT 1"
    row = conn.execute(q, (payload.mint,)).fetchone()
    conn.close()
    if not row:
        raise HTTPException(404, f'no snapshot for mint {payload.mint}')
    feats = dict(zip(cols, row))
    out = {}
    for target in _models.keys():
        try: out[target] = _predict(target, feats)
        except Exception: out[target] = None
    return {'mint': payload.mint, 'predictions': out}


if __name__ == '__main__':
    import uvicorn
    uvicorn.run(app, host='127.0.0.1', port=5050, log_level='info')

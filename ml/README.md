# degen-club ML stack (Phase 2+)

Python ML environment for the degen-club bot. Trains migration-probability + regime classifiers from sqlite trade data, serves predictions to the Node bot via FastAPI.

## Layout

```
ml/
├── .venv/             # Python 3.14 virtual env (not checked in)
├── data/              # feature CSVs, prediction logs (not checked in)
├── models/            # trained model files (.pkl) (not checked in)
├── scripts/           # extract_features.py, train.py, serve.py, etc.
├── logs/              # service logs
├── requirements.txt   # pinned deps
└── README.md
```

## Activate the venv

```bash
cd ~/Desktop/degen-club/ml
source .venv/bin/activate
```

## Re-install deps

```bash
pip install -r requirements.txt
```

## Stack

- Python 3.14.2
- scikit-learn `HistGradientBoostingClassifier` (the LightGBM/XGBoost equivalent without macOS libomp dependency)
- FastAPI + Uvicorn for inference service
- joblib for model serialization
- sqlite3 (stdlib) for read-only DB access

## Phases

- 2A: env setup ✅
- 2B: feature extraction (next)
- 2C: training pipeline
- 2D: FastAPI serve
- 2E: bot integration

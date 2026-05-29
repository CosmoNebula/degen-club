#!/bin/bash
# /opt/degen-club/scripts/retrain-all.sh
# Periodic retrain of all v2_lean models on latest snapshots.
# Designed to be cron-able + idempotent. Each model gets the latest 200k
# labeled snapshots from ml_mint_snapshots. nice -n 15 prevents stealing CPU
# from the live bot. After all models train, we POST /reload to serve.py.

set -e
export OMP_NUM_THREADS=1
export OPENBLAS_NUM_THREADS=1
export MKL_NUM_THREADS=1
cd /opt/degen-club

LOG=/var/log/degen-club/retrain.log
PY=ml/.venv/bin/python
STATUS=/opt/degen-club/data/retrain-status.json

TARGETS=(
  peaked_30 peaked_100 peaked_300
  will_rug will_die_fast will_migrate
  hits_2x_within_1h
  local_top_60s drawdown_from_peak_pct
  alive_at_1h alive_at_4h
  buy_pressure_continues_60s pump_durability_5min
  peak_within_5min
  price_up_60s price_up_300s
  drawdown_20pct_300s
  rug_within_5min migrates_within_15min
  unique_buyers_next_60s unique_sellers_next_60s
)

TOTAL=${#TARGETS[@]}
START_TS=$(date +%s%3N)
OK=0
FAIL=0

write_status() {
  local state="$1" cur="$2" idx="$3" lastdone="$4"
  python3 - "$state" "$cur" "$idx" "$TOTAL" "$START_TS" "$OK" "$FAIL" "$lastdone" "$STATUS" <<'PYEOF' 2>/dev/null || true
import json, sys
state, cur, idx, total, started, ok, fail, lastdone, path = sys.argv[1:]
d = {
  "state": state,
  "current_target": cur or None,
  "current_index": int(idx) if idx else 0,
  "total_targets": int(total),
  "started_at": int(started),
  "ok_count": int(ok),
  "fail_count": int(fail),
}
if lastdone:
  d["last_completed_at"] = int(lastdone)
else:
  # preserve prior last_completed_at if present
  try:
    with open(path) as f:
      prev = json.load(f)
    if "last_completed_at" in prev:
      d["last_completed_at"] = prev["last_completed_at"]
  except Exception:
    pass
with open(path + ".tmp", "w") as f:
  json.dump(d, f)
import os
os.replace(path + ".tmp", path)
PYEOF
}

# Always reset to idle on exit so a crashed run doesn't leave a stuck "training" badge.
trap 'write_status idle "" 0 ""' EXIT

echo "" >> "$LOG"
echo "=== retrain run started $(date) ===" >> "$LOG"
write_status starting "" 0 ""

i=0
for t in "${TARGETS[@]}"; do
  i=$((i+1))
  write_status training "$t" "$i" ""
  echo "[retrain] $t" >> "$LOG"
  if nice -n 15 "$PY" ml/scripts/train_v2.py --target "$t" --max-rows 200000 >> "$LOG" 2>&1; then
    OK=$((OK+1))
  else
    FAIL=$((FAIL+1))
    echo "[retrain] FAIL $t" >> "$LOG"
  fi
done

write_status reloading "" $TOTAL ""
echo "[retrain] reloading serve.py" >> "$LOG"
curl -s --max-time 30 -X POST http://127.0.0.1:5050/reload >> "$LOG" 2>&1 || true

DONE_TS=$(date +%s%3N)
echo "=== retrain run finished $(date) · ok=$OK fail=$FAIL ===" >> "$LOG"
write_status idle "" 0 "$DONE_TS"

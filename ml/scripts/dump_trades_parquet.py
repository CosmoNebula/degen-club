"""Dump trades for a given day to a parquet file.

Called by src/ml/cold-archive.js as a subprocess. Args:
  --db    path to degen.db
  --day   YYYY-MM-DD (UTC)
  --out   output parquet file path

Reads all trades whose timestamp falls within the UTC day, writes them as
fastparquet to the output path. Prints a single line of JSON to stdout with
{"rows": N, "size_bytes": M, "min_ts": T1, "max_ts": T2} on success.
Exits non-zero on failure with error to stderr.
"""

import argparse
import json
import sqlite3
import sys
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--day", required=True, help="YYYY-MM-DD (UTC)")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    day_start = datetime.strptime(args.day, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    start_ms = int(day_start.timestamp() * 1000)
    end_ms = start_ms + 24 * 3600 * 1000

    conn = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True, timeout=30)
    df = pd.read_sql_query(
        "SELECT * FROM trades WHERE timestamp >= ? AND timestamp < ?",
        conn,
        params=(start_ms, end_ms),
    )
    conn.close()

    if len(df) == 0:
        print(json.dumps({"rows": 0, "size_bytes": 0, "min_ts": None, "max_ts": None}))
        return

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(out, engine="fastparquet", compression="gzip")

    print(json.dumps({
        "rows": len(df),
        "size_bytes": out.stat().st_size,
        "min_ts": int(df["timestamp"].min()),
        "max_ts": int(df["timestamp"].max()),
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"dump_trades_parquet error: {e}", file=sys.stderr)
        sys.exit(1)

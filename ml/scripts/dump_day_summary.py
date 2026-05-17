"""Generate compact daily summary ("cliff notes") for archive.

Produces a single gzipped JSON capturing the day's activity at a level
that lets us answer "what happened on YYYY-MM-DD" without downloading
the raw trade Parquet (~200 MB → ~150 KB).

Called by src/ml/cold-archive.js as a subprocess. Args:
  --db    path to degen.db (read-only)
  --day   YYYY-MM-DD (UTC)
  --out   output path (.json.gz expected)

Schema of the produced JSON (top-level):
  day             — "YYYY-MM-DD"
  generated_at    — unix ms
  stats           — day-level aggregates (counts of mints, migrations, rugs, 5x+, trades, etc.)
  top_creators    — array of {wallet, launches, migrations, best_peak_mcap}
  top_buyers      — array of {wallet, buys, sol_in}
  strategy_perf   — { strategy_id: {entries, closes, wins, losses, realized_pnl_sol, exit_reasons} }
  regime          — optional regime label for the day (most recent on or before day's end)
  mints           — array of one entry per mint CREATED that day with lifecycle outcome

Exits 0 on success and writes a single JSON line to stdout:
  {"path": "...", "size_bytes": N, "rows_mints": M}
Exits non-zero on failure with stderr error.
"""

import argparse
import gzip
import json
import sqlite3
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


def day_bounds_ms(day_str: str) -> tuple[int, int]:
    """Return (start_ms, end_ms) for the UTC day."""
    dt = datetime.strptime(day_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    start = int(dt.timestamp() * 1000)
    end = start + 24 * 3600 * 1000
    return start, end


def outcome(rugged: int, migrated: int, peak_mcap: float | None, last_trade_at: int | None,
            day_end_ms: int) -> str:
    """Classify the mint's lifecycle outcome as of day-end."""
    if rugged == 1:
        return "rugged"
    if migrated == 1:
        # Migrated and still trading post-day-end?
        if last_trade_at and last_trade_at >= day_end_ms:
            return "migrated_active"
        return "migrated_dormant"
    if (peak_mcap or 0) < 28:  # initial pump.fun mcap is ~28 SOL — never moved
        return "dead_on_arrival"
    if last_trade_at and last_trade_at >= day_end_ms - 3600 * 1000:
        # Still had activity in the last hour of the day
        return "alive_post_pump"
    return "pump_died"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--day", required=True, help="YYYY-MM-DD (UTC)")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    start_ms, end_ms = day_bounds_ms(args.day)

    # Read-only — never block the live bot.
    conn = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row

    # ---------- 1. Day-level mint stats ----------
    stats_row = conn.execute(
        """
        SELECT
          COUNT(*) AS mints_created,
          SUM(CASE WHEN migrated = 1 THEN 1 ELSE 0 END) AS mints_migrated,
          SUM(CASE WHEN rugged = 1 THEN 1 ELSE 0 END) AS mints_rugged,
          SUM(CASE WHEN peak_market_cap_sol >= 140 THEN 1 ELSE 0 END) AS mints_5x_plus,
          SUM(CASE WHEN peak_market_cap_sol >= 280 THEN 1 ELSE 0 END) AS mints_10x_plus,
          SUM(CASE WHEN peak_market_cap_sol >= 1400 THEN 1 ELSE 0 END) AS mints_50x_plus,
          COUNT(DISTINCT creator_wallet) AS unique_creators
        FROM mints
        WHERE created_at >= ? AND created_at < ?
        """,
        (start_ms, end_ms),
    ).fetchone()

    trade_row = conn.execute(
        """
        SELECT
          COUNT(*) AS total_trades,
          COUNT(DISTINCT wallet) AS unique_buyers,
          ROUND(SUM(sol_amount), 2) AS total_sol_volume
        FROM trades
        WHERE timestamp >= ? AND timestamp < ? AND is_buy = 1
        """,
        (start_ms, end_ms),
    ).fetchone()

    stats = {**dict(stats_row), **dict(trade_row)}

    # ---------- 2. Top creators of the day ----------
    top_creators = [
        dict(r) for r in conn.execute(
            """
            SELECT
              creator_wallet AS wallet,
              COUNT(*) AS launches,
              SUM(CASE WHEN migrated = 1 THEN 1 ELSE 0 END) AS migrations,
              ROUND(MAX(peak_market_cap_sol), 2) AS best_peak_mcap
            FROM mints
            WHERE created_at >= ? AND created_at < ? AND creator_wallet IS NOT NULL
            GROUP BY creator_wallet
            ORDER BY launches DESC, best_peak_mcap DESC
            LIMIT 20
            """,
            (start_ms, end_ms),
        )
    ]

    # ---------- 3. Top buyers of the day (by SOL volume) ----------
    top_buyers = [
        dict(r) for r in conn.execute(
            """
            SELECT
              wallet,
              COUNT(*) AS buys,
              ROUND(SUM(sol_amount), 3) AS sol_in
            FROM trades
            WHERE timestamp >= ? AND timestamp < ? AND is_buy = 1
            GROUP BY wallet
            ORDER BY sol_in DESC
            LIMIT 25
            """,
            (start_ms, end_ms),
        )
    ]

    # ---------- 4. Strategy performance for the day ----------
    # Paper positions opened OR closed during the day, grouped by strategy.
    strat_rows = conn.execute(
        """
        SELECT
          strategy,
          SUM(CASE WHEN entered_at >= ? AND entered_at < ? THEN 1 ELSE 0 END) AS entries,
          SUM(CASE WHEN exited_at >= ? AND exited_at < ? THEN 1 ELSE 0 END) AS closes,
          SUM(CASE WHEN exited_at >= ? AND exited_at < ? AND realized_pnl_sol > 0 THEN 1 ELSE 0 END) AS wins,
          SUM(CASE WHEN exited_at >= ? AND exited_at < ? AND realized_pnl_sol < 0 THEN 1 ELSE 0 END) AS losses,
          ROUND(SUM(CASE WHEN exited_at >= ? AND exited_at < ? THEN COALESCE(realized_pnl_sol, 0) ELSE 0 END), 4) AS realized_pnl_sol
        FROM paper_positions
        WHERE (entered_at >= ? AND entered_at < ?)
           OR (exited_at >= ? AND exited_at < ?)
        GROUP BY strategy
        """,
        (start_ms, end_ms) * 7,
    ).fetchall()

    strategy_perf = {}
    for r in strat_rows:
        strat = dict(r)
        sid = strat.pop("strategy")
        # Pull exit_reason breakdown for closes this day
        reasons = conn.execute(
            """
            SELECT exit_reason, COUNT(*) AS n
            FROM paper_positions
            WHERE strategy = ? AND exited_at >= ? AND exited_at < ?
              AND exit_reason IS NOT NULL
            GROUP BY exit_reason
            """,
            (sid, start_ms, end_ms),
        ).fetchall()
        strat["exit_reasons"] = {r["exit_reason"]: r["n"] for r in reasons}
        strategy_perf[sid] = strat

    # ---------- 5. Regime label closest to (or within) day ----------
    regime = None
    try:
        rg = conn.execute(
            """
            SELECT timestamp, message, data_json
            FROM ml_agent_log
            WHERE category = 'market-regime' AND level = 'thought'
              AND timestamp < ?
            ORDER BY timestamp DESC LIMIT 1
            """,
            (end_ms,),
        ).fetchone()
        if rg:
            regime = {
                "timestamp": rg["timestamp"],
                "message": (rg["message"] or "")[:240],
            }
    except sqlite3.OperationalError:
        # Table or columns might not exist on older DBs
        pass

    # ---------- 6. Per-mint lifecycle records ----------
    mint_rows = conn.execute(
        """
        SELECT
          m.mint_address, m.symbol, m.name, m.creator_wallet,
          m.created_at, m.migrated, m.migrated_at, m.rugged, m.rugged_at,
          m.peak_market_cap_sol, m.last_trade_at,
          m.twitter, m.telegram, m.website
        FROM mints m
        WHERE m.created_at >= ? AND m.created_at < ?
        ORDER BY m.peak_market_cap_sol DESC NULLS LAST
        """,
        (start_ms, end_ms),
    ).fetchall()

    mints = []
    for row in mint_rows:
        mint = dict(row)
        addr = mint["mint_address"]

        # Time-to-peak: when did the mint reach its peak mcap? Cheap query if indexed.
        peak_ts_row = conn.execute(
            """
            SELECT MIN(timestamp) AS ts
            FROM trades
            WHERE mint_address = ? AND market_cap_sol >= ?
            """,
            (addr, mint["peak_market_cap_sol"] or 0),
        ).fetchone()
        time_to_peak_sec = None
        if peak_ts_row and peak_ts_row["ts"] and mint["created_at"]:
            time_to_peak_sec = int((peak_ts_row["ts"] - mint["created_at"]) / 1000)

        # Trade volume + unique buyer count for the mint
        agg = conn.execute(
            """
            SELECT
              COUNT(*) AS n_trades,
              COUNT(DISTINCT wallet) AS n_unique_buyers,
              ROUND(SUM(CASE WHEN is_buy = 1 THEN sol_amount ELSE 0 END), 2) AS buy_volume_sol
            FROM trades
            WHERE mint_address = ?
            """,
            (addr,),
        ).fetchone()

        # Top 5 buyers by SOL spent on this mint
        top_buyers_mint = [
            r["wallet"] for r in conn.execute(
                """
                SELECT wallet
                FROM trades
                WHERE mint_address = ? AND is_buy = 1
                GROUP BY wallet
                ORDER BY SUM(sol_amount) DESC
                LIMIT 5
                """,
                (addr,),
            )
        ]

        mints.append({
            "addr": addr,
            "symbol": mint.get("symbol"),
            "name": mint.get("name"),
            "creator": mint.get("creator_wallet"),
            "created_at": mint["created_at"],
            "peak_mcap": mint.get("peak_market_cap_sol"),
            "time_to_peak_sec": time_to_peak_sec,
            "migrated": bool(mint.get("migrated")),
            "migrated_at": mint.get("migrated_at"),
            "rugged": bool(mint.get("rugged")),
            "rugged_at": mint.get("rugged_at"),
            "outcome": outcome(
                mint.get("rugged") or 0,
                mint.get("migrated") or 0,
                mint.get("peak_market_cap_sol"),
                mint.get("last_trade_at"),
                end_ms,
            ),
            "n_trades": agg["n_trades"] if agg else 0,
            "n_unique_buyers": agg["n_unique_buyers"] if agg else 0,
            "buy_volume_sol": agg["buy_volume_sol"] if agg else 0,
            "top_buyers": top_buyers_mint,
            "has_twitter": bool(mint.get("twitter")),
            "has_telegram": bool(mint.get("telegram")),
            "has_website": bool(mint.get("website")),
        })

    conn.close()

    payload = {
        "day": args.day,
        "generated_at": int(time.time() * 1000),
        "version": 1,
        "stats": stats,
        "top_creators": top_creators,
        "top_buyers": top_buyers,
        "strategy_perf": strategy_perf,
        "regime": regime,
        "mints": mints,
    }

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with gzip.open(out_path, "wt", encoding="utf-8", compresslevel=6) as fh:
        json.dump(payload, fh, separators=(",", ":"))

    size = out_path.stat().st_size
    print(json.dumps({
        "path": str(out_path),
        "size_bytes": size,
        "rows_mints": len(mints),
    }))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"dump_day_summary error: {e}", file=sys.stderr)
        sys.exit(1)

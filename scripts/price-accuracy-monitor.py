#!/usr/bin/env python3
"""Price-accuracy monitor — None-safe v2."""
import sqlite3
import time
from datetime import datetime

DB = "/opt/degen-club/data/degen.db"
POLL_SEC = 20
PEAK_INFLATED_THRESHOLD = 0.15
ENTRY_EXIT_TOL = 0.10
MIN_TRADE_SOL = 0.02


def utc_hm():
    return datetime.utcnow().strftime("%H:%M:%S")


def last_closed_id(conn):
    r = conn.execute("SELECT COALESCE(MAX(id), 0) FROM paper_positions WHERE status=\"closed\"").fetchone()
    return r[0] if r else 0


def nearest_trade_price(conn, mint, ts, window_ms=5000):
    if not mint or not ts:
        return None
    row = conn.execute("""
        SELECT price_sol FROM trades
        WHERE mint_address = ?
          AND timestamp BETWEEN ? - ? AND ? + ?
          AND is_junk = 0 AND sol_amount >= ?
        ORDER BY ABS(timestamp - ?) ASC LIMIT 1
    """, (mint, ts, window_ms, ts, window_ms, MIN_TRADE_SOL, ts)).fetchone()
    return row[0] if row else None


def verify(conn, p):
    pid, symbol, entry_price, exit_price, highest_pct, pnl_pct, exit_reason, entered_at, exited_at, mint = p
    entry_price = entry_price or 0
    exit_price = exit_price or 0
    highest_pct = highest_pct or 0
    pnl_pct = pnl_pct or 0
    sym = (symbol or "???")[:9]
    pnl_str = f"{pnl_pct*100:+.1f}%"

    if entry_price <= 0:
        return f"[{utc_hm()}] ⊘ NO ENTRY PRICE #{pid} {sym} {pnl_str} · {exit_reason}"

    row = conn.execute("""
        SELECT MAX(price_sol), COUNT(*) FROM trades
        WHERE mint_address = ? AND timestamp BETWEEN ? AND ?
          AND is_junk = 0 AND sol_amount >= ?
    """, (mint, entered_at, exited_at, MIN_TRADE_SOL)).fetchone()
    real_max, n_trades = row if row else (None, 0)
    real_max = real_max or 0
    n_trades = n_trades or 0

    rec_peak_price = entry_price * (1 + highest_pct)
    rec_peak_pct = highest_pct * 100
    flags = []

    if real_max <= 0:
        return f"[{utc_hm()}] ⊘ NO REAL TRADES #{pid} {sym} {pnl_str} · {n_trades} trades none qualifying · {exit_reason}"

    real_peak_pct = (real_max / entry_price - 1) * 100
    peak_div = (rec_peak_price - real_max) / real_max if real_max > 0 else 0

    if peak_div > PEAK_INFLATED_THRESHOLD:
        flags.append(f"INFLATED PEAK (+{peak_div*100:.0f}%)")
    elif peak_div < -0.30 and real_peak_pct > 30:
        flags.append(f"UNDER-RECORDED PEAK (rec missed {-peak_div*100:.0f}% upside)")

    entry_real = nearest_trade_price(conn, mint, entered_at) or 0
    if entry_real > 0 and entry_price > 0:
        e_div = abs(entry_price - entry_real) / entry_real
        if e_div > ENTRY_EXIT_TOL:
            flags.append(f"ENTRY MISMATCH ({e_div*100:.0f}%)")

    exit_real = nearest_trade_price(conn, mint, exited_at) or 0
    if exit_real > 0 and exit_price > 0:
        x_div = abs(exit_price - exit_real) / exit_real
        if x_div > ENTRY_EXIT_TOL:
            flags.append(f"EXIT MISMATCH ({x_div*100:.0f}%)")

    if flags:
        return f"[{utc_hm()}] ⚠  #{pid} {sym} {pnl_str} · rec peak +{rec_peak_pct:.0f}% vs real +{real_peak_pct:.0f}% · {exit_reason} · " + " · ".join(flags)
    return f"[{utc_hm()}] ✓ #{pid} {sym} {pnl_str} · peak +{rec_peak_pct:.0f}% matches real +{real_peak_pct:.0f}% · {exit_reason} · n={n_trades}"


def main():
    conn = sqlite3.connect(DB)
    last_id = last_closed_id(conn)
    print(f"[{utc_hm()}] monitor started · watching from position id > {last_id}", flush=True)
    while True:
        try:
            rows = conn.execute("""
                SELECT pp.id, m.symbol, pp.entry_price, pp.exit_price, pp.highest_pct,
                       pp.realized_pnl_pct, pp.exit_reason, pp.entered_at, pp.exited_at, pp.mint_address
                FROM paper_positions pp LEFT JOIN mints m ON m.mint_address = pp.mint_address
                WHERE pp.status = "closed" AND pp.id > ?
                ORDER BY pp.id
            """, (last_id,)).fetchall()
            for r in rows:
                try:
                    print(verify(conn, r), flush=True)
                except Exception as ex:
                    print(f"[{utc_hm()}] ERROR row #{(r[0] if r else 0)}: {ex}", flush=True)
                last_id = r[0]
        except Exception as e:
            print(f"[{utc_hm()}] ERROR loop: {e}", flush=True)
        time.sleep(POLL_SEC)


if __name__ == "__main__":
    main()

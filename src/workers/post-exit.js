// workers/post-exit.js — post-exit price tracking.
//
// After a position fully closes, records where the coin's price actually went
// at +5m / +15m / +30m / +1h / +2h / +4h / +8h, so we can measure "sold too
// early vs held too long." Every data point comes from our OWN `trades` table
// (the pump.fun firehose we already ingest), so this works both retroactively
// (backfills every past close) and going forward — no external API calls.
//
// V1 had this; the V2 rewrite dropped it (last real data 2026-05-25 23:31 UTC).
//
// Writes:  post_exit_checks (full per-milestone trajectory)
//          + summary cols on paper_positions: post_exit_peak_pct,
//            post_exit_outcome, post_exit_recheck_at
// Read by: trade audits, and eventually exit-tuner (to learn trail width).

import { db } from '../db.js';

const MILESTONES_MIN = [5, 15, 30, 60, 120, 240, 480];
const MAX_MIN = 480;
const TICK_MS = 5 * 60 * 1000;     // steady-state sweep cadence
const FIRST_RUN_MS = 20 * 1000;    // first sweep ~20s after boot (drains backlog)
const BATCH = 120;                 // positions per pass (keeps each pass short)

// Classify the post-exit run from the realized 8h peak. Positive = the coin ran
// AFTER we sold (we left money on the table); negative = it dropped (good exit).
function classify(peakPct) {
  if (peakPct == null) return 'no_data';
  if (peakPct >= 100) return 'moon_after';   // sold WAY too early
  if (peakPct >= 30)  return 'ran_after';     // sold too early
  if (peakPct > -30)  return 'flat';          // exit roughly fair
  return 'dumped';                            // good exit — dodged a drop
}

let _stmts = null;
function S() {
  if (_stmts) return _stmts;
  const d = db();
  d.exec(`CREATE TABLE IF NOT EXISTS post_exit_checks (
    position_id   INTEGER NOT NULL,
    mint_address  TEXT    NOT NULL,
    milestone_min INTEGER NOT NULL,
    due_at        INTEGER NOT NULL,
    checked_at    INTEGER NOT NULL,
    exit_price    REAL,
    price_at_mark REAL,
    peak_price    REAL,
    pct_at_mark   REAL,
    peak_pct      REAL,
    trades_in_win INTEGER,
    PRIMARY KEY (position_id, milestone_min)
  )`);
  d.exec(`CREATE INDEX IF NOT EXISTS idx_pec_mint ON post_exit_checks(mint_address)`);
  _stmts = {
    // Closed positions whose first mark (+5m) is due and that aren't fully
    // recorded yet (re-examined each sweep until all 7 marks are filled).
    candidates: d.prepare(`
      SELECT pp.id, pp.mint_address, pp.exit_price, pp.exited_at
      FROM paper_positions pp
      WHERE pp.status='closed' AND pp.exit_price > 0 AND pp.exited_at IS NOT NULL
        AND pp.exited_at + 5*60000 <= ?
        AND (SELECT COUNT(*) FROM post_exit_checks pec WHERE pec.position_id = pp.id) < 7
      ORDER BY pp.exited_at DESC
      LIMIT ?`),
    tradesInWindow: d.prepare(`
      SELECT timestamp AS ts, price_sol AS price
      FROM trades
      WHERE mint_address = ? AND timestamp > ? AND timestamp <= ?
        AND price_sol > 0
      ORDER BY timestamp ASC`),
    recorded: d.prepare(`SELECT milestone_min FROM post_exit_checks WHERE position_id = ?`),
    insert: d.prepare(`INSERT OR IGNORE INTO post_exit_checks
      (position_id, mint_address, milestone_min, due_at, checked_at, exit_price,
       price_at_mark, peak_price, pct_at_mark, peak_pct, trades_in_win)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    agg: d.prepare(`SELECT MAX(peak_pct) AS peak, MAX(milestone_min) AS maxm
      FROM post_exit_checks WHERE position_id = ?`),
    summarize: d.prepare(`UPDATE paper_positions SET
      post_exit_peak_pct = ?, post_exit_recheck_at = ?, post_exit_outcome = ?
      WHERE id = ?`),
  };
  return _stmts;
}

// Process one position: fill any due-but-missing milestones from the trades it
// already has in our DB, then refresh its paper_positions summary.
function processPosition(pos, now) {
  const s = S();
  const have = new Set(s.recorded.all(pos.id).map(r => r.milestone_min));
  const dueMissing = MILESTONES_MIN.filter(
    m => !have.has(m) && pos.exited_at + m * 60000 <= now
  );
  if (dueMissing.length === 0) return false;

  // One indexed scan covers all milestones (peak is cumulative from exit).
  const windowEnd = pos.exited_at + MAX_MIN * 60000;
  const rows = s.tradesInWindow.all(pos.mint_address, pos.exited_at, windowEnd);

  const tx = db().transaction(() => {
    for (const m of dueMissing) {
      const dueAt = pos.exited_at + m * 60000;
      let lastPrice = null, peak = null, n = 0;
      for (const r of rows) {
        if (r.ts > dueAt) break;          // rows are ASC; stop at the mark
        lastPrice = r.price;
        if (peak == null || r.price > peak) peak = r.price;
        n++;
      }
      const pctAt = lastPrice == null ? null : (lastPrice - pos.exit_price) / pos.exit_price * 100;
      const pctPeak = peak == null ? null : (peak - pos.exit_price) / pos.exit_price * 100;
      s.insert.run(pos.id, pos.mint_address, m, dueAt, now, pos.exit_price,
        lastPrice, peak, pctAt, pctPeak, n);
    }
    const a = s.agg.get(pos.id);
    const complete = a.maxm != null && a.maxm >= MAX_MIN;
    s.summarize.run(a.peak ?? 0, now, complete ? classify(a.peak) : null, pos.id);
  });
  tx();
  return true;
}

function sweep(limit) {
  const now = Date.now();
  const cands = S().candidates.all(now, limit);
  let processed = 0;
  for (const pos of cands) {
    try { if (processPosition(pos, now)) processed++; }
    catch (e) { console.error(`[post-exit] pos ${pos.id}:`, e.message); }
  }
  return { seen: cands.length, processed };
}

// Drain the historical backlog in BATCH-sized passes, yielding between passes
// so the shared event loop (trading) keeps breathing, then go to steady cadence.
function drainBacklog(total = 0) {
  const { seen, processed } = sweep(BATCH);
  total += processed;
  if (seen >= BATCH && processed > 0) {
    setImmediate(() => drainBacklog(total));
  } else {
    if (total > 0) console.log(`[post-exit] backfill complete · ${total} positions filled`);
    setInterval(() => {
      try { const r = sweep(BATCH); if (r.processed) console.log(`[post-exit] +${r.processed} updated`); }
      catch (e) { console.error('[post-exit] sweep err:', e.message); }
    }, TICK_MS);
  }
}

export function startPostExit() {
  try { S(); } catch (e) { console.error('[post-exit] init:', e.message); }
  console.log(`[post-exit] worker armed · marks [${MILESTONES_MIN.join(',')}]min · source=trades table`);
  setTimeout(() => drainBacklog(), FIRST_RUN_MS);
}

// Cold archive — exports raw trades older than the prune horizon to Parquet
// files, uploads them to MEGA, and records each day-batch in archive_manifest.
// The prune cycle MUST consult this manifest before deleting trades — we never
// delete trades that haven't been archived (lesson learned from 2026-05-09).
//
// One file per UTC day: trades-YYYY-MM-DD.parquet (gzipped, columnar).
// MEGA tier: 20 GB free; ~50 MB compressed per active day → ~6 months runway.
//
// Failure semantics:
//   - Python dump fails → manifest not written → prune skips that day
//   - mega-put fails → manifest not written → prune skips that day
//   - Verified manifest entry → safe to prune that day's rows
//
// First run notes: this module assumes MEGAcmd is installed at the standard
// app path AND a session has been established (mega-login). If the session
// expires, mega-put returns non-zero and we fail the archive cleanly.

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db } from '../db/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

// MEGA binary location — Mac vs Linux. Override with MEGA_BIN_DIR env var if needed.
const MEGA_BIN_DIR = process.env.MEGA_BIN_DIR
  || (process.platform === 'darwin' ? '/Applications/MEGAcmd.app/Contents/MacOS' : '/usr/bin');
const MEGA_REMOTE_DIR = '/degen-club-archives';
const VENV_PYTHON = path.join(PROJECT_ROOT, 'ml', '.venv', 'bin', 'python');
const DUMP_SCRIPT = path.join(PROJECT_ROOT, 'ml', 'scripts', 'dump_trades_parquet.py');
const DB_PATH = path.join(PROJECT_ROOT, 'data', 'degen.db');
const STAGING_DIR = path.join(PROJECT_ROOT, 'data', 'archive', 'staging');

// run-every: archive runs from intelligence-condensate.js's prune tick (every
// 6h). No independent timer here — we want it tightly coupled to the prune.

// MEGA wrapper scripts (mega-put, mega-ls, etc.) internally shell out to
// mega-exec, which they expect to find on PATH. We prepend MEGA_BIN_DIR to
// PATH for every spawn so the wrappers work regardless of how the bot was
// launched (launchd inherits a minimal PATH).
const SPAWN_ENV = { ...process.env, PATH: `${MEGA_BIN_DIR}:${process.env.PATH || ''}` };

function exec(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: SPAWN_ENV,
      ...opts,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} exited ${code}: ${stderr || stdout}`));
    });
  });
}

// Days that have trades in the DB but no archive_manifest row yet, AND are old
// enough to be candidates for pruning. We exclude today (UTC) — the day isn't
// complete yet, so partial archives would later need to be re-archived.
//
// 2026-05-14: DISTINCT strftime on trades was a 4.45M-row tablescan
// (~6.3s cold, ~1.1s warm). Cache for 30min and invalidate when a day
// gets archived. Archive sweep runs every ~6h, so cache is plenty fresh.
const FIND_UNARCHIVED_TTL_MS = 30 * 60 * 1000;
let _cachedUnarchivedDays = null;
let _cachedUnarchivedAt = 0;
function invalidateUnarchivedCache() {
  _cachedUnarchivedDays = null;
  _cachedUnarchivedAt = 0;
}
function findUnarchivedDays() {
  const now = Date.now();
  if (_cachedUnarchivedDays && (now - _cachedUnarchivedAt) < FIND_UNARCHIVED_TTL_MS) {
    return _cachedUnarchivedDays.slice();
  }
  const todayUTC = new Date().toISOString().slice(0, 10);
  _cachedUnarchivedDays = db().prepare(`
    SELECT DISTINCT strftime('%Y-%m-%d', timestamp/1000, 'unixepoch') AS day
    FROM trades
    WHERE day < ?
      AND day NOT IN (SELECT date_key FROM archive_manifest)
    ORDER BY day ASC
  `).all(todayUTC).map(r => r.day);
  _cachedUnarchivedAt = now;
  return _cachedUnarchivedDays.slice();
}

async function archiveDay(day) {
  const stagingPath = path.join(STAGING_DIR, `trades-${day}.parquet`);
  const remotePath = `${MEGA_REMOTE_DIR}/trades-${day}.parquet`;

  fs.mkdirSync(STAGING_DIR, { recursive: true });

  // 1. dump to parquet via Python helper
  const dump = await exec(VENV_PYTHON, [DUMP_SCRIPT, '--db', DB_PATH, '--day', day, '--out', stagingPath]);
  let info;
  try { info = JSON.parse(dump.stdout.trim().split('\n').pop()); }
  catch (e) { throw new Error(`parquet dump for ${day}: bad JSON output: ${dump.stdout}`); }
  if (info.rows === 0) {
    // No trades that day — record an empty entry so we don't try again
    db().prepare(`INSERT OR REPLACE INTO archive_manifest
      (date_key, rows, size_bytes, min_ts, max_ts, parquet_path, mega_path, archived_at)
      VALUES (?, 0, 0, NULL, NULL, NULL, NULL, ?)`).run(day, Date.now());
    invalidateUnarchivedCache();
    return { day, rows: 0, skipped: true };
  }

  // 2. upload to MEGA
  await exec(`${MEGA_BIN_DIR}/mega-put`, ['-c', stagingPath, remotePath]);

  // 3. verify upload by listing the remote file
  const ls = await exec(`${MEGA_BIN_DIR}/mega-ls`, [remotePath]);
  if (!ls.stdout.includes(`trades-${day}.parquet`)) {
    throw new Error(`mega-ls verification failed for ${remotePath}: ${ls.stdout}`);
  }

  // 4. record manifest entry
  db().prepare(`INSERT OR REPLACE INTO archive_manifest
    (date_key, rows, size_bytes, min_ts, max_ts, parquet_path, mega_path, archived_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    day, info.rows, info.size_bytes, info.min_ts, info.max_ts,
    stagingPath, remotePath, Date.now()
  );
  invalidateUnarchivedCache();

  // 5. delete local staging file (it's safe in MEGA now)
  try { fs.unlinkSync(stagingPath); } catch {}

  return { day, rows: info.rows, size_bytes: info.size_bytes };
}

// Public: archive all unarchived days. Called by intelligence-condensate
// before pruning. Returns array of archive results (or rejections).
export async function archiveOldTrades({ verbose = true } = {}) {
  const days = findUnarchivedDays();
  if (days.length === 0) {
    if (verbose) console.log('[archive] no unarchived days');
    return [];
  }
  if (verbose) console.log(`[archive] archiving ${days.length} day(s): ${days.join(', ')}`);
  const results = [];
  for (const day of days) {
    try {
      const r = await archiveDay(day);
      if (verbose) console.log(`[archive] ✓ ${r.day} · ${r.rows} rows · ${((r.size_bytes||0)/1024/1024).toFixed(1)} MB`);
      results.push(r);
    } catch (err) {
      console.error(`[archive] ✗ ${day}: ${err.message}`);
      results.push({ day, error: err.message });
    }
  }
  return results;
}

// Returns true if all trades older than `cutoffMs` are safely archived.
// Caller (prune) uses this as a gate before DELETE.
export function canPruneBefore(cutoffMs) {
  const cutoffDay = new Date(cutoffMs).toISOString().slice(0, 10);
  // Find days that have trades older than cutoff but no manifest entry
  const unarchived = db().prepare(`
    SELECT DISTINCT strftime('%Y-%m-%d', timestamp/1000, 'unixepoch') AS day
    FROM trades
    WHERE timestamp < ?
      AND day NOT IN (SELECT date_key FROM archive_manifest)
  `).all(cutoffMs);
  return { ok: unarchived.length === 0, unarchivedDays: unarchived.map(r => r.day) };
}

// Mark a day-batch as pruned (called from intelligence-condensate after the
// DELETE succeeds for that day's rows).
export function markPruned(dayKey) {
  db().prepare(`UPDATE archive_manifest SET pruned_at = ? WHERE date_key = ?`).run(Date.now(), dayKey);
}

// CLI entry point — `node src/ml/cold-archive.js` runs an archive pass for
// any unarchived days. Useful for one-shot manual runs (initial setup).
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  archiveOldTrades({ verbose: true }).then((r) => {
    console.log(`[archive] done · ${r.length} day(s) processed`);
    process.exit(0);
  }).catch((err) => {
    console.error(`[archive] fatal: ${err.message}`);
    process.exit(1);
  });
}

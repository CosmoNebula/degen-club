// One-shot script: derive correct bonding-curve PDAs for all open positions
// + recent mints with snapshots, update mints.bonding_curve_key.

import Database from 'better-sqlite3';
import { pumpfunBondingCurvePda } from '/opt/degen-club/src/ingest/decoders/pda.js';

const PUMP_PROGRAM = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const db = new Database('/opt/degen-club/data/degen.db');

// Target: held positions + recently-created mints (last 1hr)
const targets = db.prepare(`
  SELECT mint_address, bonding_curve_key FROM mints
  WHERE mint_address IN (SELECT mint_address FROM paper_positions WHERE status='open')
     OR created_at > strftime('%s','now')*1000 - 3600000
`).all();

const upd = db.prepare('UPDATE mints SET bonding_curve_key = ? WHERE mint_address = ?');

let fixed = 0, ok = 0, errors = 0;
for (const m of targets) {
  try {
    const derived = pumpfunBondingCurvePda(m.mint_address, PUMP_PROGRAM).address;
    if (derived !== m.bonding_curve_key) {
      upd.run(derived, m.mint_address);
      fixed++;
    } else {
      ok++;
    }
  } catch (e) {
    errors++;
  }
}

console.log(`Backfill: ${targets.length} candidates · ${ok} already correct · ${fixed} fixed · ${errors} errors`);
db.close();

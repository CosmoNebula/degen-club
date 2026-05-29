// Audit each currently-flagged-migrated open position against on-chain state.
// Un-flag any where the bonding curve doesn't actually show real migration
// (vSol > 85 AND rSol drained).
import Database from 'better-sqlite3';
import { decodeBondingCurve } from '/opt/degen-club/src/ingest/decoders/pumpfun.js';

const HELIUS = 'https://mainnet.helius-rpc.com/?api-key=9f219f41-e083-4335-a2ba-87dac7db771e';
const db = new Database('/opt/degen-club/data/degen.db');

const rows = db.prepare(`SELECT pp.mint_address, m.bonding_curve_key
  FROM paper_positions pp JOIN mints m USING(mint_address)
  WHERE pp.status='open' AND m.migrated=1`).all();

console.log(`auditing ${rows.length} migrated holds...`);
let unflagged = 0, kept = 0;

for (const r of rows) {
  if (!r.bonding_curve_key) continue;
  const resp = await fetch(HELIUS, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({jsonrpc:'2.0',id:1,method:'getAccountInfo',params:[r.bonding_curve_key,{encoding:'base64',commitment:'confirmed'}]})
  });
  const j = await resp.json();
  const v = j?.result?.value;
  if (!v?.data || v.data[0] === '') {
    // BC account empty/closed - that IS a real migration. Keep flag.
    console.log(`  ${r.mint_address.slice(0,10)}…  BC closed → real migration, keep flag`);
    kept++;
    continue;
  }
  const dec = decodeBondingCurve(v.data[0]);
  if (!dec) continue;
  // Real migration: vSol > 85 (signaling real_sol of 85+ was deposited pre-migration)
  // AND rSol drained AND mcap not trivially low
  const realMig = dec.rSol < 0.5 && dec.vSol > 85 && dec.mcapSol > 30;
  if (realMig) {
    console.log(`  ${r.mint_address.slice(0,10)}…  vSol=${dec.vSol.toFixed(0)} rSol=${dec.rSol.toFixed(3)} mcap=${dec.mcapSol.toFixed(1)} SOL  → KEEP flag (real migration)`);
    kept++;
  } else {
    console.log(`  ${r.mint_address.slice(0,10)}…  vSol=${dec.vSol.toFixed(0)} rSol=${dec.rSol.toFixed(3)} mcap=${dec.mcapSol.toFixed(1)} SOL  → UN-FLAG (drained, not migrated)`);
    db.prepare(`UPDATE mints SET migrated=0, migrated_at=NULL, last_price_source='rpc-sub' WHERE mint_address=?`).run(r.mint_address);
    unflagged++;
  }
}
console.log(`\naudit done: ${kept} legit migrations · ${unflagged} drained mints un-flagged`);
db.close();

// V4.2: bump max_mint_age_sec 60 → 240. Covers the slow-warmer pattern
// (mint launches → quiet for 2-3 min → elite buys → pump). The mcap range
// 28-80 SOL is the real anti-late-chase filter; age was over-conservative.
import { db } from '/opt/degen-club/src/db/index.js';
import { deployStrategy } from '/opt/degen-club/src/ml/agent-executor.js';

const d = db();
const ID = 'agent_2026-05-17_elite-aped-v1';
const row = d.prepare('SELECT recipe_json FROM ml_agent_strategies WHERE id = ?').get(ID);
const r = JSON.parse(row.recipe_json);
r.entry.max_mint_age_sec = 240;
d.prepare('UPDATE ml_agent_strategies SET recipe_json = ? WHERE id = ?').run(JSON.stringify(r), ID);
deployStrategy(ID, r);
console.log('Updated max_mint_age_sec to 240');
process.exit(0);

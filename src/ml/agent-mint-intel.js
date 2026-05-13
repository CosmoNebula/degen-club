// Hourly batch mint metadata intel — scans the last hour's qualifying mints
// for ruggy / winner-coded patterns. Heuristic pre-filter classifies obvious
// junk and obvious winners locally (free); only borderline cases get the
// Claude consult. One call per hour, all borderline mints in one prompt.
//
// Output lands in ml_mint_intel; the agent reads recent verdicts when
// proposing strategies and the executor can use them as a feature/gate.

import { db } from '../db/index.js';
import { spawn } from 'node:child_process';
import { canConsult, recordConsult } from './agent-rate-limit.js';

const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const TICK_INTERVAL_MS = 60 * 60 * 1000;  // hourly
const MAX_BORDERLINE_FOR_CLAUDE = 60;     // cap one batch
const FIRST_RUN_DELAY_MS = 20 * 60 * 1000; // 20 min after boot

let stmts = null;
function S() {
  if (stmts) return stmts;
  const d = db();
  stmts = {
    // Pull last-hour mints we haven't analyzed yet, with metadata
    candidates: d.prepare(`
      SELECT m.mint_address, m.creator_wallet, m.name, m.symbol, m.description,
             m.twitter, m.telegram, m.website,
             m.created_at, m.unique_buyer_count, m.trade_count,
             (SELECT COUNT(*) FROM mints WHERE creator_wallet = m.creator_wallet) AS creator_launches,
             (SELECT COUNT(*) FROM mints WHERE creator_wallet = m.creator_wallet AND migrated = 1) AS creator_migs
      FROM mints m
      LEFT JOIN ml_mint_intel mi ON mi.mint_address = m.mint_address
      WHERE m.created_at > ? AND mi.mint_address IS NULL
        AND m.unique_buyer_count >= 3
      ORDER BY m.created_at DESC LIMIT ?
    `),
    insert: d.prepare(`INSERT OR REPLACE INTO ml_mint_intel
       (mint_address, analyzed_at, source, verdict, confidence, signals_json, rationale)
       VALUES (?, ?, ?, ?, ?, ?, ?)`),
    log: d.prepare(`INSERT INTO ml_agent_log (timestamp, level, category, message, data_json)
       VALUES (?, 'info', 'mint-intel', ?, ?)`),
  };
  return stmts;
}

// Quick & free heuristic. Returns:
//  { decision: 'junk'|'winner'|'clean'|'borderline', signals: [...], confidence }
// Only 'borderline' entries get sent to Claude.
function heuristicVerdict(m) {
  const signals = [];
  const name = (m.name || '').toLowerCase();
  const sym = (m.symbol || '').toLowerCase();
  const desc = (m.description || '').trim();
  const hasTwit = !!m.twitter;
  const hasTg = !!m.telegram;
  const hasWeb = !!m.website;
  const socialCount = (hasTwit ? 1 : 0) + (hasTg ? 1 : 0) + (hasWeb ? 1 : 0);

  // Obvious junk patterns → don't waste Claude on these
  if (!name && !sym) { signals.push('no-name-or-symbol'); return { decision: 'junk', signals, confidence: 0.95 }; }
  if (/^(test|abc|asdf|qwerty|aaa+|xxx+)\d*$/i.test(name)) { signals.push('test-coin-name'); return { decision: 'junk', signals, confidence: 0.95 }; }
  if (/^[a-z]{1,2}$/.test(sym)) { signals.push('1-2char-symbol'); return { decision: 'junk', signals, confidence: 0.7 }; }
  if (m.creator_launches > 100 && (m.creator_migs || 0) === 0) {
    signals.push(`creator-${m.creator_launches}-launches-0-migs`);
    return { decision: 'junk', signals, confidence: 0.9 };
  }
  if (socialCount === 0 && desc.length < 20) {
    signals.push('no-socials-no-desc');
    return { decision: 'junk', signals, confidence: 0.85 };
  }

  // Strong winner signals — likely worth tracking
  if (m.creator_migs >= 1 && socialCount >= 2) {
    signals.push(`creator-prev-mig`, `${socialCount}-socials`);
    return { decision: 'winner', signals, confidence: 0.7 };
  }
  if (socialCount === 3 && desc.length > 80) {
    signals.push('all-3-socials', 'detailed-desc');
    return { decision: 'winner', signals, confidence: 0.6 };
  }

  // Borderline — send to Claude
  if (socialCount >= 1 || desc.length >= 30) {
    if (m.creator_launches > 30) signals.push(`creator-${m.creator_launches}-launches`);
    if (m.creator_migs > 0) signals.push(`creator-${m.creator_migs}-migs`);
    if (socialCount > 0) signals.push(`${socialCount}-socials`);
    return { decision: 'borderline', signals, confidence: 0.5 };
  }
  // Else: not enough signal worth Claude — call it 'clean' as default no-action
  return { decision: 'clean', signals: ['minimal-signal'], confidence: 0.3 };
}

const SYSTEM_PROMPT = `You scan pump.fun memecoin mint metadata for rug-coded vs winner-coded patterns. Memecoins have a culture: certain naming, description, and social patterns correlate with rugs (low effort, copy-paste, fake socials), and others correlate with momentum (real community, current narrative, coherent branding).

For each mint I show you, return a verdict:
- "winner" — strong signal this could pump (good narrative, real branding, current meme, effort)
- "clean" — looks fine, no red flags, nothing exceptional
- "suspicious" — some red flags, would not enter blind
- "ruggy" — strong rug signals (test-coin, scam-coded, low-effort grift)

Be DECISIVE. Pump.fun is 99% noise — most things are "clean" or "ruggy", a few are "suspicious", very few are real "winner"s. Don't be generous with the winner verdict.`;

function fmtMintForClaude(idx, m) {
  return `${idx}. mint=${m.mint_address.slice(0, 16)}…
   name="${m.name || '—'}" symbol="${m.symbol || '—'}"
   desc="${(m.description || '—').slice(0, 200).replace(/\n/g, ' ')}"
   socials: tw=${m.twitter ? 'Y' : 'N'} tg=${m.telegram ? 'Y' : 'N'} web=${m.website ? 'Y' : 'N'}
   creator: ${m.creator_launches} launches, ${m.creator_migs} migrations`;
}

const CLAUDE_OUTPUT_SCHEMA = {
  type: 'object',
  required: ['verdicts'],
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        required: ['idx', 'verdict', 'confidence'],
        properties: {
          idx: { type: 'integer' },
          verdict: { type: 'string', enum: ['winner', 'clean', 'suspicious', 'ruggy'] },
          confidence: { type: 'number' },
          signals: { type: 'array', items: { type: 'string' } },
          rationale: { type: 'string' },
        },
      },
    },
  },
};

function callClaudeBatch(promptBody) {
  return new Promise((resolve, reject) => {
    const fullPrompt = `${promptBody}\n\nReturn JSON only, conforming to this schema. One verdict per mint, by idx:\n${JSON.stringify(CLAUDE_OUTPUT_SCHEMA, null, 2)}`;
    const args = [
      '--print', '--output-format', 'json',
      '--disallowedTools', '*',
      '--append-system-prompt', SYSTEM_PROMPT,
      fullPrompt,
    ];
    const proc = spawn(CLAUDE_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: '/tmp' });
    let stdout = '', stderr = '';
    const t = setTimeout(() => { try { proc.kill('SIGKILL'); } catch {}; reject(new Error('timeout')); }, 180000);
    proc.stdout.on('data', d => stdout += d.toString());
    proc.stderr.on('data', d => stderr += d.toString());
    proc.on('exit', (code) => {
      clearTimeout(t);
      if (code !== 0) return reject(new Error(`exit ${code}: ${stderr.slice(0, 300)}`));
      try {
        const env = JSON.parse(stdout);
        const raw = String(env.result || '');
        let s = raw.trim();
        const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (fence) s = fence[1].trim();
        if (!s.startsWith('{')) {
          const f = s.indexOf('{'), l = s.lastIndexOf('}');
          if (f >= 0 && l > f) s = s.slice(f, l + 1);
        }
        resolve({ result: JSON.parse(s), envelope: env });
      } catch (err) { reject(new Error(`parse failed: ${err.message}`)); }
    });
    proc.on('error', err => { clearTimeout(t); reject(err); });
  });
}

let _running = false;
async function tick() {
  if (_running) return;
  _running = true;
  try {
    const oneHourAgo = Date.now() - TICK_INTERVAL_MS;
    const cands = S().candidates.all(oneHourAgo, 500);
    if (cands.length === 0) return;

    // Heuristic pass — classify everything for free
    const buckets = { junk: [], winner: [], clean: [], borderline: [] };
    for (const m of cands) {
      const v = heuristicVerdict(m);
      buckets[v.decision].push({ mint: m, ...v });
    }

    // Persist heuristic verdicts for everything except borderline
    const now = Date.now();
    for (const v of [...buckets.junk, ...buckets.winner, ...buckets.clean]) {
      const verdict = v.decision === 'junk' ? 'ruggy' : (v.decision === 'winner' ? 'winner' : 'clean');
      S().insert.run(
        v.mint.mint_address, now, 'heuristic', verdict,
        v.confidence, JSON.stringify(v.signals), v.signals.join(', '));
    }

    const borderline = buckets.borderline.slice(0, MAX_BORDERLINE_FOR_CLAUDE);
    if (borderline.length === 0) {
      console.log(`[mint-intel] hour batch · heuristic only · junk=${buckets.junk.length} winner=${buckets.winner.length} clean=${buckets.clean.length}`);
      return;
    }
    if (!canConsult('mint-intel')) {
      console.log('[mint-intel] daily Claude cap hit — heuristic only this batch');
      // Persist borderline as 'clean' fallback (heuristic verdict)
      for (const b of borderline) {
        S().insert.run(b.mint.mint_address, now, 'heuristic-fallback', 'clean',
          0.3, JSON.stringify(b.signals), 'rate-limited');
      }
      return;
    }

    // Ask Claude on the borderline cases
    const promptBody = `Analyze these ${borderline.length} pump.fun mints. Return one verdict per idx.\n\n` +
      borderline.map((b, i) => fmtMintForClaude(i + 1, b.mint)).join('\n\n');

    let result;
    try {
      recordConsult('mint-intel');
      result = await callClaudeBatch(promptBody);
    } catch (err) {
      console.error('[mint-intel] claude consult failed:', err.message);
      // Persist borderline as 'clean' fallback so we don't keep retrying
      for (const b of borderline) {
        S().insert.run(b.mint.mint_address, now, 'heuristic-fallback', 'clean',
          0.3, JSON.stringify(b.signals), 'claude unavailable, deferred');
      }
      return;
    }

    const verdicts = result.result?.verdicts || [];
    const map = {};
    for (const v of verdicts) map[v.idx] = v;

    let claudeWins = 0;
    for (let i = 0; i < borderline.length; i++) {
      const b = borderline[i];
      const idx = i + 1;
      const v = map[idx];
      if (!v) {
        S().insert.run(b.mint.mint_address, now, 'heuristic-fallback', 'clean',
          0.3, JSON.stringify(b.signals), 'no claude verdict');
        continue;
      }
      const signals = [...(b.signals || []), ...(v.signals || [])];
      S().insert.run(
        b.mint.mint_address, now, 'claude', v.verdict,
        v.confidence ?? 0.5, JSON.stringify(signals), v.rationale || '');
      claudeWins++;
    }

    // Tally for the dashboard / agent context
    const tally = { junk: buckets.junk.length, winner: buckets.winner.length, clean: buckets.clean.length, claude_reviewed: claudeWins };
    S().log.run(now,
      `hour batch · heuristic: junk=${tally.junk} winner=${tally.winner} clean=${tally.clean} · claude reviewed ${tally.claude_reviewed}`,
      JSON.stringify({ tally, claude_cost_estimate_usd: result.envelope?.total_cost_usd }));
    console.log(`[mint-intel] hour batch · heuristic ${tally.junk + tally.winner + tally.clean} · claude ${claudeWins} · cost~$${(result.envelope?.total_cost_usd || 0).toFixed(2)}`);
  } finally { _running = false; }
}

export function startMintIntel() {
  setTimeout(tick, FIRST_RUN_DELAY_MS);
  setInterval(tick, TICK_INTERVAL_MS);
  console.log('[mint-intel] scheduled · hourly batch, heuristic + claude on borderlines');
}

// Public — agent reads this when proposing strategies, executor reads to filter entries
export function getMintVerdict(mintAddress) {
  return db().prepare(`SELECT verdict, confidence, signals_json, source, analyzed_at
     FROM ml_mint_intel WHERE mint_address = ?`).get(mintAddress);
}

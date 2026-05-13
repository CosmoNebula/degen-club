// Phase C — Sentiment scoring.
//
// Every 15 min, pulls recent crypto-relevant news_items, batches them, sends
// to Claude CLI for sentiment + ticker + theme extraction. Writes aggregated
// per-mint and per-narrative scores to sentiment tables.
//
// Designed to make Claude usage visible: every call logs prompt size, output
// size, duration, and item count. Conservative defaults (50 calls/day cap,
// 25 posts per call, 15-min first-run delay) — bump SENTIMENT_DAILY_CAP env
// if you're comfortable with the usage you observe.
//
// The bot doesn't USE sentiment features yet — this just collects data.
// Plumbing into ml_mint_snapshots happens after you confirm usage is fine.

import { db } from '../db/index.js';
import { spawn } from 'node:child_process';

const ENABLED = (process.env.SENTIMENT_ENABLED || 'true').toLowerCase() !== 'false';
const SCORE_INTERVAL_MS = 15 * 60 * 1000;
const FIRST_RUN_DELAY_MS = 15 * 60 * 1000;  // no boot-time auto-fire
const BATCH_SIZE = 25;
const MIN_BATCH = 5;                          // skip cycle if fewer items waiting
const DAILY_CAP = parseInt(process.env.SENTIMENT_DAILY_CAP || '50', 10);
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const CALL_TIMEOUT_MS = 90 * 1000;

const _state = {
  callsToday: 0,
  callsResetAt: 0,
  lastProcessedTs: 0,
};

const SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          idx: { type: 'integer' },
          tickers: { type: 'array', items: { type: 'string' } },
          sentiment: { type: 'string', enum: ['bullish', 'bearish', 'shill', 'fud', 'neutral'] },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          themes: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
};

const SYSTEM_PROMPT = `You score crypto memecoin social posts for trading-signal extraction.
For each numbered post, return:
- tickers: cashtags ($TICKER) or bare TICKER (uppercase, 2-12 chars). EXCLUDE common words like USD, ETH, BTC, SOL unless they're clearly a memecoin name.
- sentiment: bullish (genuine excitement, "going to moon", buying), bearish (selling, dumping, dead), shill (paid hype, copy-paste, same text across accounts), fud (deliberate fear-mongering), neutral (news only, no opinion).
- confidence: 0-1, how clear the signal is.
- themes: 1-3 short narrative tags lowercased like "ai", "doge", "trump", "election", "ipo", "earnings", "frog", "cat".

Return idx matching input order. Skip (omit) items with no clear ticker AND no clear theme.`;

function ensureSchema(d) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS mint_sentiment (
      mint_address TEXT NOT NULL,
      window_start INTEGER NOT NULL,
      bull_mentions INTEGER DEFAULT 0,
      bear_mentions INTEGER DEFAULT 0,
      shill_mentions INTEGER DEFAULT 0,
      fud_mentions INTEGER DEFAULT 0,
      neutral_mentions INTEGER DEFAULT 0,
      total_mentions INTEGER DEFAULT 0,
      sum_confidence REAL DEFAULT 0,
      last_updated_at INTEGER,
      PRIMARY KEY (mint_address, window_start)
    );
    CREATE INDEX IF NOT EXISTS idx_mint_sent_window ON mint_sentiment(window_start DESC);

    CREATE TABLE IF NOT EXISTS narrative_sentiment (
      theme TEXT NOT NULL,
      window_start INTEGER NOT NULL,
      bull_mentions INTEGER DEFAULT 0,
      bear_mentions INTEGER DEFAULT 0,
      shill_mentions INTEGER DEFAULT 0,
      fud_mentions INTEGER DEFAULT 0,
      neutral_mentions INTEGER DEFAULT 0,
      total_mentions INTEGER DEFAULT 0,
      sum_confidence REAL DEFAULT 0,
      last_updated_at INTEGER,
      PRIMARY KEY (theme, window_start)
    );
    CREATE INDEX IF NOT EXISTS idx_narr_sent_window ON narrative_sentiment(window_start DESC);

    -- Per-post raw Claude scores. Lets the dashboard show "Claude said this
    -- post = bullish $TICKER" so we can verify the worker is doing sane things.
    -- Stores both the scored fields and a snippet of the source post for context.
    CREATE TABLE IF NOT EXISTS sentiment_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id INTEGER NOT NULL,
      news_id INTEGER,
      scored_at INTEGER NOT NULL,
      source TEXT,
      post_text TEXT,
      tickers_json TEXT,
      sentiment TEXT,
      confidence REAL,
      themes_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_sent_items_scored ON sentiment_items(scored_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sent_items_run ON sentiment_items(run_id);

    CREATE TABLE IF NOT EXISTS sentiment_runs (
      run_id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      items_in INTEGER DEFAULT 0,
      items_scored INTEGER DEFAULT 0,
      claude_calls INTEGER DEFAULT 0,
      input_chars INTEGER DEFAULT 0,
      output_chars INTEGER DEFAULT 0,
      duration_ms INTEGER,
      status TEXT,
      error TEXT
    );
  `);
}

let stmts = null;
function S() {
  if (stmts) return stmts;
  const d = db();
  ensureSchema(d);
  stmts = {
    recentNews: d.prepare(`
      SELECT id, source, title, summary, ts
      FROM news_items
      WHERE ts > ? AND ts <= ?
        AND (source LIKE 'reddit:r/CryptoCurrency'
             OR source LIKE 'reddit:r/solana'
             OR source LIKE 'reddit:r/CryptoMoonShots'
             OR source LIKE 'reddit:r/wallstreetbets'
             OR source LIKE 'twitter:%'
             OR source LIKE 'truth-social:%'
             OR source IN ('rss:CoinDesk','rss:CoinTelegraph','rss:The Block','rss:Decrypt','rss:CryptoSlate'))
        AND LENGTH(COALESCE(title,'') || ' ' || COALESCE(summary,'')) >= 50
      ORDER BY ts ASC
      LIMIT 200
    `),
    findMintBySymbol: d.prepare(`
      SELECT mint_address FROM mints
      WHERE UPPER(symbol) = UPPER(?)
      ORDER BY COALESCE(peak_market_cap_sol, 0) DESC
      LIMIT 1
    `),
    upsertMint: d.prepare(`
      INSERT INTO mint_sentiment
        (mint_address, window_start, bull_mentions, bear_mentions,
         shill_mentions, fud_mentions, neutral_mentions, total_mentions,
         sum_confidence, last_updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(mint_address, window_start) DO UPDATE SET
        bull_mentions = bull_mentions + excluded.bull_mentions,
        bear_mentions = bear_mentions + excluded.bear_mentions,
        shill_mentions = shill_mentions + excluded.shill_mentions,
        fud_mentions = fud_mentions + excluded.fud_mentions,
        neutral_mentions = neutral_mentions + excluded.neutral_mentions,
        total_mentions = total_mentions + excluded.total_mentions,
        sum_confidence = sum_confidence + excluded.sum_confidence,
        last_updated_at = excluded.last_updated_at
    `),
    upsertNarrative: d.prepare(`
      INSERT INTO narrative_sentiment
        (theme, window_start, bull_mentions, bear_mentions,
         shill_mentions, fud_mentions, neutral_mentions, total_mentions,
         sum_confidence, last_updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(theme, window_start) DO UPDATE SET
        bull_mentions = bull_mentions + excluded.bull_mentions,
        bear_mentions = bear_mentions + excluded.bear_mentions,
        shill_mentions = shill_mentions + excluded.shill_mentions,
        fud_mentions = fud_mentions + excluded.fud_mentions,
        neutral_mentions = neutral_mentions + excluded.neutral_mentions,
        total_mentions = total_mentions + excluded.total_mentions,
        sum_confidence = sum_confidence + excluded.sum_confidence,
        last_updated_at = excluded.last_updated_at
    `),
    insertItem: d.prepare(`
      INSERT INTO sentiment_items
        (run_id, news_id, scored_at, source, post_text,
         tickers_json, sentiment, confidence, themes_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `),
    insertRun: d.prepare(`
      INSERT INTO sentiment_runs (started_at, status) VALUES (?, 'running')
    `),
    finishRun: d.prepare(`
      UPDATE sentiment_runs SET finished_at=?, items_in=?, items_scored=?,
        claude_calls=?, input_chars=?, output_chars=?, duration_ms=?, status=?, error=?
      WHERE run_id = ?
    `),
  };
  return stmts;
}

// 4h windows aligned to 0/4/8/12/16/20 UTC
function currentWindowStart() {
  const FOUR_HOURS = 4 * 60 * 60 * 1000;
  return Math.floor(Date.now() / FOUR_HOURS) * FOUR_HOURS;
}

function rolloverDailyCap() {
  const now = Date.now();
  const DAY = 24 * 60 * 60 * 1000;
  if (now - _state.callsResetAt > DAY) {
    _state.callsToday = 0;
    _state.callsResetAt = now;
  }
}

function callClaude(prompt) {
  const startedAt = Date.now();
  const inputChars = prompt.length;
  return new Promise((resolve, reject) => {
    const fullPrompt = `${prompt}\n\nIMPORTANT: respond with ONLY a JSON object matching the schema. No prose, no commentary. Just JSON.\n\nSCHEMA:\n${JSON.stringify(SCHEMA, null, 2)}`;
    const args = [
      '--print',
      '--output-format', 'json',
      '--disallowedTools', '*',
      '--append-system-prompt', SYSTEM_PROMPT,
      fullPrompt,
    ];
    const proc = spawn(CLAUDE_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'], cwd: '/tmp' });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => {
      try { proc.kill('SIGKILL'); } catch {}
      reject(new Error(`timeout after ${CALL_TIMEOUT_MS}ms`));
    }, CALL_TIMEOUT_MS);
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('exit', code => {
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      const outputChars = stdout.length;
      if (code !== 0) {
        return reject(new Error(`claude exited ${code}: ${stderr.slice(0, 200)}`));
      }
      try {
        const env = JSON.parse(stdout);
        let raw = String(env.result || env.response || '').trim();
        const fence = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (fence) raw = fence[1].trim();
        if (!raw.startsWith('{')) {
          const first = raw.indexOf('{'), last = raw.lastIndexOf('}');
          if (first >= 0 && last > first) raw = raw.slice(first, last + 1);
        }
        resolve({ parsed: JSON.parse(raw), inputChars, outputChars, durationMs });
      } catch (e) {
        reject(new Error(`parse: ${e.message} · stdout head: ${stdout.slice(0, 300)}`));
      }
    });
    proc.on('error', err => { clearTimeout(timer); reject(err); });
  });
}

function buildPrompt(batch) {
  const lines = batch.map((item, i) => {
    const text = `${item.title || ''} ${item.summary || ''}`.replace(/\s+/g, ' ').trim().slice(0, 500);
    return `${i}. [${item.source}] ${text}`;
  });
  return `Score these ${batch.length} posts:\n\n${lines.join('\n')}`;
}

function storeBatch(scored, batch, runId) {
  const s = S();
  const windowStart = currentWindowStart();
  const now = Date.now();
  let mintHits = 0, themeHits = 0;
  for (const item of (scored?.items || [])) {
    const sent = item.sentiment;
    const conf = typeof item.confidence === 'number' ? item.confidence : 0;
    const bull = sent === 'bullish' ? 1 : 0;
    const bear = sent === 'bearish' ? 1 : 0;
    const shill = sent === 'shill' ? 1 : 0;
    const fud = sent === 'fud' ? 1 : 0;
    const neutral = sent === 'neutral' ? 1 : 0;
    // Lookup the source post by idx (claude returns idx matching input order)
    const sourcePost = (typeof item.idx === 'number' && item.idx >= 0 && item.idx < batch.length)
      ? batch[item.idx] : null;
    const postText = sourcePost
      ? `${sourcePost.title || ''} ${sourcePost.summary || ''}`.replace(/\s+/g, ' ').trim().slice(0, 400)
      : null;
    // Persist the raw scored item so the dashboard can show "Claude said X
    // about this post". This is what makes the worker verifiable.
    try {
      s.insertItem.run(
        runId,
        sourcePost?.id ?? null,
        now,
        sourcePost?.source ?? null,
        postText,
        JSON.stringify(item.tickers || []),
        sent || null,
        conf,
        JSON.stringify(item.themes || []),
      );
    } catch (err) { /* swallow per-row insert errors */ }
    // Mint mentions
    for (const ticker of (item.tickers || []).slice(0, 5)) {
      if (typeof ticker !== 'string' || ticker.length < 2 || ticker.length > 12) continue;
      const row = s.findMintBySymbol.get(ticker);
      if (!row?.mint_address) continue;
      s.upsertMint.run(row.mint_address, windowStart, bull, bear, shill, fud, neutral, 1, conf, now);
      mintHits++;
    }
    // Theme mentions
    for (const theme of (item.themes || []).slice(0, 3)) {
      if (typeof theme !== 'string' || theme.length < 2 || theme.length > 30) continue;
      s.upsertNarrative.run(theme.toLowerCase().trim(), windowStart, bull, bear, shill, fud, neutral, 1, conf, now);
      themeHits++;
    }
  }
  return { mintHits, themeHits };
}

async function runCycle() {
  if (!ENABLED) return;
  rolloverDailyCap();
  const s = S();
  const startedAt = Date.now();
  const runId = s.insertRun.run(startedAt).lastInsertRowid;

  let callsThisRun = 0, inputCharsTotal = 0, outputCharsTotal = 0;
  let itemsIn = 0, itemsScored = 0, status = 'ok', errorMsg = null;

  try {
    const since = _state.lastProcessedTs || (Date.now() - 2 * 60 * 60 * 1000);
    const news = s.recentNews.all(since, Date.now());
    itemsIn = news.length;
    if (news.length < MIN_BATCH) {
      console.log(`[sentiment] only ${news.length} items waiting (min ${MIN_BATCH}) — skip cycle`);
      status = 'skipped';
    } else {
      // Batch and call Claude
      for (let i = 0; i < news.length; i += BATCH_SIZE) {
        if (_state.callsToday >= DAILY_CAP) {
          console.log(`[sentiment] daily cap ${DAILY_CAP} reached — stopping cycle`);
          status = 'cap-hit';
          break;
        }
        const batch = news.slice(i, i + BATCH_SIZE);
        const prompt = buildPrompt(batch);
        console.log(`[sentiment] calling claude · batch ${Math.floor(i / BATCH_SIZE) + 1} · items=${batch.length} · prompt_chars=${prompt.length} · calls_today=${_state.callsToday}/${DAILY_CAP}`);
        try {
          const { parsed, inputChars, outputChars, durationMs } = await callClaude(prompt);
          _state.callsToday++;
          callsThisRun++;
          inputCharsTotal += inputChars;
          outputCharsTotal += outputChars;
          const { mintHits, themeHits } = storeBatch(parsed, batch, runId);
          itemsScored += (parsed?.items?.length || 0);
          console.log(`[sentiment] returned · scored=${parsed?.items?.length || 0} · mint_hits=${mintHits} · theme_hits=${themeHits} · out_chars=${outputChars} · ${durationMs}ms`);
        } catch (err) {
          console.error(`[sentiment] batch err: ${err.message}`);
        }
        // Advance watermark to last item ts in this batch even on error so we don't loop forever
        _state.lastProcessedTs = batch[batch.length - 1].ts;
      }
    }
  } catch (err) {
    status = 'error';
    errorMsg = err.message;
    console.error(`[sentiment] cycle err: ${err.message}`);
  }

  const durationMs = Date.now() - startedAt;
  s.finishRun.run(Date.now(), itemsIn, itemsScored, callsThisRun, inputCharsTotal, outputCharsTotal, durationMs, status, errorMsg, runId);
  console.log(`[sentiment] cycle done · status=${status} · items_in=${itemsIn} · items_scored=${itemsScored} · claude_calls=${callsThisRun} · in_chars=${inputCharsTotal} · out_chars=${outputCharsTotal} · ${durationMs}ms · today=${_state.callsToday}/${DAILY_CAP}`);
}

export function startSentimentScorer() {
  if (!ENABLED) {
    console.log('[sentiment] DISABLED via SENTIMENT_ENABLED=false');
    return;
  }
  ensureSchema(db());
  console.log(`[sentiment] scheduled · first_run=+${FIRST_RUN_DELAY_MS / 60000}min · interval=${SCORE_INTERVAL_MS / 60000}min · batch_size=${BATCH_SIZE} · daily_cap=${DAILY_CAP}`);
  setTimeout(() => {
    runCycle().catch(err => console.error('[sentiment] initial cycle err:', err.message));
    setInterval(() => {
      runCycle().catch(err => console.error('[sentiment] cycle err:', err.message));
    }, SCORE_INTERVAL_MS);
  }, FIRST_RUN_DELAY_MS);
}

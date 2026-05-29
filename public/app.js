// Degen Club V2 dashboard — vanilla JS, no build.
// Refreshes every 3s. Single page.

const REFRESH_MS = 3000;
let SOL_USD = 145; // updated from /api/stats each tick
const fmt = {
  usd: (sol) => {
    if (sol == null || isNaN(sol)) return '—';
    const usd = sol * SOL_USD;
    if (usd >= 1_000_000) return '$' + (usd/1_000_000).toFixed(2) + 'M';
    if (usd >= 1000) return '$' + (usd/1000).toFixed(1) + 'K';
    return '$' + usd.toFixed(0);
  },
  sol: (n, d=4) => (n == null || isNaN(n)) ? '—' : (n >= 0 ? '+' : '') + n.toFixed(d) + ' ◎',
  pct: (n, d=1) => (n == null || isNaN(n)) ? '—' : (n >= 0 ? '+' : '') + n.toFixed(d) + '%',
  int: (n) => (n == null || isNaN(n)) ? '—' : Math.round(n).toLocaleString(),
  num: (n, d=2) => (n == null || isNaN(n)) ? '—' : n.toFixed(d),
  prob: (n) => (n == null || isNaN(n)) ? '—' : n.toFixed(2),
  ts: (ms) => {
    if (!ms) return '—';
    const s = Math.floor((Date.now() - ms) / 1000);
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s/60)}m ago`;
    if (s < 86400) return `${Math.floor(s/3600)}h ago`;
    return `${Math.floor(s/86400)}d ago`;
  },
  age: (ms) => {
    if (!ms) return '—';
    const s = Math.floor((Date.now() - ms) / 1000);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s/60)}m`;
    return `${(s/3600).toFixed(1)}h`;
  },
  mint: (addr) => addr ? addr.slice(0, 8) + '…' : '—',
  dur: (sec) => {
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.floor(sec/60)}m`;
    if (sec < 86400) return `${(sec/3600).toFixed(1)}h`;
    return `${(sec/86400).toFixed(1)}d`;
  },
};

const $ = (id) => document.getElementById(id);
const setTxt = (id, txt) => { const el = $(id); if (el) el.textContent = txt; };

async function getJson(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } catch (e) {
    console.warn('fetch failed', url, e.message);
    return null;
  }
}

// ============================================================ RENDER

function renderWallet(w) {
  if (!w) return;
  if (w.solUsd && w.solUsd > 0) SOL_USD = w.solUsd;
  const total = (w.sim?.totalValue ?? 0);
  const starting = (w.sim?.startingBalanceSol ?? 5);
  const pct = (w.sim?.pctChange ?? 0) * 100;
  const cash = w.sim?.cashBalance ?? 0;
  const inCoins = w.sim?.openMtm ?? 0;
  const realized = w.realizedPnlSol ?? 0;
  const peak = w.sim?.peakTotalValue ?? starting;
  const dd = (w.sim?.drawdown ?? 0) * 100;
  const wr = w.winRate ?? 0;

  $('w-total').textContent = total.toFixed(4) + ' ◎';
  $('w-total').className = 'value ' + (total >= starting ? 'green' : 'red');
  $('w-pct').textContent = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
  $('w-pct').className = 'sub ' + (pct >= 0 ? 'green' : 'red');
  setTxt('w-cash', cash.toFixed(4) + ' ◎');
  setTxt('w-incoins', inCoins.toFixed(4) + ' ◎');
  $('w-realized').textContent = (realized >= 0 ? '+' : '') + realized.toFixed(4) + ' ◎';
  $('w-realized').className = 'value ' + (realized > 0 ? 'green' : realized < 0 ? 'red' : '');
  setTxt('w-peak', peak.toFixed(3) + ' / ' + dd.toFixed(1) + '%');
  setTxt('w-winrate', (wr * 100).toFixed(0) + '%');
  setTxt('w-winratecount', (w.wins || 0) + '/' + (w.totalClosed || 0));
  setTxt('w-open', String(w.openPositions || 0));
}

function pill(id, label, status, detail) {
  const el = $(id);
  if (!el) return;
  el.className = 'pill ' + status;
  el.textContent = label + (detail ? ' ' + detail : '');
}

function renderHealth(h, mode) {
  pill('pill-mode', mode === 'paper' ? '📝 PAPER' : '🔴 LIVE', mode === 'live' ? 'live' : '');
  if (!h) { pill('pill-bot', 'BOT', 'bad', 'no heartbeat'); return; }
  const bot = h.status === 'ALIVE' ? 'ok' : 'bad';
  pill('pill-bot', 'BOT', bot, fmt.dur(h.bot?.uptime_sec || 0));
  const ot = h.feeds?.onchainTrades || {};
  const otStatus = !ot.connected ? 'bad' : (ot.last_event_ago_sec > 30 ? 'warn' : 'ok');
  pill('pill-logs', 'LOGS', otStatus, ot.connected ? `${ot.last_event_ago_sec}s` : 'down');
  const pp = h.feeds?.pumpportal || {};
  const ppStatus = !pp.connected ? 'bad' : (pp.last_event_ago_sec > 60 ? 'warn' : 'ok');
  pill('pill-pp', 'PP', ppStatus, pp.connected ? `${pp.last_event_ago_sec}s` : 'down');
  setTxt('meta-uptime', fmt.dur(h.bot?.uptime_sec || 0));
}

function renderIngest(stats, h, ml) {
  setTxt('is-logs-rate', stats?.logsSub?.trades > 0 ? (stats.logsSub.trades / 60).toFixed(1) : '0');
  setTxt('is-logs-parsed', fmt.int(stats?.logsSub?.trades));
  setTxt('is-logs-inserts', fmt.int(stats?.logsSub?.inserts));
  setTxt('is-pp-new', fmt.int(stats?.pumpportal?.newToken));
  setTxt('is-pp-mig', fmt.int(stats?.pumpportal?.migration));
  setTxt('is-pp-last', stats?.pumpportal?.lastEventAt ? fmt.ts(stats.pumpportal.lastEventAt) : '—');
  setTxt('is-ml-models', String(ml?.modelsLoaded || 36));
  setTxt('is-ml-preds', fmt.int(ml?.preds3min));
  setTxt('is-ml-snaps', fmt.int(ml?.totalSnapshots));
  setTxt('is-db-size', fmt.int(h?.db?.size_mb));
  setTxt('is-db-trades', fmt.int(h?.db?.trades));
  setTxt('is-db-mints', fmt.int(stats?.totalMints));
  setTxt('foot-rate', stats?.logsSub?.trades > 0 ? (stats.logsSub.trades / 60).toFixed(0) : '—');
  const mlStatus = h?.bot ? 'ok' : 'warn';
  pill('pill-ml', 'ML', mlStatus, ml ? `${ml.modelsLoaded || 36}` : '—');
}

function tierBadges(p) {
  let hit = [];
  try { hit = JSON.parse(p.tiers_hit || '[]'); } catch {}
  const trailArmed = (p.trail_armed === 1) || hit.length >= 1;
  const realized = p.sol_realized_so_far || 0;
  const chip = (name, trigger, isHit) => {
    const trig = trigger != null ? `+${Math.round(trigger)}%` : '—';
    const title = isHit ? `${name} hit (${trig})` : `${name} fires at ${trig}`;
    return `<span class="tier-chip ${isHit ? 'on' : 'off'}" title="${title}">${name}</span>`;
  };
  const trailChip = trailArmed
    ? `<span class="tier-chip trail" title="Trail armed · exit at peak − ${Math.round(p.trail_pct || 20)}%">▾${Math.round(p.trail_pct || 20)}</span>`
    : '';
  const realizedTag = realized > 0
    ? `<span class="tier-realized" title="SOL banked from partial sells">+${realized.toFixed(3)}◎</span>`
    : '';
  return `<div class="tier-cell">
    ${chip('T1', p.tier1_trigger_pct, hit.includes('T1'))}
    ${chip('T2', p.tier2_trigger_pct, hit.includes('T2'))}
    ${chip('T3', p.tier3_trigger_pct, hit.includes('T3'))}
    ${trailChip}
    ${realizedTag}
  </div>`;
}

function renderPositions(rows) {
  setTxt('positions-count', `(${rows?.length || 0})`);
  const tbody = $('positions-table').querySelector('tbody');
  if (!rows || rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="12" class="empty">no open positions</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map((p) => {
    const realPct = p.entry_price > 0 && p.now_price > 0 ? (p.now_price / p.entry_price - 1) * 100 : 0;
    const realPnl = (p.tokens_remaining || 0) * (p.now_price || 0) + (p.sol_realized_so_far || 0) - p.entry_sol;
    const pctClass = realPct >= 0 ? 'pos' : 'neg';
    return `<tr class="row-click" onclick="openMint('${p.mint_address}')">
      <td class="sym">${escapeHtml(p.symbol || '?')}</td>
      <td><span class="mint-link">${fmt.mint(p.mint_address)}</span></td>
      <td>${p.migrated ? '<span class="cyan">POST</span>' : '<span class="dim">PRE</span>'}</td>
      <td class="age">${fmt.age(p.entered_at)}</td>
      <td class="right">${fmt.usd(p.entry_mcap_sol)}</td>
      <td class="right">${p.entry_sol.toFixed(3)} ◎</td>
      <td class="right">${fmt.usd(p.current_market_cap_sol)}</td>
      <td class="right ${pctClass}">${realPct >= 0 ? '+' : ''}${realPct.toFixed(1)}%</td>
      <td class="right ${realPnl >= 0 ? 'pos' : 'neg'}">${realPnl >= 0 ? '+' : ''}${realPnl.toFixed(4)}</td>
      <td class="right dim">${(p.highest_pct || 0).toFixed(0)}%</td>
      <td>${tierBadges(p)}</td>
      <td class="dim small">${p.entry_score ? p.entry_score.toFixed(2) : '—'}</td>
    </tr>`;
  }).join('');
}

function renderCloses(rows) {
  setTxt('closes-count', `(${rows?.length || 0})`);
  const tbody = $('closes-table').querySelector('tbody');
  if (!rows || rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty">no closes yet</td></tr>';
    return;
  }
  const v2 = rows.filter((r) => r.strategy === 'ml-policy-v2').slice(0, 30);
  if (!v2.length) {
    tbody.innerHTML = '<tr><td colspan="8" class="empty">no V2 closes yet · (older V1 closes hidden)</td></tr>';
    return;
  }
  tbody.innerHTML = v2.map((p) => {
    const pct = p.realized_pnl_pct || 0;
    const pnl = p.realized_pnl_sol || 0;
    const pctClass = pct >= 0 ? 'pos' : 'neg';
    return `<tr class="row-click" onclick="openMint('${p.mint_address}')">
      <td class="sym">${escapeHtml(p.symbol || '?')}</td>
      <td><span class="mint-link">${fmt.mint(p.mint_address)}</span></td>
      <td><span class="dim">${escapeHtml(p.exit_reason || '?')}</span></td>
      <td class="right">${(p.entry_sol || 0).toFixed(3)}</td>
      <td class="right ${pctClass}">${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%</td>
      <td class="right ${pnl >= 0 ? 'pos' : 'neg'}">${pnl >= 0 ? '+' : ''}${pnl.toFixed(4)} ◎</td>
      <td class="right dim">${(p.highest_pct || 0).toFixed(0)}%</td>
      <td class="age">${fmt.ts(p.exited_at)}</td>
    </tr>`;
  }).join('');
}

function renderPicks(rows) {
  const tbody = $('picks-table').querySelector('tbody');
  if (!rows || rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">waiting for picks…</td></tr>';
    return;
  }
  tbody.innerHTML = rows.slice(0, 15).map((p) => {
    return `<tr class="row-click" onclick="openMint('${p.mint_address}')">
      <td class="sym">${escapeHtml(p.symbol || '?')}</td>
      <td><span class="mint-link">${fmt.mint(p.mint_address)}</span></td>
      <td class="right ${p.h2x > 0.3 ? 'cyan' : ''}">${fmt.prob(p.h2x)}</td>
      <td class="right ${p.p100 > 0.2 ? 'cyan' : ''}">${fmt.prob(p.p100)}</td>
      <td class="right ${p.die > 0.4 ? 'red' : 'dim'}">${fmt.prob(p.die)}</td>
      <td class="right ${p.rug > 0.1 ? 'red' : 'dim'}">${fmt.prob(p.rug)}</td>
      <td class="right">${fmt.usd(p.current_market_cap_sol)}</td>
    </tr>`;
  }).join('');
}

function renderMints(rows) {
  const tbody = $('mints-table').querySelector('tbody');
  if (!rows || rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">waiting for mints…</td></tr>';
    return;
  }
  tbody.innerHTML = rows.slice(0, 20).map((m) => {
    const status = m.rugged ? '<span class="red">RUGGED</span>'
                : m.migrated ? '<span class="cyan">MIGRATED</span>'
                : '<span class="dim">live</span>';
    return `<tr class="row-click" onclick="openMint('${m.mint_address}')">
      <td class="sym">${escapeHtml(m.symbol || '?')}</td>
      <td><span class="mint-link">${fmt.mint(m.mint_address)}</span></td>
      <td class="age">${fmt.age(m.created_at)}</td>
      <td class="right">${fmt.usd(m.current_market_cap_sol)}</td>
      <td class="right dim">${fmt.usd(m.peak_market_cap_sol)}</td>
      <td class="right">${m.trade_count || 0}</td>
      <td>${status}</td>
    </tr>`;
  }).join('');
}

function renderStrategy(limits) {
  if (!limits) return;
  setTxt('strat-thresh', fmt.num(limits.entryThreshold, 2));
  setTxt('strat-floor', fmt.num(limits.holdFloor, 2));
  setTxt('strat-tick', limits.tickMs);
  setTxt('strat-maxopen', limits.maxOpenPositions);
  setTxt('strat-maxexp', limits.maxExposureSol.toFixed(1));
  setTxt('strat-size', `0.10–${limits.maxPerTradeSol.toFixed(2)}`);
  setTxt('strat-cool', `${(limits.reentryCooldownMs/60000).toFixed(0)}m`);
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

// ============================================================ MODAL

async function openMint(addr) {
  $('modal-bg').classList.add('show');
  $('modal').classList.add('show');
  $('modal-title').textContent = fmt.mint(addr);
  $('modal-body').textContent = 'loading…';
  const data = await getJson(`/api/mint/${addr}`);
  if (!data || !data.mint) {
    $('modal-body').textContent = 'mint not found';
    return;
  }
  const m = data.mint;
  $('modal-title').innerHTML = `<span class="cyan">${escapeHtml(m.symbol || '?')}</span> · <span class="dim">${escapeHtml(m.name || '')}</span> · <span class="dim small">${addr}</span>`;

  // Compute pred groups
  const preds = data.predictions || [];
  const latest = {};
  for (const p of preds) {
    if (!latest[p.target] || p.timestamp > latest[p.target].timestamp) latest[p.target] = p;
  }
  const predGrid = Object.entries(latest)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([target, p]) => {
      const v = (p.prob || 0).toFixed(3);
      return `<div class="pred-cell"><span class="name">${target}</span><span class="val">${v}</span></div>`;
    }).join('');

  const trades = data.recentTrades || [];
  const recentTrades = trades.slice(0, 20).map((t) => {
    return `<tr><td class="age">${fmt.ts(t.timestamp)}</td><td>${t.is_buy ? '<span class="green">BUY</span>' : '<span class="red">SELL</span>'}</td><td>${t.sol_amount.toFixed(4)} ◎</td><td class="dim small">${fmt.mint(t.wallet)}</td></tr>`;
  }).join('');

  const snaps = data.snapshots || [];

  $('modal-body').innerHTML = `
    <h3>STATE</h3>
    <div class="preds-grid">
      <div class="pred-cell"><span class="name">price</span><span class="val">${(m.last_price_sol * 1e9).toFixed(3)}n ◎</span></div>
      <div class="pred-cell"><span class="name">mcap</span><span class="val">${fmt.usd(m.current_market_cap_sol)}</span></div>
      <div class="pred-cell"><span class="name">peak mcap</span><span class="val">${fmt.usd(m.peak_market_cap_sol)}</span></div>
      <div class="pred-cell"><span class="name">age</span><span class="val">${fmt.ts(m.created_at)}</span></div>
      <div class="pred-cell"><span class="name">trades</span><span class="val">${m.trade_count || 0}</span></div>
      <div class="pred-cell"><span class="name">status</span><span class="val">${m.rugged ? 'RUGGED' : m.migrated ? 'MIGRATED' : 'live'}</span></div>
    </div>
    <h3>ML PREDICTIONS (latest)</h3>
    ${predGrid ? `<div class="preds-grid">${predGrid}</div>` : '<div class="dim small">no predictions yet</div>'}
    <h3>SNAPSHOTS (${snaps.length})</h3>
    ${snaps.length ? `<div class="dim small">ages: ${snaps.map(s => s.snapshot_age_sec).join(', ')}s · last ${fmt.ts(snaps[snaps.length-1].snapshot_ts)}</div>` : '<div class="dim small">no snapshots yet</div>'}
    <h3>RECENT TRADES (${trades.length})</h3>
    ${trades.length ? `<table class="t"><tbody>${recentTrades}</tbody></table>` : '<div class="dim small">no trades</div>'}
  `;
}

function closeModal() {
  $('modal-bg').classList.remove('show');
  $('modal').classList.remove('show');
}

window.openMint = openMint;
window.closeModal = closeModal;

// ============================================================ RESET WALLET

async function resetWallet() {
  if (!confirm('Reset paper wallet to 5.0 SOL? This will close all open positions.')) return;
  const r = await fetch('/api/wallet/sim/reset', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ balance: 5.0 }),
  });
  if (r.ok) alert('Wallet reset to 5.0 SOL');
  else alert('reset failed');
  refresh();
}
window.resetWallet = resetWallet;

// ============================================================ TRAINING PROGRESS

function fmtAgo(ts) {
  if (!ts) return '—';
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 60) return s + 's ago';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

async function refreshTraining() {
  try {
    const t = await getJson('/api/ml/retrain-status');
    const panel = document.getElementById('training-stat');
    const stateEl = document.getElementById('t-state');
    const subEl = document.getElementById('t-sub');
    const fillEl = document.getElementById('t-bar-fill');
    if (!panel) return;
    const state = (t.state || 'idle').toLowerCase();
    const total = t.total_targets || 17;
    const idx = t.current_index || 0;
    const active = state === 'training' || state === 'starting' || state === 'reloading';
    panel.classList.toggle('active', active);

    if (state === 'training') {
      const pct = Math.round((idx / total) * 100);
      stateEl.textContent = `${idx}/${total}`;
      fillEl.style.width = pct + '%';
      subEl.textContent = t.current_target || '…';
    } else if (state === 'starting') {
      stateEl.textContent = 'starting…';
      fillEl.style.width = '2%';
      subEl.textContent = `0/${total}`;
    } else if (state === 'reloading') {
      stateEl.textContent = 'reloading';
      fillEl.style.width = '100%';
      subEl.textContent = `${total}/${total} · serve.py`;
    } else {
      stateEl.textContent = 'idle';
      fillEl.style.width = '0%';
      subEl.textContent = t.last_completed_at
        ? `last: ${fmtAgo(t.last_completed_at)}${t.fail_count ? ` · ${t.fail_count} fail` : ''}`
        : 'no runs yet';
    }
  } catch {}
}

// ============================================================ MAIN LOOP

async function refresh() {
  if (document.hidden) return;
  try {
    const [stats, positions, closes, health, mlStatus, picks, mints, limits, mode] = await Promise.all([
      getJson('/api/stats'),
      getJson('/api/positions'),
      getJson('/api/closed?limit=50'),
      getJson('/api/system/health'),
      getJson('/api/ml/status'),
      getJson('/api/ml/top-picks'),
      getJson('/api/mints?limit=20&window=600000'),
      getJson('/api/limits'),
      getJson('/api/mode'),
    ]);
    renderWallet(stats);
    renderHealth(health, mode?.mode || 'paper');
    renderIngest(stats, health, mlStatus);
    renderPositions(positions);
    renderCloses(closes);
    renderPicks(picks);
    renderMints(mints);
    renderStrategy(limits);
    setTxt('meta-refreshed', new Date().toLocaleTimeString());
  } catch (e) {
    console.error('refresh err:', e);
  }
}

refresh();
refreshTraining();
setInterval(refresh, REFRESH_MS);
setInterval(refreshTraining, 5000);

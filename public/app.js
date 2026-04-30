let solUsd = 0;
let tradersCategory = 'all';
let tradersTrackedOnly = false;
let devsCategory = 'all';
let mintsCategory = 'all';
const sortStates = {};

function getSortState(tableId) {
  return sortStates[tableId] || { key: null, dir: null };
}

function cycleSortState(tableId, key) {
  const cur = getSortState(tableId);
  if (cur.key === key) {
    if (cur.dir === 'desc') sortStates[tableId] = { key, dir: 'asc' };
    else sortStates[tableId] = { key: null, dir: null };
  } else {
    sortStates[tableId] = { key, dir: 'desc' };
  }
}

function deriveSortValue(row, key) {
  if (key === '_rugRate') return row.launch_count ? (row.rugged_count || 0) / row.launch_count : 0;
  if (key === '_duration') return (row.exited_at || 0) - (row.entered_at || 0);
  return row[key];
}

function applySort(rows, tableId) {
  const state = getSortState(tableId);
  if (!state.key) return rows;
  const key = state.key;
  const dir = state.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    let av = deriveSortValue(a, key);
    let bv = deriveSortValue(b, key);
    const aMissing = av == null || av === '';
    const bMissing = bv == null || bv === '';
    if (aMissing && bMissing) return 0;
    if (aMissing) return 1;
    if (bMissing) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return dir * (av - bv);
    return dir * String(av).localeCompare(String(bv));
  });
}

function renderSortIndicators() {
  document.querySelectorAll('th[data-sort]').forEach(th => {
    const tbody = th.closest('table').querySelector('tbody');
    if (!tbody) return;
    const state = getSortState(tbody.id);
    th.classList.toggle('sort-asc', state.key === th.dataset.sort && state.dir === 'asc');
    th.classList.toggle('sort-desc', state.key === th.dataset.sort && state.dir === 'desc');
  });
}

function bindSortable() {
  document.querySelectorAll('th[data-sort]').forEach(th => {
    th.classList.add('sortable');
    th.addEventListener('click', () => {
      const tbody = th.closest('table').querySelector('tbody');
      if (!tbody) return;
      cycleSortState(tbody.id, th.dataset.sort);
      renderSortIndicators();
      tick();
    });
  });
  renderSortIndicators();
}

function mcapUsd(mcapSol) {
  if (mcapSol == null) return '—';
  if (!solUsd) return `${Number(mcapSol).toFixed(1)} ◎`;
  const usd = Number(mcapSol) * solUsd;
  if (usd >= 1_000_000) return `$${(usd / 1_000_000).toFixed(2)}M`;
  if (usd >= 1_000) return `$${(usd / 1_000).toFixed(1)}k`;
  return `$${usd.toFixed(0)}`;
}

const fmt = {
  sol: (n) => (n == null ? '—' : `${Number(n).toFixed(3)} SOL`),
  solSigned: (n) => {
    if (n == null) return '—';
    const v = Number(n);
    return `${v >= 0 ? '+' : ''}${v.toFixed(3)} SOL`;
  },
  pct: (n) => (n == null ? '—' : `${(n * 100).toFixed(1)}%`),
  int: (n) => (n == null ? '—' : Number(n).toLocaleString()),
  num: (n, d = 2) => (n == null ? '—' : Number(n).toFixed(d)),
  usd: mcapUsd,
  mcap: (sol) => {
    if (sol == null || !isFinite(sol) || sol <= 0) return '—';
    if (solUsd > 0) {
      const usd = sol * solUsd;
      if (usd >= 1e6) return `$${(usd / 1e6).toFixed(2)}M`;
      if (usd >= 1e3) return `$${(usd / 1e3).toFixed(1)}k`;
      return `$${usd.toFixed(0)}`;
    }
    return `${sol.toFixed(1)} ◎`;
  },
  short: (s) => (s ? `${s.slice(0, 4)}…${s.slice(-4)}` : '—'),
  time: (ts) => {
    if (!ts) return '—';
    return new Date(ts).toLocaleTimeString('en-US', { hour12: false });
  },
  dt: (ts) => {
    if (!ts) return '—';
    const d = new Date(ts);
    return `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString('en-US', { hour12: false })}`;
  },
  age: (ts) => {
    if (!ts) return '—';
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
  },
  ageSec: (s) => {
    if (s == null) return '—';
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m`;
    return `${Math.floor(s / 3600)}h`;
  },
  duration: (from, to) => {
    if (!from || !to) return '—';
    const s = Math.floor((to - from) / 1000);
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  },
};

async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return res.json();
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function colorize(id, n) {
  const el = document.getElementById(id);
  if (!el) return;
  el.style.color = n > 0 ? 'var(--green)' : n < 0 ? 'var(--pink)' : '';
}

function statusBadge(m) {
  if (m.rugged) return '<span class="badge rugged">RUGGED</span>';
  if (m.migrated) return '<span class="badge migrated">MIGRATED</span>';
  return '<span class="badge live">LIVE</span>';
}

function cashbackBadge(m) {
  if (m && m.cashback_enabled === 1) return '<span class="badge cashback" title="Creator fee-share enabled — holders earn rebates">💸 CASHBACK</span>';
  return '';
}

function flagBadges(flags) {
  if (!flags || !flags.length) return '';
  return flags.map(f => {
    const cls = f === 'DEV_HOLDING' ? 'flag good' : 'flag bad';
    return `<span class="${cls}">${f}</span>`;
  }).join(' ');
}

function socialsLine(m, compact = true) {
  const items = [];
  if (m.twitter) items.push(`<a href="${m.twitter}" target="_blank" title="Twitter">𝕏</a>`);
  if (m.telegram) items.push(`<a href="${m.telegram}" target="_blank" title="Telegram">TG</a>`);
  if (m.website) items.push(`<a href="${m.website}" target="_blank" title="Website">🌐</a>`);
  if (!items.length) return compact ? '—' : '<span class="muted">no socials</span>';
  return items.join(' ');
}

function bindCopyable() {
  document.querySelectorAll('.copyable').forEach(el => {
    el.onclick = () => navigator.clipboard?.writeText(el.dataset.copy || el.textContent);
  });
}

let currentView = 'mints';
let systemWindow = '6';
let labWindow = '6';
let labFilter = 'all';

function setActiveTab(name) {
  currentView = name;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === name));
  if (name === 'ticker') tickerTick();
}

let _tickerTimer = null;
async function tickerTick() {
  if (document.hidden || currentView !== 'ticker') return;
  try {
    const r = await fetch('/api/ticker');
    if (!r.ok) return;
    const d = await r.json();
    const fmt = (n) => (n >= 0 ? '+' : '') + n.toFixed(4) + ' SOL';
    const fmtPct = (n) => (n * 100).toFixed(1) + '%';
    const ago = (t) => { const s = Math.floor((Date.now() - t) / 1000); return s < 60 ? s+'s' : s < 3600 ? Math.floor(s/60)+'m' : Math.floor(s/3600)+'h'; };
    const tot = d.totals || {};
    const pp = document.getElementById('ticker-paper-pnl');
    pp.textContent = `${fmt(tot.paperPnl || 0)} (${tot.paperN || 0})`;
    pp.style.color = (tot.paperPnl || 0) >= 0 ? 'var(--cyan)' : 'var(--pink)';
    const lp = document.getElementById('ticker-live-pnl');
    lp.textContent = `${fmt(tot.livePnl || 0)} (${tot.liveN || 0})`;
    lp.style.color = (tot.livePnl || 0) >= 0 ? 'var(--cyan)' : 'var(--pink)';
    document.getElementById('ticker-open-n').textContent = (d.open || []).length;
    document.getElementById('ticker-open-list').innerHTML = (d.open || []).map(p => {
      const cur = p.cur_price || p.entry_price;
      const pct = p.entry_price > 0 ? (cur - p.entry_price) / p.entry_price : 0;
      const cls = pct >= 0 ? 'pos' : 'neg';
      const modeColor = p.position_mode === 'live' ? 'var(--pink)' : 'var(--muted)';
      return `<div style="display:flex;justify-content:space-between;padding:6px 10px;border-bottom:1px solid var(--border);font-size:12px;"><div><b style="color:var(--cyan);">${p.mint_address.slice(0,8)}…</b> <span style="color:${modeColor};font-weight:bold;">${p.position_mode||'paper'}</span> <span style="color:var(--muted);font-size:10px;">${p.strategy} · ${ago(p.entered_at)}</span></div><div class="${cls}" style="font-weight:bold;">${fmtPct(pct)}</div></div>`;
    }).join('') || '<div style="padding:6px 10px;color:var(--muted);font-style:italic;">no open positions</div>';
    document.getElementById('ticker-closed-list').innerHTML = (d.closed || []).map(p => {
      const cls = (p.realized_pnl_sol || 0) >= 0 ? 'pos' : 'neg';
      const modeColor = p.position_mode === 'live' ? 'var(--pink)' : 'var(--muted)';
      return `<div style="display:flex;justify-content:space-between;padding:6px 10px;border-bottom:1px solid var(--border);font-size:12px;"><div><b style="color:var(--cyan);">${p.mint_address.slice(0,8)}…</b> <span style="color:${modeColor};font-weight:bold;">${p.position_mode||'paper'}</span> <span style="color:var(--muted);font-size:10px;">${p.strategy} · ${ago(p.exited_at)} · ${p.exit_reason||''}</span></div><div class="${cls}" style="font-weight:bold;">${fmt(p.realized_pnl_sol||0)} <span style="color:var(--muted);font-size:10px;">(${fmtPct(p.realized_pnl_pct||0)})</span></div></div>`;
    }).join('') || '<div style="padding:6px 10px;color:var(--muted);font-style:italic;">no closes yet</div>';
    document.getElementById('ticker-stamp').textContent = 'updated ' + new Date(d.t).toLocaleTimeString();
  } catch {}
}
setInterval(() => { if (currentView === 'ticker') tickerTick(); }, 2000);

function showDetail(pane, loader) {
  currentView = pane;
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === pane));
  loader();
}

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    const name = tab.dataset.tab;
    history.pushState(null, '', `#${name}`);
    setActiveTab(name);
  });
});

document.getElementById('stat-mode-box')?.addEventListener('click', async () => {
  try {
    if (!_cachedStatus?.halted) {
      const ok = confirm('Halt the system? Bot will stop opening new positions. Existing positions continue running their exit logic.');
      if (!ok) return;
    }
    const r = await fetch('/api/safety/toggle', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ reason: 'manual UI toggle' }),
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    refresh();
  } catch (err) { alert('Halt/resume failed: ' + err.message); }
});

let _pendingModeTarget = null;
let _cachedStatus = null;
function openModeModal(target) {
  _pendingModeTarget = target;
  const modal = document.getElementById('mode-switch-modal');
  const title = document.getElementById('mode-modal-title');
  const body = document.getElementById('mode-modal-body');
  const input = document.getElementById('mode-modal-input');
  const warn = document.getElementById('mode-modal-warning');
  const confirmBtn = document.getElementById('mode-modal-confirm');
  warn.textContent = '';
  if (target === 'live') {
    title.textContent = '⚠️ Switch to LIVE mode?';
    body.querySelector('p:nth-child(1)').innerHTML = 'You are about to switch from <b>PAPER</b> to <b>LIVE</b>.';
    body.querySelector('p:nth-child(2)').innerHTML = '<b style="color:var(--pink)">Real SOL will be used</b> to open and close positions.';
    body.querySelector('p:nth-child(3)').innerHTML = 'To confirm, type <code>LIVE</code> below:';
    input.style.display = '';
    input.value = '';
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Go LIVE';
  } else {
    title.textContent = 'Switch back to PAPER mode?';
    body.querySelector('p:nth-child(1)').innerHTML = 'You are about to switch from <b>LIVE</b> back to <b>PAPER</b>.';
    body.querySelector('p:nth-child(2)').innerHTML = 'Open live positions will continue running their exit logic; new entries will be paper.';
    body.querySelector('p:nth-child(3)').innerHTML = '';
    input.style.display = 'none';
    confirmBtn.disabled = false;
    confirmBtn.textContent = 'Switch to PAPER';
  }
  modal.style.display = 'flex';
  setTimeout(() => { if (target === 'live') input.focus(); }, 50);
}
function closeModeModal() {
  document.getElementById('mode-switch-modal').style.display = 'none';
  _pendingModeTarget = null;
}
document.getElementById('stat-mode-switch')?.addEventListener('click', () => {
  const mode = _cachedStatus?.mode || 'paper';
  openModeModal(mode === 'live' ? 'paper' : 'live');
});
document.getElementById('mode-modal-cancel')?.addEventListener('click', closeModeModal);
document.getElementById('mode-modal-input')?.addEventListener('input', (e) => {
  document.getElementById('mode-modal-confirm').disabled = (e.target.value !== 'LIVE');
});
document.getElementById('mode-modal-confirm')?.addEventListener('click', async () => {
  const target = _pendingModeTarget;
  if (!target) return closeModeModal();
  const warn = document.getElementById('mode-modal-warning');
  warn.textContent = '';
  try {
    const body = target === 'live'
      ? { mode: 'live', confirm: 'LIVE' }
      : { mode: 'paper' };
    const r = await fetch('/api/mode', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!r.ok) { warn.textContent = j.error || 'Switch failed'; return; }
    closeModeModal();
    refresh();
  } catch (err) { warn.textContent = err.message; }
});

document.querySelectorAll('.win-btn').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.win-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    systemWindow = b.dataset.window;
    if (currentView === 'system') refresh();
  });
});

document.querySelectorAll('.lab-btn').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.lab-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    labWindow = b.dataset.window;
    if (currentView === 'lab') refresh();
  });
});

document.querySelectorAll('.lab-filter').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.lab-filter').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    labFilter = b.dataset.filter;
    if (currentView === 'lab') refresh();
  });
});

document.getElementById('coin-back-btn').addEventListener('click', () => history.back());
document.getElementById('wallet-back-btn').addEventListener('click', () => history.back());
document.getElementById('dev-back-btn').addEventListener('click', () => history.back());

document.querySelectorAll('.pill-btn[data-cat]').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.pill-btn[data-cat]').forEach(x => x.classList.toggle('active', x === b));
    tradersCategory = b.dataset.cat;
    tick();
  });
});

document.querySelectorAll('.pill-btn[data-tracked]').forEach(b => {
  b.addEventListener('click', () => {
    tradersTrackedOnly = !tradersTrackedOnly;
    b.classList.toggle('active', tradersTrackedOnly);
    tick();
  });
});

document.querySelectorAll('.pill-btn[data-devcat]').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.pill-btn[data-devcat]').forEach(x => x.classList.toggle('active', x === b));
    devsCategory = b.dataset.devcat;
    tick();
  });
});

document.querySelectorAll('.pill-btn[data-mintcat]').forEach(b => {
  b.addEventListener('click', () => {
    document.querySelectorAll('.pill-btn[data-mintcat]').forEach(x => x.classList.toggle('active', x === b));
    mintsCategory = b.dataset.mintcat;
    tick();
  });
});

function handleHash() {
  const h = location.hash.slice(1);
  if (h.startsWith('coin/')) {
    showDetail('coin', () => loadCoin(h.slice(5)));
  } else if (h.startsWith('wallet/')) {
    showDetail('wallet', () => loadWallet(h.slice(7)));
  } else if (h.startsWith('dev/')) {
    showDetail('dev', () => loadDev(h.slice(4)));
  } else if (document.querySelector(`.tab[data-tab="${h}"]`)) {
    setActiveTab(h);
  } else {
    setActiveTab('mints');
  }
}
window.addEventListener('hashchange', handleHash);
handleHash();

const coinLink = (addr) => `onclick="event.stopPropagation(); location.hash='coin/${addr}'"`;
const walletLink = (addr) => `onclick="event.stopPropagation(); location.hash='wallet/${addr}'"`;
const devLink = (addr) => `onclick="event.stopPropagation(); location.hash='dev/${addr}'"`;

function renderOverviewMints(rows) {
  const el = document.getElementById('overview-mints-body');
  const top = rows.slice(0, 10);
  if (!top.length) { el.innerHTML = '<div class="empty">No mints seen yet. Waiting on ingestion…</div>'; return; }
  el.innerHTML = top.map(m => `
    <div class="row clickable" style="grid-template-columns: 1fr 1fr 80px 80px;" ${coinLink(m.mint_address)}>
      <div><span class="sym">${m.symbol || '???'}</span> <span class="addr">${fmt.short(m.mint_address)}</span></div>
      <div class="addr">dev ${fmt.short(m.creator_wallet)}</div>
      <div class="num">${fmt.sol(m.initial_buy_sol)}</div>
      <div class="num">${fmt.time(m.created_at)}</div>
    </div>
  `).join('');
}

function renderOverviewDevs(rows) {
  const el = document.getElementById('overview-devs-body');
  const top = rows.slice(0, 5);
  if (!top.length) { el.innerHTML = '<div class="empty">No creators scored yet.</div>'; return; }
  el.innerHTML = top.map(c => `
    <div class="row clickable" style="grid-template-columns: 1fr 50px 50px 50px;" ${devLink(c.wallet)}>
      <div class="addr">${fmt.short(c.wallet)}</div>
      <div class="num">${c.launch_count}</div>
      <div class="num ${c.rugged_count ? 'neg' : 'pos'}">${c.rugged_count || 0}</div>
      <div class="num">${(c.reputation_score || 0).toFixed(1)}</div>
    </div>
  `).join('');
}

function renderOverviewTraders(rows) {
  const el = document.getElementById('overview-traders-body');
  const top = rows.slice(0, 5);
  if (!top.length) { el.innerHTML = '<div class="empty">No traders ranked yet.</div>'; return; }
  el.innerHTML = top.map(w => `
    <div class="row clickable" style="grid-template-columns: 1fr 80px 50px;" ${walletLink(w.address)}>
      <div class="addr">${fmt.short(w.address)} ${w.tracked ? '<span class="badge tracked" style="margin-left:4px">★</span>' : ''}</div>
      <div class="num ${(w.realized_pnl || 0) >= 0 ? 'pos' : 'neg'}">${fmt.solSigned(w.realized_pnl)}</div>
      <div class="num">${w.closed_position_count || 0}</div>
    </div>
  `).join('');
}

function renderOverviewSignals(rows) {
  const el = document.getElementById('overview-signals-body');
  if (!rows.length) { el.innerHTML = '<div class="empty">No copy signals fired yet.</div>'; return; }
  el.innerHTML = rows.slice(0, 10).map(s => `
    <div class="row clickable" style="grid-template-columns: 1fr 60px 60px 70px 80px;" ${coinLink(s.mint_address)}>
      <div><span class="sym">${s.symbol || '???'}</span> <span class="addr">${fmt.short(s.mint_address)}</span></div>
      <div class="num">${s.wallet_count}🎯</div>
      <div class="num">${s.time_span_seconds ? s.time_span_seconds.toFixed(1) + 's' : '—'}</div>
      <div class="num">${fmt.usd(s.current_market_cap_sol)}</div>
      <div class="num">${fmt.age(s.fired_at)}</div>
    </div>
  `).join('');
}

function renderOverviewVolume(rows) {
  const el = document.getElementById('overview-volume-body');
  if (!rows.length) { el.innerHTML = '<div class="empty">No volume surges fired yet.</div>'; return; }
  el.innerHTML = rows.slice(0, 10).map(s => `
    <div class="row clickable" style="grid-template-columns: 1fr 60px 60px 60px 70px 70px;" ${coinLink(s.mint_address)}>
      <div><span class="sym">${s.symbol || '???'}</span> <span class="addr">${fmt.short(s.mint_address)}</span>${s.has_tracked_overlap ? ' <span class="tier-pip on">+TRK</span>' : ''}</div>
      <div class="num">${(s.velocity_ratio || 0).toFixed(1)}×</div>
      <div class="num">${(s.current_buys_per_min || 0).toFixed(0)}/m</div>
      <div class="num">${s.unique_buyers}u</div>
      <div class="num">${(s.score || 0).toFixed(2)}</div>
      <div class="num">${fmt.age(s.fired_at)}</div>
    </div>
  `).join('');
}

function renderOverviewPositions({ open, recent }) {
  const openEl = document.getElementById('overview-positions-body');
  const histEl = document.getElementById('overview-history-body');
  if (!open.length) {
    openEl.innerHTML = '<div class="empty">No open positions.</div>';
  } else {
    openEl.innerHTML = open.slice(0, 10).map(p => `
      <div class="row clickable" style="grid-template-columns: 1fr 80px 80px 80px;" ${coinLink(p.mint_address)}>
        <div class="addr">${fmt.short(p.mint_address)}</div>
        <div class="num">${fmt.sol(p.entry_sol)}</div>
        <div class="num">${p.entry_signal || '—'}</div>
        <div class="num">${fmt.age(p.entered_at)}</div>
      </div>
    `).join('');
  }
  if (!recent.length) {
    histEl.innerHTML = '<div class="empty">No closed trades yet.</div>';
  } else {
    histEl.innerHTML = recent.slice(0, 10).map(p => `
      <div class="row clickable" style="grid-template-columns: 1fr 80px 80px 80px 80px;" ${coinLink(p.mint_address)}>
        <div class="addr">${fmt.short(p.mint_address)}</div>
        <div class="num">${fmt.sol(p.entry_sol)}</div>
        <div class="num ${(p.realized_pnl_sol || 0) >= 0 ? 'pos' : 'neg'}">${fmt.sol(p.realized_pnl_sol)}</div>
        <div class="num">${p.exit_reason || '—'}</div>
        <div class="num">${fmt.time(p.exited_at)}</div>
      </div>
    `).join('');
  }
}

function curveProgress(m) {
  if (m.migrated) return '<span class="curve-bar full">100%</span>';
  const reserve = m.v_sol_in_curve || 0;
  const pct = Math.min(100, (reserve / 85) * 100);
  const cls = pct >= 70 ? 'hot' : pct >= 30 ? 'mid' : 'low';
  return `<span class="curve-bar ${cls}"><span class="curve-fill" style="width:${pct.toFixed(0)}%"></span><span class="curve-text">${pct.toFixed(0)}%</span></span>`;
}

function renderMintsTable(rows) {
  const el = document.getElementById('mints-table');
  rows = applySort(rows, 'mints-table');
  if (!rows.length) { el.innerHTML = '<tr><td colspan="14" class="empty">No mints in this category yet.</td></tr>'; return; }
  el.innerHTML = rows.map(m => `
    <tr class="clickable" ${coinLink(m.mint_address)}>
      <td class="addr">${fmt.time(m.created_at)}</td>
      <td class="sym">${m.symbol || '???'}</td>
      <td>${m.name || '—'}</td>
      <td class="addr">${fmt.short(m.mint_address)}</td>
      <td class="addr">${fmt.short(m.creator_wallet)}</td>
      <td class="num">${fmt.sol(m.initial_buy_sol)}</td>
      <td class="num">${fmt.usd(m.peak_market_cap_sol)}</td>
      <td class="num">${fmt.usd(m.current_market_cap_sol)}</td>
      <td class="num">${curveProgress(m)}</td>
      <td class="num">${fmt.int(m.trade_count)}</td>
      <td class="num">${fmt.int(m.unique_buyer_count)}</td>
      <td>${socialsLine(m)}</td>
      <td>${flagBadges(m.flags)} ${cashbackBadge(m)}</td>
      <td>${statusBadge(m)}</td>
    </tr>
  `).join('');
}

function devCategoryBadge(c) {
  const map = {
    LEGIT: '<span class="cat-badge cat-legit">👑 LEGIT</span>',
    WHALE: '<span class="cat-badge cat-whale">💎 WHALE</span>',
    RUGGER: '<span class="cat-badge cat-rugger">🚨 RUGGER</span>',
    SERIAL: '<span class="cat-badge cat-serial">🔥 SERIAL</span>',
    NEW: '<span class="cat-badge cat-new">🆕 NEW</span>',
    NOT_SURE: '<span class="cat-badge cat-unsure">❓ ?</span>',
  };
  return map[c] || map.NOT_SURE;
}

function devFlagBadges(flags) {
  if (!flags || !flags.length) return '';
  return flags.map(f => {
    const positive = f === 'GRADUATED' || f === 'CONSISTENT_GRADS' || f === 'BIG_HIT';
    const cls = positive ? 'flag good' : 'flag bad';
    return `<span class="${cls}">${f}</span>`;
  }).join(' ');
}

function fmtCycle(s) {
  if (!s) return '—';
  if (s < 60) return `${s.toFixed(0)}s`;
  if (s < 3600) return `${(s / 60).toFixed(0)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

function renderDevsTable(rows) {
  const el = document.getElementById('devs-table');
  rows = applySort(rows, 'devs-table');
  if (!rows.length) { el.innerHTML = '<tr><td colspan="15" class="empty">No creators in this category.</td></tr>'; return; }
  el.innerHTML = rows.map(c => {
    const rugRate = c.launch_count ? (c.rugged_count || 0) / c.launch_count : 0;
    return `<tr class="clickable" ${devLink(c.wallet)}>
      <td class="addr">${fmt.short(c.wallet)}</td>
      <td>${devCategoryBadge(c.category)}</td>
      <td class="num">${c.launch_count || 0}</td>
      <td class="num pos">${c.migrated_count || 0}</td>
      <td class="num ${c.rugged_count ? 'neg' : ''}">${c.rugged_count || 0}</td>
      <td class="num">${c.abandoned_count || 0}</td>
      <td class="num ${rugRate > 0.3 ? 'neg' : rugRate > 0 ? '' : 'pos'}">${fmt.pct(rugRate)}</td>
      <td class="num">${fmt.usd(c.avg_peak_mcap)}</td>
      <td class="num">${fmt.usd(c.best_peak_mcap)}</td>
      <td class="num ${c.avg_cycle_time_seconds && c.avg_cycle_time_seconds < 600 ? 'neg' : ''}">${fmtCycle(c.avg_cycle_time_seconds)}</td>
      <td class="num">${fmtCycle(c.avg_launch_lifetime_seconds)}</td>
      <td class="num ${c.bundle_overlap_count >= 3 ? 'neg' : ''}">${c.bundle_overlap_count || 0}</td>
      <td class="num">${(c.days_active || 0).toFixed(1)}d</td>
      <td class="num ${(c.reputation_score || 0) > 0 ? 'pos' : 'neg'}">${(c.reputation_score || 0).toFixed(1)}</td>
      <td>${devFlagBadges(c.dev_flags)}</td>
    </tr>`;
  }).join('');
}

function categoryBadge(c, copyFriendly) {
  const map = {
    HUMAN: '<span class="cat-badge cat-human">🧑 HUMAN</span>',
    BOT: '<span class="cat-badge cat-bot">🤖 BOT</span>',
    SCALPER: '<span class="cat-badge cat-scalper">⚡ SCALPER</span>',
    BUNDLE: '<span class="cat-badge cat-bundle">🧬 BUNDLE</span>',
    NOT_SURE: '<span class="cat-badge cat-unsure">❓ ?</span>',
  };
  const main = map[c] || map.NOT_SURE;
  const cf = copyFriendly ? ' <span class="cat-badge cat-copy">COPY-OK</span>' : '';
  return main + cf;
}

function botFlagsBadges(flags) {
  if (!flags || !flags.length) return '';
  return flags.map(f => `<span class="flag bad">${f}</span>`).join(' ');
}

function renderTradersTable(rows) {
  const el = document.getElementById('traders-table');
  rows = applySort(rows, 'traders-table');
  if (!rows.length) { el.innerHTML = '<tr><td colspan="17" class="empty">No wallets match this filter.</td></tr>'; return; }
  el.innerHTML = rows.map(w => {
    const pnl30 = w.realized_pnl_30d || 0;
    const pnl = w.realized_pnl || 0;
    const un = w.unrealized_pnl || 0;
    const wr30 = w.win_rate_30d || 0;
    const sr = w.sniper_ratio || 0;
    const fbr = w.first_block_ratio || 0;
    const tpp = w.trades_per_position || 0;
    const s100 = w.sell_100pct_ratio || 0;
    const grad = w.graduated_touched || 0;
    return `<tr class="clickable" ${walletLink(w.address)}>
      <td class="addr">${fmt.short(w.address)}</td>
      <td>${categoryBadge(w.category, w.copy_friendly)}</td>
      <td class="num ${pnl30 >= 0 ? 'pos' : 'neg'}">${fmt.solSigned(pnl30)}</td>
      <td class="num ${pnl >= 0 ? 'pos' : 'neg'}">${fmt.solSigned(pnl)}</td>
      <td class="num ${un >= 0 ? 'pos' : 'neg'}">${fmt.solSigned(un)}</td>
      <td class="num">${w.closed_30d || 0}</td>
      <td class="num ${wr30 >= 0.55 ? 'pos' : 'neg'}">${fmt.pct(wr30)}</td>
      <td class="num ${grad >= 3 ? 'pos' : ''}">${grad}</td>
      <td class="num ${sr > 0.6 ? 'neg' : ''}">${fmt.pct(sr)}</td>
      <td class="num ${fbr > 0.5 ? 'neg' : ''}">${fmt.pct(fbr)}</td>
      <td class="num ${tpp > 6 ? 'neg' : ''}">${fmt.num(tpp, 1)}</td>
      <td class="num">${fmt.ageSec(w.avg_hold_seconds)}</td>
      <td class="num ${s100 > 0.7 ? 'neg' : ''}">${fmt.pct(s100)}</td>
      <td class="num pos">${fmt.solSigned(w.best_coin_pnl)}</td>
      <td class="num neg">${fmt.solSigned(w.worst_coin_pnl)}</td>
      <td>${botFlagsBadges(w.bot_flags)}</td>
      <td>${w.is_kol ? '<span class="badge kol">👑 KOL</span> ' : ''}${w.tracked ? '<span class="badge tracked">TRACKED</span>' : ''}</td>
    </tr>`;
  }).join('');
}

function renderOverviewBundles(rows) {
  const el = document.getElementById('overview-bundles-body');
  if (!rows.length) { el.innerHTML = '<div class="empty">No bundle clusters detected yet.</div>'; return; }
  el.innerHTML = rows.slice(0, 10).map(b => `
    <div class="row" style="grid-template-columns: 1fr 60px 60px 80px 80px;">
      <div><span class="sym">${b.cluster_id}</span></div>
      <div class="num">${b.member_count}🧬</div>
      <div class="num">${b.mint_count}m</div>
      <div class="num ${(b.total_realized_pnl || 0) >= 0 ? 'pos' : 'neg'}">${fmt.solSigned(b.total_realized_pnl)}</div>
      <div class="num">${fmt.age(b.detected_at)}</div>
    </div>
  `).join('');
}

function strategyBadge(s) {
  if (!s) return '<span class="strat-badge">—</span>';
  if (s === 'smartMoneyConfluence') return '<span class="strat-badge strat-confluence">🚨 CONFLUENCE</span>';
  if (s === 'trackedWalletFollow') return '<span class="strat-badge strat-follow">🎯 B-EARLY</span>';
  if (s === 'trackedFollowTrojan') return '<span class="strat-badge strat-trojan">🐎 A-TROJAN</span>';
  if (s === 'trackedFollowScalper') return '<span class="strat-badge strat-scalper">⚡ C-SCALP</span>';
  if (s === 'trackedFollowHybrid') return '<span class="strat-badge strat-hybrid">🔥 D-HYBRID</span>';
  if (s === 'runnerScore') return '<span class="strat-badge strat-runner">🚀 RUNNER</span>';
  if (s === 'volumeSurgeRunner') return '<span class="strat-badge strat-surge">🔥 SURGE</span>';
  if (s === 'coBuyerCluster') return '<span class="strat-badge strat-cluster">⚡ CLUSTER</span>';
  return `<span class="strat-badge">${s}</span>`;
}

function tierBadges(tiers_hit_json, isMoonbag, moonbagPeakPct) {
  let tiers = [];
  try { tiers = JSON.parse(tiers_hit_json || '[]'); } catch {}
  const t1 = tiers.includes('TIER_1') ? '<span class="tier-pip on">T1</span>' : '<span class="tier-pip">T1</span>';
  const t2 = tiers.includes('TIER_2') ? '<span class="tier-pip on">T2</span>' : '<span class="tier-pip">T2</span>';
  const t3 = tiers.includes('TIER_3') ? '<span class="tier-pip on">T3</span>' : '<span class="tier-pip">T3</span>';
  const moon = isMoonbag ? ` <span class="tier-pip on" style="color:var(--yellow);border-color:var(--yellow);background:rgba(249,248,113,0.1);">🌙 ${((moonbagPeakPct||0)*100).toFixed(0)}%</span>` : '';
  return `${t1}${t2}${t3}${moon}`;
}

function exitReasonBadge(r) {
  if (!r) return '—';
  const positive = r === 'TIERED_FULL' || r === 'MIGRATED' || r === 'TP_TRAIL' || r === 'TP_HIT';
  const negative = r === 'SL_HIT' || r === 'RUGGED' || r === 'STAGNATED' || r === 'TRAIL_STOP';
  const neutral = r === 'BREAKEVEN_SL' || r === 'TIME_EXIT';
  const cls = positive ? 'pos' : negative ? 'neg' : neutral ? '' : '';
  return `<span class="${cls}">${r}</span>`;
}

function renderPositionsTables({ open, recent }) {
  const openEl = document.getElementById('positions-open-table');
  const closedEl = document.getElementById('positions-closed-table');
  open = applySort(open, 'positions-open-table');
  recent = applySort(recent, 'positions-closed-table');

  if (!open.length) {
    openEl.innerHTML = '<tr><td colspan="12" class="empty">No open positions.</td></tr>';
  } else {
    openEl.innerHTML = open.map(p => {
      const un = p.unrealized_pnl_sol || 0;
      const unPct = p.unrealized_pnl_pct || 0;
      const peakPct = p.highest_pct || 0;
      const realized = p.sol_realized_so_far || 0;
      const entryMc = p.entry_mcap_sol || 0;
      const nowMc = p.current_market_cap_sol || 0;
      const mcChange = entryMc > 0 ? (nowMc - entryMc) / entryMc : 0;
      return `<tr class="clickable" ${coinLink(p.mint_address)}>
        <td class="addr">${fmt.dt(p.entered_at)}</td>
        <td>${strategyBadge(p.strategy)}</td>
        <td><span class="sym">${p.symbol || '???'}</span> <span class="addr">${fmt.short(p.mint_address)}</span></td>
        <td>${tierBadges(p.tiers_hit, p.is_moonbag, p.moonbag_peak_pct)}${p.breakeven_armed ? ' <span class="be-pip">BE</span>' : ''}</td>
        <td class="num">${fmt.sol(p.entry_sol)}</td>
        <td class="num">${fmt.usd(entryMc)}</td>
        <td class="num ${mcChange >= 0 ? 'pos' : 'neg'}">${fmt.usd(nowMc)}</td>
        <td class="num pos">${realized > 0 ? fmt.solSigned(realized) : '—'}</td>
        <td class="num ${un >= 0 ? 'pos' : 'neg'}">${fmt.solSigned(un)}</td>
        <td class="num ${unPct >= 0 ? 'pos' : 'neg'}">${(unPct * 100).toFixed(1)}%</td>
        <td class="num pos">${(peakPct * 100).toFixed(1)}%</td>
        <td class="num">${fmt.age(p.entered_at)}</td>
      </tr>`;
    }).join('');
  }

  if (!recent.length) {
    closedEl.innerHTML = '<tr><td colspan="11" class="empty">No closed trades yet.</td></tr>';
  } else {
    closedEl.innerHTML = recent.map(p => {
      const pnl = p.realized_pnl_sol || 0;
      const pct = p.realized_pnl_pct || 0;
      const peakPct = p.highest_pct || 0;
      const entryMc = p.entry_mcap_sol || 0;
      const exitMc = avgExitMc(p);
      const mcDeltaPct = entryMc > 0 ? ((exitMc - entryMc) / entryMc) : 0;
      const events = parseSellEvents(p.sell_events);
      const exitMcTitle = events.length > 1
        ? `Weighted avg of ${events.length} sells: ${events.map(e => `${e.r}@${fmt.mcap(e.m)} (${(e.s||0).toFixed(4)}◎)`).join(' · ')}`
        : 'Single exit';
      return `<tr class="clickable" ${coinLink(p.mint_address)}>
        <td class="addr">${fmt.dt(p.exited_at)}</td>
        <td>${strategyBadge(p.strategy)}</td>
        <td><span class="sym">${p.symbol || '???'}</span> <span class="addr">${fmt.short(p.mint_address)}</span></td>
        <td class="num">${fmt.sol(p.entry_sol)}</td>
        <td class="num">${fmt.mcap(entryMc)}</td>
        <td class="num ${mcDeltaPct >= 0 ? 'pos' : 'neg'}" title="${exitMcTitle}">${fmt.mcap(exitMc)}${events.length > 1 ? ' <span class="muted">(avg)</span>' : ''}</td>
        <td class="num ${pnl >= 0 ? 'pos' : 'neg'}">${fmt.solSigned(pnl)}</td>
        <td class="num ${pct >= 0 ? 'pos' : 'neg'}">${(pct * 100).toFixed(1)}%</td>
        <td class="num pos">${(peakPct * 100).toFixed(1)}%</td>
        <td>${exitReasonBadge(p.exit_reason)}</td>
        <td class="num">${fmt.duration(p.entered_at, p.exited_at)}</td>
      </tr>`;
    }).join('');
  }
}

function parseSellEvents(s) {
  if (!s) return [];
  try { return JSON.parse(s) || []; } catch { return []; }
}
function avgExitMc(p) {
  const events = parseSellEvents(p.sell_events);
  if (!events.length) return p.exit_mcap_sol || 0;
  let totalSol = 0, totalMcSol = 0;
  for (const e of events) {
    const sol = +e.s || 0; const mc = +e.m || 0;
    if (sol <= 0 || mc <= 0) continue;
    totalSol += sol; totalMcSol += sol * mc;
  }
  if (totalSol <= 0) return p.exit_mcap_sol || 0;
  return totalMcSol / totalSol;
}

function editableField(strategyName, key, label, value, suffix = '', step = 'any') {
  return `<div class="edit-field">
    <span class="stat-label">${label}</span>
    <input class="strat-input" type="number" step="${step}" value="${value}"
           data-strategy="${strategyName}" data-key="${key}" />
    ${suffix ? `<span class="stat-suffix">${suffix}</span>` : ''}
  </div>`;
}

function renderStrategiesPanel(rows) {
  const el = document.getElementById('strategies-panel');
  const focused = document.activeElement;
  if (focused && focused.classList?.contains('strat-input') && el.contains(focused)) return;
  const all = rows || [];
  const enabled = all.filter(s => s.enabled);
  const disabled = all.filter(s => !s.enabled);
  const sorted = [...enabled, ...disabled];
  if (!sorted.length) { el.innerHTML = '<div class="empty">No strategies configured.</div>'; return; }
  el.innerHTML = sorted.map(s => {
    const closed = (s.wins || 0) + (s.losses || 0);
    const wr = closed ? (s.wins / closed) : 0;
    const pnl = s.total_pnl_sol || 0;
    const t3Trailing = (s.tier3_trail_pct || 0) > 0;
    return `<div class="strategy-card ${s.enabled ? 'on' : 'off'}">
      <div class="strategy-head">
        <div class="strategy-title">
          <span class="strategy-name">${s.label}</span>
          <span class="strategy-status ${s.enabled ? 'on' : 'off'}">${s.enabled ? 'ON' : 'OFF'}</span>
          <span class="strategy-mode tiered">🪜 TIERED${t3Trailing ? ' + 🌙' : ''}</span>
        </div>
        <button class="pill-btn ${s.enabled ? 'active' : ''}" data-strategy="${s.name}">${s.enabled ? 'DISABLE' : 'ENABLE'}</button>
      </div>
      <div class="strategy-desc">${s.description}</div>

      <div class="tier-ladder">
        <div class="tier-row">
          <span class="tier-label">T1</span>
          <span>at</span>
          <input class="strat-input" type="number" step="1" data-strategy="${s.name}" data-key="tier1_trigger_pct" value="${(s.tier1_trigger_pct * 100).toFixed(0)}" />%
          <span>sell</span>
          <input class="strat-input" type="number" step="1" data-strategy="${s.name}" data-key="tier1_sell_pct" value="${(s.tier1_sell_pct * 100).toFixed(0)}" />%
        </div>
        ${s.tier2_sell_pct > 0 ? `
        <div class="tier-row">
          <span class="tier-label">T2</span>
          <span>at</span>
          <input class="strat-input" type="number" step="1" data-strategy="${s.name}" data-key="tier2_trigger_pct" value="${(s.tier2_trigger_pct * 100).toFixed(0)}" />%
          <span>sell</span>
          <input class="strat-input" type="number" step="1" data-strategy="${s.name}" data-key="tier2_sell_pct" value="${(s.tier2_sell_pct * 100).toFixed(0)}" />%
        </div>` : '<div class="tier-row tier-disabled"><span class="tier-label muted">T2</span><span class="muted" style="font-size:11px;font-style:italic;">disabled</span></div>'}
        ${s.tier3_sell_pct > 0 ? `
        <div class="tier-row">
          <span class="tier-label">T3 🌙</span>
          <span>at</span>
          <input class="strat-input" type="number" step="1" data-strategy="${s.name}" data-key="tier3_trigger_pct" value="${(s.tier3_trigger_pct * 100).toFixed(0)}" />%
          <span>sell</span>
          <input class="strat-input" type="number" step="1" data-strategy="${s.name}" data-key="tier3_sell_pct" value="${(s.tier3_sell_pct * 100).toFixed(0)}" />%
          <span>trail</span>
          <input class="strat-input" type="number" step="1" data-strategy="${s.name}" data-key="tier3_trail_pct" value="${(s.tier3_trail_pct * 100).toFixed(0)}" />%
        </div>` : '<div class="tier-row tier-disabled"><span class="tier-label muted">T3 🌙</span><span class="muted" style="font-size:11px;font-style:italic;">disabled</span></div>'}
        ${(s.tp_trail_pct || 0) > 0 ? `
        <div class="tier-row">
          <span class="tier-label">Trail 🌙</span>
          <span>arm at peak ≥</span>
          <input class="strat-input" type="number" step="1" data-strategy="${s.name}" data-key="tp_trail_arm_pct" value="${(s.tp_trail_arm_pct * 100).toFixed(0)}" />%
          <span>then exit at peak −</span>
          <input class="strat-input" type="number" step="1" data-strategy="${s.name}" data-key="tp_trail_pct" value="${(s.tp_trail_pct * 100).toFixed(0)}" />%
        </div>` : ''}
        <div class="tier-row">
          <span class="tier-label">After T1</span>
          <label class="be-toggle">
            <input type="checkbox" data-strategy="${s.name}" data-key="breakeven_after_tier1" ${s.breakeven_after_tier1 ? 'checked' : ''} />
            move SL → breakeven
          </label>
          <span class="muted" style="font-size:11px;margin-left:8px;">arm at peak ≥</span>
          <input class="strat-input" type="number" step="1" data-strategy="${s.name}" data-key="breakeven_arm_pct" value="${((s.breakeven_arm_pct || 0) * 100).toFixed(0)}" style="width:50px;" />%
          <span class="muted" style="font-size:11px;">floor</span>
          <input class="strat-input" type="number" step="1" data-strategy="${s.name}" data-key="breakeven_floor_pct" value="${((s.breakeven_floor_pct || 0) * 100).toFixed(0)}" style="width:50px;" />%
        </div>
        <div class="tier-row">
          <span class="tier-label">PF L1</span>
          <span class="muted" style="font-size:11px;">arm ≥</span>
          <input class="strat-input" type="number" step="1" data-strategy="${s.name}" data-key="peak_floor_arm_pct" value="${((s.peak_floor_arm_pct || 0) * 100).toFixed(0)}" style="width:50px;" />%
          <span class="muted" style="font-size:11px;">exit &lt;</span>
          <input class="strat-input" type="number" step="1" data-strategy="${s.name}" data-key="peak_floor_exit_pct" value="${((s.peak_floor_exit_pct || 0) * 100).toFixed(0)}" style="width:50px;" />%
        </div>
        <div class="tier-row">
          <span class="tier-label">PF L2</span>
          <span class="muted" style="font-size:11px;">arm ≥</span>
          <input class="strat-input" type="number" step="1" data-strategy="${s.name}" data-key="peak_floor_arm2_pct" value="${((s.peak_floor_arm2_pct || 0) * 100).toFixed(0)}" style="width:50px;" />%
          <span class="muted" style="font-size:11px;">exit &lt;</span>
          <input class="strat-input" type="number" step="1" data-strategy="${s.name}" data-key="peak_floor_exit2_pct" value="${((s.peak_floor_exit2_pct || 0) * 100).toFixed(0)}" style="width:50px;" />%
        </div>
        <div class="tier-row">
          <span class="tier-label">PF L3</span>
          <span class="muted" style="font-size:11px;">arm ≥</span>
          <input class="strat-input" type="number" step="1" data-strategy="${s.name}" data-key="peak_floor_arm3_pct" value="${((s.peak_floor_arm3_pct || 0) * 100).toFixed(0)}" style="width:50px;" />%
          <span class="muted" style="font-size:11px;">exit &lt;</span>
          <input class="strat-input" type="number" step="1" data-strategy="${s.name}" data-key="peak_floor_exit3_pct" value="${((s.peak_floor_exit3_pct || 0) * 100).toFixed(0)}" style="width:50px;" />%
        </div>
      </div>

      <div class="strategy-edit">
        ${editableField(s.name, 'entry_sol', 'Entry', s.entry_sol, 'SOL', '0.001')}
        ${editableField(s.name, 'sl_pct', 'SL', (s.sl_pct * 100).toFixed(0), '%', '1')}
        ${editableField(s.name, 'max_hold_min', 'Max Hold', s.max_hold_min, 'min', '1')}
        ${editableField(s.name, 'stagnant_exit_min', 'Stagnant', s.stagnant_exit_min, 'min', '1')}
        ${editableField(s.name, 'stagnant_loss_pct', 'Stag Loss', (s.stagnant_loss_pct * 100).toFixed(0), '%', '1')}
      </div>
      <div class="strategy-stats">
        <div><span class="stat-label">Opened</span> ${s.positions_opened || 0}</div>
        <div><span class="stat-label">W/L</span> <span class="pos">${s.wins || 0}</span>/<span class="neg">${s.losses || 0}</span></div>
        <div><span class="stat-label">Win Rate</span> ${(wr * 100).toFixed(0)}%</div>
        <div><span class="stat-label">P&L</span> <span class="${pnl >= 0 ? 'pos' : 'neg'}">${fmt.solSigned(pnl)}</span></div>
      </div>
    </div>`;
  }).join('');

  document.querySelectorAll('button[data-strategy]').forEach(b => {
    b.addEventListener('click', async () => {
      b.disabled = true;
      try { await fetch(`/api/strategies/${b.dataset.strategy}/toggle`, { method: 'POST' }); }
      catch {}
      tick();
    });
  });

  document.querySelectorAll('input.strat-input').forEach(inp => {
    inp.addEventListener('change', () => saveStrategyField(inp));
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveStrategyField(inp); });
  });
  document.querySelectorAll('input[type=checkbox][data-strategy]').forEach(cb => {
    cb.addEventListener('change', async () => {
      try {
        await fetch(`/api/strategies/${cb.dataset.strategy}/settings`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ [cb.dataset.key]: cb.checked ? 1 : 0 }),
        });
        tick();
      } catch {}
    });
  });
}

function exitOutcomeBadge(o) {
  if (o === 'EARLY_EXIT') return '<span class="cat-badge cat-rugger">⚠️ EARLY</span>';
  if (o === 'LEFT_MONEY') return '<span class="cat-badge cat-scalper">💸 LEFT $</span>';
  if (o === 'CORRECT_EXIT') return '<span class="cat-badge cat-legit">✓ CORRECT</span>';
  if (o === 'NEUTRAL') return '<span class="cat-badge cat-unsure">~ NEUTRAL</span>';
  return '<span class="cat-badge cat-unsure">PENDING</span>';
}

function renderExitAnalysis(data) {
  const el = document.getElementById('exit-analysis-panel');
  if (!data || !data.summary || !data.summary.length) {
    el.innerHTML = '<div class="empty">No post-exit data yet. Wait 30 min after first closes.</div>';
    return;
  }

  const totalRows = data.summary.reduce((s, r) => s + (r.total || 0), 0);
  const totalEarly = data.summary.reduce((s, r) => s + (r.early_exits || 0), 0);
  const totalLeft = data.summary.reduce((s, r) => s + (r.left_money || 0), 0);
  const totalCorrect = data.summary.reduce((s, r) => s + (r.correct_exits || 0), 0);
  const totalNeutral = data.summary.reduce((s, r) => s + (r.neutral || 0), 0);
  const totalPending = data.summary.reduce((s, r) => s + (r.pending || 0), 0);
  const evaluated = totalRows - totalPending;

  el.innerHTML = `
    <div class="backtest-summary" style="grid-template-columns: repeat(5, 1fr);">
      <div class="bt-stat ${totalEarly > 0 ? 'bad' : ''}">
        <div class="stat-label">⚠️ Early Exits (Stops)</div>
        <div class="stat-value">${totalEarly}</div>
      </div>
      <div class="bt-stat ${totalLeft > 0 ? 'bad' : ''}">
        <div class="stat-label">💸 Left $ (TPs)</div>
        <div class="stat-value">${totalLeft}</div>
      </div>
      <div class="bt-stat good">
        <div class="stat-label">✓ Correct Exits</div>
        <div class="stat-value">${totalCorrect}</div>
      </div>
      <div class="bt-stat">
        <div class="stat-label">~ Neutral</div>
        <div class="stat-value">${totalNeutral}</div>
      </div>
      <div class="bt-stat">
        <div class="stat-label">Pending (<30m)</div>
        <div class="stat-value">${totalPending}</div>
      </div>
    </div>
    <div class="table-wrap" style="margin-top:14px;">
      <table class="data">
        <thead>
          <tr>
            <th>Exit Reason</th>
            <th class="num">Total</th>
            <th class="num">Early</th>
            <th class="num">Left $</th>
            <th class="num">Correct</th>
            <th class="num">Neutral</th>
            <th class="num">Avg Peak After</th>
            <th class="num">Max Peak</th>
            <th>Verdict</th>
          </tr>
        </thead>
        <tbody>
          ${data.summary.map(s => {
            const evalCount = s.total - (s.pending || 0);
            const earlyRate = evalCount > 0 ? s.early_exits / evalCount : 0;
            const leftRate = evalCount > 0 ? s.left_money / evalCount : 0;
            const isStop = ['SL_HIT', 'BREAKEVEN_SL', 'STAGNATED', 'TIME_EXIT', 'MOONBAG_SL', 'MOONBAG_TRAIL'].includes(s.exit_reason);
            let verdict;
            if (evalCount < 5) verdict = '<span class="cat-badge cat-unsure">need more data</span>';
            else if (isStop && earlyRate >= 0.5) verdict = '<span class="cat-badge cat-rugger">TOO STRICT — loosening helps</span>';
            else if (!isStop && leftRate >= 0.5) verdict = '<span class="cat-badge cat-scalper">TOO TIGHT — wider TPs help</span>';
            else verdict = '<span class="cat-badge cat-legit">TUNED</span>';
            return `<tr>
              <td><span class="flag bad">${s.exit_reason}</span></td>
              <td class="num">${s.total}</td>
              <td class="num neg">${s.early_exits}</td>
              <td class="num neg">${s.left_money}</td>
              <td class="num pos">${s.correct_exits}</td>
              <td class="num">${s.neutral}</td>
              <td class="num">${((s.avg_peak_pct || 0) * 100).toFixed(0)}%</td>
              <td class="num pos">${((s.max_peak_pct || 0) * 100).toFixed(0)}%</td>
              <td>${verdict}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    <div class="section-title" style="font-size:10px; margin-top:14px;">BIGGEST EARLY EXITS / LEFT MONEY</div>
    <div class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th>Exited</th>
            <th>Strategy</th>
            <th>Coin</th>
            <th>Exit Reason</th>
            <th class="num">Realized P&L</th>
            <th class="num">Peak After</th>
            <th>Outcome</th>
          </tr>
        </thead>
        <tbody>
          ${data.rows.slice(0, 25).map(r => `<tr class="clickable" ${coinLink(r.mint_address)}>
            <td class="addr">${fmt.dt(r.exited_at)}</td>
            <td>${strategyBadge(r.strategy)}</td>
            <td><span class="sym">${r.symbol || '???'}</span> <span class="addr">${fmt.short(r.mint_address)}</span></td>
            <td><span class="flag bad">${r.exit_reason}</span></td>
            <td class="num ${(r.realized_pnl_sol||0) >= 0 ? 'pos' : 'neg'}">${fmt.solSigned(r.realized_pnl_sol)}</td>
            <td class="num ${(r.post_exit_peak_pct||0) >= 0.3 ? 'neg' : ''}">${((r.post_exit_peak_pct||0)*100).toFixed(0)}%</td>
            <td>${exitOutcomeBadge(r.post_exit_outcome)}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function outcomeBadge(o) {
  if (o === 'BIG_WIN') return '<span class="cat-badge cat-whale">💎 BIG_WIN</span>';
  if (o === 'WIN') return '<span class="cat-badge cat-legit">✓ WIN</span>';
  if (o === 'LOSS') return '<span class="cat-badge cat-unsure">✗ LOSS (gate right)</span>';
  return '<span class="cat-badge cat-unsure">PENDING</span>';
}

function renderRunnerLeaderboard(data) {
  const el = document.getElementById('runner-leaderboard');
  if (!el) return;
  const rows = data?.rows || [];
  if (!rows.length) {
    el.innerHTML = '<div class="empty muted">No coins scored yet. Sweep runs every 20s.</div>';
    return;
  }
  const ageStr = (ts) => {
    const sec = Math.floor((Date.now() - ts) / 1000);
    if (sec < 60) return `${sec}s`;
    const m = Math.floor(sec / 60);
    return m < 60 ? `${m}m` : `${Math.floor(m/60)}h${m%60}m`;
  };
  const cards = rows.map((r, i) => {
    let b = {}; try { b = JSON.parse(r.runner_breakdown || '{}'); } catch {}
    const score = r.runner_score || 0;
    const scoreClass = score >= 80 ? 'runner-score-elite' : score >= 70 ? 'runner-score-fire' : 'runner-score-watch';
    const fired = r.runner_fired ? '<span class="runner-fired">🚀 FIRED</span>' : '';
    const cashback = r.cashback_enabled === 1 ? '<span class="muted" style="font-size:11px;">💸</span>' : '';
    return `<div class="runner-card clickable ${scoreClass}" ${coinLink(r.mint_address)}>
      <div class="runner-rank">#${i + 1}</div>
      <div class="runner-main">
        <div class="runner-sym-row">
          <span class="sym">${r.symbol || '?'}</span> ${cashback} ${fired}
          <span class="muted runner-meta">${ageStr(r.created_at)} old · ${fmt.usd(r.current_market_cap_sol)}</span>
        </div>
        <div class="runner-components">
          <span title="Velocity (trades to 5 SOL)"><b>VEL</b> <span class="${b.velocity >= 30 ? 'pos' : ''}">${b.velocity ?? '—'}</span>/40</span>
          <span title="Non-bot trader fraction"><b>τ</b> <span class="${b.tau >= 0.65 ? 'pos' : 'neg'}">${b.tau != null ? b.tau.toFixed(2) : '—'}</span></span>
          <span><b>BUY60s</b> ${b.buyers60 ?? '—'}</span>
          <span><b>SOL60s</b> ${b.solIn60 ?? '—'}</span>
          <span><b>B/S</b> ${b.bsRatio ?? '—'}</span>
          <span><b>BUNDLE</b> <span class="${b.bundlePct < 0.25 ? 'pos' : 'neg'}">${b.bundlePct != null ? (b.bundlePct*100).toFixed(0) + '%' : '—'}</span></span>
          <span><b>WHALE</b> <span class="${b.whalePct < 0.25 ? 'pos' : 'neg'}">${b.whalePct != null ? (b.whalePct*100).toFixed(0) + '%' : '—'}</span></span>
          <span title="Trades to reach 5 SOL bonded"><b>TR→5SOL</b> <span class="${b.tradesTo5 <= 25 ? 'pos' : ''}">${b.tradesTo5 ?? '—'}</span></span>
        </div>
      </div>
      <div class="runner-score-big">${score}</div>
    </div>`;
  }).join('');
  el.innerHTML = `<div class="runner-grid">${cards}</div>`;
}

function renderLabPanel(data) {
  const sumEl = document.getElementById('lab-summary');
  const tblEl = document.getElementById('lab-table');
  if (!data || !data.summary) {
    if (tblEl) tblEl.innerHTML = '<tr><td colspan="21" class="empty">No data.</td></tr>';
    return;
  }
  const s = data.summary;
  const migPct = s.total ? (100 * s.migrated / s.total).toFixed(1) : '0';
  if (sumEl) {
    sumEl.innerHTML = `
      <div class="missed-stat"><div class="label">📦 TOTAL</div><div class="value">${s.total}</div></div>
      <div class="missed-stat"><div class="label">🌙 MIGRATED</div><div class="value pos">${s.migrated} <span class="muted" style="font-size:11px;">(${migPct}%)</span></div></div>
      <div class="missed-stat"><div class="label">🟢 LIVE</div><div class="value">${s.live}</div></div>
      <div class="missed-stat"><div class="label">💀 RUGGED</div><div class="value neg">${s.rugged}</div></div>
      <div class="missed-stat"><div class="label">⏱ AVG MIN→MIG</div><div class="value">${s.avg_min_to_mig || '—'}m</div></div>
      <div class="missed-stat"><div class="label">📈 AVG PEAK</div><div class="value">${fmt.usd(s.avg_peak_mcap || 0)}</div></div>
    `;
  }

  const rows = data.rows || [];
  if (!rows.length) {
    tblEl.innerHTML = '<tr><td colspan="21" class="empty">No coins in window.</td></tr>';
    return;
  }
  const ageStr = (created_at, migrated_at) => {
    const end = migrated_at || Date.now();
    const min = Math.floor((end - created_at) / 60000);
    return min < 60 ? `${min}m` : `${Math.floor(min/60)}h${min%60}m`;
  };
  const statusBadge = (r) => {
    if (r.rugged) return '<span class="badge rugged">RUGGED</span>';
    if (r.migrated) return '<span class="badge migrated">MIGRATED</span>';
    return '<span class="badge live">LIVE</span>';
  };
  const flagBadges = (flagsJson) => {
    let flags = [];
    try { flags = JSON.parse(flagsJson || '[]'); } catch {}
    return flags.slice(0,3).map(f => `<span class="flag bad" style="font-size:10px;">${f}</span>`).join('');
  };
  const cashbackB = (enabled) => enabled === 1 ? '💸' : '';

  tblEl.innerHTML = rows.map(r => {
    const trkSec = r.tracked_first_buy_age_sec != null ? `${r.tracked_first_buy_age_sec}s` : '—';
    const peakColor = (r.peak_market_cap_sol >= 100) ? 'pos' : '';
    const we = r.we_strategy ? `<span class="cat-badge cat-${(r.we_strategy === 'trackedWalletFollow' ? 'tracked' : 'other')}">${r.we_strategy.slice(0,8)}</span>` : '—';
    const pnl = r.we_pnl_sol != null ? r.we_pnl_sol : null;
    const pnlClass = pnl != null ? (pnl >= 0 ? 'pos' : 'neg') : '';
    const pnlStr = pnl != null ? `${pnl >= 0 ? '+' : ''}${pnl.toFixed(3)}` : '—';
    return `<tr class="clickable" ${coinLink(r.mint_address)}>
      <td><span class="sym">${r.symbol || '?'}</span> ${cashbackB(r.cashback_enabled)}</td>
      <td>${statusBadge(r)}</td>
      <td class="addr">${ageStr(r.created_at, r.migrated_at)}</td>
      <td class="num">${fmt.usd(r.current_market_cap_sol)}</td>
      <td class="num ${peakColor}">${fmt.usd(r.peak_market_cap_sol)}</td>
      <td class="num">${(((r.v_sol_in_curve || 0) / 85) * 100).toFixed(0)}%</td>
      <td class="num">${r.buyers_1min || 0}</td>
      <td class="num">${r.buyers_5min || 0}</td>
      <td class="num">${r.buyers_15min || 0}</td>
      <td class="num">${r.buyers_60min || 0}</td>
      <td class="num">${(r.sol_in_1min || 0).toFixed(2)}</td>
      <td class="num">${(r.sol_in_5min || 0).toFixed(2)}</td>
      <td class="num">${(r.sol_in_15min || 0).toFixed(2)}</td>
      <td class="num">${r.sniper_count || 0}</td>
      <td class="num ${(r.tracked_buyers || 0) > 0 ? 'pos' : ''}">${r.tracked_buyers || 0}</td>
      <td class="num ${(r.kol_buyers || 0) > 0 ? 'pos' : ''}">${r.kol_buyers || 0}</td>
      <td class="num ${(r.boosted_buyers || 0) > 0 ? 'pos' : ''}">${r.boosted_buyers || 0}</td>
      <td class="addr">${trkSec}</td>
      <td>${flagBadges(r.flags)}</td>
      <td>${we}</td>
      <td class="num ${pnlClass}">${pnlStr}</td>
    </tr>`;
  }).join('');
}

function renderBoostStatus(data) {
  const el = document.getElementById('boost-status-panel');
  if (!el) return;
  if (!data) { el.innerHTML = '<div class="empty">Loading…</div>'; return; }
  const s = data.summary || {};
  const boosted = data.boosted || [];
  const blocked = data.blocked || [];
  const row = (w, type) => {
    const wr = w.follow_wr ? (w.follow_wr * 100).toFixed(0) : '0';
    const net = (w.follow_net_sol || 0).toFixed(3);
    const cat = w.category || '?';
    const kol = w.is_kol ? ' 👑' : '';
    return `<tr class="clickable" ${walletLink(w.address)}>
      <td class="addr">${fmt.short(w.address)}${kol}</td>
      <td><span class="cat-badge cat-${cat.toLowerCase()}">${cat}</span></td>
      <td class="num">${w.follow_trades || 0}</td>
      <td class="num ${wr >= 50 ? 'pos' : 'neg'}">${wr}%</td>
      <td class="num ${(w.follow_net_sol || 0) >= 0 ? 'pos' : 'neg'}">${(w.follow_net_sol || 0) >= 0 ? '+' : ''}${net} SOL</td>
      ${type === 'boosted' ? `<td class="num pos">${(w.auto_boost_mult || 1).toFixed(1)}x</td>` : ''}
    </tr>`;
  };
  el.innerHTML = `
    <div class="missed-summary">
      <div class="missed-stat"><div class="label">🚀 BOOSTED</div><div class="value pos">${s.boostedCount}</div></div>
      <div class="missed-stat"><div class="label">⛔ BLOCKED</div><div class="value neg">${s.blockedCount}</div></div>
      <div class="missed-stat"><div class="label">🎯 TRACKED</div><div class="value">${s.trackedCount}</div></div>
      <div class="missed-stat"><div class="label">👑 KOLS</div><div class="value">${s.kolCount}</div></div>
      <div class="missed-stat"><div class="label">⏳ CANDIDATES</div><div class="value">${s.candidateCount}</div></div>
    </div>
    <div class="muted" style="font-size:11px;font-style:italic;margin:8px 0 14px;">
      <strong>Boost rule:</strong> ${data.criteria?.boost || ''} ·
      <strong>Block rule:</strong> ${data.criteria?.block || ''} · re-evaluated every 5 min
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;">
      <div>
        <div style="color:var(--green);font-size:12px;letter-spacing:3px;margin-bottom:6px;">🚀 BOOSTED — 2x SIZING + QUICKFLIP ELIGIBLE</div>
        ${boosted.length ? `
          <table class="missed-table">
            <thead><tr><th>WALLET</th><th>CAT</th><th class="num">N</th><th class="num">WR</th><th class="num">NET</th><th class="num">×</th></tr></thead>
            <tbody>${boosted.map(b => row(b, 'boosted')).join('')}</tbody>
          </table>` : '<div class="empty muted">None yet — needs ≥5 trades + ≥80% WR + ≥+0.20 SOL net</div>'}
      </div>
      <div>
        <div style="color:var(--pink);font-size:12px;letter-spacing:3px;margin-bottom:6px;">⛔ AUTO-BLOCKED — NO LONGER FIRE</div>
        ${blocked.length ? `
          <table class="missed-table">
            <thead><tr><th>WALLET</th><th>CAT</th><th class="num">N</th><th class="num">WR</th><th class="num">NET</th></tr></thead>
            <tbody>${blocked.map(b => row(b, 'blocked')).join('')}</tbody>
          </table>` : '<div class="empty muted">None blocked — system is clean</div>'}
      </div>
    </div>
  `;
}

function renderSystemPanels(data) {
  if (!data) return;
  const k = data.kpis || {};
  const sign = (v) => v >= 0 ? 'pos' : 'neg';
  document.getElementById('system-kpis').innerHTML = `
    <div class="kpi-card"><div class="label">TRADES</div><div class="value">${k.trades || 0}</div></div>
    <div class="kpi-card"><div class="label">WIN RATE</div><div class="value ${k.wr >= 50 ? 'pos' : 'neg'}">${(k.wr || 0).toFixed(1)}%</div></div>
    <div class="kpi-card"><div class="label">NET P&L</div><div class="value ${sign(k.net_sol)}">${(k.net_sol >= 0 ? '+' : '') + (k.net_sol || 0).toFixed(4)} SOL</div></div>
    <div class="kpi-card"><div class="label">AVG P&L</div><div class="value ${sign(k.avg_pnl_pct)}">${(k.avg_pnl_pct >= 0 ? '+' : '') + ((k.avg_pnl_pct || 0) * 100).toFixed(1)}%</div></div>
    <div class="kpi-card"><div class="label">AVG HOLD</div><div class="value">${(k.avg_hold_min || 0).toFixed(1)}m</div></div>
    <div class="kpi-card"><div class="label">MAX DRAWDOWN</div><div class="value neg">−${(k.drawdown || 0).toFixed(4)} SOL</div></div>
    <div class="kpi-card"><div class="label">BEST</div><div class="value pos">+${((k.best_pct || 0) * 100).toFixed(0)}%</div></div>
    <div class="kpi-card"><div class="label">WORST</div><div class="value neg">${((k.worst_pct || 0) * 100).toFixed(0)}%</div></div>
  `;

  const exits = data.exits || [];
  document.getElementById('system-exits').innerHTML = exits.length ? `
    <table class="missed-table">
      <thead><tr><th>EXIT REASON</th><th class="num">N</th><th class="num">AVG P&L</th><th class="num">AVG PEAK</th><th class="num">AVG HOLD</th><th class="num">NET SOL</th></tr></thead>
      <tbody>${exits.map(e => `
        <tr>
          <td><span class="flag ${e.net_sol >= 0 ? 'good' : 'bad'}">${e.exit_reason || '?'}</span></td>
          <td class="num">${e.n}</td>
          <td class="num ${e.avg_pnl >= 0 ? 'pos' : 'neg'}">${(e.avg_pnl >= 0 ? '+' : '') + e.avg_pnl}%</td>
          <td class="num pos">+${e.avg_peak}%</td>
          <td class="num">${e.avg_hold_min}m</td>
          <td class="num ${e.net_sol >= 0 ? 'pos' : 'neg'}">${(e.net_sol >= 0 ? '+' : '') + e.net_sol.toFixed(4)}</td>
        </tr>`).join('')}</tbody>
    </table>` : '<div class="empty muted">No closed trades in window.</div>';

  const strats = data.strategies || [];
  document.getElementById('system-strategies').innerHTML = strats.length ? `
    <table class="missed-table">
      <thead><tr><th>STRATEGY</th><th class="num">TRADES</th><th class="num">W</th><th class="num">L</th><th class="num">WR</th><th class="num">AVG P&L</th><th class="num">NET SOL</th></tr></thead>
      <tbody>${strats.map(s => `
        <tr>
          <td>${strategyBadge(s.strategy)}</td>
          <td class="num">${s.trades}</td>
          <td class="num pos">${s.wins}</td>
          <td class="num neg">${s.losses}</td>
          <td class="num ${s.wr >= 50 ? 'pos' : 'neg'}">${s.wr}%</td>
          <td class="num ${s.avg_pnl >= 0 ? 'pos' : 'neg'}">${(s.avg_pnl >= 0 ? '+' : '') + s.avg_pnl}%</td>
          <td class="num ${s.net_sol >= 0 ? 'pos' : 'neg'}">${(s.net_sol >= 0 ? '+' : '') + s.net_sol.toFixed(4)}</td>
        </tr>`).join('')}</tbody>
    </table>` : '<div class="empty muted">No data.</div>';

  const wallets = data.wallets || [];
  document.getElementById('system-wallets').innerHTML = wallets.length ? `
    <table class="missed-table">
      <thead><tr><th>WALLET</th><th>CAT</th><th class="num">COPIED</th><th class="num">W</th><th class="num">L</th><th class="num">WR</th><th class="num">AVG P&L</th><th class="num">NET SOL</th></tr></thead>
      <tbody>${wallets.slice(0, 30).map(w => `
        <tr class="clickable" ${walletLink(w.wallet)}>
          <td class="addr">${fmt.short(w.wallet)} ${w.is_kol ? '👑' : ''}</td>
          <td><span class="cat-badge cat-${(w.category || 'NOT_SURE').toLowerCase()}">${w.category || '?'}</span></td>
          <td class="num">${w.copied}</td>
          <td class="num pos">${w.wins}</td>
          <td class="num neg">${w.losses}</td>
          <td class="num ${w.wr >= 50 ? 'pos' : 'neg'}">${w.wr}%</td>
          <td class="num ${w.avg_pnl >= 0 ? 'pos' : 'neg'}">${(w.avg_pnl >= 0 ? '+' : '') + w.avg_pnl}%</td>
          <td class="num ${w.net_sol >= 0 ? 'pos' : 'neg'}">${(w.net_sol >= 0 ? '+' : '') + w.net_sol.toFixed(4)}</td>
        </tr>`).join('')}</tbody>
    </table>` : '<div class="empty muted">No follow trades in window.</div>';

  const mcap = data.mcap || [];
  document.getElementById('system-mcap').innerHTML = mcap.length ? `
    <table class="missed-table">
      <thead><tr><th>BUCKET</th><th class="num">TRADES</th><th class="num">WINS</th><th class="num">WR</th><th class="num">AVG P&L</th><th class="num">NET SOL</th></tr></thead>
      <tbody>${mcap.map(m => `
        <tr>
          <td>${m.bucket}</td>
          <td class="num">${m.trades}</td>
          <td class="num pos">${m.wins}</td>
          <td class="num ${m.wr >= 50 ? 'pos' : 'neg'}">${m.wr}%</td>
          <td class="num ${m.avg_pnl >= 0 ? 'pos' : 'neg'}">${(m.avg_pnl >= 0 ? '+' : '') + m.avg_pnl}%</td>
          <td class="num ${m.net_sol >= 0 ? 'pos' : 'neg'}">${(m.net_sol >= 0 ? '+' : '') + m.net_sol.toFixed(4)}</td>
        </tr>`).join('')}</tbody>
    </table>` : '<div class="empty muted">No data.</div>';

  const hours = data.hours || [];
  const maxAbs = Math.max(0.001, ...hours.map(h => Math.abs(h.net_sol || 0)));
  document.getElementById('system-hours').innerHTML = hours.length ? `
    <div class="hour-bars">
      ${Array.from({ length: 24 }, (_, h) => {
        const row = hours.find(x => x.hour === h);
        const n = row?.net_sol || 0;
        const trades = row?.trades || 0;
        const wr = row?.wr || 0;
        const widthPct = (Math.abs(n) / maxAbs) * 100;
        const cls = n >= 0 ? 'pos' : 'neg';
        const time = `${String(h).padStart(2,'0')}:00`;
        return `<div class="hour-row">
          <div class="hour-label">${time}</div>
          <div class="hour-bar-track"><div class="hour-bar ${cls}" style="width:${widthPct}%"></div></div>
          <div class="hour-meta">${trades} trades · ${wr}% WR · ${n >= 0 ? '+' : ''}${n.toFixed(4)} SOL</div>
        </div>`;
      }).join('')}
    </div>` : '<div class="empty muted">No data.</div>';
}

function renderMissedPanel(data) {
  const el = document.getElementById('missed-panel');
  if (!data || !data.rejections || !data.rejections.length) {
    el.innerHTML = '<div class="empty">No rejections logged yet.</div>';
    return;
  }
  const rows = data.rejections;
  const bigWins = rows.filter(r => r.outcome === 'BIG_WIN').length;
  const wins = rows.filter(r => r.outcome === 'WIN').length;
  const losses = rows.filter(r => r.outcome === 'LOSS').length;
  const pending = rows.filter(r => r.outcome === 'PENDING').length;
  const total = rows.length;
  const missRate = total > 0 ? (bigWins + wins) / total : 0;

  const reasonRows = (data.summary || []).map(s => `<span class="reason-chip">${s.reason}: ${s.n}</span>`).join(' ');

  el.innerHTML = `
    <div class="backtest-summary" style="grid-template-columns: repeat(5, 1fr);">
      <div class="bt-stat ${bigWins > 0 ? 'bad' : ''}">
        <div class="stat-label">💎 Big Wins Missed</div>
        <div class="stat-value">${bigWins}</div>
      </div>
      <div class="bt-stat ${wins > 5 ? 'bad' : ''}">
        <div class="stat-label">✓ Wins Missed</div>
        <div class="stat-value">${wins}</div>
      </div>
      <div class="bt-stat good">
        <div class="stat-label">✗ Correctly Rejected</div>
        <div class="stat-value">${losses}</div>
      </div>
      <div class="bt-stat">
        <div class="stat-label">Pending Outcome</div>
        <div class="stat-value">${pending}</div>
      </div>
      <div class="bt-stat ${missRate > 0.3 ? 'bad' : 'good'}">
        <div class="stat-label">Miss Rate</div>
        <div class="stat-value">${(missRate * 100).toFixed(0)}%</div>
      </div>
    </div>
    <div class="backtest-reasons">
      <div class="reason-row"><span class="reason-label">By reason:</span> ${reasonRows}</div>
    </div>
    <div class="table-wrap">
      <table class="data">
        <thead>
          <tr>
            <th>First Reject</th>
            <th>Symbol</th>
            <th>Mint</th>
            <th>Reason</th>
            <th>Detail</th>
            <th>Signal</th>
            <th class="num">MCap @ Reject</th>
            <th class="num">Peak After</th>
            <th class="num">Peak %</th>
            <th>Outcome</th>
            <th class="num">Rejects</th>
          </tr>
        </thead>
        <tbody>
          ${rows.slice(0, 50).map(r => `<tr class="clickable" ${coinLink(r.mint_address)}>
            <td class="addr">${fmt.dt(r.first_rejected_at)}</td>
            <td class="sym">${r.symbol || '???'}</td>
            <td class="addr">${fmt.short(r.mint_address)}</td>
            <td><span class="flag bad">${r.reason}</span></td>
            <td class="addr">${r.reason_detail || '—'}</td>
            <td class="addr">${r.signal_type || '—'}</td>
            <td class="num">${fmt.usd(r.mcap_at_reject)}</td>
            <td class="num">${fmt.usd(r.peak_market_cap_sol)}</td>
            <td class="num ${(r.peak_pct_after || 0) >= 0.3 ? 'pos' : 'neg'}">${((r.peak_pct_after || 0) * 100).toFixed(0)}%</td>
            <td>${outcomeBadge(r.outcome)}</td>
            <td class="num">${r.reject_count}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
  `;
}

async function runBacktest() {
  const btn = document.getElementById('backtest-btn');
  const panel = document.getElementById('backtest-panel');
  btn.disabled = true;
  btn.textContent = 'RUNNING…';
  panel.innerHTML = '<div class="empty muted">Replaying every historical signal through current strategy params…</div>';
  try {
    const res = await fetch('/api/backtest/run', { method: 'POST' });
    const data = await res.json();
    btn.disabled = false;
    btn.textContent = 'RE-RUN';
    renderBacktestResults(data);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = 'RUN BACKTEST';
    panel.innerHTML = `<div class="empty">Backtest failed: ${err.message}</div>`;
  }
}

function renderBacktestResults(data) {
  const panel = document.getElementById('backtest-panel');
  const strategies = Object.keys(data.results);
  if (!strategies.length) { panel.innerHTML = '<div class="empty">No strategies.</div>'; return; }
  let totalPnl = 0;
  let totalPositions = 0;
  let totalWins = 0;
  let totalEntered = 0;
  for (const name of strategies) {
    const r = data.results[name];
    if (!r) continue;
    totalPnl += r.totalPnlSol || 0;
    totalPositions += r.positions || 0;
    totalWins += r.wins || 0;
    totalEntered += r.totalEntered || 0;
  }
  const overallRoi = totalEntered > 0 ? totalPnl / totalEntered : 0;
  const overallWr = totalPositions > 0 ? totalWins / totalPositions : 0;

  panel.innerHTML = `
    <div class="backtest-summary">
      <div class="bt-stat ${totalPnl >= 0 ? 'good' : 'bad'}">
        <div class="stat-label">Combined P&L</div>
        <div class="stat-value">${fmt.solSigned(totalPnl)}</div>
      </div>
      <div class="bt-stat ${overallRoi >= 0 ? 'good' : 'bad'}">
        <div class="stat-label">ROI on Capital Risked</div>
        <div class="stat-value">${(overallRoi * 100).toFixed(1)}%</div>
      </div>
      <div class="bt-stat">
        <div class="stat-label">Total Positions</div>
        <div class="stat-value">${totalPositions}</div>
      </div>
      <div class="bt-stat">
        <div class="stat-label">Combined Win Rate</div>
        <div class="stat-value">${(overallWr * 100).toFixed(1)}%</div>
      </div>
      <div class="bt-stat">
        <div class="stat-label">Capital Risked</div>
        <div class="stat-value">${fmt.sol(totalEntered)}</div>
      </div>
      <div class="bt-stat">
        <div class="stat-label">Backtest took</div>
        <div class="stat-value">${data.elapsedMs}ms</div>
      </div>
    </div>
    <div class="table-wrap" style="margin-top:14px;">
      <table class="data">
        <thead>
          <tr>
            <th>Strategy</th>
            <th class="num">Signals</th>
            <th class="num">Sim Positions</th>
            <th class="num">W / L</th>
            <th class="num">Win Rate</th>
            <th class="num">Total P&L</th>
            <th class="num">ROI</th>
            <th class="num">Avg Win</th>
            <th class="num">Avg Loss</th>
            <th class="num">R:R</th>
            <th class="num">Best</th>
            <th class="num">Worst</th>
            <th class="num">Avg Hold</th>
          </tr>
        </thead>
        <tbody>
          ${strategies.map(name => {
            const r = data.results[name];
            if (!r) return `<tr><td colspan="13">${name} — no data</td></tr>`;
            const pnl = r.totalPnlSol || 0;
            const roi = r.roi || 0;
            return `<tr>
              <td>${strategyBadge(name)}</td>
              <td class="num">${r.signalCount || 0}</td>
              <td class="num">${r.positions || 0}</td>
              <td class="num"><span class="pos">${r.wins || 0}</span>/<span class="neg">${r.losses || 0}</span></td>
              <td class="num ${r.winRate >= 0.5 ? 'pos' : 'neg'}">${(r.winRate * 100).toFixed(0)}%</td>
              <td class="num ${pnl >= 0 ? 'pos' : 'neg'}">${fmt.solSigned(pnl)}</td>
              <td class="num ${roi >= 0 ? 'pos' : 'neg'}">${(roi * 100).toFixed(1)}%</td>
              <td class="num pos">${fmt.solSigned(r.avgWin)}</td>
              <td class="num neg">${fmt.solSigned(r.avgLoss)}</td>
              <td class="num">${(r.rrRatio || 0).toFixed(2)}</td>
              <td class="num pos">${fmt.solSigned(r.bestWin)}</td>
              <td class="num neg">${fmt.solSigned(r.worstLoss)}</td>
              <td class="num">${(r.avgHoldMin || 0).toFixed(1)}m</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
    <div class="backtest-reasons">
      ${strategies.map(name => {
        const r = data.results[name];
        if (!r || !r.exitReasons) return '';
        const reasons = Object.entries(r.exitReasons).map(([k, v]) => `<span class="reason-chip">${k}: ${v}</span>`).join('');
        return `<div class="reason-row"><span class="reason-label">${name}:</span> ${reasons}</div>`;
      }).join('')}
    </div>
    <div class="backtest-disclaimer">
      ⚠️ Backtest uses CURRENT tracked/bundle/holder state — directional only, not exact. Pruned dead coins skipped. No slippage modeled.
    </div>
  `;
}

async function saveStrategyField(inp) {
  const strategyName = inp.dataset.strategy;
  const key = inp.dataset.key;
  let val = parseFloat(inp.value);
  if (isNaN(val)) return;
  if (key.endsWith('_pct')) val = val / 100;
  inp.classList.add('saving');
  try {
    await fetch(`/api/strategies/${strategyName}/settings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ [key]: val }),
    });
    inp.classList.remove('saving');
    inp.classList.add('saved');
    setTimeout(() => inp.classList.remove('saved'), 1000);
    tick();
  } catch {
    inp.classList.remove('saving');
    inp.classList.add('error');
    setTimeout(() => inp.classList.remove('error'), 2000);
  }
}

async function loadCoin(address) {
  setText('coin-breadcrumb', `COIN / ${address.slice(0, 8)}…`);
  try {
    const data = await fetchJson(`/api/mint/${address}`);
    const m = data.mint;

    const img = document.getElementById('coin-image');
    if (m.image_uri) { img.src = m.image_uri; img.style.display = 'block'; }
    else { img.style.display = 'none'; }

    setText('coin-symbol', m.symbol || '???');
    setText('coin-name', m.name || '');
    document.getElementById('coin-status-badges').innerHTML = statusBadge(m) + ' ' + flagBadges(m.flags) + ' ' + cashbackBadge(m);
    setText('coin-description', m.description || '');

    const creatorEl = document.getElementById('coin-creator');
    creatorEl.textContent = m.creator_wallet;
    creatorEl.dataset.copy = m.creator_wallet;
    const mintEl = document.getElementById('coin-mint');
    mintEl.textContent = m.mint_address;
    mintEl.dataset.copy = m.mint_address;
    document.getElementById('coin-socials').innerHTML = socialsLine(m, false);
    bindCopyable();

    setText('coin-current-mcap', fmt.usd(m.current_market_cap_sol));
    setText('coin-peak-mcap', fmt.usd(m.peak_market_cap_sol));
    setText('coin-age', fmt.age(m.created_at));
    setText('coin-trades-count', fmt.int(m.trade_count));
    setText('coin-unique-buyers', fmt.int(m.unique_buyer_count));
    setText('coin-initial-buy', fmt.sol(m.initial_buy_sol));
    setText('coin-pool', (m.pool || 'pump').toUpperCase());

    const snipersEl = document.getElementById('coin-snipers-table');
    if (!data.snipers.length) {
      snipersEl.innerHTML = '<tr><td colspan="9" class="empty">No snipers detected.</td></tr>';
    } else {
      snipersEl.innerHTML = data.snipers.map(s => {
        const status = s.sold_pct >= 0.99 ? '<span class="badge rugged">SOLD</span>'
          : s.sold_pct > 0 ? '<span class="badge partial">PARTIAL</span>'
          : '<span class="badge live">HOLDING</span>';
        const net = s.net_sol || 0;
        return `<tr class="clickable" ${walletLink(s.wallet)}>
          <td class="addr">${fmt.short(s.wallet)}</td>
          <td class="addr">${fmt.dt(s.first_buy_at)}</td>
          <td class="num">${fmt.sol(s.sol_invested)}</td>
          <td class="num">${fmt.num(s.tokens_bought, 0)}</td>
          <td class="num">${fmt.num(s.tokens_sold, 0)}</td>
          <td class="num">${fmt.pct(s.sold_pct || 0)}</td>
          <td class="num">${fmt.sol(s.sol_realized)}</td>
          <td class="num ${net >= 0 ? 'pos' : 'neg'}">${fmt.sol(net)}</td>
          <td>${status}</td>
        </tr>`;
      }).join('');
    }

    const tradesEl = document.getElementById('coin-trades-table');
    if (!data.trades.length) {
      tradesEl.innerHTML = '<tr><td colspan="9" class="empty">No trades.</td></tr>';
    } else {
      tradesEl.innerHTML = data.trades.map(t => {
        const side = t.is_buy ? '<span class="pos">BUY</span>' : '<span class="neg">SELL</span>';
        const labelClass = t.wallet_label === 'SNIPER' ? 'label-sniper'
          : t.wallet_label === 'DEV' ? 'label-dev'
          : t.wallet_label === 'SMART' ? 'label-smart'
          : t.wallet_label === 'NEW' ? 'label-new' : '';
        return `<tr class="clickable" ${walletLink(t.wallet)}>
          <td class="addr">${fmt.time(t.timestamp)}</td>
          <td class="addr">+${t.seconds_from_creation}s</td>
          <td>${side}</td>
          <td class="addr">${fmt.short(t.wallet)}</td>
          <td><span class="wallet-label ${labelClass}">${t.wallet_label || '—'}</span></td>
          <td class="num">${fmt.sol(t.sol_amount)}</td>
          <td class="num">${fmt.num(t.token_amount, 0)}</td>
          <td class="num">${fmt.num(t.price_sol, 10)}</td>
          <td class="num">${fmt.usd(t.market_cap_sol)}</td>
        </tr>`;
      }).join('');
    }

    const histEl = document.getElementById('coin-creator-history');
    if (!data.creatorHistory.length) {
      histEl.innerHTML = '<tr><td colspan="6" class="empty">No other launches by this creator.</td></tr>';
    } else {
      histEl.innerHTML = data.creatorHistory.map(c => `
        <tr class="clickable" ${coinLink(c.mint_address)}>
          <td class="addr">${fmt.dt(c.created_at)}</td>
          <td class="sym">${c.symbol || '???'}</td>
          <td>${c.name || '—'}</td>
          <td class="addr">${fmt.short(c.mint_address)}</td>
          <td class="num">${fmt.usd(c.peak_market_cap_sol)}</td>
          <td>${statusBadge(c)}</td>
        </tr>`).join('');
    }

    const holdersEl = document.getElementById('coin-holders-panel');
    if (!data.holders || data.holders.holderCount === 0) {
      holdersEl.innerHTML = '<div class="empty">No holder data yet.</div>';
    } else {
      const h = data.holders;
      const cfg = { whale: 0.25, bundle: 0.20, dev: 0.10, minHolders: 10 };
      const whaleBad = (h.whalePct || 0) > cfg.whale;
      const bundleBad = h.bundlePct > cfg.bundle;
      const devBad = h.creatorPct > cfg.dev;
      const thinBad = h.holderCount < cfg.minHolders;
      const gateOk = !whaleBad && !bundleBad && !devBad && !thinBad;
      holdersEl.innerHTML = `
        <div class="holder-summary">
          <div class="holder-stat ${whaleBad ? 'bad' : 'good'}"><div class="stat-label">Top Whale (non-bundle)</div><div class="stat-value">${((h.whalePct||0)*100).toFixed(1)}%</div></div>
          <div class="holder-stat ${bundleBad ? 'bad' : 'good'}"><div class="stat-label">Bundle Hold</div><div class="stat-value">${(h.bundlePct*100).toFixed(1)}%</div></div>
          <div class="holder-stat ${devBad ? 'bad' : 'good'}"><div class="stat-label">Dev Hold</div><div class="stat-value">${(h.creatorPct*100).toFixed(1)}%</div></div>
          <div class="holder-stat ${thinBad ? 'bad' : 'good'}"><div class="stat-label">Holders</div><div class="stat-value">${h.holderCount}</div></div>
          <div class="holder-stat ${gateOk ? 'good' : 'bad'}"><div class="stat-label">Diversity Gate</div><div class="stat-value">${gateOk ? '✓ PASS' : '✗ FAIL'}</div></div>
        </div>
        <div class="table-wrap" style="margin-top:10px;">
          <table class="data">
            <thead>
              <tr>
                <th>#</th>
                <th>Wallet</th>
                <th class="num">Tokens</th>
                <th class="num">% of Supply</th>
                <th class="num">Invested</th>
                <th>Tags</th>
              </tr>
            </thead>
            <tbody>
              ${h.topHolders.map((th, i) => {
                const tags = [];
                if (th.is_creator) tags.push('<span class="cat-badge cat-rugger">DEV</span>');
                if (th.is_bundle) tags.push('<span class="cat-badge cat-bundle">🧬 BUNDLE</span>');
                if (th.is_first_block) tags.push('<span class="flag bad">FIRST_BLOCK</span>');
                else if (th.is_sniper) tags.push('<span class="flag bad">SNIPER</span>');
                return `<tr class="clickable" ${walletLink(th.wallet)}>
                  <td class="num">${i+1}</td>
                  <td class="addr">${fmt.short(th.wallet)}</td>
                  <td class="num">${fmt.num(th.net_tokens, 0)}</td>
                  <td class="num ${th.pct >= 0.1 ? 'neg' : ''}">${(th.pct*100).toFixed(2)}%</td>
                  <td class="num">${fmt.sol(th.sol_invested)}</td>
                  <td>${tags.join(' ')}</td>
                </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>`;
    }

    const flagEl = document.getElementById('coin-flag-log');
    if (!data.flagLog.length) {
      flagEl.innerHTML = '<tr><td colspan="3" class="empty">No flags fired.</td></tr>';
    } else {
      flagEl.innerHTML = data.flagLog.map(f => {
        const cls = f.flag_type === 'DEV_HOLDING' ? 'flag good' : 'flag bad';
        return `<tr>
          <td class="addr">${fmt.dt(f.fired_at)}</td>
          <td><span class="${cls}">${f.flag_type}</span></td>
          <td class="addr">${JSON.stringify(f.details)}</td>
        </tr>`;
      }).join('');
    }
  } catch (err) {
    setText('coin-breadcrumb', `COIN / ${address.slice(0, 8)}… · ERROR: ${err.message}`);
  }
}

async function loadWallet(address) {
  setText('wallet-breadcrumb', `WALLET / ${address.slice(0, 8)}…`);
  try {
    const data = await fetchJson(`/api/wallet/${address}`);
    const w = data.wallet;

    setText('wallet-title', fmt.short(w.address));
    const badges = [];
    if (w.tracked) badges.push('<span class="badge tracked">TRACKED</span>');
    if ((w.sniper_ratio || 0) > 0.8) badges.push('<span class="badge rugged">SNIPE BOT</span>');
    document.getElementById('wallet-status-badges').innerHTML = badges.join(' ');

    const addrEl = document.getElementById('wallet-address');
    addrEl.textContent = w.address;
    addrEl.dataset.copy = w.address;
    setText('wallet-first-seen', fmt.dt(w.first_seen));
    setText('wallet-last-active', fmt.dt(w.last_activity_at));
    bindCopyable();

    setText('wallet-realized', fmt.solSigned(w.realized_pnl));
    colorize('wallet-realized', w.realized_pnl || 0);
    setText('wallet-unrealized', fmt.solSigned(w.unrealized_pnl));
    colorize('wallet-unrealized', w.unrealized_pnl || 0);
    setText('wallet-positions', fmt.int(w.position_count));
    setText('wallet-closed', fmt.int(w.closed_position_count));
    setText('wallet-winrate', fmt.pct(w.win_rate));
    setText('wallet-best', fmt.solSigned(w.best_coin_pnl));
    colorize('wallet-best', w.best_coin_pnl || 0);
    setText('wallet-worst', fmt.solSigned(w.worst_coin_pnl));
    colorize('wallet-worst', w.worst_coin_pnl || 0);

    const posEl = document.getElementById('wallet-positions-table');
    if (!data.positions.length) {
      posEl.innerHTML = '<tr><td colspan="10" class="empty">No positions.</td></tr>';
    } else {
      posEl.innerHTML = data.positions.map(p => {
        const bought = p.tokens_bought || 0;
        const sold = p.tokens_sold || 0;
        const invested = p.sol_invested || 0;
        const out = p.sol_realized || 0;
        const soldFrac = bought ? Math.min(sold / bought, 1) : 0;
        const realized = out - invested * soldFrac;
        const remaining = Math.max(0, bought - sold);
        const remCost = invested * (1 - soldFrac);
        const markValue = remaining * (p.last_price_sol || 0);
        const unrealized = markValue - remCost;
        const status = soldFrac >= 0.99 ? '<span class="badge rugged">CLOSED</span>'
          : soldFrac > 0 ? '<span class="badge partial">PARTIAL</span>'
          : '<span class="badge live">HOLDING</span>';
        return `<tr class="clickable" ${coinLink(p.mint_address)}>
          <td class="addr">${fmt.dt(p.first_buy_at)}</td>
          <td class="sym">${p.symbol || '???'}</td>
          <td class="addr">${fmt.short(p.mint_address)}</td>
          <td class="num">${fmt.sol(invested)}</td>
          <td class="num">${fmt.sol(out)}</td>
          <td class="num">${fmt.pct(soldFrac)}</td>
          <td class="num ${realized >= 0 ? 'pos' : 'neg'}">${fmt.solSigned(realized)}</td>
          <td class="num ${unrealized >= 0 ? 'pos' : 'neg'}">${fmt.solSigned(unrealized)}</td>
          <td>${status}</td>
          <td>${flagBadges(p.flags)}</td>
        </tr>`;
      }).join('');
    }

    const coEl = document.getElementById('wallet-cotraders-table');
    if (!data.coTraders.length) {
      coEl.innerHTML = '<tr><td colspan="4" class="empty">No co-trader data.</td></tr>';
    } else {
      coEl.innerHTML = data.coTraders.map(c => `
        <tr class="clickable" ${walletLink(c.wallet)}>
          <td class="addr">${fmt.short(c.wallet)}</td>
          <td class="num">${c.overlap_count}</td>
          <td class="num ${(c.realized_pnl || 0) >= 0 ? 'pos' : 'neg'}">${fmt.solSigned(c.realized_pnl)}</td>
          <td>${c.tracked ? '<span class="badge tracked">TRACKED</span>' : ''}</td>
        </tr>`).join('');
    }

    const tradesEl = document.getElementById('wallet-trades-table');
    if (!data.trades.length) {
      tradesEl.innerHTML = '<tr><td colspan="8" class="empty">No trades.</td></tr>';
    } else {
      tradesEl.innerHTML = data.trades.map(t => {
        const side = t.is_buy ? '<span class="pos">BUY</span>' : '<span class="neg">SELL</span>';
        const labelClass = t.wallet_label === 'SNIPER' ? 'label-sniper'
          : t.wallet_label === 'DEV' ? 'label-dev'
          : t.wallet_label === 'SMART' ? 'label-smart'
          : t.wallet_label === 'NEW' ? 'label-new' : '';
        return `<tr class="clickable" ${coinLink(t.mint_address)}>
          <td class="addr">${fmt.time(t.timestamp)}</td>
          <td class="sym">${t.symbol || '???'}</td>
          <td class="addr">${fmt.short(t.mint_address)}</td>
          <td>${side}</td>
          <td><span class="wallet-label ${labelClass}">${t.wallet_label || '—'}</span></td>
          <td class="num">${fmt.sol(t.sol_amount)}</td>
          <td class="num">${fmt.num(t.token_amount, 0)}</td>
          <td class="addr">+${t.seconds_from_creation}s</td>
        </tr>`;
      }).join('');
    }
  } catch (err) {
    setText('wallet-breadcrumb', `WALLET / ${address.slice(0, 8)}… · ERROR: ${err.message}`);
  }
}

const BAR_TIERS = [
  { min: 0,   max: 0.5,  cls: 'tier-0', name: 'DIVE BAR',         quotes: ["This place is a dump.", "Watch the broken glass.", "Tip jar's empty again.", "Last call already?"] },
  { min: 0.5, max: 1.0,  cls: 'tier-1', name: 'CORNER PUB',       quotes: ["What'll it be, friend?", "House special's strong tonight.", "Two for one on shots.", "Stick around, kid."] },
  { min: 1.0, max: 2.0,  cls: 'tier-2', name: 'COCKTAIL LOUNGE',  quotes: ["Top shelf, you say?", "Mixing somethin' nice.", "On the house — for now.", "Patrons starting to notice."] },
  { min: 2.0, max: 5.0,  cls: 'tier-3', name: 'SPEAKEASY',        quotes: ["Members only, pal.", "The good stuff's in back.", "Cash only — discretion guaranteed.", "Word's getting around."] },
  { min: 5.0, max: 15.0, cls: 'tier-4', name: 'PREMIUM CLUB',     quotes: ["Welcome to the big leagues.", "Reservation required.", "VIP section's filling up.", "We import this stuff weekly."] },
  { min: 15.0, max: Infinity, cls: 'tier-5', name: '👑 CRYPTO ROYALTY 👑', quotes: ["Money? We don't ask the price.", "The chandelier? Solid gold.", "Every glass is hand-cut crystal.", "Mr. Monkey will see you now."] },
];
const BARTENDER_ACTIONS = ['🥃', '🥂', '🧊', '🍋', '🥤', '🌿', '🍒'];
let _barAnimTimer = null;
function updateBar(walletSol) {
  const room = document.querySelector('.bar-room');
  if (!room) return;
  const tier = BAR_TIERS.find(t => walletSol >= t.min && walletSol < t.max) || BAR_TIERS[0];
  for (const t of BAR_TIERS) room.classList.remove(t.cls);
  room.classList.add(tier.cls);
  const nameEl = document.getElementById('bar-tier-name');
  const valEl = document.getElementById('bar-tier-value');
  if (nameEl) nameEl.textContent = tier.name;
  if (valEl) valEl.textContent = walletSol.toFixed(4) + ' SOL';
  if (!_barAnimTimer) {
    _barAnimTimer = setInterval(() => {
      const action = document.getElementById('bartender-action');
      const quote = document.getElementById('bar-quote');
      if (action) action.textContent = BARTENDER_ACTIONS[Math.floor(Math.random() * BARTENDER_ACTIONS.length)];
      if (quote) {
        const q = tier.quotes[Math.floor(Math.random() * tier.quotes.length)];
        quote.textContent = `"${q}"`;
      }
    }, 4000);
  }
}

function updateTopbar(stats) {
  const sim = stats.sim;
  const isLive = document.body.classList.contains('mode-live');
  if (sim && !isLive) {
    const walletEl = document.getElementById('stat-wallet');
    walletEl.textContent = sim.totalValue.toFixed(4) + ' SOL';
    walletEl.style.color = sim.totalValue >= sim.startingBalanceSol ? 'var(--green)' : 'var(--pink)';

    const pctEl = document.getElementById('stat-wallet-pct');
    const pct = (sim.pctChange * 100);
    pctEl.textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%`;
    pctEl.style.color = sim.pctChange >= 0 ? 'var(--green)' : 'var(--pink)';

    const peakEl = document.getElementById('stat-wallet-peak');
    peakEl.textContent = `${sim.peakTotalValue.toFixed(3)} / ${(sim.drawdown * 100).toFixed(1)}%`;
    peakEl.style.color = sim.drawdown < -0.05 ? 'var(--pink)' : '';
  }
  const pnlEl = document.getElementById('stat-pnl');
  if (!isLive) {
    pnlEl.textContent = fmt.sol(stats.realizedPnlSol);
    pnlEl.style.color = stats.realizedPnlSol > 0 ? 'var(--green)' : stats.realizedPnlSol < 0 ? 'var(--pink)' : '';
  }
  const lockedSol = (stats.mode === 'live' ? stats.live?.lockedInOpen : stats.sim?.lockedInOpen) || 0;
  setText('stat-open', `${fmt.int(stats.openPositions)} · ${lockedSol.toFixed(3)}◎`);
  setText('stat-winrate', fmt.pct(stats.winRate));
  setText('stat-mints', fmt.int(stats.totalMints));
  setText('stat-trades', fmt.int(stats.totalTrades));
  setText('stat-wallets', fmt.int(stats.totalWallets));
  setText('stat-tracked', fmt.int(stats.trackedWallets));
  setText('stat-kols', fmt.int(stats.kolWallets));
  setText('stat-signals', fmt.int(stats.copySignals));
  setText('stat-volume-surges', fmt.int(stats.volumeSignals));
  setText('stat-bundles', fmt.int(stats.bundleClusters));
  fetchJson('/api/safety/status').then(s => {
    _cachedStatus = s;
    const modeEl = document.getElementById('stat-mode');
    const labelEl = document.getElementById('stat-mode-label');
    const box = document.getElementById('stat-mode-box');
    const switchBox = document.getElementById('stat-mode-switch');
    const switchVal = document.getElementById('stat-mode-switch-val');
    document.body.classList.toggle('mode-live', s.mode === 'live');
    document.body.classList.toggle('mode-halted', !!s.halted);
    if (modeEl && box) {
      if (s.halted) {
        modeEl.textContent = '🛑 HALTED';
        modeEl.style.color = 'var(--yellow)';
        box.style.borderColor = 'var(--yellow)';
        if (labelEl) labelEl.textContent = 'click to RESUME';
      } else if (s.mode === 'live') {
        modeEl.textContent = '🔴 LIVE';
        modeEl.style.color = 'var(--pink)';
        box.style.borderColor = 'var(--pink)';
        if (labelEl) labelEl.textContent = 'click to HALT';
      } else {
        modeEl.textContent = '📝 PAPER';
        modeEl.style.color = 'var(--cyan)';
        box.style.borderColor = 'var(--border)';
        if (labelEl) labelEl.textContent = 'click to HALT';
      }
    }
    if (switchVal) {
      switchVal.textContent = s.mode === 'live' ? '→ PAPER' : '→ LIVE';
      switchVal.style.color = s.mode === 'live' ? 'var(--cyan)' : 'var(--pink)';
    }
    if (switchBox) {
      switchBox.style.borderColor = s.mode === 'live' ? 'var(--cyan)' : 'var(--pink)';
    }
    const walletEl = document.getElementById('stat-wallet');
    const walletLabel = document.querySelector('.stat.sim-wallet .stat-label');
    const walletBox = document.querySelector('.stat.sim-wallet');
    if (s.mode === 'live') {
      if (walletLabel) walletLabel.textContent = '🔴 Live Wallet';
      if (walletBox) walletBox.classList.add('live-balance');
      if (walletEl && s.walletSolBalance != null) {
        walletEl.textContent = s.walletSolBalance.toFixed(4) + ' SOL';
        walletEl.style.color = 'var(--pink)';
      }
      const pnlEl = document.getElementById('stat-pnl');
      const pnlLabel = pnlEl?.parentElement?.querySelector('.stat-label');
      if (pnlLabel) pnlLabel.textContent = '🔴 Live P&L';
      if (pnlEl && s.livePnlSol != null) {
        const v = s.livePnlSol;
        pnlEl.textContent = (v >= 0 ? '+' : '') + v.toFixed(4) + ' ◎';
        pnlEl.style.color = v > 0 ? 'var(--green)' : v < 0 ? 'var(--pink)' : '';
      }
      const pctEl = document.getElementById('stat-wallet-pct');
      if (pctEl && s.walletSolBalance != null && s.liveStartingSol) {
        const pct = (s.walletSolBalance - s.liveStartingSol) / s.liveStartingSol;
        pctEl.textContent = (pct >= 0 ? '+' : '') + (pct * 100).toFixed(2) + '%';
        pctEl.style.color = pct > 0 ? 'var(--green)' : pct < 0 ? 'var(--pink)' : '';
      }
      const peakEl = document.getElementById('stat-wallet-peak');
      if (peakEl && stats.live && stats.live.peakTotalValue != null) {
        const peak = stats.live.peakTotalValue;
        const dd = stats.live.drawdown || 0;
        peakEl.textContent = `${peak.toFixed(3)} / ${(dd * 100).toFixed(1)}%`;
        peakEl.style.color = dd < -0.05 ? 'var(--pink)' : '';
      }
    } else {
      if (walletLabel && walletLabel.textContent !== '💼 Wallet') walletLabel.textContent = '💼 Wallet';
      if (walletBox) walletBox.classList.remove('live-balance');
      const pnlLabel = document.getElementById('stat-pnl')?.parentElement?.querySelector('.stat-label');
      if (pnlLabel && pnlLabel.textContent !== 'Realized P&L') pnlLabel.textContent = 'Realized P&L';
    }
  }).catch(() => {});
  const incin = stats.incinerateSol || 0;
  const mintsTraded = stats.uniqueMintsTraded || 0;
  setText('stat-incinerate', `${incin.toFixed(4)}◎`);
  const incEl = document.getElementById('stat-incinerate');
  if (incEl) incEl.title = `${mintsTraded} unique mints × 0.00203928 SOL rent recoverable per account`;
  const cashback = stats.cashbackEstimatedSol || 0;
  const cbPositions = stats.cashbackPositions || 0;
  setText('stat-cashback', `~${cashback.toFixed(4)}◎`);
  const cbEl = document.getElementById('stat-cashback');
  if (cbEl) cbEl.title = `Est. cashback across ${cbPositions} positions in cashback coins · 0.5% × our share × volume during hold (calibrate at live launch)`;
  if (stats.solUsd) solUsd = stats.solUsd;
  const ing = stats.ingestion;
  if (ing) {
    setText('stat-status', ing.connected ? 'LIVE' : 'OFFLINE');
    document.getElementById('stat-status').style.color = ing.connected ? 'var(--green)' : 'var(--pink)';
  }
}

function updateTraderCatCounts(c) {
  setText('cat-count-all', c.all || 0);
  setText('cat-count-HUMAN', c.HUMAN || 0);
  setText('cat-count-BOT', c.BOT || 0);
  setText('cat-count-SCALPER', c.SCALPER || 0);
  setText('cat-count-BUNDLE', c.BUNDLE || 0);
  setText('cat-count-NOT_SURE', c.NOT_SURE || 0);
}

function updateDevCatCounts(c) {
  setText('devcat-count-all', c.all || 0);
  setText('devcat-count-LEGIT', c.LEGIT || 0);
  setText('devcat-count-WHALE', c.WHALE || 0);
  setText('devcat-count-RUGGER', c.RUGGER || 0);
  setText('devcat-count-SERIAL', c.SERIAL || 0);
  setText('devcat-count-NEW', c.NEW || 0);
  setText('devcat-count-NOT_SURE', c.NOT_SURE || 0);
}

function updateMintCatCounts(c) {
  setText('mintcat-count-all', c.all || 0);
  setText('mintcat-count-fresh', c.fresh || 0);
  setText('mintcat-count-runners', c.runners || 0);
  setText('mintcat-count-near_grad', c.near_grad || 0);
  setText('mintcat-count-migrated', c.migrated || 0);
  setText('mintcat-count-rugged', c.rugged || 0);
}

async function tick() {
  if (document.hidden) return;
  try {
    const stats = await fetchJson('/api/stats');
    updateTopbar(stats);

    if (currentView === 'mints') {
      const [mints, counts] = await Promise.all([
        fetchJson(`/api/mints?limit=200&category=${mintsCategory}`),
        fetchJson('/api/mints/counts'),
      ]);
      renderMintsTable(mints);
      updateMintCatCounts(counts);
    } else if (currentView === 'devs') {
      const [devs, counts] = await Promise.all([
        fetchJson(`/api/creators/top?category=${devsCategory}`),
        fetchJson('/api/creators/counts'),
      ]);
      renderDevsTable(devs);
      updateDevCatCounts(counts);
    } else if (currentView === 'traders') {
      const [traders, counts, grader] = await Promise.all([
        fetchJson(`/api/traders/top?tracked=${tradersTrackedOnly ? '1' : '0'}&category=${tradersCategory}`),
        fetchJson('/api/traders/counts'),
        fetchJson('/api/grader/status'),
      ]);
      renderTradersTable(traders);
      updateTraderCatCounts(counts);
      renderBoostStatus(grader);
    } else if (currentView === 'positions') {
      const [positions, strategies, missed, exits] = await Promise.all([
        fetchJson('/api/positions'),
        fetchJson('/api/strategies'),
        fetchJson('/api/rejections/missed'),
        fetchJson('/api/exits/analysis'),
      ]);
      renderPositionsTables(positions);
      renderStrategiesPanel(strategies);
      renderMissedPanel(missed);
      renderExitAnalysis(exits);
    } else if (currentView === 'system') {
      const data = await fetchJson(`/api/system?window=${systemWindow}`);
      renderSystemPanels(data);
    } else if (currentView === 'lab') {
      const [data, leaderboard] = await Promise.all([
        fetchJson(`/api/coins/lifecycle?window=${labWindow}&filter=${labFilter}`),
        fetchJson('/api/runner-leaderboard?limit=20'),
      ]);
      renderLabPanel(data);
      renderRunnerLeaderboard(leaderboard);
    } else if (currentView === 'coin' && location.hash.startsWith('#coin/')) {
      loadCoin(location.hash.slice(6));
    } else if (currentView === 'wallet' && location.hash.startsWith('#wallet/')) {
      loadWallet(location.hash.slice(8));
    } else if (currentView === 'dev' && location.hash.startsWith('#dev/')) {
      loadDev(location.hash.slice(5));
    }

    const solTag = solUsd ? ` · SOL $${solUsd.toFixed(2)}` : '';
    setText('last-update', `updated ${new Date().toLocaleTimeString('en-US', { hour12: false })}${solTag}`);
  } catch (err) {
    setText('stat-status', 'ERR');
    setText('last-update', `error: ${err.message}`);
  }
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) tick();
});

async function loadDev(wallet) {
  setText('dev-breadcrumb', `DEV / ${wallet.slice(0, 8)}…`);
  try {
    const data = await fetchJson(`/api/dev/${wallet}`);
    const c = data.creator;

    setText('dev-title', fmt.short(c.wallet));
    document.getElementById('dev-status-badges').innerHTML = devCategoryBadge(c.category) + ' ' + devFlagBadges(c.dev_flags);

    const wEl = document.getElementById('dev-wallet');
    wEl.textContent = c.wallet;
    wEl.dataset.copy = c.wallet;
    setText('dev-first-launch', fmt.dt(c.first_launch));
    setText('dev-last-launch', fmt.dt(c.last_launch));
    bindCopyable();

    const rep = c.reputation_score || 0;
    setText('dev-rep', rep.toFixed(1));
    document.getElementById('dev-rep').style.color = rep > 0 ? 'var(--green)' : rep < 0 ? 'var(--pink)' : '';
    setText('dev-launches', fmt.int(c.launch_count));
    setText('dev-migrated', fmt.int(c.migrated_count));
    setText('dev-rugged', fmt.int(c.rugged_count));
    setText('dev-abandoned', fmt.int(c.abandoned_count));
    setText('dev-best', fmt.usd(c.best_peak_mcap));
    setText('dev-avgpeak', fmt.usd(c.avg_peak_mcap));
    setText('dev-cycle', fmtCycle(c.avg_cycle_time_seconds));
    setText('dev-lifetime', fmtCycle(c.avg_launch_lifetime_seconds));
    setText('dev-days', (c.days_active || 0).toFixed(1) + 'd');
    setText('dev-bundle', fmt.int(c.bundle_overlap_count));

    const traderEl = document.getElementById('dev-as-trader-panel');
    if (data.walletStats) {
      const w = data.walletStats;
      traderEl.innerHTML = `
        <div class="row clickable" style="grid-template-columns: 1fr 110px 110px 80px 80px 100px;" ${walletLink(w.address)}>
          <div class="addr">View this wallet's trade activity →</div>
          <div class="num ${(w.realized_pnl || 0) >= 0 ? 'pos' : 'neg'}">PnL ${fmt.solSigned(w.realized_pnl)}</div>
          <div class="num">PnL30d ${fmt.solSigned(w.realized_pnl_30d)}</div>
          <div class="num">${w.closed_position_count || 0} closed</div>
          <div class="num">${fmt.pct(w.win_rate)} WR</div>
          <div>${categoryBadge(w.category, w.copy_friendly)}</div>
        </div>`;
    } else {
      traderEl.innerHTML = '<div class="empty">This wallet hasn\'t shown up in our trade feed (creator-only).</div>';
    }

    const lEl = document.getElementById('dev-launches-table');
    if (!data.launches.length) {
      lEl.innerHTML = '<tr><td colspan="11" class="empty">No launches.</td></tr>';
    } else {
      lEl.innerHTML = data.launches.map(m => `<tr class="clickable" ${coinLink(m.mint_address)}>
        <td class="addr">${fmt.dt(m.created_at)}</td>
        <td class="sym">${m.symbol || '???'}</td>
        <td>${m.name || '—'}</td>
        <td class="addr">${fmt.short(m.mint_address)}</td>
        <td class="num">${fmt.sol(m.initial_buy_sol)}</td>
        <td class="num">${fmt.usd(m.peak_market_cap_sol)}</td>
        <td class="num">${fmt.usd(m.current_market_cap_sol)}</td>
        <td class="num">${fmt.int(m.trade_count)}</td>
        <td class="num">${fmt.int(m.unique_buyer_count)}</td>
        <td>${flagBadges(m.flags)}</td>
        <td>${statusBadge(m)}</td>
      </tr>`).join('');
    }
  } catch (err) {
    setText('dev-breadcrumb', `DEV / ${wallet.slice(0, 8)}… · ERROR: ${err.message}`);
  }
}

function fmtBytes(n) {
  if (!n) return '0B';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`;
}

async function refreshDbStats() {
  try {
    const s = await fetchJson('/api/db/stats');
    const c = s.counts;
    setText('db-stats', `db: ${fmtBytes(s.totalBytes)} · ${fmt.int(c.trades)} trades · ${fmt.int(c.mints)} mints · ${fmt.int(c.wallets)} wallets`);
  } catch {}
}

document.getElementById('backtest-btn')?.addEventListener('click', runBacktest);

document.getElementById('reset-wallet-btn')?.addEventListener('click', async () => {
  if (!confirm('Reset simulated wallet to 1.0 SOL? Past trades will no longer count.')) return;
  const btn = document.getElementById('reset-wallet-btn');
  btn.disabled = true;
  btn.textContent = 'RESETTING…';
  try {
    await fetch('/api/wallet/sim/reset', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ balance: 1.0 }),
    });
    btn.textContent = '✓ RESET';
    setTimeout(() => { btn.textContent = 'RESET WALLET'; btn.disabled = false; }, 2000);
    tick();
  } catch (err) {
    btn.textContent = 'ERR';
    setTimeout(() => { btn.textContent = 'RESET WALLET'; btn.disabled = false; }, 2000);
  }
});

document.getElementById('prune-btn').addEventListener('click', async () => {
  const btn = document.getElementById('prune-btn');
  btn.disabled = true;
  btn.textContent = 'PRUNING…';
  try {
    const res = await fetch('/api/db/prune', { method: 'POST' });
    const r = await res.json();
    btn.textContent = `−${fmt.int(r.ruggedDeleted + r.quietDeleted)} trades · freed ${fmtBytes(r.vacuumFreed)}`;
    setTimeout(() => { btn.textContent = 'PRUNE NOW'; btn.disabled = false; }, 4000);
    refreshDbStats();
  } catch (err) {
    btn.textContent = `ERR: ${err.message}`;
    setTimeout(() => { btn.textContent = 'PRUNE NOW'; btn.disabled = false; }, 4000);
  }
});

function persistSectionState() {
  document.querySelectorAll('details.section[data-section]').forEach(el => {
    const key = `section-${el.dataset.section}`;
    const stored = localStorage.getItem(key);
    if (stored === 'open') el.open = true;
    else if (stored === 'closed') el.open = false;
    el.addEventListener('toggle', () => {
      localStorage.setItem(key, el.open ? 'open' : 'closed');
    });
  });
}

bindSortable();
persistSectionState();
const refresh = tick;
tick();
setInterval(tick, 3000);
refreshDbStats();
setInterval(refreshDbStats, 30000);

(function setupStrategyBuilder() {
  const listEl = document.getElementById('builder-list');
  const formEl = document.getElementById('builder-form');
  const titleEl = document.getElementById('builder-form-title');
  const newBtn = document.getElementById('builder-new-btn');
  const restartBtn = document.getElementById('builder-restart-btn');
  const saveBtn = document.getElementById('b-save-btn');
  const deleteBtn = document.getElementById('b-delete-btn');
  const cancelBtn = document.getElementById('b-cancel-btn');
  const statusEl = document.getElementById('b-status');
  if (!listEl || !formEl) return;
  let editingName = null;

  const $ = (id) => document.getElementById(id);
  const setVal = (id, v) => { const el = $(id); if (el) el.value = (v === undefined || v === null) ? '' : v; };
  const getVal = (id) => $(id)?.value || '';
  const getNum = (id) => { const v = parseFloat(getVal(id)); return isFinite(v) ? v : 0; };
  const getInt = (id) => { const v = parseInt(getVal(id), 10); return isFinite(v) ? v : 0; };

  async function refreshList() {
    try {
      const r = await fetchJson('/api/strategies/builder/list');
      listEl.innerHTML = (r.strategies || []).map(s => {
        const editable = !!s.sourceFile;
        return `<div class="builder-row" data-name="${s.name}" style="padding:8px 10px;border:1px solid var(--border);border-radius:4px;cursor:pointer;background:#0d0d1a;">
          <div style="font-size:12px;color:var(--cyan);font-weight:bold;">${s.config.label || s.name}</div>
          <div style="font-size:10px;color:var(--muted);">${s.name} · ${s.config.trigger || 'smart_trade'} ${editable ? '' : '(built-in)'}</div>
        </div>`;
      }).join('');
      listEl.querySelectorAll('.builder-row').forEach(row => {
        row.addEventListener('click', () => loadForEdit(row.dataset.name));
      });
    } catch (e) { listEl.innerHTML = `<div class="muted">load failed: ${e.message}</div>`; }
  }

  function clearForm() {
    ['b-name','b-label','b-description','b-whitelist','b-categories','b-cat-under-mc','b-mc-floor','b-mc-ceiling','b-king-wallets'].forEach(id => setVal(id, ''));
    setVal('b-trigger', 'smart_trade'); setVal('b-enabled', '0'); setVal('b-require-kol', '0');
    setVal('b-entry-sol', 0.13); setVal('b-max-hold', 30); setVal('b-sl-pct', -0.10);
    setVal('b-t1-trig', 0.20); setVal('b-t1-sell', 1.00);
    setVal('b-t2-trig', 99); setVal('b-t2-sell', 0);
    setVal('b-t3-trig', 99); setVal('b-t3-sell', 0); setVal('b-t3-trail', 0);
    setVal('b-pf1-arm', 0.10); setVal('b-pf1-exit', 0.10);
    setVal('b-pf2-arm', 0.20); setVal('b-pf2-exit', 0.20);
    setVal('b-pf3-arm', 0.30); setVal('b-pf3-exit', 0.30);
    setVal('b-be-after-t1', '0'); setVal('b-be-arm', 0); setVal('b-be-floor', 0);
    setVal('b-tp-trail', 0); setVal('b-tp-trail-arm', 0);
    setVal('b-ff-sec', 0); setVal('b-ff-peak', 0); setVal('b-ff-sl', 0);
    setVal('b-fp-sec', 0); setVal('b-fp-peak', 0); setVal('b-fp-sl', 0);
    setVal('b-flat-min', 0); setVal('b-flat-peak', 0); setVal('b-flat-band', 0);
    setVal('b-stag-min', 0); setVal('b-stag-loss', 0); setVal('b-cashback', 1.0);
    setVal('b-king-sell-thresh', 0.5);
  }

  async function loadForEdit(name) {
    try {
      const r = await fetchJson('/api/strategies/builder/list');
      const s = (r.strategies || []).find(x => x.name === name);
      if (!s) return;
      const c = s.config; const d = c.defaults || {};
      clearForm();
      setVal('b-name', s.name); $('b-name').disabled = true;
      setVal('b-label', c.label); setVal('b-description', c.description); setVal('b-trigger', c.trigger || 'smart_trade');
      setVal('b-enabled', d.enabled || 0);
      const sf = c.sourceFilter || {};
      setVal('b-whitelist', (sf.walletWhitelist || []).join(','));
      setVal('b-categories', (sf.walletCategories || []).join(','));
      setVal('b-cat-under-mc', Object.entries(sf.categoriesUnderMc || {}).map(([k,v]) => `${k}:${v}`).join(','));
      setVal('b-require-kol', sf.requireKol ? '1' : '0');
      setVal('b-mc-floor', c.mcFloor); setVal('b-mc-ceiling', c.mcCeiling);
      setVal('b-entry-sol', d.entry_sol); setVal('b-max-hold', d.max_hold_min); setVal('b-sl-pct', d.sl_pct);
      setVal('b-t1-trig', d.tier1_trigger_pct); setVal('b-t1-sell', d.tier1_sell_pct);
      setVal('b-t2-trig', d.tier2_trigger_pct); setVal('b-t2-sell', d.tier2_sell_pct);
      setVal('b-t3-trig', d.tier3_trigger_pct); setVal('b-t3-sell', d.tier3_sell_pct); setVal('b-t3-trail', d.tier3_trail_pct);
      setVal('b-pf1-arm', d.peak_floor_arm_pct); setVal('b-pf1-exit', d.peak_floor_exit_pct);
      setVal('b-pf2-arm', d.peak_floor_arm2_pct); setVal('b-pf2-exit', d.peak_floor_exit2_pct);
      setVal('b-pf3-arm', d.peak_floor_arm3_pct); setVal('b-pf3-exit', d.peak_floor_exit3_pct);
      setVal('b-be-after-t1', d.breakeven_after_tier1 || 0); setVal('b-be-arm', d.breakeven_arm_pct); setVal('b-be-floor', d.breakeven_floor_pct);
      setVal('b-tp-trail', d.tp_trail_pct); setVal('b-tp-trail-arm', d.tp_trail_arm_pct);
      setVal('b-ff-sec', d.fast_fail_sec); setVal('b-ff-peak', d.fast_fail_min_peak_pct); setVal('b-ff-sl', d.fast_fail_sl_pct);
      setVal('b-fp-sec', d.fakepump_sec); setVal('b-fp-peak', d.fakepump_min_peak_pct); setVal('b-fp-sl', d.fakepump_sl_pct);
      setVal('b-flat-min', d.flat_exit_min); setVal('b-flat-peak', d.flat_exit_max_peak_pct); setVal('b-flat-band', d.flat_exit_band_pct);
      setVal('b-stag-min', d.stagnant_exit_min); setVal('b-stag-loss', d.stagnant_loss_pct); setVal('b-cashback', d.cashback_trigger_boost || 1.0);
      setVal('b-king-wallets', (c.kingWallets || []).join(','));
      setVal('b-king-sell-thresh', c.kingSellExitThreshold || 0.5);
      editingName = s.name;
      titleEl.textContent = `EDIT: ${s.name}`;
      deleteBtn.style.display = s.sourceFile ? 'block' : 'none';
      formEl.style.display = 'block';
      statusEl.textContent = s.sourceFile ? `editing ${s.sourceFile}` : 'built-in (read-only fields will save as override)';
    } catch (e) { statusEl.textContent = `load failed: ${e.message}`; }
  }

  function buildSpec() {
    const whitelist = getVal('b-whitelist').split(',').map(s => s.trim()).filter(Boolean);
    const categories = getVal('b-categories').split(',').map(s => s.trim()).filter(Boolean);
    const catUnderMc = {};
    getVal('b-cat-under-mc').split(',').map(s => s.trim()).filter(Boolean).forEach(pair => {
      const [k, v] = pair.split(':'); if (k && v && !isNaN(+v)) catUnderMc[k.toUpperCase().trim()] = +v;
    });
    const sourceFilter = {};
    if (whitelist.length) sourceFilter.walletWhitelist = whitelist;
    if (categories.length) sourceFilter.walletCategories = categories;
    if (Object.keys(catUnderMc).length) sourceFilter.categoriesUnderMc = catUnderMc;
    if (getVal('b-require-kol') === '1') sourceFilter.requireKol = true;
    const kingWallets = getVal('b-king-wallets').split(',').map(s => s.trim()).filter(Boolean);
    return {
      name: getVal('b-name').trim(),
      label: getVal('b-label').trim() || getVal('b-name').trim(),
      description: getVal('b-description').trim(),
      trigger: getVal('b-trigger'),
      sourceFilter: Object.keys(sourceFilter).length ? sourceFilter : undefined,
      mcFloor: getVal('b-mc-floor') !== '' ? getNum('b-mc-floor') : undefined,
      mcCeiling: getVal('b-mc-ceiling') !== '' ? getNum('b-mc-ceiling') : undefined,
      kingWallets: kingWallets.length ? kingWallets : undefined,
      kingSellExitThreshold: kingWallets.length ? getNum('b-king-sell-thresh') : undefined,
      defaults: {
        enabled: getInt('b-enabled'),
        entry_sol: getNum('b-entry-sol'), sl_pct: getNum('b-sl-pct'), max_hold_min: getNum('b-max-hold'),
        tier1_trigger_pct: getNum('b-t1-trig'), tier1_sell_pct: getNum('b-t1-sell'),
        tier2_trigger_pct: getNum('b-t2-trig'), tier2_sell_pct: getNum('b-t2-sell'),
        tier3_trigger_pct: getNum('b-t3-trig'), tier3_sell_pct: getNum('b-t3-sell'), tier3_trail_pct: getNum('b-t3-trail'),
        peak_floor_arm_pct: getNum('b-pf1-arm'), peak_floor_exit_pct: getNum('b-pf1-exit'),
        peak_floor_arm2_pct: getNum('b-pf2-arm'), peak_floor_exit2_pct: getNum('b-pf2-exit'),
        peak_floor_arm3_pct: getNum('b-pf3-arm'), peak_floor_exit3_pct: getNum('b-pf3-exit'),
        breakeven_after_tier1: getInt('b-be-after-t1'), breakeven_arm_pct: getNum('b-be-arm'), breakeven_floor_pct: getNum('b-be-floor'),
        tp_trail_pct: getNum('b-tp-trail'), tp_trail_arm_pct: getNum('b-tp-trail-arm'),
        fast_fail_sec: getInt('b-ff-sec'), fast_fail_min_peak_pct: getNum('b-ff-peak'), fast_fail_sl_pct: getNum('b-ff-sl'),
        fakepump_sec: getInt('b-fp-sec'), fakepump_min_peak_pct: getNum('b-fp-peak'), fakepump_sl_pct: getNum('b-fp-sl'),
        flat_exit_min: getInt('b-flat-min'), flat_exit_max_peak_pct: getNum('b-flat-peak'), flat_exit_band_pct: getNum('b-flat-band'),
        stagnant_exit_min: getInt('b-stag-min'), stagnant_loss_pct: getNum('b-stag-loss'),
        cashback_trigger_boost: getNum('b-cashback'),
      },
    };
  }

  newBtn?.addEventListener('click', () => {
    editingName = null;
    clearForm(); $('b-name').disabled = false;
    titleEl.textContent = 'NEW STRATEGY';
    deleteBtn.style.display = 'none';
    formEl.style.display = 'block';
    statusEl.textContent = 'fill in the form, then SAVE';
  });

  cancelBtn?.addEventListener('click', () => { formEl.style.display = 'none'; statusEl.textContent = ''; });

  saveBtn?.addEventListener('click', async () => {
    const spec = buildSpec();
    if (!spec.name) { statusEl.textContent = 'name required'; return; }
    statusEl.textContent = 'saving…';
    try {
      const url = editingName ? `/api/strategies/builder/${editingName}` : '/api/strategies/builder/create';
      const method = editingName ? 'PUT' : 'POST';
      const res = await fetch(url, { method, headers: {'Content-Type':'application/json'}, body: JSON.stringify(spec) });
      const r = await res.json();
      if (r.ok) {
        statusEl.style.color = 'var(--green)';
        statusEl.textContent = `saved → ${r.sourceFile || spec.name}. click RESTART TO APPLY.`;
        refreshList();
      } else { statusEl.style.color = 'var(--pink)'; statusEl.textContent = `error: ${r.error}`; }
    } catch (e) { statusEl.style.color = 'var(--pink)'; statusEl.textContent = `failed: ${e.message}`; }
  });

  deleteBtn?.addEventListener('click', async () => {
    if (!editingName || !confirm(`Delete ${editingName}?`)) return;
    try {
      const res = await fetch(`/api/strategies/builder/${editingName}`, { method: 'DELETE' });
      const r = await res.json();
      if (r.ok) {
        statusEl.style.color = 'var(--green)';
        statusEl.textContent = `deleted. click RESTART TO APPLY.`;
        formEl.style.display = 'none'; refreshList();
      } else { statusEl.textContent = `error: ${r.error}`; }
    } catch (e) { statusEl.textContent = `failed: ${e.message}`; }
  });

  restartBtn?.addEventListener('click', async () => {
    if (!confirm('Restart server to apply strategy changes?')) return;
    try {
      await fetch('/api/strategies/builder/restart', { method: 'POST' });
      restartBtn.textContent = '↻ restarting…';
      setTimeout(() => { restartBtn.textContent = '↻ RESTART TO APPLY'; refreshList(); }, 4000);
    } catch (e) { console.error(e); }
  });

  refreshList();
})();

(function setupLimitInputs() {
  const mptEl = document.getElementById('input-max-per-trade');
  const mxEl = document.getElementById('input-max-exposure');
  const slipEl = document.getElementById('input-max-entry-slip');
  const lagEl = document.getElementById('input-paper-latency');
  if (!mptEl || !mxEl) return;
  let lastSaved = { maxPerTradeSol: null, maxSolExposure: null, maxEntrySlippagePct: null, paperLatencyMs: null };
  async function loadLimits() {
    try {
      const r = await fetchJson('/api/limits');
      lastSaved = r;
      if (document.activeElement !== mptEl) mptEl.value = r.maxPerTradeSol;
      if (document.activeElement !== mxEl) mxEl.value = r.maxSolExposure;
      if (slipEl && document.activeElement !== slipEl) slipEl.value = r.maxEntrySlippagePct;
      if (lagEl && document.activeElement !== lagEl) lagEl.value = r.paperLatencyMs;
    } catch {}
  }
  async function saveOne(field, el) {
    const v = parseFloat(el.value);
    if (!isFinite(v) || v < 0) { el.value = lastSaved[field]; return; }
    if (v === lastSaved[field]) return;
    el.style.borderColor = 'var(--yellow)';
    try {
      const res = await fetch('/api/limits', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [field]: v }),
      });
      const r = await res.json();
      if (r.ok) {
        lastSaved[field] = v;
        el.style.borderColor = 'var(--green)';
        setTimeout(() => { el.style.borderColor = 'var(--border)'; }, 1200);
      } else {
        el.style.borderColor = 'var(--pink)';
        el.value = lastSaved[field];
        setTimeout(() => { el.style.borderColor = 'var(--border)'; }, 1500);
      }
    } catch {
      el.style.borderColor = 'var(--pink)';
      el.value = lastSaved[field];
    }
  }
  mptEl.addEventListener('change', () => saveOne('maxPerTradeSol', mptEl));
  mxEl.addEventListener('change', () => saveOne('maxSolExposure', mxEl));
  if (slipEl) slipEl.addEventListener('change', () => saveOne('maxEntrySlippagePct', slipEl));
  if (lagEl) lagEl.addEventListener('change', () => saveOne('paperLatencyMs', lagEl));
  loadLimits();
  setInterval(loadLimits, 10000);
})();

// If the Chart.js CDN can't load (offline / blocked), keep the rest of the app working.
if (typeof Chart === 'undefined') { window.Chart = class { constructor() {} destroy() {} }; }

const DEFAULT_CATEGORIES = [
  { id:'food',       name:'Food',       icon:'🍱', custom:false },
  { id:'travel',     name:'Travel',     icon:'🚌', custom:false },
  { id:'stationary', name:'Stationary', icon:'📚', custom:false },
  { id:'medicine',   name:'Medicine',   icon:'💊', custom:false },
  { id:'clothes',    name:'Clothes',    icon:'👕', custom:false },
];

const CHART_COLORS = [
  '#4f8ef7','#3ecf8e','#f7617a','#f5a623','#a78bfa',
  '#38bdf8','#fb7185','#34d399','#fbbf24','#c084fc',
];

let state = {
  pocketMoney: 0,
  expenses: [],
  manualSavings: [],
  categories: [],
  transactions: [],
  budget: { enabled: false, amount: 0 },
  autoSaving: { enabled: false, amount: 0, day: 1, lastRun: null, lastSkipped: null },
};

let donutChartInstance = null;
let barChartInstance   = null;


// ========================
//  STORAGE: account database on the server + local cache
// ========================
const LEGACY_KEY = 'pocketwise_v3';   // old browser-only storage (kept for one-time import)
let currentUser   = null;   // username while signed in
let serverVersion = 0;      // version of the data last loaded from / saved to the server
let dirty         = false;  // local changes that are not on the server yet
let lastSynced    = null;
let pushTimer     = null;
let pushing       = false;

const API = {
  async req(method, url, body) {
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: method === 'GET' ? undefined : JSON.stringify(body || {})
      });
    } catch (e) {
      const err = new Error(location.protocol === 'file:'
        ? 'This page was opened as a file. Run "npm start" in the PocketWise folder, then open http://localhost:3000 in your browser.'
        : 'Cannot reach the PocketWise server. Make sure it is running ("npm start") and you opened its address, e.g. http://localhost:3000.');
      err.status = 0; throw err;
    }
    let data = {};
    try { data = await res.json(); } catch (e) {}
    if (!res.ok) {
      const notOurServer = !data.error && [404, 405, 501].includes(res.status);
      const err = new Error(data.error || (notOurServer
        ? 'This page is not being served by the PocketWise server (try http://localhost:3000 after "npm start").'
        : 'Request failed (' + res.status + ')'));
      err.status = res.status; err.data = data; throw err;
    }
    return data;
  }
};

function normalizeState(s) {
  s = (s && typeof s === 'object' && !Array.isArray(s)) ? s : {};
  const out = Object.assign({
    pocketMoney: 0, expenses: [], manualSavings: [], categories: [], transactions: [],
    budget: { enabled: false, amount: 0 },
    autoSaving: { enabled: false, amount: 0, day: 1, lastRun: null, lastSkipped: null }
  }, s);
  ['expenses', 'manualSavings', 'transactions', 'categories'].forEach(k => { if (!Array.isArray(out[k])) out[k] = []; });
  if (typeof out.pocketMoney !== 'number' || !isFinite(out.pocketMoney)) out.pocketMoney = 0;
  if (!out.budget) out.budget = { enabled: false, amount: 0 };
  if (!out.autoSaving) out.autoSaving = { enabled: false, amount: 0, day: 1, lastRun: null, lastSkipped: null };
  if (!out.categories.length) out.categories = [...DEFAULT_CATEGORIES];
  DEFAULT_CATEGORIES.forEach(dc => {
    if (!out.categories.find(c => c.id === dc.id)) out.categories.unshift(dc);
  });
  return out;
}

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

// ---- local cache (per user, so the app still opens offline) ----
function cacheKey() { return currentUser ? 'pocketwise_cache_' + currentUser.toLowerCase() : null; }
function writeCache() {
  const k = cacheKey(); if (!k) return;
  try { localStorage.setItem(k, JSON.stringify({ data: state, version: serverVersion, dirty })); } catch (e) {}
}
function readCache() {
  const k = cacheKey(); if (!k) return null;
  try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; }
}
function readLegacy() {
  try { return JSON.parse(localStorage.getItem(LEGACY_KEY)); } catch (e) { return null; }
}

// ---- sync status shown in the sidebar ----
function setSyncStatus(kind) {
  const el = document.getElementById('syncStatus');
  const info = document.getElementById('accSyncInfo');
  const map = {
    synced:  ['☁ Synced',              'sync-status synced'],
    pending: ['⏳ Saving…',            'sync-status pending'],
    offline: ['⚠ Offline – will retry', 'sync-status offline'],
    none:    ['☁ …',                   'sync-status']
  };
  const [text, cls] = map[kind] || map.none;
  if (el) { el.textContent = text; el.className = cls; }
  if (info) {
    info.textContent = kind === 'synced'
      ? 'All changes are saved to your account' + (lastSynced ? ' · ' + new Date(lastSynced).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '')
      : kind === 'pending' ? 'Saving changes…'
      : kind === 'offline' ? 'Cannot reach the server. Changes are kept on this device and will upload automatically.'
      : '';
  }
}

// Every part of the app calls saveState() after changing `state`.
function saveState() {
  if (!currentUser) return;
  dirty = true;
  writeCache();
  setSyncStatus('pending');
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushToServer, 600);
}

async function pushToServer() {
  if (!currentUser || pushing || !dirty) return;
  clearTimeout(pushTimer);
  pushing = true;
  const sentJson = JSON.stringify(state);
  try {
    const r = await API.req('PUT', '/api/data', { data: JSON.parse(sentJson), baseVersion: serverVersion });
    serverVersion = r.version;
    lastSynced = Date.now();
    dirty = JSON.stringify(state) !== sentJson;   // changed again while we were saving?
    writeCache();
    setSyncStatus(dirty ? 'pending' : 'synced');
    if (dirty) pushTimer = setTimeout(pushToServer, 300);
  } catch (e) {
    if (e.status === 409) {
      // another device saved first: take its version so nothing is silently overwritten
      try {
        applyServerData(await API.req('GET', '/api/data'));
        renderAll();
        showToast('Your data was changed on another device and has been refreshed. Please repeat your last change.', 'warning');
      } catch (e2) { setSyncStatus('offline'); }
    } else if (e.status === 401) {
      sessionExpired();
    } else {
      setSyncStatus('offline');
      pushTimer = setTimeout(pushToServer, 15000);
    }
  } finally {
    pushing = false;
  }
}

function applyServerData(r) {
  state = normalizeState(r.data);
  serverVersion = r.version || 0;
  dirty = false;
  lastSynced = Date.now();
  writeCache();
  setSyncStatus('synced');
}

// Pick up changes made on another device
async function pullIfNewer() {
  if (!currentUser || dirty || pushing) return;
  try {
    const r = await API.req('GET', '/api/data');
    if (dirty || pushing) return;               // user edited while we were fetching
    if (r.version > serverVersion) {
      applyServerData(r); renderAll();
      showToast('Synced changes from another device.', 'info');
    } else {
      lastSynced = Date.now(); setSyncStatus('synced');
    }
  } catch (e) {
    if (e.status === 401) sessionExpired(); else setSyncStatus('offline');
  }
}



function totalExpenses()      { return state.expenses.reduce((s,e) => s + e.amount, 0); }
function totalManualSavings() { return state.manualSavings.reduce((s,v) => s + v.amount, 0); }
// Available balance = pocket money - expenses - manual savings
function availableBalance()   { return state.pocketMoney - totalExpenses() - totalManualSavings(); }

function fmt(n) {
  return '₹' + parseFloat(n || 0).toLocaleString('en-IN', { minimumFractionDigits:2, maximumFractionDigits:2 });
}
function fmtShort(n) {
  const v = parseFloat(n || 0);
  if (v >= 100000) return '₹' + (v/100000).toFixed(1) + 'L';
  if (v >= 1000)   return '₹' + (v/1000).toFixed(1) + 'K';
  return fmt(v);
}
function fmtDate(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('en-IN', { day:'2-digit', month:'short', year:'numeric' });
}
function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2,6); }
function today() { return new Date().toISOString().split('T')[0]; }

function getCategoryTotals() {
  const t = {};
  state.expenses.forEach(e => {
    if (!t[e.categoryId]) {
      const cat = state.categories.find(c => c.id === e.categoryId);
      t[e.categoryId] = { amount:0, count:0, icon:cat?.icon || '📦', name:cat?.name || e.categoryId };
    }
    t[e.categoryId].amount += e.amount;
    t[e.categoryId].count++;
  });
  return t;
}

// ========================
//  TOAST
// ========================
let toastTimer = null;
function showToast(msg, type = 'info') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast ${type} show`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

// ========================
//  RENDER ALL
// ========================
function renderAll() {
  renderSidebar();
  renderDashboard();
  renderExpenses();
  renderSavings();
  renderCharts();
  renderHistory();
  populateCategorySelect();
  populateFilterSelect();
}

// ========================
//  SIDEBAR
// ========================
function renderSidebar() {
  const avail   = availableBalance();
  const spent   = totalExpenses();
  const pocket  = state.pocketMoney;
  const saved   = totalManualSavings();
  const spentPct = pocket > 0 ? Math.min((spent / pocket) * 100, 100) : 0;

  document.getElementById('balanceDisplay').textContent = fmt(avail);
  document.getElementById('sidebarPocket').textContent  = fmtShort(pocket);
  document.getElementById('sidebarSpent').textContent   = fmtShort(spent);
  document.getElementById('sfSaved').textContent        = fmt(saved);
  document.getElementById('sfRemaining').textContent    = fmt(avail);

  // Health ring
  const circumference = 201;
  const offset = circumference - (spentPct / 100) * circumference;
  const ring   = document.getElementById('healthRingFill');
  ring.style.strokeDashoffset = offset;
  ring.className = 'ring-fill' + (spentPct >= 100 ? ' danger' : spentPct >= 80 ? ' warn' : '');
  document.getElementById('healthPct').textContent = Math.round(spentPct) + '%';
}

// ========================
//  DASHBOARD
// ========================
function renderDashboard() {
  const pocket  = state.pocketMoney;
  const spent   = totalExpenses();
  const saved   = totalManualSavings();
  const avail   = availableBalance();
  const spentPct = pocket > 0 ? Math.min((spent / pocket) * 100, 100) : 0;
  const availPct = pocket > 0 ? ((avail / pocket) * 100).toFixed(0) : 0;

  document.getElementById('dashPocket').textContent    = fmt(pocket);
  document.getElementById('dashSpent').textContent     = fmt(spent);
  document.getElementById('dashSaved').textContent     = fmt(saved);
  document.getElementById('dashRemaining').textContent = fmt(avail);
  document.getElementById('spentBarFill').style.width  = spentPct + '%';
  document.getElementById('remainingPctLabel').textContent = availPct + '% of total left';

  // Budget alert banner
  const banner = document.getElementById('alertBanner');
  if (state.budget.enabled && state.budget.amount > 0) {
    const budgetPct = (spent / state.budget.amount) * 100;
    if (budgetPct >= 100) {
      banner.style.display = 'flex';
      banner.className = 'alert-banner danger';
      banner.textContent = `🚨 You've exceeded your budget of ${fmt(state.budget.amount)}! Spent: ${fmt(spent)}`;
    } else if (budgetPct >= 80) {
      banner.style.display = 'flex';
      banner.className = 'alert-banner warn';
      banner.textContent = `⚠️ You've used ${Math.round(budgetPct)}% of your ₹${state.budget.amount} budget. Slow down!`;
    } else {
      banner.style.display = 'none';
    }
  } else {
    banner.style.display = 'none';
  }

  // Category bars
  const container = document.getElementById('categoryBars');
  const totals = getCategoryTotals();
  const totalSpent = spent;
  if (totalSpent === 0) {
    container.innerHTML = '<p class="empty-msg">No expenses yet.</p>';
  } else {
    container.innerHTML = '';
    Object.entries(totals).sort((a,b) => b[1].amount - a[1].amount).forEach(([,data]) => {
      const pct = ((data.amount / totalSpent) * 100).toFixed(1);
      const div = document.createElement('div');
      div.className = 'category-bar-item';
      div.innerHTML = `
        <div class="category-bar-header">
          <span>${esc(data.icon)} ${esc(data.name)}</span>
          <span>${fmt(data.amount)} <span class="category-bar-pct">(${pct}%)</span></span>
        </div>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>`;
      container.appendChild(div);
    });
  }

  // All expenses list
  const list = document.getElementById('dashExpenseList');
  document.getElementById('txnCountBadge').textContent = state.expenses.length;
  if (state.expenses.length === 0) {
    list.innerHTML = '<li class="empty-msg">No expenses yet.</li>';
  } else {
    list.innerHTML = '';
    [...state.expenses].reverse().forEach(exp => {
      const cat = state.categories.find(c => c.id === exp.categoryId);
      list.appendChild(makeExpenseItem(exp, cat));
    });
  }
}

// ========================
//  EXPENSES TAB
// ========================
function renderExpenses() {
  const grid   = document.getElementById('categoriesGrid');
  const totals = getCategoryTotals();
  const totalSpent = totalExpenses();
  grid.innerHTML = '';
  state.categories.forEach(cat => {
    grid.appendChild(makeCategoryCard(cat, totals[cat.id], totalSpent));
  });

  const customList = document.getElementById('customCatsList');
  const customs = state.categories.filter(c => c.custom);
  if (!customs.length) {
    customList.innerHTML = '<p class="empty-msg">No custom categories yet.</p>';
  } else {
    customList.innerHTML = '';
    customs.forEach(cat => {
      const chip = document.createElement('div');
      chip.className = 'custom-cat-chip';
      chip.innerHTML = `<span>${esc(cat.icon)}</span><span>${esc(cat.name)}</span>
        <button title="Delete">✕</button>`;
      chip.querySelector('button').addEventListener('click', () => deleteCategory(cat.id));
      customList.appendChild(chip);
    });
  }
}

function makeCategoryCard(cat, data, totalSpent) {
  const card = document.createElement('div');
  card.className = 'category-card';
  const amount = data?.amount || 0;
  const count  = data?.count  || 0;
  const pct    = totalSpent > 0 ? (amount / totalSpent) * 100 : 0;
  card.innerHTML = `
    <div class="cat-icon">${esc(cat.icon)}</div>
    <div class="cat-name">${esc(cat.name)}</div>
    <div class="cat-amount">${fmt(amount)}</div>
    <div class="cat-count">${count} transaction${count !== 1 ? 's' : ''}</div>
    <div class="cat-budget-bar"><div class="cat-budget-fill" style="width:${pct.toFixed(1)}%"></div></div>`;
  card.addEventListener('click', () => {
    document.getElementById('expenseCategorySelect').value = cat.id;
    updateBalanceHint();
    openModal('expenseModal');
  });
  return card;
}

// ========================
//  SAVINGS TAB
// ========================
function renderSavings() {
  const saved = totalManualSavings();
  const avail = availableBalance();
  document.getElementById('totalSavingsDisplay').textContent     = fmt(saved);
  document.getElementById('savingsRemainingDisplay').textContent = fmt(avail);
  renderAutoSaving();

  const list = document.getElementById('savingsHistoryList');
  if (!state.manualSavings.length) {
    list.innerHTML = '<li class="empty-msg">No savings entries yet.</li>';
    return;
  }
  list.innerHTML = '';
  [...state.manualSavings].reverse().forEach(s => {
    const li = document.createElement('li');
    li.className = 'txn-item';
    li.innerHTML = `
      <div class="txn-left">
        <div class="txn-icon green-bg">💰</div>
        <div>
          <div class="txn-name">${esc(s.note || 'Manual Saving')}</div>
          <div class="txn-date">${fmtDate(s.date)}</div>
        </div>
      </div>
      <div class="txn-right">
        <div class="txn-amount saving">+${fmt(s.amount)}</div>
        <div class="saving-actions">
          <button class="btn-edit-save" title="Edit this saving entry">✏️</button>
          <button class="btn-withdraw" title="Withdraw some amount back to balance">↩ Use</button>
          <button class="btn-delete" title="Delete entire saving entry">🗑</button>
        </div>
      </div>`;

    // Edit
    li.querySelector('.btn-edit-save').addEventListener('click', () => openEditSavingModal(s));

    // Withdraw
    li.querySelector('.btn-withdraw').addEventListener('click', () => openWithdrawSavingModal(s));

    // Delete
    li.querySelector('.btn-delete').addEventListener('click', () => {
      if (!confirm(`Delete entire saving entry of ${fmt(s.amount)}?\nThis amount will be returned to your available balance.`)) return;
      state.manualSavings    = state.manualSavings.filter(sv => sv.id !== s.id);
      state.transactions     = state.transactions.filter(t  => t.refId !== s.id);
      saveState(); renderAll();
      showToast(`${fmt(s.amount)} saving deleted. Balance restored.`, 'info');
    });

    list.appendChild(li);
  });
}

// ========================
//  CHARTS
// ========================
function renderCharts() {
  const totals  = getCategoryTotals();
  const entries = Object.entries(totals).sort((a,b) => b[1].amount - a[1].amount);
  const total   = totalExpenses();

  document.getElementById('donutTotalVal').textContent = fmt(total);

  if (!entries.length) {
    if (donutChartInstance) { donutChartInstance.destroy(); donutChartInstance = null; }
    if (barChartInstance)   { barChartInstance.destroy();   barChartInstance   = null; }
    document.getElementById('donutLegend').innerHTML  = '<p class="empty-msg" style="margin:0">No data yet.</p>';
    document.getElementById('summaryTable').innerHTML = '<p class="empty-msg">No expenses to summarize.</p>';
    return;
  }

  const labels  = entries.map(([,d]) => d.icon + ' ' + d.name);
  const amounts = entries.map(([,d]) => d.amount);
  const colors  = entries.map((_,i) => CHART_COLORS[i % CHART_COLORS.length]);

  // Donut
  const dCtx = document.getElementById('donutChart').getContext('2d');
  if (donutChartInstance) donutChartInstance.destroy();
  donutChartInstance = new Chart(dCtx, {
    type: 'doughnut',
    data: { labels, datasets: [{ data: amounts, backgroundColor: colors, borderColor: '#16181f', borderWidth: 3, hoverOffset: 6 }] },
    options: {
      cutout: '68%',
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: ctx => {
          const pct = total > 0 ? ((ctx.raw / total) * 100).toFixed(1) : 0;
          return ` ${fmt(ctx.raw)} (${pct}%)`;
        }}}
      },
      animation: { animateRotate: true, duration: 600 }
    }
  });

  // Legend
  const legend = document.getElementById('donutLegend');
  legend.innerHTML = '';
  entries.forEach(([,data], i) => {
    const pct = total > 0 ? ((data.amount / total) * 100).toFixed(1) : 0;
    const item = document.createElement('div');
    item.className = 'legend-item';
    item.innerHTML = `<div class="legend-dot" style="background:${colors[i]}"></div><span>${esc(data.icon)} ${esc(data.name)} ${pct}%</span>`;
    legend.appendChild(item);
  });

  // Bar
  const bCtx = document.getElementById('barChart').getContext('2d');
  if (barChartInstance) barChartInstance.destroy();
  barChartInstance = new Chart(bCtx, {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Amount Spent', data: amounts,
        backgroundColor: colors.map(c => c + 'bb'),
        borderColor: colors, borderWidth: 2,
        borderRadius: 6, borderSkipped: false,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: ctx => ' ' + fmt(ctx.raw) } } },
      scales: {
        x: { ticks: { color:'#7a7f96', font:{ size:11 } }, grid: { color:'#2a2d3a' } },
        y: { ticks: { color:'#7a7f96', font:{ size:11 }, callback: v => '₹' + v.toLocaleString('en-IN') }, grid: { color:'#2a2d3a' } }
      },
      animation: { duration: 600 }
    }
  });

  // Summary table
  const rows = entries.map(([,data], i) => {
    const pct = total > 0 ? ((data.amount / total) * 100).toFixed(1) : 0;
    return `<tr>
      <td><span style="color:${colors[i]}">${esc(data.icon)}</span> ${esc(data.name)}</td>
      <td style="color:var(--rose);font-weight:600">${fmt(data.amount)}</td>
      <td>${data.count}</td>
      <td class="pct-bar-cell">
        <div style="display:flex;align-items:center;gap:8px">
          <div class="pct-bar-wrap" style="flex:1"><div class="pct-bar-inner" style="width:${pct}%;background:${colors[i]}"></div></div>
          <span style="font-size:12px;color:var(--text-muted);min-width:36px">${pct}%</span>
        </div>
      </td>
    </tr>`;
  }).join('');
  document.getElementById('summaryTable').innerHTML = `
    <table class="sum-table">
      <thead><tr><th>Category</th><th>Amount</th><th>Transactions</th><th>Share</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

// ========================
//  HISTORY
// ========================
function renderHistory() {
  const filterCat  = document.getElementById('filterCategory').value || 'all';
  const filterType = document.getElementById('filterType').value || 'all';
  const list = document.getElementById('historyList');
  let txns = [...state.transactions].reverse();
  if (filterCat  !== 'all') txns = txns.filter(t => t.categoryId === filterCat);
  if (filterType !== 'all') txns = txns.filter(t => t.type === filterType);
  if (!txns.length) {
    list.innerHTML = '<li class="empty-msg">No transactions match.</li>';
  } else {
    list.innerHTML = '';
    txns.forEach(txn => list.appendChild(makeHistoryItem(txn)));
  }
}

// ========================
//  ITEM BUILDERS
// ========================
function makeExpenseItem(exp, cat) {
  const li = document.createElement('li');
  li.className = 'txn-item';
  li.innerHTML = `
    <div class="txn-left">
      <div class="txn-icon rose-bg">${esc(cat?.icon || '💸')}</div>
      <div>
        <div class="txn-name">${esc(exp.desc || cat?.name || 'Expense')}</div>
        <div class="txn-date">${esc(cat?.name || '')} · ${fmtDate(exp.date)}</div>
      </div>
    </div>
    <div class="txn-right">
      <div class="txn-amount negative">-${fmt(exp.amount)}</div>
      <button class="btn-delete" title="Delete expense">🗑</button>
    </div>`;
  li.querySelector('.btn-delete').addEventListener('click', e => { e.stopPropagation(); deleteExpense(exp.id); });
  return li;
}

function makeHistoryItem(txn) {
  const li = document.createElement('li');
  li.className = 'txn-item';
  const isExpense = txn.type === 'expense';
  const isSaving  = txn.type === 'saving';
  const amtClass  = isExpense ? 'negative' : isSaving ? 'saving' : 'positive';
  const prefix    = isExpense ? '-' : '+';
  const iconBg    = isExpense ? 'rose-bg' : isSaving ? 'green-bg' : '';
  li.innerHTML = `
    <div class="txn-left">
      <div class="txn-icon ${iconBg}">${esc(txn.icon || '💸')}</div>
      <div>
        <div class="txn-name">${esc(txn.desc || '')}</div>
        <div class="txn-date">${txn.category ? esc(txn.category) + ' · ' : ''}${fmtDate(txn.date)}</div>
      </div>
    </div>
    <div class="txn-right">
      <div class="txn-amount ${amtClass}">${prefix}${fmt(txn.amount)}</div>
      ${isExpense ? `<button class="btn-delete" title="Delete">🗑</button>` : ''}
    </div>`;
  if (isExpense) {
    li.querySelector('.btn-delete').addEventListener('click', e => { e.stopPropagation(); deleteExpense(txn.refId); });
  }
  return li;
}

// ========================
//  DELETE
// ========================
function deleteExpense(expId) {
  if (!confirm('Delete this expense? Your balance will be restored.')) return;
  state.expenses     = state.expenses.filter(e => e.id !== expId);
  state.transactions = state.transactions.filter(t => t.refId !== expId && t.id !== expId);
  saveState(); renderAll();
  showToast('Expense deleted. Balance updated.', 'success');
}

function deleteCategory(catId) {
  if (!confirm('Delete this custom category?')) return;
  state.categories = state.categories.filter(c => c.id !== catId);
  saveState(); renderAll();
  showToast('Category deleted.', 'info');
}

// ========================
//  SELECTS
// ========================
function populateCategorySelect() {
  const sel = document.getElementById('expenseCategorySelect');
  const cur = sel.value;
  sel.innerHTML = '';
  state.categories.forEach(cat => {
    const opt = document.createElement('option');
    opt.value = cat.id; opt.textContent = `${cat.icon} ${cat.name}`;
    sel.appendChild(opt);
  });
  if (cur) sel.value = cur;
}

function populateFilterSelect() {
  const sel = document.getElementById('filterCategory');
  const cur = sel.value;
  sel.innerHTML = '<option value="all">All Categories</option>';
  state.categories.forEach(cat => {
    const opt = document.createElement('option');
    opt.value = cat.id; opt.textContent = `${cat.icon} ${cat.name}`;
    sel.appendChild(opt);
  });
  if (cur) sel.value = cur;
}

// ========================
//  BALANCE HINT (in expense modal)
// ========================
function updateBalanceHint() {
  const hint = document.getElementById('balanceHint');
  const avail = availableBalance();
  hint.textContent = `Available balance: ${fmt(avail)}`;
  hint.style.color = avail < 0 ? 'var(--rose)' : 'var(--text-muted)';
}

// ========================
//  MODALS
// ========================
function openModal(id)  { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

document.querySelectorAll('.modal-overlay').forEach(o => {
  o.addEventListener('click', e => { if (e.target === o) o.classList.remove('open'); });
});
document.querySelectorAll('[data-close]').forEach(btn => {
  btn.addEventListener('click', () => closeModal(btn.dataset.close));
});

// ========================
//  EDIT / RESET POCKET MONEY
// ========================
document.getElementById('openEditMoneyModal').addEventListener('click', () => {
  const input = document.getElementById('editMoneyInput');
  const hint  = document.getElementById('editMoneyHint');
  input.value = state.pocketMoney || '';
  const spent = totalExpenses();
  const saved = totalManualSavings();
  hint.innerHTML =
    `Current pocket money: <strong style="color:var(--blue)">${fmt(state.pocketMoney)}</strong><br>
     Total expenses: <strong style="color:var(--rose)">${fmt(spent)}</strong><br>
     Manual savings: <strong style="color:var(--amber)">${fmt(saved)}</strong><br>
     New available balance will be: <strong style="color:var(--green)" id="hintNewBal">${fmt(state.pocketMoney - spent - saved)}</strong>`;
  openModal('editMoneyModal');
});

document.getElementById('editMoneyInput').addEventListener('input', () => {
  const val   = parseFloat(document.getElementById('editMoneyInput').value) || 0;
  const spent = totalExpenses();
  const saved = totalManualSavings();
  const newBal = val - spent - saved;
  const el = document.getElementById('hintNewBal');
  if (el) {
    el.textContent = fmt(newBal);
    el.style.color = newBal < 0 ? 'var(--rose)' : 'var(--green)';
  }
});

document.getElementById('confirmEditMoney').addEventListener('click', () => {
  const val = parseFloat(document.getElementById('editMoneyInput').value);
  if (isNaN(val) || val < 0) return showToast('Please enter a valid amount.', 'error');
  const old = state.pocketMoney;
  state.pocketMoney = val;
  // Log the correction in transactions
  state.transactions.push({
    id: genId(), type: 'income',
    amount: val - old,
    desc: `Pocket money corrected (${old < val ? '+' : ''}${fmt(val - old)})`,
    icon: '✏️', date: today()
  });
  saveState(); renderAll(); closeModal('editMoneyModal');
  showToast(`Pocket money updated to ${fmt(val)}`, 'success');
});

document.getElementById('resetPocketMoney').addEventListener('click', () => {
  if (!confirm('Reset pocket money to ₹0?\n\nThis will clear your pocket money total but keep all expense and savings records.')) return;
  state.pocketMoney = 0;
  state.transactions.push({ id: genId(), type: 'income', amount: 0, desc: 'Pocket money reset to ₹0', icon: '🔄', date: today() });
  saveState(); renderAll();
  showToast('Pocket money reset to ₹0.', 'info');
});

// ========================
//  ADD MONEY
// ========================
document.getElementById('openAddMoneyModal').addEventListener('click', () => {
  document.getElementById('moneyInput').value = '';
  document.getElementById('moneyNote').value  = '';
  openModal('addMoneyModal');
});
document.getElementById('confirmAddMoney').addEventListener('click', () => {
  const amt  = parseFloat(document.getElementById('moneyInput').value);
  const note = document.getElementById('moneyNote').value.trim();
  if (!amt || amt <= 0) return showToast('Enter a valid amount.', 'error');
  state.pocketMoney += amt;
  state.transactions.push({ id:genId(), type:'income', amount:amt, desc:note || 'Pocket Money Added', icon:'💵', date:today() });
  saveState(); renderAll(); closeModal('addMoneyModal');
  showToast(`₹${amt.toLocaleString('en-IN')} added to your pocket!`, 'success');
});

// ========================
//  ADD EXPENSE
// ========================
function openExpenseModal() {
  document.getElementById('expenseAmount').value = '';
  document.getElementById('expenseDesc').value   = '';
  document.getElementById('expenseDate').value   = today();
  updateBalanceHint();
  openModal('expenseModal');
}
document.getElementById('openExpenseModal').addEventListener('click', openExpenseModal);
document.getElementById('dashAddExpenseBtn').addEventListener('click', openExpenseModal);
document.getElementById('expenseAmount').addEventListener('input', updateBalanceHint);

document.getElementById('confirmExpense').addEventListener('click', () => {
  const catId = document.getElementById('expenseCategorySelect').value;
  const amt   = parseFloat(document.getElementById('expenseAmount').value);
  const desc  = document.getElementById('expenseDesc').value.trim();
  const date  = document.getElementById('expenseDate').value || today();
  if (!amt || amt <= 0) return showToast('Enter a valid amount.', 'error');
  const avail = availableBalance();
  if (amt > avail) {
    if (!confirm(`⚠️ This exceeds your available balance of ${fmt(avail)}.\n\nYour balance will go negative. Continue?`)) return;
  }
  const cat   = state.categories.find(c => c.id === catId);
  const expId = genId();
  state.expenses.push({ id:expId, categoryId:catId, amount:amt, desc:desc || cat?.name || 'Expense', date });
  state.transactions.push({ id:genId(), refId:expId, type:'expense', amount:amt, desc:desc || cat?.name || 'Expense', categoryId:catId, category:cat?.name || catId, icon:cat?.icon || '💸', date });
  saveState(); renderAll(); closeModal('expenseModal');

  const newAvail = availableBalance();
  const msg = newAvail < 0
    ? `Expense added! ⚠️ Balance is now ${fmt(newAvail)}`
    : `Expense added! Balance: ${fmt(newAvail)} remaining.`;
  showToast(msg, newAvail < 0 ? 'warning' : 'success');

  // Budget check after adding
  if (state.budget.enabled && state.budget.amount > 0) {
    const budgetPct = (totalExpenses() / state.budget.amount) * 100;
    if (budgetPct >= 100) showToast('🚨 Budget exceeded!', 'error');
    else if (budgetPct >= 80) showToast(`⚠️ ${Math.round(budgetPct)}% of budget used.`, 'warning');
  }
});

// ========================
//  SET BUDGET
// ========================
document.getElementById('openBudgetModal').addEventListener('click', () => {
  document.getElementById('budgetInput').value   = state.budget.amount || '';
  document.getElementById('budgetEnabled').checked = state.budget.enabled;
  openModal('budgetModal');
});
document.getElementById('confirmBudget').addEventListener('click', () => {
  const amt     = parseFloat(document.getElementById('budgetInput').value);
  const enabled = document.getElementById('budgetEnabled').checked;
  state.budget = { enabled, amount: amt || 0 };
  saveState(); renderAll(); closeModal('budgetModal');
  showToast(enabled ? `Budget set to ${fmt(amt)}.` : 'Budget disabled.', 'info');
});

// ========================
//  ADD CATEGORY
// ========================
document.getElementById('openCategoryModal').addEventListener('click', () => {
  document.getElementById('newCategoryName').value = '';
  document.getElementById('newCategoryIcon').value = '';
  openModal('categoryModal');
});
document.getElementById('confirmCategory').addEventListener('click', () => {
  const name = document.getElementById('newCategoryName').value.trim();
  const icon = document.getElementById('newCategoryIcon').value.trim() || '📦';
  if (!name) return showToast('Enter a category name.', 'error');
  if (state.categories.find(c => c.name.toLowerCase() === name.toLowerCase())) return showToast('Category already exists.', 'error');
  const id = name.toLowerCase().replace(/\s+/g,'_') + '_' + genId();
  state.categories.push({ id, name, icon, custom:true });
  saveState(); renderAll(); closeModal('categoryModal');
  showToast(`"${name}" category added!`, 'success');
});

// ========================
//  WITHDRAW FROM SAVING
// ========================
let _withdrawTargetId = null;
let _withdrawMax      = 0;

function openWithdrawSavingModal(s) {
  _withdrawTargetId = s.id;
  _withdrawMax      = s.amount;
  document.getElementById('withdrawSavingAmount').value = '';
  document.getElementById('withdrawSavingDesc').innerHTML =
    `Saving: <strong style="color:var(--amber)">${esc(s.note || 'Manual Saving')}</strong> &nbsp;|&nbsp; Saved: <strong style="color:var(--green)">${fmt(s.amount)}</strong>`;
  document.getElementById('withdrawHint').textContent =
    `Max you can withdraw: ${fmt(s.amount)}. The amount returns to your available balance.`;
  openModal('withdrawSavingModal');
}

document.getElementById('withdrawSavingAmount').addEventListener('input', () => {
  const val  = parseFloat(document.getElementById('withdrawSavingAmount').value) || 0;
  const hint = document.getElementById('withdrawHint');
  if (val > _withdrawMax) {
    hint.textContent = `⚠️ Max you can withdraw is ${fmt(_withdrawMax)}.`;
    hint.style.color = 'var(--rose)';
  } else {
    hint.textContent = `After withdrawal, ${fmt(_withdrawMax - val)} will remain in this saving.`;
    hint.style.color = 'var(--text-muted)';
  }
});

document.getElementById('confirmWithdrawSaving').addEventListener('click', () => {
  const amt = parseFloat(document.getElementById('withdrawSavingAmount').value);
  if (!amt || amt <= 0)     return showToast('Enter a valid amount.', 'error');
  if (amt > _withdrawMax)   return showToast(`Max withdrawal is ${fmt(_withdrawMax)}.`, 'error');

  const saving = state.manualSavings.find(s => s.id === _withdrawTargetId);
  if (!saving) return;

  if (amt === saving.amount) {
    // Full withdrawal — remove the entry
    state.manualSavings    = state.manualSavings.filter(s => s.id !== _withdrawTargetId);
    state.transactions     = state.transactions.filter(t => t.refId !== _withdrawTargetId);
  } else {
    // Partial withdrawal — reduce the amount
    saving.amount -= amt;
    // Update transaction log too
    const txn = state.transactions.find(t => t.refId === _withdrawTargetId && t.type === 'saving');
    if (txn) txn.amount = saving.amount;
  }

  // Log the withdrawal in history
  state.transactions.push({
    id: genId(), type: 'income', amount: amt,
    desc: `Withdrawal from savings: ${saving?.note || 'Manual Saving'}`,
    icon: '↩️', date: today()
  });

  saveState(); renderAll(); closeModal('withdrawSavingModal');
  showToast(`${fmt(amt)} withdrawn from savings. Balance updated! ↩️`, 'success');
});

// ========================
//  EDIT SAVING ENTRY
// ========================
let _editSavingTargetId = null;

function openEditSavingModal(s) {
  _editSavingTargetId = s.id;
  document.getElementById('editSavingAmount').value = s.amount;
  document.getElementById('editSavingNote').value   = s.note || '';
  const avail = availableBalance();
  document.getElementById('editSavingHint').innerHTML =
    `Current saved amount: <strong style="color:var(--amber)">${fmt(s.amount)}</strong><br>
     Available balance: <strong style="color:var(--blue)">${fmt(avail)}</strong><br>
     You can increase by up to <strong style="color:var(--green)">${fmt(avail)}</strong> more.`;
  openModal('editSavingModal');
}

document.getElementById('editSavingAmount').addEventListener('input', () => {
  const saving  = state.manualSavings.find(s => s.id === _editSavingTargetId);
  if (!saving) return;
  const newAmt  = parseFloat(document.getElementById('editSavingAmount').value) || 0;
  const diff    = newAmt - saving.amount; // positive = need more from balance, negative = returns to balance
  const avail   = availableBalance();
  const hint    = document.getElementById('editSavingHint');
  if (diff > avail) {
    hint.innerHTML = `⚠️ Not enough balance. You can increase by at most <strong style="color:var(--rose)">${fmt(avail)}</strong>.`;
  } else if (diff > 0) {
    hint.innerHTML = `${fmt(diff)} will be moved from your balance to savings.`;
  } else if (diff < 0) {
    hint.innerHTML = `${fmt(Math.abs(diff))} will be returned to your available balance.`;
  } else {
    hint.innerHTML = `No change in amount.`;
  }
});

document.getElementById('confirmEditSaving').addEventListener('click', () => {
  const newAmt  = parseFloat(document.getElementById('editSavingAmount').value);
  const newNote = document.getElementById('editSavingNote').value.trim();
  if (isNaN(newAmt) || newAmt <= 0) return showToast('Enter a valid amount.', 'error');

  const saving = state.manualSavings.find(s => s.id === _editSavingTargetId);
  if (!saving) return;

  const diff  = newAmt - saving.amount;
  const avail = availableBalance();
  if (diff > avail) return showToast(`Not enough balance. Max increase: ${fmt(avail)}.`, 'error');

  saving.amount = newAmt;
  saving.note   = newNote || saving.note;

  // Update the transaction log
  const txn = state.transactions.find(t => t.refId === _editSavingTargetId && t.type === 'saving');
  if (txn) { txn.amount = newAmt; txn.desc = newNote || txn.desc; }

  saveState(); renderAll(); closeModal('editSavingModal');
  showToast(`Saving updated to ${fmt(newAmt)}. ✏️`, 'success');
});

// ========================
//  MANUAL SAVINGS
// ========================
document.getElementById('openManualSavingModal').addEventListener('click', () => {
  document.getElementById('manualSavingAmount').value = '';
  document.getElementById('manualSavingNote').value   = '';
  const hint = document.getElementById('savingHint');
  hint.textContent = `Available to save: ${fmt(availableBalance())}`;
  openModal('manualSavingModal');
});
document.getElementById('confirmManualSaving').addEventListener('click', () => {
  const amt  = parseFloat(document.getElementById('manualSavingAmount').value);
  const note = document.getElementById('manualSavingNote').value.trim();
  if (!amt || amt <= 0) return showToast('Enter a valid amount.', 'error');
  const avail = availableBalance();
  if (amt > avail) return showToast(`Only ${fmt(avail)} is available to save.`, 'error');
  const savId = genId();
  const entry = { id:savId, amount:amt, note:note || 'Manual Saving', date:today() };
  state.manualSavings.push(entry);
  state.transactions.push({ id:genId(), refId:savId, type:'saving', amount:amt, desc:note || 'Manual Saving', icon:'💰', date:today() });
  saveState(); renderAll(); closeModal('manualSavingModal');
  showToast(`${fmt(amt)} saved successfully! 💰`, 'success');
});

// ========================
//  AUTO MONTHLY SAVING
// ========================
function localDateStr(d = new Date()) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function monthKey(d = new Date()) { return localDateStr(d).slice(0, 7); }
// Day of month the deduction is due in the month of `d` (clamped to the month's length)
function autoDueDay(d = new Date()) {
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  return Math.min(state.autoSaving.day || 1, lastDay);
}

// Runs on load, every minute, and when the tab becomes visible again.
// Deducts once per month, on/after the chosen day, if the balance covers it.
function processAutoSaving() {
  if (!currentUser) return false;
  const a = state.autoSaving;
  if (!a || !a.enabled || !(a.amount > 0)) return false;
  const now = new Date();
  const key = monthKey(now);
  if (a.lastRun === key) return false;                 // already done this month
  if (now.getDate() < autoDueDay(now)) return false;   // not due yet

  if (availableBalance() < a.amount) {
    // Not enough balance: skip for now, keep retrying silently; warn once per month.
    if (a.lastSkipped !== key) {
      a.lastSkipped = key;
      saveState(); renderAll();
      showToast(`Auto saving of ${fmt(a.amount)} skipped: not enough balance. It will retry automatically.`, 'warning');
    }
    return false;
  }

  const label = now.toLocaleDateString('en-IN', { month: 'short', year: 'numeric' });
  const savId = genId();
  const date  = localDateStr(now);
  const note  = `Auto Saving · ${label}`;
  state.manualSavings.push({ id: savId, amount: a.amount, note, date, auto: true });
  state.transactions.push({ id: genId(), refId: savId, type: 'saving', amount: a.amount, desc: note, icon: '🔁', date });
  a.lastRun = key;
  a.lastSkipped = null;
  saveState(); renderAll();
  showToast(`${fmt(a.amount)} auto-saved for ${label}. 🔁`, 'success');
  return true;
}

function nextAutoSavingDate() {
  const a = state.autoSaving;
  const now = new Date();
  const thisMonthDue = new Date(now.getFullYear(), now.getMonth(), autoDueDay(now));
  if (a.lastRun !== monthKey(now)) return thisMonthDue;   // still pending this month
  const nextBase = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  return new Date(nextBase.getFullYear(), nextBase.getMonth(), autoDueDay(nextBase));
}

function renderAutoSaving() {
  const a     = state.autoSaving;
  const badge = document.getElementById('autoSavingBadge');
  const desc  = document.getElementById('autoSavingDesc');
  const meta  = document.getElementById('autoSavingMeta');
  if (!badge) return;

  if (!a.enabled || !(a.amount > 0)) {
    badge.textContent = 'Off'; badge.className = 'auto-badge off';
    desc.textContent  = 'Automatically move a fixed amount into savings every month.';
    meta.style.display = 'none';
    return;
  }
  badge.textContent = 'On'; badge.className = 'auto-badge on';
  desc.textContent  = `${fmt(a.amount)} is saved automatically on day ${a.day} of every month.`;

  const next = nextAutoSavingDate().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  const key  = monthKey();
  const pending = a.lastRun !== key && new Date().getDate() >= autoDueDay();
  const yearly = a.amount * 12;
  meta.style.display = 'flex';
  meta.innerHTML =
    `<span>Monthly: <strong>${fmt(a.amount)}</strong></span>
     <span>Next deduction: <strong>${next}</strong></span>
     <span>Per year: <strong>${fmt(yearly)}</strong></span>` +
    (pending ? `<span class="warn">⚠️ This month's deduction is waiting for enough balance.</span>` : '');
}

function updateAutoSavingHint() {
  const amt  = parseFloat(document.getElementById('autoSavingAmount').value) || 0;
  const day  = parseInt(document.getElementById('autoSavingDay').value, 10) || 1;
  const on   = document.getElementById('autoSavingEnabled').checked;
  const hint = document.getElementById('autoSavingHint');
  const avail = availableBalance();
  let text = `Available balance: ${fmt(avail)}`;
  if (on && amt > 0) {
    const now = new Date();
    const due = Math.min(day, new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate());
    if (state.autoSaving.lastRun !== monthKey(now) && now.getDate() >= due) {
      text += amt > avail
        ? ` · ⚠️ ${fmt(amt)} is more than your balance, so this month's saving will wait.`
        : ` · This month's ${fmt(amt)} will be deducted right away.`;
    } else {
      text += ` · Next deduction on day ${day}.`;
    }
  }
  hint.textContent = text;
}

document.getElementById('openAutoSavingModal').addEventListener('click', () => {
  const sel = document.getElementById('autoSavingDay');
  if (!sel.options.length) {
    for (let d = 1; d <= 28; d++) {
      const o = document.createElement('option');
      const suffix = (d >= 11 && d <= 13) ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[d % 10] || 'th');
      o.value = d; o.textContent = `${d}${suffix} of every month`;
      sel.appendChild(o);
    }
  }
  const a = state.autoSaving;
  document.getElementById('autoSavingAmount').value  = a.amount || '';
  document.getElementById('autoSavingDay').value     = a.day || 1;
  document.getElementById('autoSavingEnabled').checked = a.enabled || !a.amount;
  updateAutoSavingHint();
  openModal('autoSavingModal');
});
['autoSavingAmount', 'autoSavingDay', 'autoSavingEnabled'].forEach(id => {
  document.getElementById(id).addEventListener('input',  updateAutoSavingHint);
  document.getElementById(id).addEventListener('change', updateAutoSavingHint);
});

document.getElementById('confirmAutoSaving').addEventListener('click', () => {
  const amt     = parseFloat(document.getElementById('autoSavingAmount').value);
  const day     = parseInt(document.getElementById('autoSavingDay').value, 10) || 1;
  const enabled = document.getElementById('autoSavingEnabled').checked;
  if (enabled && (!amt || amt <= 0)) return showToast('Enter a valid monthly amount.', 'error');

  const prev = state.autoSaving;
  state.autoSaving = { enabled, amount: amt > 0 ? amt : 0, day, lastRun: prev.lastRun || null, lastSkipped: prev.lastSkipped || null };
  saveState(); renderAll(); closeModal('autoSavingModal');
  if (!enabled) return showToast('Auto saving turned off.', 'info');
  showToast(`Auto saving set: ${fmt(amt)} on day ${day} of every month.`, 'success');
  processAutoSaving();   // if this month's day has already passed, it runs right away
});

// ========================
//  HISTORY FILTERS
// ========================
document.getElementById('filterCategory').addEventListener('change', renderHistory);
document.getElementById('filterType').addEventListener('change', renderHistory);

// ========================
//  CLEAR ALL
// ========================
document.getElementById('clearHistoryBtn').addEventListener('click', async () => {
  if (!confirm('Clear ALL data?\n\nA backup is saved first, so you can restore it from Account & Backup.')) return;
  try { await pushToServer(); await API.req('POST', '/api/backups', {}); }
  catch (e) { if (!confirm('Could not save a backup first (' + e.message + '). Clear anyway?')) return; }
  state = { pocketMoney:0, expenses:[], manualSavings:[], categories:[...DEFAULT_CATEGORIES], transactions:[], budget:{ enabled:false, amount:0 }, autoSaving:{ enabled:false, amount:0, day:1, lastRun:null, lastSkipped:null } };
  saveState(); renderAll();
  showToast('All data cleared.', 'info');
});

// ========================
//  TAB NAVIGATION
// ========================
document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.tab;
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + tab).classList.add('active');
    // Reset charts view when leaving expenses
    if (tab !== 'expenses') {
      chartsVisible = false;
      document.getElementById('expenseMainView').style.display  = 'block';
      document.getElementById('expenseChartsView').style.display = 'none';
      document.getElementById('toggleChartsBtn').textContent = '◬ View Charts';
      document.getElementById('toggleChartsBtn').style.color = '';
      document.getElementById('toggleChartsBtn').style.borderColor = '';
    }
  });
});

// ========================
//  CHARTS TOGGLE (inside Expenses)
// ========================
let chartsVisible = false;
document.getElementById('toggleChartsBtn').addEventListener('click', () => {
  chartsVisible = !chartsVisible;
  const mainView   = document.getElementById('expenseMainView');
  const chartsView = document.getElementById('expenseChartsView');
  const btn        = document.getElementById('toggleChartsBtn');
  if (chartsVisible) {
    mainView.style.display   = 'none';
    chartsView.style.display = 'block';
    btn.textContent = '◉ View Categories';
    btn.style.color = 'var(--blue)';
    btn.style.borderColor = 'rgba(79,142,247,0.4)';
    renderCharts();
  } else {
    mainView.style.display   = 'block';
    chartsView.style.display = 'none';
    btn.textContent = '◬ View Charts';
    btn.style.color = '';
    btn.style.borderColor = '';
  }
});

// ========================
//  DATE
// ========================
document.getElementById('currentDate').textContent =
  new Date().toLocaleDateString('en-IN', { weekday:'long', day:'numeric', month:'long', year:'numeric' });

// ========================
//  LOGIN / SIGN UP
// ========================
let authMode = 'login';
function setAuthMode(mode) {
  authMode = mode;
  document.querySelectorAll('.auth-tab').forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
  document.getElementById('authSubmit').textContent = mode === 'login' ? 'Log in' : 'Create account';
  document.getElementById('authHelp').style.display = mode === 'register' ? 'block' : 'none';
  document.getElementById('authPassword').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
  document.getElementById('authError').textContent = '';
}
function showAuth(msg) {
  document.getElementById('authOverlay').classList.add('open');
  document.getElementById('authError').textContent = msg || '';
  document.getElementById('authPassword').value = '';
  setTimeout(() => document.getElementById('authUsername').focus(), 50);
}
function hideAuth() {
  document.getElementById('authOverlay').classList.remove('open');
  document.getElementById('authPassword').value = '';
  document.getElementById('authError').textContent = '';
}
document.querySelectorAll('.auth-tab').forEach(t => t.addEventListener('click', () => setAuthMode(t.dataset.mode)));

document.getElementById('authForm').addEventListener('submit', async e => {
  e.preventDefault();
  const username = document.getElementById('authUsername').value.trim();
  const password = document.getElementById('authPassword').value;
  const btn = document.getElementById('authSubmit');
  const err = document.getElementById('authError');
  err.textContent = '';
  if (!username || !password) { err.textContent = 'Enter username and password.'; return; }
  btn.disabled = true;
  try {
    const r = await API.req('POST', '/api/' + authMode, { username, password });
    await onSignedIn(r.user.username);
  } catch (ex) {
    err.textContent = ex.message;
  }
  btn.disabled = false;
});

function updateAccountUI() {
  const name = currentUser || 'Not signed in';
  document.getElementById('accountName').textContent = name;
  document.getElementById('accountAvatar').textContent = (currentUser || '?').charAt(0);
  document.getElementById('accUser').textContent = name;
}

async function onSignedIn(username) {
  clearTimeout(pushTimer);
  currentUser = username; serverVersion = 0; dirty = false;
  try { localStorage.setItem('pocketwise_last_user', username); } catch (e) {}

  let r;
  try { r = await API.req('GET', '/api/data'); }
  catch (e) { currentUser = null; throw e; }

  const cache = readCache();
  if (cache && cache.dirty && cache.data) {
    // this device has changes that never reached the server (made offline)
    const keepLocal = cache.version === r.version ||
      confirm('This device has changes that were never saved to your account, but your account was also changed elsewhere.\n\nOK = keep this device\'s changes (replaces the online copy)\nCancel = use the online copy');
    if (keepLocal) { state = normalizeState(cache.data); serverVersion = r.version; dirty = true; }
    else applyServerData(r);
  } else if (r.data) {
    applyServerData(r);
  } else {
    // brand-new account: offer to bring over data from the old browser-only version
    state = normalizeState({}); serverVersion = r.version || 0;
    const legacy = readLegacy();
    const hasData = legacy && ((legacy.pocketMoney > 0) || (legacy.expenses || []).length || (legacy.manualSavings || []).length);
    if (hasData && confirm('Found PocketWise data saved in this browser from before accounts existed.\n\nImport it into your account?')) {
      state = normalizeState(legacy); dirty = true;
      try { localStorage.setItem(LEGACY_KEY + '_imported', localStorage.getItem(LEGACY_KEY)); localStorage.removeItem(LEGACY_KEY); } catch (e) {}
    }
  }

  hideAuth(); updateAccountUI(); renderAll();
  if (dirty) { writeCache(); setSyncStatus('pending'); pushToServer(); } else setSyncStatus('synced');
  processAutoSaving();
}

// Session ended on the server (e.g. password changed elsewhere): keep unsynced data cached, ask to log in again
function sessionExpired() {
  clearTimeout(pushTimer);
  writeCache();
  currentUser = null; dirty = false; serverVersion = 0;
  state = normalizeState({}); renderAll(); updateAccountUI();
  closeModal('accountModal');
  showAuth('Your session expired. Please log in again.');
}

function endSession() {
  clearTimeout(pushTimer);
  const k = cacheKey(); if (k) { try { localStorage.removeItem(k); } catch (e) {} }
  try { localStorage.removeItem('pocketwise_last_user'); } catch (e) {}
  currentUser = null; dirty = false; serverVersion = 0; lastSynced = null;
  state = normalizeState({}); renderAll(); updateAccountUI(); setSyncStatus('none');
  closeModal('accountModal');
  document.getElementById('authUsername').value = '';
  showAuth();
}

async function logout() {
  if (dirty) {
    await pushToServer();
    if (dirty && !confirm('Some changes could not be saved to the server yet. Log out anyway and lose them?')) return;
  }
  try { await API.req('POST', '/api/logout', {}); } catch (e) {}
  endSession();
}

async function bootstrap() {
  setAuthMode('login');
  try {
    const me = await API.req('GET', '/api/me');
    await onSignedIn(me.user.username);
  } catch (e) {
    if (e.status === 401) return showAuth();
    // server unreachable: open the last signed-in account from this device's cache
    let last = null; try { last = localStorage.getItem('pocketwise_last_user'); } catch (x) {}
    if (last) {
      currentUser = last;
      const c = readCache();
      if (c && c.data) {
        state = normalizeState(c.data); serverVersion = c.version || 0; dirty = !!c.dirty;
        hideAuth(); updateAccountUI(); renderAll(); setSyncStatus('offline');
        if (dirty) pushTimer = setTimeout(pushToServer, 15000);
        return;
      }
      currentUser = null;
    }
    showAuth(e.message || 'Cannot reach the server.');
  }
}

async function syncTick() {
  if (!currentUser) return;
  if (dirty) await pushToServer(); else await pullIfNewer();
  processAutoSaving();
}
setInterval(syncTick, 60 * 1000);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { if (dirty) pushToServer(); } else syncTick();
});
window.addEventListener('online', syncTick);
document.getElementById('syncStatus').addEventListener('click', syncTick);

// ========================
//  ACCOUNT & BACKUP
// ========================
const BACKUP_LABELS = { auto: 'Automatic', manual: 'Manual', 'before-import': 'Before import', 'before-restore': 'Before restore' };

async function flushPending() { if (dirty) await pushToServer(); }

async function loadBackups() {
  const list = document.getElementById('backupList');
  try {
    const { backups } = await API.req('GET', '/api/backups');
    if (!backups.length) { list.innerHTML = '<li class="empty-msg">No saved backups yet.</li>'; return; }
    list.innerHTML = '';
    backups.forEach(b => {
      const li = document.createElement('li');
      li.className = 'backup-item';
      const when = new Date(b.createdAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      li.innerHTML = `<span>${esc(when)}<span class="bk-label">${esc(BACKUP_LABELS[b.label] || b.label)}</span></span><button type="button" class="btn-restore">Restore</button>`;
      li.querySelector('button').addEventListener('click', () => restoreBackup(b.id, when));
      list.appendChild(li);
    });
  } catch (e) {
    list.innerHTML = `<li class="empty-msg">${esc(e.message)}</li>`;
  }
}

async function restoreBackup(id, when) {
  if (!confirm(`Restore your data to the backup from ${when}?\n\nYour current data is backed up first.`)) return;
  try {
    await flushPending();
    applyServerData(await API.req('POST', `/api/backups/${id}/restore`, {}));
    renderAll(); loadBackups();
    showToast('Backup restored.', 'success');
  } catch (e) { showToast(e.message, 'error'); }
}

document.getElementById('openAccountModal').addEventListener('click', () => {
  updateAccountUI();
  setSyncStatus(!currentUser ? 'none' : dirty ? 'pending' : 'synced');
  ['curPassword', 'newPassword'].forEach(id => document.getElementById(id).value = '');
  const m = document.getElementById('pwMsg'); m.textContent = ''; m.className = 'acc-msg';
  openModal('accountModal');
  loadBackups();
});

document.getElementById('createBackupBtn').addEventListener('click', async () => {
  try {
    await flushPending();
    await API.req('POST', '/api/backups', {});
    showToast('Backup saved.', 'success'); loadBackups();
  } catch (e) { showToast(e.message, 'error'); }
});

document.getElementById('downloadBackupBtn').addEventListener('click', async () => {
  try {
    await flushPending();
    const res = await fetch('/api/export', { credentials: 'same-origin' });
    if (!res.ok) throw new Error('Could not download backup.');
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `pocketwise-backup-${localDateStr()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) { showToast(e.message, 'error'); }
});

document.getElementById('uploadBackupBtn').addEventListener('click', () => document.getElementById('backupFileInput').click());
document.getElementById('backupFileInput').addEventListener('change', async e => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const data = (parsed && parsed.data && typeof parsed.data === 'object') ? parsed.data : parsed;
    if (!confirm('Replace ALL your current data with this backup file?\n\nYour current data is backed up first.')) return;
    await flushPending();
    applyServerData(await API.req('POST', '/api/import', { data }));
    renderAll(); loadBackups();
    showToast('Backup restored from file.', 'success');
  } catch (ex) {
    showToast(ex instanceof SyntaxError ? 'That file is not a valid backup.' : ex.message, 'error');
  }
});

document.getElementById('changePasswordBtn').addEventListener('click', async () => {
  const msg = document.getElementById('pwMsg');
  const cur = document.getElementById('curPassword').value;
  const nw  = document.getElementById('newPassword').value;
  try {
    await API.req('POST', '/api/change-password', { currentPassword: cur, newPassword: nw });
    msg.textContent = 'Password updated. Other devices were signed out.'; msg.className = 'acc-msg ok';
    document.getElementById('curPassword').value = ''; document.getElementById('newPassword').value = '';
  } catch (e) { msg.textContent = e.message; msg.className = 'acc-msg error'; }
});

document.getElementById('logoutBtn').addEventListener('click', logout);

document.getElementById('deleteAccountBtn').addEventListener('click', async () => {
  if (!confirm('Delete your account and ALL its data permanently?\n\nThis cannot be undone. Download a backup first if you want to keep a copy.')) return;
  const password = prompt('Enter your password to confirm:');
  if (password === null) return;
  try {
    await API.req('DELETE', '/api/account', { password });
    clearTimeout(pushTimer); dirty = false;
    endSession();
    showAuth('Your account was deleted.');
  } catch (e) { showToast(e.message, 'error'); }
});

// ========================
//  INIT
// ========================
bootstrap();

// ========================
//  AI HELPERS
// ========================
function buildFinancialContext() {
  const totals   = getCategoryTotals();
  const spent    = totalExpenses();
  const saved    = totalManualSavings();
  const pocket   = state.pocketMoney;
  const avail    = availableBalance();
  const budget   = state.budget;
  const spentPct = pocket > 0 ? ((spent / pocket) * 100).toFixed(1) : 0;

  const categoryBreakdown = Object.entries(totals)
    .sort((a,b) => b[1].amount - a[1].amount)
    .map(([,d]) => `  - ${d.icon} ${d.name}: ₹${d.amount.toFixed(2)} (${pocket > 0 ? ((d.amount/spent)*100).toFixed(1) : 0}% of spending, ${d.count} transactions)`)
    .join('\n');

  const recentExpenses = [...state.expenses]
    .reverse().slice(0, 8)
    .map(e => {
      const cat = state.categories.find(c => c.id === e.categoryId);
      return `  - ${cat?.name || e.categoryId}: ₹${e.amount} — "${e.desc}" on ${e.date}`;
    }).join('\n');

  return `Student Finance Summary:
- Total Pocket Money: ₹${pocket.toFixed(2)}
- Total Spent: ₹${spent.toFixed(2)} (${spentPct}% of pocket money)
- Manually Saved: ₹${saved.toFixed(2)}
- Available Balance: ₹${avail.toFixed(2)}
- Budget: ${budget.enabled ? `₹${budget.amount} limit set (${pocket > 0 ? ((spent/budget.amount)*100).toFixed(1) : 0}% used)` : 'No budget set'}
- Total Transactions: ${state.expenses.length}

Spending by Category:
${categoryBreakdown || '  No expenses yet'}

Recent Expenses:
${recentExpenses || '  No recent expenses'}`;
}

async function callClaude(systemPrompt, userMessage) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    })
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.content.map(b => b.text || '').join('');
}

// ========================
//  AI SPENDING ADVISOR (Dashboard)
// ========================
document.getElementById('runAdvisorBtn')?.addEventListener('click', async () => {
  const body    = document.getElementById('aiAdvisorBody');
  const loading = document.getElementById('aiAdvisorLoading');
  const result  = document.getElementById('aiAdvisorResult');
  const btn     = document.getElementById('runAdvisorBtn');

  if (state.expenses.length === 0 && state.pocketMoney === 0) {
    body.style.display   = 'block';
    loading.style.display = 'none';
    result.textContent   = 'Add some pocket money and expenses first, then I can analyze your finances! 😊';
    return;
  }

  btn.disabled          = true;
  btn.textContent       = 'Analyzing...';
  body.style.display    = 'block';
  loading.style.display = 'flex';
  result.textContent    = '';

  try {
    const context = buildFinancialContext();
    const text = await callClaude(
      `You are a friendly, practical financial advisor for students in India. 
       Analyze their spending data and give 3-5 specific, actionable insights.
       Use ₹ for currency. Be encouraging but honest. Keep it concise and easy to read.
       Use bullet points. Highlight the most important insight first.`,
      `Here is my financial data:\n\n${context}\n\nGive me a spending analysis with actionable tips.`
    );
    loading.style.display = 'none';
    result.innerHTML = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  } catch(e) {
    loading.style.display = 'none';
    result.textContent = '⚠️ Could not connect to AI. Check your internet connection.';
  }

  btn.disabled    = false;
  btn.textContent = 'Analyze Now';
});

// ========================
//  AI SMART EXPENSE FILL
// ========================
document.getElementById('runSmartFill').addEventListener('click', async () => {
  const input  = document.getElementById('aiSmartInput').value.trim();
  const status = document.getElementById('aiSmartStatus');
  const btn    = document.getElementById('runSmartFill');

  if (!input) { status.textContent = 'Please type something first.'; status.className = 'ai-smart-status error'; return; }

  btn.disabled    = true;
  btn.textContent = '...';
  status.textContent = '✦ Thinking...';
  status.className   = 'ai-smart-status';

  const categoryList = state.categories.map(c => `${c.id}: ${c.name}`).join(', ');

  try {
    const text = await callClaude(
      `You are a smart expense parser for a student finance app. 
       Extract expense details from natural language and return ONLY valid JSON.
       Available categories: ${categoryList}
       Pick the most fitting categoryId from the list above.
       Return exactly this format with no extra text:
       {"amount": number, "categoryId": "string", "desc": "string"}`,
      `Parse this expense: "${input}"`
    );

    const clean = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(clean);

    if (parsed.amount)     document.getElementById('expenseAmount').value = parsed.amount;
    if (parsed.desc)       document.getElementById('expenseDesc').value   = parsed.desc;
    if (parsed.categoryId) {
      const sel = document.getElementById('expenseCategorySelect');
      if ([...sel.options].some(o => o.value === parsed.categoryId)) {
        sel.value = parsed.categoryId;
      }
    }
    updateBalanceHint();
    status.textContent = '✅ Fields filled! Review and confirm.';
    status.className   = 'ai-smart-status success';
    document.getElementById('aiSmartInput').value = '';
  } catch(e) {
    status.textContent = '⚠️ Could not parse. Try: "spent 80 on lunch"';
    status.className   = 'ai-smart-status error';
  }

  btn.disabled    = false;
  btn.textContent = 'Fill';
});

document.getElementById('aiSmartInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') document.getElementById('runSmartFill').click();
});

// ========================
//  AI CHAT
// ========================
const chatHistory = [];

const QUICK_PROMPTS = {
  analyze: 'Give me a detailed analysis of my spending patterns. What am I spending too much on? Where can I cut back?',
  budget:  'Based on my spending history, suggest a realistic monthly budget for each of my expense categories.',
  savings: 'Give me 5 practical tips to save more money based on my current spending habits.',
  report:  'Give me a complete monthly financial report — income, expenses by category, savings, and an overall assessment of my financial health.'
};

function appendChatMsg(role, text, isLoading = false) {
  const messages = document.getElementById('aiChatMessages');
  const div = document.createElement('div');
  div.className = `ai-chat-msg ${role === 'user' ? 'user-msg' : 'ai-msg'}`;

  if (isLoading) {
    div.id = 'aiTypingIndicator';
    div.innerHTML = `
      <div class="ai-msg-avatar">✦</div>
      <div class="ai-typing"><span class="ai-dot"></span><span class="ai-dot"></span><span class="ai-dot"></span><span>Thinking...</span></div>`;
  } else {
    const avatar = role === 'user' ? '👤' : '✦';
    const formatted = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
    div.innerHTML = `
      <div class="ai-msg-avatar">${avatar}</div>
      <div class="ai-msg-bubble">${formatted}</div>`;
  }

  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
  return div;
}

async function sendChatMessage(userText) {
  if (!userText.trim()) return;

  const sendBtn  = document.getElementById('aiSendBtn');
  const chatInput = document.getElementById('aiChatInput');

  appendChatMsg('user', userText);
  chatHistory.push({ role: 'user', content: userText });
  chatInput.value = '';
  sendBtn.disabled = true;

  const typingEl = appendChatMsg('ai', '', true);

  try {
    const context = buildFinancialContext();
    const systemPrompt = `You are a friendly, smart financial advisor for a student in India using PocketWise app.
You have access to their real financial data. Answer questions conversationally and helpfully.
Use ₹ for currency. Be concise, practical, and encouraging.
Here is their current financial data:\n\n${context}`;

    const messages = chatHistory.map(m => ({ role: m.role, content: m.content }));

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: systemPrompt,
        messages
      })
    });

    const data  = await response.json();
    if (data.error) throw new Error(data.error.message);
    const reply = data.content.map(b => b.text || '').join('');

    typingEl.remove();
    appendChatMsg('ai', reply);
    chatHistory.push({ role: 'assistant', content: reply });
  } catch(e) {
    typingEl.remove();
    appendChatMsg('ai', '⚠️ Could not connect to AI. Please check your internet connection.');
  }

  sendBtn.disabled = false;
}

document.getElementById('aiSendBtn')?.addEventListener('click', () => {
  sendChatMessage(document.getElementById('aiChatInput').value);
});
document.getElementById('aiChatInput')?.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendChatMessage(document.getElementById('aiChatInput').value);
  }
});

// Quick action buttons
document.querySelectorAll('.ai-quick-card').forEach(btn => {
  btn.addEventListener('click', () => {
    const prompt = QUICK_PROMPTS[btn.dataset.prompt];
    if (prompt) sendChatMessage(prompt);
  });
});

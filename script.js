// ===========================
//  POCKETWISE — SCRIPT.JS
// ===========================

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
};

let donutChartInstance = null;
let barChartInstance   = null;

// ========================
//  PERSIST
// ========================
function loadState() {
  const raw = localStorage.getItem('pocketwise_v3');
  if (raw) {
    try { state = JSON.parse(raw); } catch(e) {}
  }
  if (!state.categories || !state.categories.length) state.categories = [...DEFAULT_CATEGORIES];
  if (!state.budget) state.budget = { enabled: false, amount: 0 };
  DEFAULT_CATEGORIES.forEach(dc => {
    if (!state.categories.find(c => c.id === dc.id)) state.categories.unshift(dc);
  });
}
function saveState() { localStorage.setItem('pocketwise_v3', JSON.stringify(state)); }

// ========================
//  COMPUTED HELPERS
// ========================
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
          <span>${data.icon} ${data.name}</span>
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
      chip.innerHTML = `<span>${cat.icon}</span><span>${cat.name}</span>
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
    <div class="cat-icon">${cat.icon}</div>
    <div class="cat-name">${cat.name}</div>
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
          <div class="txn-name">${s.note || 'Manual Saving'}</div>
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
    item.innerHTML = `<div class="legend-dot" style="background:${colors[i]}"></div><span>${data.icon} ${data.name} ${pct}%</span>`;
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
      <td><span style="color:${colors[i]}">${data.icon}</span> ${data.name}</td>
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
      <div class="txn-icon rose-bg">${cat?.icon || '💸'}</div>
      <div>
        <div class="txn-name">${exp.desc || cat?.name || 'Expense'}</div>
        <div class="txn-date">${cat?.name || ''} · ${fmtDate(exp.date)}</div>
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
      <div class="txn-icon ${iconBg}">${txn.icon || '💸'}</div>
      <div>
        <div class="txn-name">${txn.desc || ''}</div>
        <div class="txn-date">${txn.category ? txn.category + ' · ' : ''}${fmtDate(txn.date)}</div>
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
    `Saving: <strong style="color:var(--amber)">${s.note || 'Manual Saving'}</strong> &nbsp;|&nbsp; Saved: <strong style="color:var(--green)">${fmt(s.amount)}</strong>`;
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
//  HISTORY FILTERS
// ========================
document.getElementById('filterCategory').addEventListener('change', renderHistory);
document.getElementById('filterType').addEventListener('change', renderHistory);

// ========================
//  CLEAR ALL
// ========================
document.getElementById('clearHistoryBtn').addEventListener('click', () => {
  if (!confirm('Clear ALL data? This cannot be undone.')) return;
  state = { pocketMoney:0, expenses:[], manualSavings:[], categories:[...DEFAULT_CATEGORIES], transactions:[], budget:{ enabled:false, amount:0 } };
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
//  INIT
// ========================
loadState();
renderAll();

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
document.getElementById('runAdvisorBtn').addEventListener('click', async () => {
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

document.getElementById('aiSendBtn').addEventListener('click', () => {
  sendChatMessage(document.getElementById('aiChatInput').value);
});
document.getElementById('aiChatInput').addEventListener('keydown', e => {
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

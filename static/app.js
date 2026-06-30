// ── Utilities ──────────────────────────────────────────────────────────────────────────────────────

function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = 'toast toast-' + type;
    toast.textContent = message;
    document.body.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add('toast-visible'));
    setTimeout(() => {
        toast.classList.remove('toast-visible');
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}

function formatCurrency(n) {
    return new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 0 }).format(n) + ' kr';
}

function escHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

// ── State ──────────────────────────────────────────────────────────────────────────────────────────

const MONTH_NAMES_SV = [
    'Januari','Februari','Mars','April','Maj','Juni',
    'Juli','Augusti','September','Oktober','November','December'
];

const householdsState = {
    list:     [],   // [{id, name}]
    activeId: null,
};

const billsState = {
    year:              new Date().getFullYear(),
    month:             new Date().getMonth() + 1,
    calYear:           new Date().getFullYear(),
    partners:          [],
    bills:             [],
    allBills:          [],
    monthlyIncomes:    {},
    monthsWithBills:   new Set(),
    settledMonths:     new Set(),
    comparisonVisible: false,
    comparisonCharts:  {},
    comparisonData:    null,
    selectedComparisonMonths: new Set(),
    analysisView:      'income',
};

function _hid() { return householdsState.activeId; }

// ── Households persistence ──────────────────────────────────────────────────────────────────────

function _loadHouseholds() {
    try {
        const h = localStorage.getItem('rkn_households');
        if (h) householdsState.list = JSON.parse(h);
    } catch(e) {}
}

function _saveHouseholds() {
    try {
        localStorage.setItem('rkn_households', JSON.stringify(householdsState.list));
    } catch(e) {}
}

// Migrate old single-household data to per-household format
function _migrateOldData() {
    if (localStorage.getItem('rkn_households')) return;
    const oldPartners = localStorage.getItem('rkn_partners');
    if (!oldPartners) return;

    const hid = 1;
    localStorage.setItem('rkn_households', JSON.stringify([{ id: hid, name: 'Mitt hushåll' }]));
    localStorage.setItem(`rkn_partners_${hid}`, oldPartners);

    const oldBills = localStorage.getItem('rkn_all_bills');
    if (oldBills) localStorage.setItem(`rkn_bills_${hid}`, oldBills);

    const oldSettled = localStorage.getItem('rkn_settled');
    if (oldSettled) localStorage.setItem(`rkn_settled_${hid}`, oldSettled);

    // Migrate income keys: rkn_inc_Y_M_PID → rkn_inc_1_Y_M_PID
    const incKeys = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.startsWith('rkn_inc_')) incKeys.push(key);
    }
    incKeys.forEach(key => {
        const suffix = key.slice(8);
        const parts = suffix.split('_');
        if (parts.length === 3 && parts.every(p => /^\d+$/.test(p))) {
            localStorage.setItem(`rkn_inc_${hid}_${suffix}`, localStorage.getItem(key));
        }
    });
}

// ── Bills persistence (per-household) ──────────────────────────────────────────────────────────

function _saveState() {
    const hid = _hid();
    if (!hid) return;
    try {
        localStorage.setItem(`rkn_partners_${hid}`, JSON.stringify(billsState.partners));
        localStorage.setItem(`rkn_bills_${hid}`, JSON.stringify(billsState.allBills));
        localStorage.setItem(`rkn_settled_${hid}`, JSON.stringify([...billsState.settledMonths]));
    } catch(e) {}
}

function _loadState() {
    const hid = _hid();
    billsState.partners     = [];
    billsState.allBills     = [];
    billsState.settledMonths = new Set();
    if (!hid) return;
    try {
        const p = localStorage.getItem(`rkn_partners_${hid}`);
        const b = localStorage.getItem(`rkn_bills_${hid}`);
        const s = localStorage.getItem(`rkn_settled_${hid}`);
        if (p) billsState.partners  = JSON.parse(p);
        if (b) billsState.allBills  = JSON.parse(b);
        if (s) billsState.settledMonths = new Set(JSON.parse(s));
    } catch(e) {}
}

function _nextId(arr) {
    return arr.length === 0 ? 1 : Math.max(...arr.map(x => x.id)) + 1;
}

function _incomeKey(y, m, pid) { return `rkn_inc_${_hid()}_${y}_${m}_${pid}`; }
function _persistIncome(y, m, pid, v) { try { localStorage.setItem(_incomeKey(y, m, pid), String(v)); } catch(e) {} }
function _readLocalIncome(y, m, pid) {
    try {
        const v = localStorage.getItem(_incomeKey(y, m, pid));
        return v !== null ? (parseFloat(v) || 0) : 0;
    } catch(e) { return 0; }
}

// ── Boot ──────────────────────────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    _migrateOldData();
    _loadHouseholds();
    showHouseholdsPage();
});

// ── Households page ───────────────────────────────────────────────────────────────────────────────

function showHouseholdsPage() {
    document.getElementById('households-page').classList.add('active');
    document.getElementById('bills-page').classList.remove('active');
    householdsState.activeId = null;
    renderHouseholdsPage();
}

function goBackToHouseholds() {
    destroyBillsCharts();
    if (billsState.comparisonVisible) {
        billsState.comparisonVisible = false;
        const section = document.getElementById('bills-comparison-section');
        if (section) section.classList.add('hidden');
        const btn = document.getElementById('bills-comparison-btn');
        if (btn) btn.classList.remove('active');
        billsState.selectedComparisonMonths = new Set();
    }
    document.getElementById('bills-page').classList.remove('active');
    document.getElementById('households-page').classList.add('active');
    householdsState.activeId = null;
    renderHouseholdsPage();
}

function openHousehold(id) {
    householdsState.activeId = id;

    // Reset bills view state
    billsState.comparisonVisible = false;
    billsState.comparisonCharts  = {};
    billsState.comparisonData    = null;
    billsState.selectedComparisonMonths = new Set();
    billsState.analysisView = 'income';
    destroyBillsCharts();
    const section = document.getElementById('bills-comparison-section');
    if (section) section.classList.add('hidden');
    const compBtn = document.getElementById('bills-comparison-btn');
    if (compBtn) compBtn.classList.remove('active');

    const h = householdsState.list.find(x => x.id === id);
    const nameEl = document.getElementById('bills-household-name');
    if (nameEl) nameEl.textContent = h ? h.name : 'Räkningar';

    document.getElementById('households-page').classList.remove('active');
    document.getElementById('bills-page').classList.add('active');

    _loadState();
    _refreshForMonth();
    initMobilePanels();
}

function _getHouseholdSummary(hid) {
    try {
        const bills    = JSON.parse(localStorage.getItem(`rkn_bills_${hid}`)    || '[]');
        const settled  = new Set(JSON.parse(localStorage.getItem(`rkn_settled_${hid}`) || '[]'));
        const partners = JSON.parse(localStorage.getItem(`rkn_partners_${hid}`) || '[]');
        const now = new Date();
        const y = now.getFullYear(), m = now.getMonth() + 1;
        const monthBills = bills.filter(b => b.year === y && b.month === m);
        const monthTotal = monthBills.reduce((s, b) => s + b.amount, 0);
        return { partners, monthTotal, isSettled: settled.has(`${y}-${m}`) };
    } catch(e) { return { partners: [], monthTotal: 0, isSettled: false }; }
}

function renderHouseholdsPage() {
    const grid = document.getElementById('households-grid');
    if (!grid) return;

    if (householdsState.list.length === 0) {
        grid.innerHTML = `
            <div class="households-empty">
                <div class="households-empty-title">Välkommen!</div>
                <div class="households-empty-sub">Skapa ditt första hushåll för att börja dela räkningar.</div>
                <button class="btn btn-primary" onclick="openCreateHouseholdModal()">+ Nytt hushåll</button>
            </div>`;
        return;
    }

    const now = new Date();
    const monthLabel = `${MONTH_NAMES_SV[now.getMonth()]} ${now.getFullYear()}`;

    grid.innerHTML = householdsState.list.map(h => {
        const { partners, monthTotal, isSettled } = _getHouseholdSummary(h.id);
        const participantChips = partners.length > 0
            ? partners.map(p => `<span class="household-card-participant">${escHtml(p.name)}</span>`).join('')
            : '<span style="font-size:12px;color:var(--text-muted);font-style:italic">Inga deltagare</span>';
        const settledBadge = isSettled ? '<span class="household-card-settled">✓ Uppgjord</span>' : '';
        return `
        <div class="household-card" onclick="openHousehold(${h.id})">
            <div class="household-card-name">${escHtml(h.name)}</div>
            <div class="household-card-participants">${participantChips}</div>
            <div class="household-card-footer">
                <div class="household-card-stat">
                    <strong>${monthTotal > 0 ? formatCurrency(monthTotal) : '—'}</strong>
                    ${monthLabel}
                </div>
                ${settledBadge}
            </div>
        </div>`;
    }).join('');
}

// ── Create household ─────────────────────────────────────────────────────────────────────────────

let _newHouseholdParticipants = [];

function openCreateHouseholdModal() {
    _newHouseholdParticipants = [];
    document.getElementById('household-name-input').value = '';
    document.getElementById('household-participant-input').value = '';
    document.getElementById('household-participants-chips').innerHTML = '';
    document.getElementById('create-household-modal').classList.remove('hidden');
    setTimeout(() => document.getElementById('household-name-input').focus(), 50);
}

function closeCreateHouseholdModal() {
    document.getElementById('create-household-modal').classList.add('hidden');
}

function addHouseholdParticipant() {
    const input = document.getElementById('household-participant-input');
    const name  = (input.value || '').trim();
    if (!name) return;
    if (_newHouseholdParticipants.some(p => p.name.toLowerCase() === name.toLowerCase())) {
        showToast('Deltagare finns redan', 'error');
        return;
    }
    const id = _newHouseholdParticipants.length === 0 ? 1
        : Math.max(..._newHouseholdParticipants.map(p => p.id)) + 1;
    _newHouseholdParticipants.push({ id, name });
    input.value = '';
    input.focus();
    _renderNewHouseholdParticipants();
}

function removeNewHouseholdParticipant(idx) {
    _newHouseholdParticipants.splice(idx, 1);
    _renderNewHouseholdParticipants();
}

function _renderNewHouseholdParticipants() {
    const el = document.getElementById('household-participants-chips');
    if (!el) return;
    el.innerHTML = _newHouseholdParticipants.map((p, i) => `
        <span class="bills-partner-chip">
            <span>${escHtml(p.name)}</span>
            <button class="bills-partner-delete" onclick="removeNewHouseholdParticipant(${i})" title="Ta bort">×</button>
        </span>`).join('');
}

function createHousehold() {
    const name = (document.getElementById('household-name-input').value || '').trim();
    if (!name) { showToast('Ange ett namn för hushållet', 'error'); return; }

    const newId = householdsState.list.length === 0 ? 1
        : Math.max(...householdsState.list.map(h => h.id)) + 1;
    householdsState.list.push({ id: newId, name });
    _saveHouseholds();

    if (_newHouseholdParticipants.length > 0) {
        try {
            localStorage.setItem(`rkn_partners_${newId}`, JSON.stringify(_newHouseholdParticipants));
        } catch(e) {}
    }

    closeCreateHouseholdModal();
    openHousehold(newId);
}

// ── Refresh for current month ──────────────────────────────────────────────────────────────────────

function _refreshForMonth() {
    billsState.bills = billsState.allBills.filter(
        b => b.year === billsState.year && b.month === billsState.month
    );
    billsState.monthsWithBills = new Set(billsState.allBills.map(b => `${b.year}-${b.month}`));
    billsState.monthlyIncomes  = {};
    billsState.partners.forEach(p => {
        const inc = _readLocalIncome(billsState.year, billsState.month, p.id);
        if (inc > 0) billsState.monthlyIncomes[p.id] = inc;
    });
    updateBillsMonthLabel();
    renderBillsPartners();
    renderBillsIncomeSummary();
    renderBillsTable();
    renderBillsSettlement();
    renderBillsMonthCalendar();
    updateBillsSettledCheckbox(false);
}

// ── Client-side settlement calculation ────────────────────────────────────────────────────────────

function _calculateSettlement() {
    const { partners, bills, monthlyIncomes } = billsState;
    if (partners.length < 2) return null;
    const splitBills = bills.filter(b => b.is_split);
    if (splitBills.length === 0) return null;

    const totalAll   = bills.reduce((s, b) => s + b.amount, 0);
    const totalSplit = splitBills.reduce((s, b) => s + b.amount, 0);

    const paid = {}, personal = {};
    partners.forEach(p => { paid[p.id] = 0; personal[p.id] = 0; });
    splitBills.forEach(b => { paid[b.paid_by] = (paid[b.paid_by] || 0) + b.amount; });
    bills.filter(b => !b.is_split).forEach(b => { personal[b.paid_by] = (personal[b.paid_by] || 0) + b.amount; });

    const totalIncome = Object.values(monthlyIncomes).reduce((s, v) => s + v, 0);
    const n = partners.length;
    const sharesPct = {}, fairShares = {};

    if (totalIncome > 0) {
        partners.forEach(p => {
            const inc = monthlyIncomes[p.id] || 0;
            sharesPct[p.id]  = Math.round(inc / totalIncome * 1000) / 10;
            fairShares[p.id] = Math.round(totalSplit * inc / totalIncome * 100) / 100;
        });
    } else {
        partners.forEach(p => {
            sharesPct[p.id]  = Math.round(100 / n * 10) / 10;
            fairShares[p.id] = Math.round(totalSplit / n * 100) / 100;
        });
    }

    const balances = {};
    partners.forEach(p => { balances[p.id] = Math.round((paid[p.id] - fairShares[p.id]) * 100) / 100; });

    const partnerMap = {};
    partners.forEach(p => { partnerMap[p.id] = p.name; });

    let pos = partners.filter(p => balances[p.id] >  0.005).map(p => [balances[p.id], p.id]).sort((a, b) => b[0] - a[0]);
    let neg = partners.filter(p => balances[p.id] < -0.005).map(p => [balances[p.id], p.id]).sort((a, b) => a[0] - b[0]);
    const transfers = [];
    while (pos.length && neg.length) {
        const [creditAmt, creditor] = pos.shift();
        const [debtAmt,   debtor]   = neg.shift();
        const settle = Math.min(creditAmt, Math.abs(debtAmt));
        transfers.push({ from: partnerMap[debtor], to: partnerMap[creditor], amount: Math.round(settle * 100) / 100 });
        if (creditAmt - settle > 0.005) { pos.unshift([creditAmt - settle, creditor]); pos.sort((a, b) => b[0] - a[0]); }
        if (Math.abs(debtAmt) - settle > 0.005) { neg.unshift([debtAmt + settle, debtor]); neg.sort((a, b) => a[0] - b[0]); }
    }

    return {
        total:       Math.round(totalAll   * 100) / 100,
        total_split: Math.round(totalSplit * 100) / 100,
        partners: partners.map(p => ({
            id:         p.id,
            name:       p.name,
            share:      sharesPct[p.id],
            paid:       Math.round(paid[p.id]       * 100) / 100,
            fair_share: fairShares[p.id],
            balance:    balances[p.id],
            personal:   Math.round(personal[p.id]   * 100) / 100,
        })),
        transfers,
    };
}

// ── Comparison data calculation ────────────────────────────────────────────────────────────────────

function _getComparisonData() {
    const { allBills, partners } = billsState;
    const partnerNames = partners.map(p => p.name);
    const partnerMap   = {};
    partners.forEach(p => { partnerMap[p.id] = p.name; });

    const monthMap = {};
    allBills.forEach(b => {
        const key = `${b.year}-${b.month}`;
        if (!monthMap[key]) {
            const empty = {};
            partnerNames.forEach(n => { empty[n] = 0; });
            monthMap[key] = {
                year: b.year, month: b.month,
                total: 0, total_split: 0, total_personal: 0,
                per_partner_shared:   {...empty},
                per_partner_personal: {...empty},
            };
        }
        const m    = monthMap[key];
        const name = partnerMap[b.paid_by] || '';
        m.total   += b.amount;
        if (b.is_split) {
            m.total_split += b.amount;
            if (name) m.per_partner_shared[name] = (m.per_partner_shared[name] || 0) + b.amount;
        } else {
            m.total_personal += b.amount;
            if (name) m.per_partner_personal[name] = (m.per_partner_personal[name] || 0) + b.amount;
        }
    });

    const months = Object.values(monthMap).sort((a, b) => a.year !== b.year ? a.year - b.year : a.month - b.month);
    return { months, partners: partnerNames };
}

// ── Renderers ────────────────────────────────────────────────────────────────────────────────────

function updateBillsMonthLabel() {
    const monthYear = `${MONTH_NAMES_SV[billsState.month - 1]} ${billsState.year}`;
    const nav = document.getElementById('bills-month-label');
    if (nav) nav.textContent = monthYear;
    const costsTitle = document.getElementById('bills-costs-title');
    if (costsTitle) costsTitle.textContent = `Räkningar – ${monthYear}`;
    const settlementTitle = document.getElementById('bills-settlement-title');
    if (settlementTitle) settlementTitle.textContent = `Uppgörelse – ${monthYear}`;
}

function renderBillsIncomeSummary() {
    const el = document.getElementById('bills-income-summary');
    if (!el) return;
    const partners = billsState.partners;
    if (partners.length === 0) { el.innerHTML = ''; return; }
    const totalIncome = Object.values(billsState.monthlyIncomes).reduce((s, v) => s + v, 0);
    const monthLabel  = `${MONTH_NAMES_SV[billsState.month - 1]} ${billsState.year}`;
    const rows = partners.map(p => {
        const income = billsState.monthlyIncomes[p.id] || 0;
        const share  = totalIncome > 0 ? Math.round(income / totalIncome * 1000) / 10 : 0;
        return `
        <div class="bills-income-row">
            <span class="bills-income-name">${escHtml(p.name)}</span>
            <div class="bills-income-input-wrap">
                <input type="number" class="bills-income-input" data-pid="${p.id}"
                       value="${income || ''}" placeholder="0" min="0" step="1000"
                       oninput="onBillIncomeInput(${p.id}, this.value)">
                <span class="bills-income-unit">kr</span>
            </div>
            <span class="bills-income-share-badge" id="bills-income-share-${p.id}">${share > 0 ? share + '%' : '—'}</span>
        </div>`;
    }).join('');
    el.innerHTML = `
        <div class="bills-income-block">
            <div class="bills-income-block-title">Inkomster – ${monthLabel}</div>
            ${rows}
            <div class="bills-income-block-total">
                <span>Totalt</span>
                <span>${totalIncome > 0 ? formatCurrency(totalIncome) + '/mån' : '—'}</span>
            </div>
        </div>`;
}

function onBillIncomeInput(partnerId, value) {
    const income = parseFloat(value) || 0;
    billsState.monthlyIncomes[partnerId] = income;
    _persistIncome(billsState.year, billsState.month, partnerId, income);
    _updateIncomeShareBadges();
    renderBillsSettlement();
}

function _updateIncomeShareBadges() {
    const total = Object.values(billsState.monthlyIncomes).reduce((s, v) => s + v, 0);
    billsState.partners.forEach(p => {
        const badge = document.getElementById(`bills-income-share-${p.id}`);
        if (!badge) return;
        const income = billsState.monthlyIncomes[p.id] || 0;
        badge.textContent = total > 0 ? (Math.round(income / total * 1000) / 10) + '%' : '—';
    });
    const totalEl = document.querySelector('.bills-income-block-total span:last-child');
    if (totalEl) totalEl.textContent = total > 0 ? formatCurrency(total) + '/mån' : '—';
}

function renderBillsPartners() {
    const list = document.getElementById('bills-partners-list');
    if (!list) return;
    if (billsState.partners.length === 0) {
        list.innerHTML = '<span style="font-size:13px;color:var(--text-muted);font-style:italic">Inga deltagare ännu</span>';
        const mobileList = document.getElementById('bills-partners-list-mobile');
        if (mobileList) mobileList.innerHTML = list.innerHTML;
        return;
    }
    list.innerHTML = billsState.partners.map(p => `
        <span class="bills-partner-chip">
            <button class="bills-partner-chip-edit" onclick="openEditPartnerModal(${p.id})" title="Redigera">${escHtml(p.name)}</button>
            <button class="bills-partner-delete" onclick="deletePartner(${p.id})" title="Ta bort">×</button>
        </span>`).join('');
    const mobileList = document.getElementById('bills-partners-list-mobile');
    if (mobileList) mobileList.innerHTML = list.innerHTML;
}

function renderBillsTable() {
    const tbody   = document.getElementById('bills-tbody');
    const table   = document.getElementById('bills-table');
    const empty   = document.getElementById('bills-empty');
    const totCell = document.getElementById('bills-total-cell');
    if (!tbody) return;
    if (billsState.bills.length === 0) {
        table.classList.add('hidden');
        empty.classList.remove('hidden');
        if (totCell) totCell.textContent = '0 kr';
        return;
    }
    table.classList.remove('hidden');
    empty.classList.add('hidden');
    tbody.innerHTML = billsState.bills.map(b => {
        const splitCls = b.is_split ? 'is-split' : 'not-split';
        const splitTxt = b.is_split ? 'Delas' : 'Personlig';
        return `
        <tr>
            <td>${escHtml(b.name)}</td>
            <td class="bills-td-amount">${formatCurrency(b.amount)}</td>
            <td>${escHtml(b.partner_name)}</td>
            <td><button class="bills-split-badge ${splitCls}" onclick="toggleBillSplit(${b.id})" title="Klicka för att växla">${splitTxt}</button></td>
            <td><button class="bills-delete-btn" onclick="deleteBill(${b.id})" title="Ta bort">×</button></td>
        </tr>`;
    }).join('');
    const total = billsState.bills.reduce((s, b) => s + b.amount, 0);
    if (totCell) totCell.textContent = formatCurrency(total);
}

function renderBillsSettlement() {
    const body = document.getElementById('bills-settlement-body');
    const card = document.getElementById('bills-view-settlement');
    if (!body) return;

    const settledKey = `${billsState.year}-${billsState.month}`;
    const settled    = billsState.settledMonths.has(settledKey);
    if (card) card.classList.toggle('is-settled', settled);

    if (billsState.partners.length < 2) {
        body.innerHTML = '<p class="bills-settlement-empty">Lägg till minst två deltagare för att beräkna uppgörelsen.</p>';
        return;
    }
    const data = _calculateSettlement();
    if (!data) {
        body.innerHTML = '<p class="bills-settlement-empty">Inga delade räkningar den här månaden.</p>';
        return;
    }
    const totalIncome = Object.values(billsState.monthlyIncomes).reduce((s, v) => s + v, 0);
    const partnerBlocks = data.partners.map(p => {
        const monthTotal   = p.fair_share + p.personal;
        const diff         = p.balance;
        const balanceCls   = diff >= 0 ? 'bills-balance-positive' : 'bills-balance-negative';
        const balanceLabel = settled
            ? (diff >= 0 ? `Fick tillbaka ${formatCurrency(diff)}` : `Betalade ${formatCurrency(Math.abs(diff))}`)
            : (diff >= 0 ? `Får tillbaka ${formatCurrency(diff)}` : `Är skyldig ${formatCurrency(Math.abs(diff))}`);
        const monthIncome  = billsState.monthlyIncomes[p.id] || 0;
        const incomeLabel  = monthIncome > 0
            ? `<span class="bills-partner-income-label">${formatCurrency(monthIncome)}/mån</span>`
            : '';
        const personalRow = p.personal > 0 ? `
                <li>
                    <span class="breakdown-label">Betalade (personliga)</span>
                    <span class="breakdown-value">${formatCurrency(p.personal)}</span>
                </li>` : '';
        return `
        <div class="bills-partner-block">
            <div class="bills-partner-block-name">
                ${escHtml(p.name)}
                <span class="bills-partner-share-pct">(${p.share}%)</span>
                ${incomeLabel}
                <span class="bills-partner-balance-inline ${balanceCls}">${balanceLabel}</span>
            </div>
            <ul class="bills-partner-breakdown">
                <li>
                    <span class="breakdown-label">Betalade (delade)</span>
                    <span class="breakdown-value">${formatCurrency(p.paid)}</span>
                </li>${personalRow}
                <li>
                    <span class="breakdown-label">Andel (delade kostnader)</span>
                    <span class="breakdown-value">${formatCurrency(p.fair_share)}</span>
                </li>
                <li class="breakdown-total">
                    <span class="breakdown-label">Totalt denna månad</span>
                    <span class="breakdown-value">${formatCurrency(monthTotal)}</span>
                </li>
            </ul>
        </div>`;
    }).join('');
    const transfersTitle = settled ? 'Betalades' : 'Att betala';
    const transferRows = data.transfers.length === 0
        ? '<p style="font-size:13px;color:var(--income);font-weight:500">✓ Allt är jämnt fördelat!</p>'
        : data.transfers.map(t => `
            <div class="bills-transfer-row">
                <span>${escHtml(t.from)}</span>
                <span class="bills-transfer-arrow">→</span>
                <span>${escHtml(t.to)}</span>
                <span class="bills-transfer-amount">${formatCurrency(t.amount)}</span>
            </div>`).join('');
    const incomeRow = totalIncome > 0 ? `
        <div class="bills-total-summary">
            <span>Hushållets inkomst</span>
            <strong>${formatCurrency(totalIncome)}/mån</strong>
        </div>` : '';
    body.innerHTML = `
        ${partnerBlocks}
        <div class="bills-transfers-section">
            <div class="bills-transfers-title">${transfersTitle}</div>
            ${transferRows}
        </div>
        ${incomeRow}
        <div class="bills-total-summary">
            <span>Delade kostnader</span>
            <strong>${formatCurrency(data.total_split)}</strong>
        </div>`;
}

// ── Month calendar ─────────────────────────────────────────────────────────────────────────────────

function renderBillsMonthCalendar() {
    const cal     = document.getElementById('bills-month-calendar');
    const yearLbl = document.getElementById('bills-cal-year');
    if (!cal) return;
    const y = billsState.calYear;
    if (yearLbl) yearLbl.textContent = y;
    const SHORT = ['Jan','Feb','Mar','Apr','Maj','Jun','Jul','Aug','Sep','Okt','Nov','Dec'];
    cal.innerHTML = SHORT.map((name, i) => {
        const mo           = i + 1;
        const key          = `${y}-${mo}`;
        const hasBills     = billsState.monthsWithBills.has(key);
        const isActive     = y === billsState.year && mo === billsState.month;
        const isSettled    = billsState.settledMonths.has(key);
        const inComparison = billsState.comparisonVisible && !isActive && billsState.selectedComparisonMonths.has(key);
        const atCap        = billsState.comparisonVisible && !billsState.selectedComparisonMonths.has(key) && billsState.selectedComparisonMonths.size >= 12;
        const cls = [
            'bills-month-cell',
            hasBills     ? 'has-bills'     : 'no-bills',
            isActive     ? 'active'        : '',
            isSettled    ? 'is-settled'    : '',
            inComparison ? 'in-comparison' : '',
            atCap        ? 'comp-at-cap'   : '',
        ].join(' ').trim();
        const check = isSettled ? '<span class="bills-month-check">✓</span>' : '';
        return `<div class="${cls}" onclick="billsJumpToMonth(${y},${mo})" title="${MONTH_NAMES_SV[i]} ${y}">${name}${check}</div>`;
    }).join('');
}

function billsCalendarChangeYear(delta) {
    billsState.calYear += delta;
    renderBillsMonthCalendar();
}

function billsJumpToMonth(year, month) {
    if (billsState.comparisonVisible) {
        const key       = `${year}-${month}`;
        const activeKey = `${billsState.year}-${billsState.month}`;
        if (key === activeKey) return;
        if (billsState.selectedComparisonMonths.has(key)) {
            billsState.selectedComparisonMonths.delete(key);
        } else if (billsState.selectedComparisonMonths.size < 12) {
            billsState.selectedComparisonMonths.add(key);
        }
        renderBillsMonthCalendar();
        destroyBillsCharts();
        _renderComparisonChartData();
        return;
    }
    billsState.year    = year;
    billsState.month   = month;
    billsState.calYear = year;
    _refreshForMonth();
}

// ── Month navigation ──────────────────────────────────────────────────────────────────────────────

function billsChangeMonth(delta) {
    let m = billsState.month + delta;
    let y = billsState.year;
    if (m > 12) { m = 1;  y++; }
    if (m < 1)  { m = 12; y--; }
    billsState.month   = m;
    billsState.year    = y;
    billsState.calYear = y;
    _refreshForMonth();
    _syncComparisonToMonth();
}

function _syncComparisonToMonth() {
    if (!billsState.comparisonVisible) return;
    billsState.selectedComparisonMonths = new Set([`${billsState.year}-${billsState.month}`]);
    billsState.comparisonData = _getComparisonData();
    destroyBillsCharts();
    _renderComparisonChartData();
}

// ── View toggles ─────────────────────────────────────────────────────────────────────────────────

function toggleBillsView(view) {
    const isMobile = window.innerWidth <= 750;
    if (isMobile) {
        ['calendar', 'costs', 'settlement'].forEach(v => {
            document.getElementById(`bills-view-${v}`)?.classList.remove('mobile-active');
            document.querySelector(`.bills-view-tab[data-view="${v}"]`)?.classList.remove('active');
        });
        document.getElementById(`bills-view-${view}`)?.classList.add('mobile-active');
        document.querySelector(`.bills-view-tab[data-view="${view}"]`)?.classList.add('active');
    } else {
        const panel = document.getElementById(`bills-view-${view}`);
        const btn   = document.querySelector(`.bills-view-tab[data-view="${view}"]`);
        if (!panel) return;
        const nowHidden = panel.classList.toggle('hidden');
        if (btn) btn.classList.toggle('active', !nowHidden);
    }
}

function initMobilePanels() {
    if (window.innerWidth > 750) return;
    ['calendar', 'costs', 'settlement'].forEach(v => {
        document.getElementById(`bills-view-${v}`)?.classList.remove('mobile-active');
        document.querySelector(`.bills-view-tab[data-view="${v}"]`)?.classList.remove('active');
    });
    document.getElementById('bills-view-calendar')?.classList.add('mobile-active');
    document.querySelector('.bills-view-tab[data-view="calendar"]')?.classList.add('active');
}

let _lastInnerWidth = window.innerWidth;
window.addEventListener('resize', () => {
    const w = window.innerWidth;
    if (w > 750) {
        ['calendar', 'costs', 'settlement'].forEach(v => {
            const el = document.getElementById(`bills-view-${v}`);
            if (el) { el.classList.remove('hidden'); el.classList.remove('mobile-active'); }
        });
    } else if (w !== _lastInnerWidth) {
        // iOS Safari fires resize on scroll when address bar hides/shows (height-only change)
        initMobilePanels();
    }
    _lastInnerWidth = w;
});

if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', _adjustForKeyboard);
    window.visualViewport.addEventListener('scroll', _adjustForKeyboard);
}

function _adjustForKeyboard() {
    const modal = document.querySelector('.modal:not(.hidden)');
    if (!modal) return;
    const vv = window.visualViewport;
    const keyboardHeight = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    modal.style.paddingBottom = keyboardHeight > 50 ? `${keyboardHeight}px` : '';
}

// ── Settled ──────────────────────────────────────────────────────────────────────────────────────

function updateBillsSettledCheckbox(celebrate = false) {
    const cb = document.getElementById('bills-settled-checkbox');
    if (!cb) return;
    const key     = `${billsState.year}-${billsState.month}`;
    const settled = billsState.settledMonths.has(key);
    cb.checked = settled;
    if (settled && celebrate) celebrateBillsSettled();
}

function toggleBillsSettled(checked) {
    const key = `${billsState.year}-${billsState.month}`;
    if (checked) {
        billsState.settledMonths.add(key);
        celebrateBillsSettled();
    } else {
        billsState.settledMonths.delete(key);
    }
    _saveState();
    updateBillsSettledCheckbox();
    renderBillsSettlement();
    renderBillsMonthCalendar();
}

function celebrateBillsSettled() {
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:9999;';
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;

    const COLORS = ['#e74c3c','#f39c12','#2ecc71','#3498db','#9b59b6','#e91e63','#1abc9c','#ff6b35','#ffd700'];

    function makeParticles(count, originX) {
        const arr = [];
        for (let i = 0; i < count; i++) {
            arr.push({
                x: originX + (Math.random() - 0.5) * 60,
                y: canvas.height * 0.8,
                vx: (Math.random() - 0.5) * 10,
                vy: -(Math.random() * 14 + 8),
                color: COLORS[Math.floor(Math.random() * COLORS.length)],
                size: Math.random() * 7 + 3,
                rot: Math.random() * Math.PI * 2,
                rotV: (Math.random() - 0.5) * 0.25,
                rect: Math.random() > 0.4,
                alpha: 1,
            });
        }
        return arr;
    }

    let particles = makeParticles(80, canvas.width * 0.25);
    particles = particles.concat(makeParticles(80, canvas.width * 0.75));

    setTimeout(() => {
        particles = particles.concat(makeParticles(60, canvas.width * 0.5));
        particles = particles.concat(makeParticles(40, canvas.width * 0.1));
        particles = particles.concat(makeParticles(40, canvas.width * 0.9));
    }, 400);

    const start = Date.now();
    const DURATION = 3600;

    function draw() {
        const elapsed = Date.now() - start;
        const t = elapsed / DURATION;
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        particles.forEach(p => {
            p.x  += p.vx;
            p.y  += p.vy;
            p.vy += 0.35;
            p.rot += p.rotV;
            p.alpha = Math.max(0, 1 - t * 1.3);

            ctx.save();
            ctx.globalAlpha = p.alpha;
            ctx.fillStyle = p.color;
            ctx.translate(p.x, p.y);
            ctx.rotate(p.rot);
            if (p.rect) {
                ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
            } else {
                ctx.beginPath();
                ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
                ctx.fill();
            }
            ctx.restore();
        });

        if (t < 1) {
            requestAnimationFrame(draw);
        } else {
            canvas.remove();
        }
    }
    requestAnimationFrame(draw);
}

// ── Add/save bill ────────────────────────────────────────────────────────────────────────────────

function openAddBillModal() {
    if (billsState.partners.length === 0) {
        showToast('Lägg till minst en deltagare först', 'error');
        return;
    }
    const sel = document.getElementById('bill-payer-inline');
    if (sel) sel.innerHTML = billsState.partners.map(p =>
        `<option value="${p.id}">${escHtml(p.name)}</option>`).join('');
    document.getElementById('bill-name-inline').value    = '';
    document.getElementById('bill-amount-inline').value  = '';
    document.getElementById('bill-split-inline').checked = true;
    document.getElementById('add-bill-modal').classList.remove('hidden');
    setTimeout(() => document.getElementById('bill-name-inline').focus(), 50);
}

function closeAddBillModal() {
    document.getElementById('add-bill-modal').classList.add('hidden');
}

function saveBillInline() {
    const name    = (document.getElementById('bill-name-inline').value || '').trim();
    const amount  = parseFloat(document.getElementById('bill-amount-inline').value);
    const paidBy  = parseInt(document.getElementById('bill-payer-inline').value);
    const isSplit = document.getElementById('bill-split-inline').checked;
    if (!name || isNaN(amount) || amount <= 0) {
        showToast('Fyll i namn och belopp', 'error');
        return;
    }
    const partner = billsState.partners.find(p => p.id === paidBy);
    billsState.allBills.push({
        id:           _nextId(billsState.allBills),
        name,
        amount,
        paid_by:      paidBy,
        partner_name: partner ? partner.name : '',
        year:         billsState.year,
        month:        billsState.month,
        is_split:     isSplit,
    });
    _saveState();
    closeAddBillModal();
    _refreshForMonth();
    if (billsState.comparisonVisible) _refreshComparisonCharts();
    showToast('Räkning sparad', 'success');
}

function deleteBill(id) {
    billsState.allBills = billsState.allBills.filter(b => b.id !== id);
    _saveState();
    _refreshForMonth();
    if (billsState.comparisonVisible) _refreshComparisonCharts();
}

function toggleBillSplit(id) {
    const bill = billsState.allBills.find(b => b.id === id);
    if (!bill) return;
    bill.is_split = !bill.is_split;
    _saveState();
    _refreshForMonth();
    if (billsState.comparisonVisible) _refreshComparisonCharts();
}

// ── Partners ─────────────────────────────────────────────────────────────────────────────────────

function openAddPartnerModal() {
    document.getElementById('partner-name-input').value = '';
    document.getElementById('add-partner-modal').classList.remove('hidden');
    setTimeout(() => document.getElementById('partner-name-input').focus(), 100);
}

function savePartner() {
    const name = document.getElementById('partner-name-input').value.trim();
    if (!name) { showToast('Ange ett namn', 'error'); return; }
    if (billsState.partners.some(p => p.name.toLowerCase() === name.toLowerCase())) {
        showToast('Deltagare finns redan', 'error');
        return;
    }
    billsState.partners.push({ id: _nextId(billsState.partners), name });
    _saveState();
    document.getElementById('add-partner-modal').classList.add('hidden');
    renderBillsPartners();
    renderBillsIncomeSummary();
    renderBillsSettlement();
    showToast('Deltagare tillagd', 'success');
}

function openEditPartnerModal(id) {
    const p = billsState.partners.find(x => x.id === id);
    if (!p) return;
    document.getElementById('edit-partner-id').value         = p.id;
    document.getElementById('edit-partner-name-input').value = p.name;
    document.getElementById('edit-partner-modal').classList.remove('hidden');
    document.getElementById('edit-partner-name-input').focus();
}

function updatePartner() {
    const id      = parseInt(document.getElementById('edit-partner-id').value);
    const name    = document.getElementById('edit-partner-name-input').value.trim();
    if (!name) { showToast('Fyll i namn', 'error'); return; }
    const partner = billsState.partners.find(p => p.id === id);
    if (!partner) return;
    partner.name = name;
    billsState.allBills.forEach(b => { if (b.paid_by === id) b.partner_name = name; });
    _saveState();
    document.getElementById('edit-partner-modal').classList.add('hidden');
    renderBillsPartners();
    renderBillsIncomeSummary();
    renderBillsTable();
    renderBillsSettlement();
    showToast('Deltagare uppdaterad', 'success');
}

function deletePartner(id) {
    billsState.partners = billsState.partners.filter(p => p.id !== id);
    billsState.allBills = billsState.allBills.filter(b => b.paid_by !== id);
    delete billsState.monthlyIncomes[id];
    _saveState();
    _refreshForMonth();
    showToast('Deltagare borttagen', 'success');
}

// ── Comparison charts ─────────────────────────────────────────────────────────────────────────────

function _refreshComparisonCharts() {
    billsState.comparisonData = _getComparisonData();
    const currentKey = `${billsState.year}-${billsState.month}`;
    if (!billsState.selectedComparisonMonths || billsState.selectedComparisonMonths.size === 0) {
        billsState.selectedComparisonMonths = new Set([currentKey]);
    }
    destroyBillsCharts();
    _renderComparisonChartData();
}

function toggleBillsComparison() {
    const section = document.getElementById('bills-comparison-section');
    const btn     = document.getElementById('bills-comparison-btn');
    if (!section) return;
    billsState.comparisonVisible = !billsState.comparisonVisible;
    if (billsState.comparisonVisible) {
        section.classList.remove('hidden');
        if (btn) btn.classList.add('active');
        requestAnimationFrame(() => _refreshComparisonCharts());
    } else {
        section.classList.add('hidden');
        if (btn) btn.classList.remove('active');
        destroyBillsCharts();
        billsState.selectedComparisonMonths = new Set();
    }
}

function destroyBillsCharts() {
    Object.values(billsState.comparisonCharts).forEach(c => { try { c.destroy(); } catch(e) {} });
    billsState.comparisonCharts = {};
}

function setAnalysisView(view) {
    const hasBills = billsState.comparisonData && billsState.comparisonData.months && billsState.comparisonData.months.length > 0;
    if ((view === 'total' || view === 'perperson') && !hasBills) return;
    billsState.analysisView = view;
    destroyBillsCharts();
    _renderComparisonChartData();
}

function _getIncomeForMonths(monthKeys) {
    return monthKeys.map(key => {
        const [y, m] = key.split('-').map(Number);
        const incomes = {};
        billsState.partners.forEach(p => {
            incomes[p.name] = _readLocalIncome(y, m, p.id);
        });
        return { key, year: y, month: m, incomes };
    });
}

function _compMonthKey(m) { return `${m.year}-${m.month}`; }

function _zeroMonth(year, month, partners) {
    const empty = {};
    partners.forEach(name => { empty[name] = 0; });
    return { year, month, total: 0, total_split: 0, total_personal: 0,
             per_partner_shared: {...empty}, per_partner_personal: {...empty} };
}

function _renderComparisonChartData() {
    const data     = billsState.comparisonData;
    const partners = billsState.partners;
    if (partners.length === 0) return;

    const hasBills = data && data.months && data.months.length > 0;

    if (!hasBills && billsState.analysisView !== 'income') {
        billsState.analysisView = 'income';
    }

    document.querySelectorAll('.bills-analysis-tab').forEach(btn => {
        const v = btn.dataset.view;
        btn.classList.toggle('active', v === billsState.analysisView);
        const billView = v === 'total' || v === 'perperson';
        btn.disabled = billView && !hasBills;
        btn.classList.toggle('disabled', billView && !hasBills);
    });

    const sortedKeys = Array.from(billsState.selectedComparisonMonths).sort((a, b) => {
        const [ay, am] = a.split('-').map(Number);
        const [by, bm] = b.split('-').map(Number);
        return ay !== by ? ay - by : am - bm;
    });
    const labels = sortedKeys.map(key => {
        const [y, mo] = key.split('-').map(Number);
        return `${MONTH_NAMES_SV[mo - 1].substring(0, 3)} ${y}`;
    });

    const ctx = document.getElementById('bills-analysis-chart');
    if (!ctx) return;

    const PARTNER_COLORS = [
        ['rgba(90,122,94,0.85)',  'rgba(60,95,65,1)'],
        ['rgba(90,130,180,0.85)', 'rgba(60,100,160,1)'],
        ['rgba(180,110,80,0.85)', 'rgba(150,80,55,1)'],
        ['rgba(160,90,160,0.85)', 'rgba(130,60,130,1)'],
    ];
    const STACK_GREEN         = 'rgba(76,175,80,0.82)';
    const STACK_GREEN_BORDER  = 'rgba(56,142,60,1)';
    const STACK_YELLOW        = 'rgba(255,193,7,0.88)';
    const STACK_YELLOW_BORDER = 'rgba(245,168,0,1)';
    const PERSONAL_COLORS = [
        ['rgba(255,193,7,0.88)',  'rgba(245,168,0,1)'],
        ['rgba(255,152,0,0.88)',  'rgba(230,120,0,1)'],
        ['rgba(255,235,59,0.88)', 'rgba(220,200,0,1)'],
        ['rgba(255,111,0,0.88)',  'rgba(230,80,0,1)'],
    ];

    let datasets, scales;

    if (billsState.analysisView === 'income') {
        const incomeMonths = _getIncomeForMonths(sortedKeys);
        datasets = partners.map((p, i) => {
            const [bg, border] = PARTNER_COLORS[i % PARTNER_COLORS.length];
            return { label: p.name, data: incomeMonths.map(m => m.incomes[p.name] || 0),
                     backgroundColor: bg, borderColor: border, borderWidth: 1, borderRadius: 4 };
        });
        scales = { y: { beginAtZero: true, ticks: { callback: v => v + ' kr', font: { size: 10 } } } };

    } else {
        const monthMap = {};
        data.months.forEach(m => { monthMap[_compMonthKey(m)] = m; });
        const filtered = sortedKeys.map(key => {
            if (monthMap[key]) return monthMap[key];
            const [y, mo] = key.split('-').map(Number);
            return _zeroMonth(y, mo, data.partners || []);
        });
        scales = {
            x: { stacked: true },
            y: { stacked: true, beginAtZero: true, ticks: { callback: v => v + ' kr', font: { size: 10 } } },
        };

        if (billsState.analysisView === 'total') {
            datasets = [
                { label: 'Delade kostnader', data: filtered.map(m => m.total_split),
                  backgroundColor: STACK_GREEN, borderColor: STACK_GREEN_BORDER, borderWidth: 1, borderSkipped: false, stack: 'total' },
                ...(data.partners || []).map((name, i) => {
                    const [bg, border] = PERSONAL_COLORS[i % PERSONAL_COLORS.length];
                    return { label: `${name} – Personliga`, data: filtered.map(m => m.per_partner_personal[name] || 0),
                             backgroundColor: bg, borderColor: border, borderWidth: 1, borderSkipped: false, stack: 'total' };
                }),
            ];
        } else {
            datasets = [];
            (data.partners || []).forEach(name => {
                datasets.push({ label: `${name} – Delade`, data: filtered.map(m => m.per_partner_shared[name] || 0),
                                backgroundColor: STACK_GREEN, borderColor: STACK_GREEN_BORDER, borderWidth: 1, borderSkipped: false, stack: name });
                datasets.push({ label: `${name} – Personliga`, data: filtered.map(m => m.per_partner_personal[name] || 0),
                                backgroundColor: STACK_YELLOW, borderColor: STACK_YELLOW_BORDER, borderWidth: 1, borderSkipped: false, stack: name });
            });
        }
    }

    billsState.comparisonCharts.main = new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets },
        options: { responsive: true, maintainAspectRatio: false, scales,
                   plugins: { legend: { position: 'top', labels: { font: { size: 10 } } } } },
    });
}

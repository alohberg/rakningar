// ── Utilities ─────────────────────────────────────────────────────────────────────────────────────────────────

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

// ── State ───────────────────────────────────────────────────────────────────────────────────────────

const MONTH_NAMES_SV = [
    'Januari','Februari','Mars','April','Maj','Juni',
    'Juli','Augusti','September','Oktober','November','December'
];

const billsState = {
    year:              new Date().getFullYear(),
    month:             new Date().getMonth() + 1,
    calYear:           new Date().getFullYear(),
    partners:          [],
    bills:             [],
    monthlyIncomes:    {},
    monthsWithBills:   new Set(),
    settledMonths:     new Set(),
    comparisonVisible: false,
    comparisonCharts:  {},
    comparisonData:    null,
    selectedComparisonMonths: new Set(),
};

const _incomeTimers = {};

// ── Boot ────────────────────────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
    await loadBillsPage();
});

async function loadBillsPage() {
    await Promise.all([
        loadBillPartners().catch(() => {}),
        loadBillsForMonth().catch(() => {}),
        loadBillsCalendarData().catch(() => {}),
        loadBillIncomes().catch(() => {}),
    ]);
    renderBillsPartners();
    renderBillsIncomeSummary();
    renderBillsTable();
    try { await renderBillsSettlement(); } catch(e) {}
    updateBillsMonthLabel();
    renderBillsMonthCalendar();
    updateBillsSettledCheckbox(true);
    initMobilePanels();
}

// ── Data loaders ───────────────────────────────────────────────────────────────────────────────────

async function loadBillPartners() {
    const res = await fetch('/api/bill-partners');
    billsState.partners = await res.json();
}

async function loadBillIncomes() {
    const res = await fetch(`/api/bill-incomes?year=${billsState.year}&month=${billsState.month}`);
    if (res.ok) {
        const data = await res.json();
        billsState.monthlyIncomes = {};
        data.forEach(d => { billsState.monthlyIncomes[d.partner_id] = d.income || 0; });
    }
}

async function loadBillsForMonth() {
    const res = await fetch(`/api/bills?year=${billsState.year}&month=${billsState.month}`);
    billsState.bills = await res.json();
}

async function loadBillsCalendarData() {
    const [monthsRes, settledRes] = await Promise.all([
        fetch('/api/bills/months'),
        fetch('/api/bills/settled'),
    ]);
    if (monthsRes.ok) {
        const months = await monthsRes.json();
        billsState.monthsWithBills = new Set(months.map(m => `${m.year}-${m.month}`));
    }
    if (settledRes.ok) {
        const settled = await settledRes.json();
        billsState.settledMonths = new Set(settled.map(m => `${m.year}-${m.month}`));
    }
}

// ── Renderers ───────────────────────────────────────────────────────────────────────────────────────────────

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
    billsState.monthlyIncomes[partnerId] = parseFloat(value) || 0;
    _updateIncomeShareBadges();
    clearTimeout(_incomeTimers[partnerId]);
    _incomeTimers[partnerId] = setTimeout(async () => {
        await saveBillIncome(partnerId, billsState.monthlyIncomes[partnerId]);
        await renderBillsSettlement();
    }, 700);
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

async function saveBillIncome(partnerId, income) {
    await fetch('/api/bill-incomes', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ partner_id: partnerId, year: billsState.year, month: billsState.month, income }),
    });
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

async function renderBillsSettlement() {
    const body = document.getElementById('bills-settlement-body');
    if (!body) return;
    if (billsState.partners.length < 2) {
        body.innerHTML = '<p class="bills-settlement-empty">Lägg till minst två deltagare för att beräkna uppgörelsen.</p>';
        return;
    }
    const splitBills = billsState.bills.filter(b => b.is_split);
    if (splitBills.length === 0) {
        body.innerHTML = '<p class="bills-settlement-empty">Inga delade räkningar den här månaden.</p>';
        return;
    }
    const res  = await fetch(`/api/bills/summary?year=${billsState.year}&month=${billsState.month}`);
    const data = await res.json();
    const settledKey = `${billsState.year}-${billsState.month}`;
    const settled    = billsState.settledMonths.has(settledKey);
    const partnerBlocks = data.partners.map(p => {
        const monthTotal   = p.fair_share + p.personal;
        const diff         = p.balance;
        const balanceCls   = diff >= 0 ? 'bills-balance-positive' : 'bills-balance-negative';
        const balanceLabel = settled
            ? (diff >= 0 ? `Fick tillbaka ${formatCurrency(diff)}` : `Betalade ${formatCurrency(Math.abs(diff))}`)
            : (diff >= 0 ? `Får tillbaka ${formatCurrency(diff)}` : `Är skyldig ${formatCurrency(Math.abs(diff))}`);
        const partnerData  = billsState.partners.find(x => x.name === p.name);
        const monthIncome  = partnerData ? (billsState.monthlyIncomes[partnerData.id] || 0) : 0;
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
    body.innerHTML = `
        ${partnerBlocks}
        <div class="bills-transfers-section">
            <div class="bills-transfers-title">${transfersTitle}</div>
            ${transferRows}
        </div>
        <div class="bills-total-summary">
            <span>Delade kostnader</span>
            <strong>${formatCurrency(data.total_split)}</strong>
        </div>`;
}

// ── Month calendar ────────────────────────────────────────────────────────────────────────────────────

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
        _renderComparisonMonthChips(billsState.comparisonData);
        destroyBillsCharts();
        _renderComparisonChartData();
        return;
    }
    billsState.year    = year;
    billsState.month   = month;
    billsState.calYear = year;
    Promise.all([loadBillsForMonth(), loadBillIncomes()]).then(() => {
        renderBillsTable();
        renderBillsSettlement();
        renderBillsIncomeSummary();
        updateBillsMonthLabel();
        renderBillsMonthCalendar();
        updateBillsSettledCheckbox();
    });
}

// ── Month navigation ──────────────────────────────────────────────────────────────────────────────────────────────

function billsChangeMonth(delta) {
    let m = billsState.month + delta;
    let y = billsState.year;
    if (m > 12) { m = 1;  y++; }
    if (m < 1)  { m = 12; y--; }
    billsState.month   = m;
    billsState.year    = y;
    billsState.calYear = y;
    Promise.all([loadBillsForMonth(), loadBillIncomes()]).then(() => {
        renderBillsTable();
        renderBillsSettlement();
        renderBillsIncomeSummary();
        updateBillsMonthLabel();
        renderBillsMonthCalendar();
        updateBillsSettledCheckbox(true);
        _syncComparisonToMonth();
    });
}

function _syncComparisonToMonth() {
    if (!billsState.comparisonVisible || !billsState.comparisonData) return;
    billsState.selectedComparisonMonths = new Set([`${billsState.year}-${billsState.month}`]);
    _renderComparisonMonthChips(billsState.comparisonData);
    destroyBillsCharts();
    _renderComparisonChartData();
}

// ── View toggles ────────────────────────────────────────────────────────────────────────────────────────

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

window.addEventListener('resize', () => {
    if (window.innerWidth > 750) {
        ['calendar', 'costs', 'settlement'].forEach(v => {
            const el = document.getElementById(`bills-view-${v}`);
            if (el) { el.classList.remove('hidden'); el.classList.remove('mobile-active'); }
        });
    } else {
        initMobilePanels();
    }
});

// ── Settled ──────────────────────────────────────────────────────────────────────────────────────────────

function updateBillsSettledCheckbox(celebrate = false) {
    const cb = document.getElementById('bills-settled-checkbox');
    if (!cb) return;
    const key     = `${billsState.year}-${billsState.month}`;
    const settled = billsState.settledMonths.has(key);
    cb.checked = settled;
    if (settled && celebrate) celebrateBillsSettled();
}

async function toggleBillsSettled(checked) {
    const year  = billsState.year;
    const month = billsState.month;
    const key   = `${year}-${month}`;
    if (checked) {
        await fetch('/api/bills/settled', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ year, month }),
        });
        billsState.settledMonths.add(key);
        celebrateBillsSettled();
    } else {
        await fetch(`/api/bills/settled/${year}/${month}`, { method: 'DELETE' });
        billsState.settledMonths.delete(key);
    }
    updateBillsSettledCheckbox();
    renderBillsSettlement();
    renderBillsMonthCalendar();
}

function celebrateBillsSettled() {}

// ── Add/save bill ────────────────────────────────────────────────────────────────────────────────────

async function openAddBillModal() {
    if (billsState.partners.length === 0) {
        await loadBillPartners();
        renderBillsPartners();
    }
    if (billsState.partners.length === 0) {
        showToast('Lägg till minst en deltagare först', 'error');
        return;
    }
    const sel = document.getElementById('bill-payer-inline');
    if (sel) sel.innerHTML = billsState.partners.map(p =>
        `<option value="${p.id}">${escHtml(p.name)}</option>`).join('');
    document.getElementById('bill-name-inline').value   = '';
    document.getElementById('bill-amount-inline').value = '';
    document.getElementById('bill-split-inline').checked = true;
    document.getElementById('add-bill-modal').classList.remove('hidden');
    setTimeout(() => document.getElementById('bill-name-inline').focus(), 50);
}

function closeAddBillModal() {
    document.getElementById('add-bill-modal').classList.add('hidden');
}

async function saveBillInline() {
    const name    = (document.getElementById('bill-name-inline').value || '').trim();
    const amount  = parseFloat(document.getElementById('bill-amount-inline').value);
    const paidBy  = parseInt(document.getElementById('bill-payer-inline').value);
    const isSplit = document.getElementById('bill-split-inline').checked;
    if (!name || isNaN(amount) || amount <= 0) {
        showToast('Fyll i namn och belopp', 'error');
        return;
    }
    const res = await fetch('/api/bills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, amount, paid_by: paidBy,
                               year: billsState.year, month: billsState.month, is_split: isSplit }),
    });
    if (res.ok) {
        closeAddBillModal();
        await loadBillsForMonth();
        renderBillsTable();
        await renderBillsSettlement();
        await loadBillsCalendarData();
        renderBillsMonthCalendar();
        if (billsState.comparisonVisible) await renderBillsComparisonCharts();
        showToast('Räkning sparad', 'success');
    } else {
        showToast('Kunde inte spara räkning', 'error');
    }
}

async function deleteBill(id) {
    const res = await fetch(`/api/bills/${id}`, { method: 'DELETE' });
    if (res.ok) {
        await loadBillsForMonth();
        renderBillsTable();
        renderBillsSettlement();
        await loadBillsCalendarData();
        renderBillsMonthCalendar();
    }
}

async function toggleBillSplit(id) {
    const res = await fetch(`/api/bills/${id}/toggle-split`, { method: 'PATCH' });
    if (res.ok) {
        const data = await res.json();
        const bill = billsState.bills.find(b => b.id === id);
        if (bill) bill.is_split = data.is_split;
        renderBillsTable();
        await renderBillsSettlement();
        if (billsState.comparisonVisible) await renderBillsComparisonCharts();
    }
}

// ── Partners ──────────────────────────────────────────────────────────────────────────────────────────────

function openAddPartnerModal() {
    document.getElementById('partner-name-input').value = '';
    document.getElementById('add-partner-modal').classList.remove('hidden');
    document.getElementById('partner-name-input').focus();
}

async function savePartner() {
    const name = document.getElementById('partner-name-input').value.trim();
    if (!name) { showToast('Ange ett namn', 'error'); return; }
    const res = await fetch('/api/bill-partners', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
    });
    if (res.ok) {
        document.getElementById('add-partner-modal').classList.add('hidden');
        await loadBillPartners();
        renderBillsPartners();
        renderBillsIncomeSummary();
        renderBillsSettlement();
        showToast('Deltagare tillagd', 'success');
    } else {
        const err = await res.json();
        showToast(err.error || 'Kunde inte spara deltagare', 'error');
    }
}

function openEditPartnerModal(id) {
    const p = billsState.partners.find(x => x.id === id);
    if (!p) return;
    document.getElementById('edit-partner-id').value         = p.id;
    document.getElementById('edit-partner-name-input').value = p.name;
    document.getElementById('edit-partner-modal').classList.remove('hidden');
    document.getElementById('edit-partner-name-input').focus();
}

async function updatePartner() {
    const id   = parseInt(document.getElementById('edit-partner-id').value);
    const name = document.getElementById('edit-partner-name-input').value.trim();
    if (!name) { showToast('Fyll i namn', 'error'); return; }
    const res = await fetch(`/api/bill-partners/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
    });
    if (res.ok) {
        document.getElementById('edit-partner-modal').classList.add('hidden');
        await loadBillPartners();
        renderBillsPartners();
        renderBillsIncomeSummary();
        renderBillsSettlement();
        showToast('Deltagare uppdaterad', 'success');
    } else {
        const err = await res.json();
        showToast(err.error || 'Kunde inte uppdatera', 'error');
    }
}

async function deletePartner(id) {
    const res = await fetch(`/api/bill-partners/${id}`, { method: 'DELETE' });
    if (res.ok) {
        delete billsState.monthlyIncomes[id];
        await loadBillPartners();
        renderBillsPartners();
        renderBillsIncomeSummary();
        renderBillsSettlement();
    }
}

// ── Comparison charts ──────────────────────────────────────────────────────────────────────────────────

async function toggleBillsComparison() {
    const section = document.getElementById('bills-comparison-section');
    const btn     = document.getElementById('bills-comparison-btn');
    if (!section) return;
    billsState.comparisonVisible = !billsState.comparisonVisible;
    if (billsState.comparisonVisible) {
        section.classList.remove('hidden');
        if (btn) btn.classList.add('active');
        await renderBillsComparisonCharts();
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

function _compMonthKey(m) { return `${m.year}-${m.month}`; }

async function renderBillsComparisonCharts() {
    destroyBillsCharts();
    const res  = await fetch('/api/bills/comparison');
    const data = await res.json();
    if (!data.months || data.months.length === 0) {
        const section = document.getElementById('bills-comparison-section');
        if (section) section.innerHTML = '<p style="color:var(--text-muted);font-size:12px;padding:8px 0">Inga data att jämföra ännu.</p>';
        return;
    }
    billsState.comparisonData = data;
    const currentKey = `${billsState.year}-${billsState.month}`;
    if (!billsState.selectedComparisonMonths || billsState.selectedComparisonMonths.size === 0) {
        billsState.selectedComparisonMonths = new Set([currentKey]);
    }
    _renderComparisonMonthChips(data);
    _renderComparisonChartData();
}

function _renderComparisonMonthChips(data) {
    const section = document.getElementById('bills-comparison-section');
    if (!section) return;
    let selector = document.getElementById('bills-comp-month-selector');
    if (!selector) {
        selector = document.createElement('div');
        selector.id = 'bills-comp-month-selector';
        selector.className = 'bills-comp-month-selector';
        section.prepend(selector);
    }
    const currentKey  = `${billsState.year}-${billsState.month}`;
    const [cy, cm]    = currentKey.split('-').map(Number);
    const activeLabel = `${MONTH_NAMES_SV[cm - 1]} ${cy}`;
    const extraKeys = Array.from(billsState.selectedComparisonMonths)
        .filter(k => k !== currentKey)
        .sort((a, b) => {
            const [ay, am] = a.split('-').map(Number);
            const [by, bm] = b.split('-').map(Number);
            return ay !== by ? ay - by : am - bm;
        });
    const extraChips = extraKeys.map(key => {
        const [y, mo] = key.split('-').map(Number);
        const label   = `${MONTH_NAMES_SV[mo - 1].substring(0, 3)} ${y}`;
        return `<span class="bills-comp-extra-chip">${label}<button class="bills-comp-remove" onclick="removeComparisonMonth('${key}')" title="Ta bort">×</button></span>`;
    }).join('');
    const atCap = billsState.selectedComparisonMonths.size >= 12;
    const hint  = atCap
        ? `<span class="bills-comp-cap-note">Max 12 månader valda</span>`
        : `<span class="bills-comp-hint">Klicka månader i kalendern för att jämföra</span>`;
    selector.innerHTML = `<span class="bills-comp-active-label">${activeLabel}</span>${extraChips}${hint}`;
}

function removeComparisonMonth(key) {
    billsState.selectedComparisonMonths.delete(key);
    renderBillsMonthCalendar();
    _renderComparisonMonthChips(billsState.comparisonData);
    destroyBillsCharts();
    _renderComparisonChartData();
}

function _zeroMonth(year, month, partners) {
    const empty = {};
    partners.forEach(name => { empty[name] = 0; });
    return { year, month, total: 0, total_split: 0, total_personal: 0,
             per_partner_shared: {...empty}, per_partner_personal: {...empty} };
}

function _renderComparisonChartData() {
    const data     = billsState.comparisonData;
    const monthMap = {};
    data.months.forEach(m => { monthMap[_compMonthKey(m)] = m; });
    const filtered = Array.from(billsState.selectedComparisonMonths)
        .sort((a, b) => {
            const [ay, am] = a.split('-').map(Number);
            const [by, bm] = b.split('-').map(Number);
            return ay !== by ? ay - by : am - bm;
        })
        .map(key => {
            if (monthMap[key]) return monthMap[key];
            const [y, mo] = key.split('-').map(Number);
            return _zeroMonth(y, mo, data.partners);
        });
    const labels            = filtered.map(m => `${MONTH_NAMES_SV[m.month - 1].substring(0,3)} ${m.year}`);
    const STACK_GREEN        = 'rgba(76,175,80,0.82)';
    const STACK_GREEN_BORDER = 'rgba(56,142,60,1)';
    const STACK_YELLOW        = 'rgba(255,193,7,0.88)';
    const STACK_YELLOW_BORDER = 'rgba(245,168,0,1)';
    const stackedScales = {
        x: { stacked: true },
        y: { stacked: true, beginAtZero: true, ticks: { callback: v => v + ' kr', font: { size: 10 } } },
    };
    const ctxTotal = document.getElementById('bills-total-chart');
    if (ctxTotal) {
        const PERSONAL_COLORS = [
            ['rgba(255,193,7,0.88)',  'rgba(245,168,0,1)'],
            ['rgba(255,152,0,0.88)',  'rgba(230,120,0,1)'],
            ['rgba(255,235,59,0.88)', 'rgba(220,200,0,1)'],
            ['rgba(255,111,0,0.88)',  'rgba(230,80,0,1)'],
        ];
        const totalDatasets = [
            { label: 'Delade kostnader', data: filtered.map(m => m.total_split),
              backgroundColor: STACK_GREEN, borderColor: STACK_GREEN_BORDER, borderWidth: 1, borderSkipped: false, stack: 'total' },
            ...data.partners.map((name, i) => {
                const [bg, border] = PERSONAL_COLORS[i % PERSONAL_COLORS.length];
                return { label: `${name} – Personliga`, data: filtered.map(m => m.per_partner_personal[name] || 0),
                         backgroundColor: bg, borderColor: border, borderWidth: 1, borderSkipped: false, stack: 'total' };
            }),
        ];
        billsState.comparisonCharts.total = new Chart(ctxTotal, {
            type: 'bar',
            data: { labels, datasets: totalDatasets },
            options: { responsive: true, maintainAspectRatio: true, scales: stackedScales,
                       plugins: { legend: { position: 'top', labels: { font: { size: 10 } } } } },
        });
    }
    const ctxPP = document.getElementById('bills-per-person-chart');
    if (ctxPP && data.partners.length > 0) {
        const ppDatasets = [];
        data.partners.forEach(name => {
            ppDatasets.push({ label: `${name} – Delade`, data: filtered.map(m => m.per_partner_shared[name] || 0),
                              backgroundColor: STACK_GREEN, borderColor: STACK_GREEN_BORDER, borderWidth: 1, borderSkipped: false, stack: name });
            ppDatasets.push({ label: `${name} – Personliga`, data: filtered.map(m => m.per_partner_personal[name] || 0),
                              backgroundColor: STACK_YELLOW, borderColor: STACK_YELLOW_BORDER, borderWidth: 1, borderSkipped: false, stack: name });
        });
        billsState.comparisonCharts.perPerson = new Chart(ctxPP, {
            type: 'bar',
            data: { labels, datasets: ppDatasets },
            options: { responsive: true, maintainAspectRatio: true, scales: stackedScales,
                       plugins: { legend: { position: 'top', labels: { font: { size: 10 } } } } },
        });
    }
}

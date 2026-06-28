// ── Utilities ─────────────────────────────────────────────────────────────────

function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = 'toast toast-' + type;
    const icon = type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️';
    toast.textContent = `${icon} ${message}`;
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

// ── State ─────────────────────────────────────────────────────────────────────

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
    monthsWithBills:   new Set(),
    settledMonths:     new Set(),
    comparisonVisible: false,
    comparisonCharts:  {},
    comparisonData:    null,
    selectedComparisonMonths: new Set(),
};

// ── Boot ──────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
    await loadBillsPage();
});

async function loadBillsPage() {
    await Promise.all([
        loadBillPartners().catch(() => {}),
        loadBillsForMonth().catch(() => {}),
        loadBillsCalendarData().catch(() => {}),
    ]);
    renderBillsPartners();
    renderBillsTable();
    try { await renderBillsSettlement(); } catch(e) {}
    updateBillsMonthLabel();
    renderBillsMonthCalendar();
    updateBillsSettledCheckbox(true);
}

// ── Data loaders ──────────────────────────────────────────────────────────────

async function loadBillPartners() {
    const res = await fetch('/api/bill-partners');
    billsState.partners = await res.json();
    renderBillsIncomeSummary();
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

// ── Renderers ─────────────────────────────────────────────────────────────────

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
    const withIncome = partners.filter(p => p.income > 0);
    if (withIncome.length === 0) { el.innerHTML = ''; return; }
    const totalIncome = partners.reduce((s, p) => s + (p.income || 0), 0);
    const rows = partners.map(p => `
        <div class="bills-income-row">
            <span class="bills-income-name">${escHtml(p.name)}</span>
            <span class="bills-income-figures">
                ${p.income ? formatCurrency(p.income) + '/mån' : '—'}
                <span class="bills-income-share-badge">${p.share}%</span>
            </span>
        </div>`).join('');
    el.innerHTML = `
        <div class="bills-income-block">
            <div class="bills-income-block-title">Inkomster</div>
            ${rows}
            <div class="bills-income-block-total">
                <span>Totalt</span>
                <span>${formatCurrency(totalIncome)}/mån</span>
            </div>
        </div>`;
}

function renderBillsPartners() {
    const list = document.getElementById('bills-partners-list');
    if (!list) return;
    if (billsState.partners.length === 0) {
        list.innerHTML = '<span style="font-size:13px;color:var(--text-muted);font-style:italic">Inga deltagare ännu</span>';
        return;
    }
    const totalShare = billsState.partners.reduce((s, p) => s + (p.share || 0), 0);
    const warn = Math.abs(totalShare - 100) > 0.5
        ? `<span class="bills-share-warning" title="Andelarna summerar till ${totalShare}%, inte 100%">⚠ ${totalShare}%</span>`
        : '';
    list.innerHTML = billsState.partners.map(p => {
        const incomeStr = p.income ? ` · ${Math.round(p.income / 1000)}k` : '';
        const shareStr  = p.share != null ? p.share + '%' : '';
        return `
        <span class="bills-partner-chip">
            <button class="bills-partner-chip-edit" onclick="openEditPartnerModal(${p.id})" title="Redigera">
                ${escHtml(p.name)}
                <span class="bills-partner-share-badge">${shareStr}${incomeStr}</span>
            </button>
            <button class="bills-partner-delete" onclick="deletePartner(${p.id})" title="Ta bort">×</button>
        </span>`;
    }).join('') + warn;
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
        const incomeLabel  = partnerData && partnerData.income
            ? `<span class="bills-partner-income-label">${formatCurrency(partnerData.income)}/mån</span>`
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

// ── Month calendar ────────────────────────────────────────────────────────────

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
    loadBillsForMonth().then(() => {
        renderBillsTable();
        renderBillsSettlement();
        updateBillsMonthLabel();
        renderBillsMonthCalendar();
        updateBillsSettledCheckbox();
    });
}

// ── Month navigation ──────────────────────────────────────────────────────────

function billsChangeMonth(delta) {
    let m = billsState.month + delta;
    let y = billsState.year;
    if (m > 12) { m = 1;  y++; }
    if (m < 1)  { m = 12; y--; }
    billsState.month   = m;
    billsState.year    = y;
    billsState.calYear = y;
    loadBillsForMonth().then(() => {
        renderBillsTable();
        renderBillsSettlement();
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

// ── View toggles ──────────────────────────────────────────────────────────────

function toggleBillsView(view) {
    const panel = document.getElementById(`bills-view-${view}`);
    const btn   = document.querySelector(`.bills-view-tab[data-view="${view}"]`);
    if (!panel) return;
    const nowHidden = panel.classList.toggle('hidden');
    if (btn) btn.classList.toggle('active', !nowHidden);
}

// ── Settled ───────────────────────────────────────────────────────────────────

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

function celebrateBillsSettled() {
    const old = document.getElementById('bills-fireworks-canvas');
    if (old) old.remove();
    const canvas = document.createElement('canvas');
    canvas.id = 'bills-fireworks-canvas';
    canvas.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:9998;';
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    const COLORS = ['#5a7a5e','#8fbc8f','#f0c040','#e07840','#b06050','#6a8aaa','#c8a060'];
    const particles = [];
    function spawnBurst(x, y) {
        const color = COLORS[Math.floor(Math.random() * COLORS.length)];
        for (let i = 0; i < 50; i++) {
            const angle = (Math.PI * 2 / 50) * i + (Math.random() - 0.5) * 0.3;
            const speed = Math.random() * 5 + 2;
            particles.push({ x, y, vx: Math.cos(angle)*speed, vy: Math.sin(angle)*speed-1,
                             alpha: 1, radius: Math.random()*3+1, color, gravity: 0.12 });
        }
    }
    const positions = [0.2, 0.5, 0.8, 0.35, 0.65, 0.5];
    positions.forEach((xFrac, i) => {
        setTimeout(() => spawnBurst(canvas.width*xFrac, canvas.height*(0.15+Math.random()*0.4)), i*280);
    });
    const bottle = document.createElement('div');
    bottle.textContent = '🍾';
    bottle.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-60%) scale(0) rotate(-15deg);font-size:90px;z-index:9999;pointer-events:none;transition:transform 0.45s cubic-bezier(0.34,1.56,0.64,1),opacity 0.4s ease;opacity:0;';
    document.body.appendChild(bottle);
    requestAnimationFrame(() => requestAnimationFrame(() => {
        bottle.style.transform = 'translate(-50%,-60%) scale(1) rotate(8deg)';
        bottle.style.opacity   = '1';
    }));
    setTimeout(() => {
        bottle.style.opacity   = '0';
        bottle.style.transform = 'translate(-50%,-80%) scale(0.8) rotate(8deg)';
        setTimeout(() => bottle.remove(), 400);
    }, 1800);
    const start = Date.now();
    function frame() {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        for (let i = particles.length-1; i >= 0; i--) {
            const p = particles[i];
            p.vx *= 0.97; p.vy += p.gravity; p.x += p.vx; p.y += p.vy; p.alpha -= 0.016;
            if (p.alpha <= 0) { particles.splice(i,1); continue; }
            ctx.globalAlpha = p.alpha; ctx.fillStyle = p.color;
            ctx.beginPath(); ctx.arc(p.x, p.y, p.radius, 0, Math.PI*2); ctx.fill();
        }
        ctx.globalAlpha = 1;
        if (Date.now()-start < 3000 || particles.length > 0) requestAnimationFrame(frame);
        else canvas.remove();
    }
    requestAnimationFrame(frame);
}

// ── Add/save bill ─────────────────────────────────────────────────────────────

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

// ── Partners ──────────────────────────────────────────────────────────────────

function openAddPartnerModal() {
    document.getElementById('partner-name-input').value   = '';
    document.getElementById('partner-income-input').value = '';
    const hint = document.getElementById('partner-income-hint');
    if (hint) hint.textContent = '';
    document.getElementById('add-partner-modal').classList.remove('hidden');
    document.getElementById('partner-name-input').focus();
}

async function savePartner() {
    const name   = document.getElementById('partner-name-input').value.trim();
    const income = parseFloat(document.getElementById('partner-income-input').value) || 0;
    if (!name) { showToast('Ange ett namn', 'error'); return; }
    const res = await fetch('/api/bill-partners', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, income }),
    });
    if (res.ok) {
        document.getElementById('add-partner-modal').classList.add('hidden');
        await loadBillPartners();
        renderBillsPartners();
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
    document.getElementById('edit-partner-id').value           = p.id;
    document.getElementById('edit-partner-name-input').value   = p.name;
    document.getElementById('edit-partner-income-input').value = p.income || '';
    const hint = document.getElementById('edit-partner-income-hint');
    if (hint) {
        hint.textContent = p.income
            ? `Nuvarande andel: ${p.share}%`
            : 'Ange inkomst för att beräkna andel automatiskt';
    }
    document.getElementById('edit-partner-modal').classList.remove('hidden');
    document.getElementById('edit-partner-name-input').focus();
}

async function updatePartner() {
    const id     = parseInt(document.getElementById('edit-partner-id').value);
    const name   = document.getElementById('edit-partner-name-input').value.trim();
    const income = parseFloat(document.getElementById('edit-partner-income-input').value) || 0;
    if (!name) { showToast('Fyll i namn', 'error'); return; }
    const res = await fetch(`/api/bill-partners/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, income }),
    });
    if (res.ok) {
        document.getElementById('edit-partner-modal').classList.add('hidden');
        await loadBillPartners();
        renderBillsPartners();
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
        await loadBillPartners();
        renderBillsPartners();
        renderBillsSettlement();
    }
}

function updatePartnerIncomeHint() {
    const income = parseFloat(document.getElementById('partner-income-input').value) || 0;
    const hint   = document.getElementById('partner-income-hint');
    if (!hint) return;
    if (income <= 0) { hint.textContent = ''; return; }
    const othersTotal = billsState.partners.reduce((s, p) => s + (p.income || 0), 0);
    const total = othersTotal + income;
    const pct   = Math.round(income / total * 1000) / 10;
    const otherPcts = billsState.partners.map(p => {
        const share = Math.round((p.income || 0) / total * 1000) / 10;
        return `${p.name} ${share}%`;
    }).join(', ');
    hint.textContent = `Din andel: ${pct}%` + (otherPcts ? ` · ${otherPcts}` : '');
}

function updateEditPartnerIncomeHint() {
    const id     = parseInt(document.getElementById('edit-partner-id').value);
    const income = parseFloat(document.getElementById('edit-partner-income-input').value) || 0;
    const hint   = document.getElementById('edit-partner-income-hint');
    if (!hint) return;
    if (income <= 0) { hint.textContent = ''; return; }
    const othersTotal = billsState.partners.reduce((s, p) => p.id !== id ? s + (p.income || 0) : s, 0);
    const total = othersTotal + income;
    const pct   = Math.round(income / total * 1000) / 10;
    const otherPcts = billsState.partners.filter(p => p.id !== id).map(p => {
        const share = Math.round((p.income || 0) / total * 1000) / 10;
        return `${p.name} ${share}%`;
    }).join(', ');
    hint.textContent = `Din andel: ${pct}%` + (otherPcts ? ` · ${otherPcts}` : '');
}

// ── Comparison charts ─────────────────────────────────────────────────────────

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

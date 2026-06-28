import os
import sqlite3
from flask import Flask, render_template, request, jsonify

app = Flask(
    __name__,
    template_folder=os.path.join(os.path.dirname(__file__), '..', 'templates'),
    static_folder=os.path.join(os.path.dirname(__file__), '..', 'static'),
)

# On Vercel the filesystem is read-only except /tmp
DB_PATH = os.environ.get('DB_PATH', os.path.join(os.path.dirname(__file__), '..', 'rakningar.db'))
if not os.access(os.path.dirname(DB_PATH) or '.', os.W_OK):
    DB_PATH = '/tmp/rakningar.db'


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys = ON')
    return conn


def init_db():
    conn = get_db()
    conn.executescript('''
        CREATE TABLE IF NOT EXISTS bill_partners (
            id      INTEGER PRIMARY KEY AUTOINCREMENT,
            name    TEXT NOT NULL UNIQUE,
            share   REAL DEFAULT 50,
            income  REAL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS bills (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            name       TEXT NOT NULL,
            amount     REAL NOT NULL,
            paid_by    INTEGER NOT NULL,
            year       INTEGER NOT NULL,
            month      INTEGER NOT NULL,
            is_split   INTEGER DEFAULT 1,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(paid_by) REFERENCES bill_partners(id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS bill_month_settled (
            year  INTEGER NOT NULL,
            month INTEGER NOT NULL,
            PRIMARY KEY (year, month)
        );
        CREATE TABLE IF NOT EXISTS bill_partner_incomes (
            partner_id INTEGER NOT NULL,
            year       INTEGER NOT NULL,
            month      INTEGER NOT NULL,
            income     REAL NOT NULL DEFAULT 0,
            PRIMARY KEY (partner_id, year, month),
            FOREIGN KEY (partner_id) REFERENCES bill_partners(id) ON DELETE CASCADE
        );
    ''')
    conn.commit()
    conn.close()


init_db()


def _recalculate_partner_shares(conn):
    rows = conn.execute('SELECT id, income FROM bill_partners').fetchall()
    if not rows:
        return
    if not all((r['income'] or 0) > 0 for r in rows):
        return
    total = sum(r['income'] for r in rows)
    for r in rows:
        share = round(r['income'] / total * 100, 1)
        conn.execute('UPDATE bill_partners SET share = ? WHERE id = ?', (share, r['id']))


# ── Routes ────────────────────────────────────────────────────────────────────────────────────

@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/bill-partners', methods=['GET'])
def get_bill_partners():
    conn = get_db()
    rows = conn.execute('SELECT * FROM bill_partners ORDER BY name').fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route('/api/bill-partners', methods=['POST'])
def create_bill_partner():
    data   = request.json
    name   = (data.get('name') or '').strip()
    income = float(data.get('income') or 0)
    share  = float(data.get('share') or 50)
    if not name:
        return jsonify({'error': 'Namn krävs'}), 400
    conn = get_db()
    try:
        conn.execute('INSERT INTO bill_partners (name, share, income) VALUES (?, ?, ?)',
                     (name, share, income))
        conn.commit()
        _recalculate_partner_shares(conn)
        conn.commit()
        row = conn.execute('SELECT * FROM bill_partners WHERE name = ?', (name,)).fetchone()
        conn.close()
        return jsonify(dict(row)), 201
    except Exception as e:
        conn.close()
        return jsonify({'error': str(e)}), 400


@app.route('/api/bill-partners/<int:pid>', methods=['PATCH'])
def update_bill_partner(pid):
    data = request.json
    conn = get_db()
    row  = conn.execute('SELECT * FROM bill_partners WHERE id = ?', (pid,)).fetchone()
    if not row:
        conn.close()
        return jsonify({'error': 'Hittades inte'}), 404
    name   = (data.get('name') or '').strip() or row['name']
    income = float(data.get('income') if data.get('income') is not None else (row['income'] or 0))
    share  = float(data.get('share')  if data.get('share')  is not None else row['share'])
    try:
        conn.execute('UPDATE bill_partners SET name = ?, share = ?, income = ? WHERE id = ?',
                     (name, share, income, pid))
        conn.commit()
        _recalculate_partner_shares(conn)
        conn.commit()
        updated = conn.execute('SELECT * FROM bill_partners WHERE id = ?', (pid,)).fetchone()
        conn.close()
        return jsonify(dict(updated))
    except Exception as e:
        conn.close()
        return jsonify({'error': str(e)}), 400


@app.route('/api/bill-partners/<int:pid>', methods=['DELETE'])
def delete_bill_partner(pid):
    conn = get_db()
    conn.execute('DELETE FROM bill_partners WHERE id = ?', (pid,))
    conn.commit()
    conn.close()
    return jsonify({'ok': True})


@app.route('/api/bills', methods=['GET'])
def get_bills():
    year  = request.args.get('year',  type=int)
    month = request.args.get('month', type=int)
    conn  = get_db()
    if year and month:
        rows = conn.execute('''
            SELECT b.*, p.name as partner_name
            FROM bills b JOIN bill_partners p ON p.id = b.paid_by
            WHERE b.year = ? AND b.month = ?
            ORDER BY b.created_at
        ''', (year, month)).fetchall()
    else:
        rows = conn.execute('''
            SELECT b.*, p.name as partner_name
            FROM bills b JOIN bill_partners p ON p.id = b.paid_by
            ORDER BY b.year DESC, b.month DESC, b.created_at
        ''').fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route('/api/bills', methods=['POST'])
def create_bill():
    data     = request.json
    name     = (data.get('name') or '').strip()
    amount   = data.get('amount')
    paid_by  = data.get('paid_by')
    year     = data.get('year')
    month    = data.get('month')
    is_split = 1 if data.get('is_split', True) else 0
    if not name or amount is None or not paid_by or not year or not month:
        return jsonify({'error': 'Ogiltiga fält'}), 400
    conn = get_db()
    try:
        conn.execute(
            'INSERT INTO bills (name, amount, paid_by, year, month, is_split) VALUES (?, ?, ?, ?, ?, ?)',
            (name, float(amount), int(paid_by), int(year), int(month), is_split)
        )
        conn.commit()
        row = conn.execute('''
            SELECT b.*, p.name as partner_name FROM bills b
            JOIN bill_partners p ON p.id = b.paid_by
            ORDER BY b.id DESC LIMIT 1
        ''').fetchone()
        conn.close()
        return jsonify(dict(row)), 201
    except Exception as e:
        conn.close()
        return jsonify({'error': str(e)}), 400


@app.route('/api/bills/<int:bid>/toggle-split', methods=['PATCH'])
def toggle_bill_split(bid):
    conn = get_db()
    row  = conn.execute('SELECT is_split FROM bills WHERE id = ?', (bid,)).fetchone()
    if not row:
        conn.close()
        return jsonify({'error': 'Hittades inte'}), 404
    new_val = 0 if row['is_split'] else 1
    conn.execute('UPDATE bills SET is_split = ? WHERE id = ?', (new_val, bid))
    conn.commit()
    conn.close()
    return jsonify({'is_split': new_val})


@app.route('/api/bills/<int:bid>', methods=['DELETE'])
def delete_bill(bid):
    conn = get_db()
    conn.execute('DELETE FROM bills WHERE id = ?', (bid,))
    conn.commit()
    conn.close()
    return jsonify({'ok': True})


@app.route('/api/bill-incomes', methods=['GET'])
def get_bill_incomes():
    year  = request.args.get('year',  type=int)
    month = request.args.get('month', type=int)
    if not year or not month:
        return jsonify({'error': 'year och month krävs'}), 400
    conn     = get_db()
    partners = conn.execute('SELECT id FROM bill_partners ORDER BY name').fetchall()
    stored   = {r['partner_id']: r['income'] for r in conn.execute(
        'SELECT partner_id, income FROM bill_partner_incomes WHERE year=? AND month=?',
        (year, month)
    ).fetchall()}
    conn.close()
    return jsonify([{'partner_id': p['id'], 'income': stored.get(p['id'], 0)} for p in partners])


@app.route('/api/bill-incomes', methods=['PATCH'])
def upsert_bill_income():
    data       = request.json
    partner_id = data.get('partner_id')
    year       = data.get('year')
    month      = data.get('month')
    income     = float(data.get('income') or 0)
    if not partner_id or not year or not month:
        return jsonify({'error': 'partner_id, year och month krävs'}), 400
    conn = get_db()
    conn.execute(
        'INSERT INTO bill_partner_incomes (partner_id, year, month, income) VALUES (?,?,?,?)'
        ' ON CONFLICT(partner_id,year,month) DO UPDATE SET income=excluded.income',
        (int(partner_id), int(year), int(month), income)
    )
    conn.commit()
    conn.close()
    return jsonify({'ok': True})


@app.route('/api/bills/months', methods=['GET'])
def get_bill_months():
    conn = get_db()
    rows = conn.execute(
        'SELECT DISTINCT year, month FROM bills ORDER BY year DESC, month DESC'
    ).fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route('/api/bills/comparison', methods=['GET'])
def get_bills_comparison():
    conn     = get_db()
    months   = conn.execute('SELECT DISTINCT year, month FROM bills ORDER BY year ASC, month ASC').fetchall()
    partners = conn.execute('SELECT id, name, share FROM bill_partners ORDER BY id').fetchall()
    result_months = []
    for m in months:
        y, mo = m['year'], m['month']
        total_row      = conn.execute('SELECT COALESCE(SUM(amount),0) as total FROM bills WHERE year=? AND month=?', (y, mo)).fetchone()
        split_total_row = conn.execute('SELECT COALESCE(SUM(amount),0) as total FROM bills WHERE year=? AND month=? AND is_split=1', (y, mo)).fetchone()
        total_split = split_total_row['total']
        per_partner_shared   = {}
        per_partner_personal = {}
        for p in partners:
            per_partner_shared[p['name']] = round(total_split * (p['share'] or 0) / 100, 2)
            personal_row = conn.execute(
                'SELECT COALESCE(SUM(amount),0) as personal FROM bills WHERE year=? AND month=? AND paid_by=? AND is_split=0',
                (y, mo, p['id'])
            ).fetchone()
            per_partner_personal[p['name']] = round(personal_row['personal'], 2)
        total_all      = round(total_row['total'], 2)
        total_personal = round(total_all - total_split, 2)
        result_months.append({
            'year': y, 'month': mo,
            'total': total_all, 'total_split': round(total_split, 2), 'total_personal': total_personal,
            'per_partner_shared': per_partner_shared, 'per_partner_personal': per_partner_personal,
        })
    conn.close()
    return jsonify({'months': result_months, 'partners': [p['name'] for p in partners]})


@app.route('/api/bills/settled', methods=['GET'])
def get_bills_settled():
    conn = get_db()
    rows = conn.execute('SELECT year, month FROM bill_month_settled').fetchall()
    conn.close()
    return jsonify([dict(r) for r in rows])


@app.route('/api/bills/settled', methods=['POST'])
def mark_bill_settled():
    data  = request.get_json()
    year  = data.get('year')
    month = data.get('month')
    if not year or not month:
        return jsonify({'error': 'year och month krävs'}), 400
    conn = get_db()
    conn.execute('INSERT OR IGNORE INTO bill_month_settled (year, month) VALUES (?,?)', (year, month))
    conn.commit()
    conn.close()
    return jsonify({'ok': True})


@app.route('/api/bills/settled/<int:year>/<int:month>', methods=['DELETE'])
def unmark_bill_settled(year, month):
    conn = get_db()
    conn.execute('DELETE FROM bill_month_settled WHERE year=? AND month=?', (year, month))
    conn.commit()
    conn.close()
    return jsonify({'ok': True})


@app.route('/api/bills/summary', methods=['GET'])
def get_bills_summary():
    year  = request.args.get('year',  type=int)
    month = request.args.get('month', type=int)
    if not year or not month:
        return jsonify({'error': 'year och month krävs'}), 400
    conn     = get_db()
    bills    = conn.execute('''
        SELECT b.amount, b.paid_by, b.is_split, p.name as partner_name
        FROM bills b JOIN bill_partners p ON p.id = b.paid_by
        WHERE b.year = ? AND b.month = ?
    ''', (year, month)).fetchall()
    partners = conn.execute('SELECT * FROM bill_partners ORDER BY name').fetchall()
    monthly_income_rows = conn.execute(
        'SELECT partner_id, income FROM bill_partner_incomes WHERE year=? AND month=?',
        (year, month)
    ).fetchall()
    conn.close()
    if not partners:
        return jsonify({'partners': [], 'transfers': [], 'total': 0, 'total_split': 0})
    total_all   = sum(b['amount'] for b in bills)
    split_bills = [b for b in bills if b['is_split']]
    total_split = sum(b['amount'] for b in split_bills)
    paid     = {p['id']: 0.0 for p in partners}
    personal = {p['id']: 0.0 for p in partners}
    for b in split_bills:
        paid[b['paid_by']] += b['amount']
    for b in bills:
        if not b['is_split']:
            personal[b['paid_by']] += b['amount']
    monthly_incomes = {r['partner_id']: r['income'] for r in monthly_income_rows}
    if monthly_incomes:
        total_income = sum(monthly_incomes.get(p['id'], 0) for p in partners)
        if total_income > 0:
            shares_pct  = {p['id']: round(monthly_incomes.get(p['id'], 0) / total_income * 100, 1) for p in partners}
            fair_shares = {p['id']: round(total_split * monthly_incomes.get(p['id'], 0) / total_income, 2) for p in partners}
        else:
            n = len(partners)
            shares_pct  = {p['id']: round(100 / n, 1) for p in partners}
            fair_shares = {p['id']: round(total_split / n, 2) for p in partners}
    else:
        shares_pct  = {p['id']: (p['share'] or 0) for p in partners}
        fair_shares = {p['id']: round(total_split * (p['share'] or 0) / 100, 2) for p in partners}
    balances = {p['id']: round(paid[p['id']] - fair_shares[p['id']], 2) for p in partners}
    pos = sorted([(v, k) for k, v in balances.items() if v > 0.005],  reverse=True)
    neg = sorted([(v, k) for k, v in balances.items() if v < -0.005])
    transfers = []
    while pos and neg:
        credit_amt, creditor = pos.pop(0)
        debt_amt,   debtor   = neg.pop(0)
        settle = min(credit_amt, abs(debt_amt))
        partner_names = {p['id']: p['name'] for p in partners}
        transfers.append({'from': partner_names[debtor], 'to': partner_names[creditor], 'amount': round(settle, 2)})
        if credit_amt - settle > 0.005:
            pos.insert(0, (credit_amt - settle, creditor)); pos.sort(reverse=True)
        if abs(debt_amt) - settle > 0.005:
            neg.insert(0, (debt_amt + settle, debtor)); neg.sort()
    return jsonify({
        'total': round(total_all, 2), 'total_split': round(total_split, 2),
        'partners': [{
            'id': p['id'], 'name': p['name'], 'share': shares_pct[p['id']],
            'paid': round(paid[p['id']], 2), 'fair_share': fair_shares[p['id']],
            'balance': round(balances[p['id']], 2), 'personal': round(personal[p['id']], 2),
        } for p in partners],
        'transfers': transfers,
    })


if __name__ == '__main__':
    app.run(debug=True, port=5001)

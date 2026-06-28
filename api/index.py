import os
import sqlite3
from flask import Flask, render_template, request, jsonify

DATABASE_URL = os.environ.get('DATABASE_URL')

if DATABASE_URL:
    try:
        import psycopg2
        import psycopg2.extras
    except ImportError:
        DATABASE_URL = None

app = Flask(
    __name__,
    template_folder=os.path.join(os.path.dirname(__file__), '..', 'templates'),
    static_folder=os.path.join(os.path.dirname(__file__), '..', 'static'),
)

_SQLITE_PATH = os.environ.get('DB_PATH', '/tmp/rakningar.db')
_db_ready = False


def get_db():
    if DATABASE_URL:
        return psycopg2.connect(DATABASE_URL, cursor_factory=psycopg2.extras.RealDictCursor)
    conn = sqlite3.connect(_SQLITE_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA foreign_keys = ON')
    return conn


def _q(sql):
    """Swap ? placeholders to %s for PostgreSQL."""
    if DATABASE_URL:
        return sql.replace('?', '%s')
    return sql


def _exec(conn, sql, params=()):
    if DATABASE_URL:
        cur = conn.cursor()
        cur.execute(_q(sql), params)
        return cur
    return conn.execute(sql, params)


def _all(conn, sql, params=()):
    if DATABASE_URL:
        cur = conn.cursor()
        cur.execute(_q(sql), params)
        return [dict(r) for r in cur.fetchall()]
    return [dict(r) for r in conn.execute(sql, params).fetchall()]


def _one(conn, sql, params=()):
    if DATABASE_URL:
        cur = conn.cursor()
        cur.execute(_q(sql), params)
        row = cur.fetchone()
        return dict(row) if row else None
    row = conn.execute(sql, params).fetchone()
    return dict(row) if row else None


def init_db():
    conn = get_db()
    try:
        if DATABASE_URL:
            cur = conn.cursor()
            cur.execute('''CREATE TABLE IF NOT EXISTS bill_partners (
                id      SERIAL PRIMARY KEY,
                name    TEXT NOT NULL UNIQUE,
                share   DOUBLE PRECISION DEFAULT 50,
                income  DOUBLE PRECISION DEFAULT 0
            )''')
            cur.execute('''CREATE TABLE IF NOT EXISTS bills (
                id         SERIAL PRIMARY KEY,
                name       TEXT NOT NULL,
                amount     DOUBLE PRECISION NOT NULL,
                paid_by    INTEGER NOT NULL REFERENCES bill_partners(id) ON DELETE CASCADE,
                year       INTEGER NOT NULL,
                month      INTEGER NOT NULL,
                is_split   INTEGER DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )''')
            cur.execute('''CREATE TABLE IF NOT EXISTS bill_month_settled (
                year  INTEGER NOT NULL,
                month INTEGER NOT NULL,
                PRIMARY KEY (year, month)
            )''')
        else:
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
            ''')
        conn.commit()
    finally:
        conn.close()


@app.before_request
def ensure_db():
    global _db_ready
    if not _db_ready:
        init_db()
        _db_ready = True


def _recalculate_partner_shares(conn):
    rows = _all(conn, 'SELECT id, income FROM bill_partners')
    if not rows:
        return
    if not all((r['income'] or 0) > 0 for r in rows):
        return
    total = sum(r['income'] for r in rows)
    for r in rows:
        share = round(r['income'] / total * 100, 1)
        _exec(conn, 'UPDATE bill_partners SET share = ? WHERE id = ?', (share, r['id']))


# ── Routes ────────────────────────────────────────────────────────────────────

@app.route('/')
def index():
    return render_template('index.html')


@app.route('/api/bill-partners', methods=['GET'])
def get_bill_partners():
    conn = get_db()
    rows = _all(conn, 'SELECT * FROM bill_partners ORDER BY name')
    conn.close()
    return jsonify(rows)


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
        _exec(conn, 'INSERT INTO bill_partners (name, share, income) VALUES (?, ?, ?)',
              (name, share, income))
        conn.commit()
        _recalculate_partner_shares(conn)
        conn.commit()
        row = _one(conn, 'SELECT * FROM bill_partners WHERE name = ?', (name,))
        conn.close()
        return jsonify(row), 201
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        conn.close()
        return jsonify({'error': str(e)}), 400


@app.route('/api/bill-partners/<int:pid>', methods=['PATCH'])
def update_bill_partner(pid):
    data = request.json
    conn = get_db()
    row  = _one(conn, 'SELECT * FROM bill_partners WHERE id = ?', (pid,))
    if not row:
        conn.close()
        return jsonify({'error': 'Hittades inte'}), 404
    name   = (data.get('name') or '').strip() or row['name']
    income = float(data.get('income') if data.get('income') is not None else (row['income'] or 0))
    share  = float(data.get('share')  if data.get('share')  is not None else row['share'])
    try:
        _exec(conn, 'UPDATE bill_partners SET name = ?, share = ?, income = ? WHERE id = ?',
              (name, share, income, pid))
        conn.commit()
        _recalculate_partner_shares(conn)
        conn.commit()
        updated = _one(conn, 'SELECT * FROM bill_partners WHERE id = ?', (pid,))
        conn.close()
        return jsonify(updated)
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        conn.close()
        return jsonify({'error': str(e)}), 400


@app.route('/api/bill-partners/<int:pid>', methods=['DELETE'])
def delete_bill_partner(pid):
    conn = get_db()
    _exec(conn, 'DELETE FROM bill_partners WHERE id = ?', (pid,))
    conn.commit()
    conn.close()
    return jsonify({'ok': True})


@app.route('/api/bills', methods=['GET'])
def get_bills():
    year  = request.args.get('year',  type=int)
    month = request.args.get('month', type=int)
    conn  = get_db()
    if year and month:
        rows = _all(conn, '''
            SELECT b.*, p.name as partner_name
            FROM bills b JOIN bill_partners p ON p.id = b.paid_by
            WHERE b.year = ? AND b.month = ?
            ORDER BY b.created_at
        ''', (year, month))
    else:
        rows = _all(conn, '''
            SELECT b.*, p.name as partner_name
            FROM bills b JOIN bill_partners p ON p.id = b.paid_by
            ORDER BY b.year DESC, b.month DESC, b.created_at
        ''')
    conn.close()
    return jsonify(rows)


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
        _exec(conn,
            'INSERT INTO bills (name, amount, paid_by, year, month, is_split) VALUES (?, ?, ?, ?, ?, ?)',
            (name, float(amount), int(paid_by), int(year), int(month), is_split)
        )
        conn.commit()
        row = _one(conn, '''
            SELECT b.*, p.name as partner_name FROM bills b
            JOIN bill_partners p ON p.id = b.paid_by
            ORDER BY b.id DESC LIMIT 1
        ''')
        conn.close()
        return jsonify(row), 201
    except Exception as e:
        try:
            conn.rollback()
        except Exception:
            pass
        conn.close()
        return jsonify({'error': str(e)}), 400


@app.route('/api/bills/<int:bid>/toggle-split', methods=['PATCH'])
def toggle_bill_split(bid):
    conn = get_db()
    row  = _one(conn, 'SELECT is_split FROM bills WHERE id = ?', (bid,))
    if not row:
        conn.close()
        return jsonify({'error': 'Hittades inte'}), 404
    new_val = 0 if row['is_split'] else 1
    _exec(conn, 'UPDATE bills SET is_split = ? WHERE id = ?', (new_val, bid))
    conn.commit()
    conn.close()
    return jsonify({'is_split': new_val})


@app.route('/api/bills/<int:bid>', methods=['DELETE'])
def delete_bill(bid):
    conn = get_db()
    _exec(conn, 'DELETE FROM bills WHERE id = ?', (bid,))
    conn.commit()
    conn.close()
    return jsonify({'ok': True})


@app.route('/api/bills/months', methods=['GET'])
def get_bill_months():
    conn = get_db()
    rows = _all(conn, 'SELECT DISTINCT year, month FROM bills ORDER BY year DESC, month DESC')
    conn.close()
    return jsonify(rows)


@app.route('/api/bills/comparison', methods=['GET'])
def get_bills_comparison():
    conn     = get_db()
    months   = _all(conn, 'SELECT DISTINCT year, month FROM bills ORDER BY year ASC, month ASC')
    partners = _all(conn, 'SELECT id, name, share FROM bill_partners ORDER BY id')
    result_months = []
    for m in months:
        y, mo = m['year'], m['month']
        total_row       = _one(conn, 'SELECT COALESCE(SUM(amount),0) as total FROM bills WHERE year=? AND month=?', (y, mo))
        split_total_row = _one(conn, 'SELECT COALESCE(SUM(amount),0) as total FROM bills WHERE year=? AND month=? AND is_split=1', (y, mo))
        total_split = split_total_row['total']
        per_partner_shared   = {}
        per_partner_personal = {}
        for p in partners:
            per_partner_shared[p['name']] = round(total_split * (p['share'] or 0) / 100, 2)
            personal_row = _one(conn,
                'SELECT COALESCE(SUM(amount),0) as personal FROM bills WHERE year=? AND month=? AND paid_by=? AND is_split=0',
                (y, mo, p['id'])
            )
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
    rows = _all(conn, 'SELECT year, month FROM bill_month_settled')
    conn.close()
    return jsonify(rows)


@app.route('/api/bills/settled', methods=['POST'])
def mark_bill_settled():
    data  = request.get_json()
    year  = data.get('year')
    month = data.get('month')
    if not year or not month:
        return jsonify({'error': 'year och month krävs'}), 400
    conn = get_db()
    sql = ('INSERT INTO bill_month_settled (year, month) VALUES (?, ?) ON CONFLICT DO NOTHING'
           if DATABASE_URL else
           'INSERT OR IGNORE INTO bill_month_settled (year, month) VALUES (?, ?)')
    _exec(conn, sql, (year, month))
    conn.commit()
    conn.close()
    return jsonify({'ok': True})


@app.route('/api/bills/settled/<int:year>/<int:month>', methods=['DELETE'])
def unmark_bill_settled(year, month):
    conn = get_db()
    _exec(conn, 'DELETE FROM bill_month_settled WHERE year=? AND month=?', (year, month))
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
    bills    = _all(conn, '''
        SELECT b.amount, b.paid_by, b.is_split, p.name as partner_name
        FROM bills b JOIN bill_partners p ON p.id = b.paid_by
        WHERE b.year = ? AND b.month = ?
    ''', (year, month))
    partners = _all(conn, 'SELECT * FROM bill_partners ORDER BY name')
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
    fair_shares = {p['id']: round(total_split * (p['share'] or 0) / 100, 2) for p in partners}
    balances    = {p['id']: round(paid[p['id']] - fair_shares[p['id']], 2) for p in partners}
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
            'id': p['id'], 'name': p['name'], 'share': p['share'],
            'paid': round(paid[p['id']], 2), 'fair_share': fair_shares[p['id']],
            'balance': round(balances[p['id']], 2), 'personal': round(personal[p['id']], 2),
        } for p in partners],
        'transfers': transfers,
    })


if __name__ == '__main__':
    app.run(debug=True, port=5001)

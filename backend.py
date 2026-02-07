from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import pyodbc
import hashlib
import datetime
import time
import os
import re
from typing import Optional
from config import SQL_DATABASE, SQL_DRIVER, SQL_SERVER, SQL_USERNAME, SQL_PASSWORD
try:
    from config import BACKUP_TARGET_DIR
except Exception:
    BACKUP_TARGET_DIR = ""

CONFIG_DIR = os.environ.get("FINLOGS_CONFIG_DIR", os.getcwd())
CONFIG_FILE = os.path.join(CONFIG_DIR, "db_config.json")

def load_runtime_config():
    data = {}
    if os.path.exists(CONFIG_FILE):
        try:
            import json
            with open(CONFIG_FILE, "r") as f:
                data = json.load(f) or {}
        except Exception:
            data = {}

    auth_type = data.get("auth_type") or ("windows" if not SQL_USERNAME else "sql")
    username = data.get("username") if auth_type == "sql" else ""
    return {
        "server": data.get("server", SQL_SERVER),
        "database": data.get("database", SQL_DATABASE),
        "auth_type": auth_type,
        "username": username or SQL_USERNAME,
        "password": data.get("password", SQL_PASSWORD),
        "backup_dir": data.get("backup_dir") or BACKUP_TARGET_DIR
    }

def build_connection_string(database: str = None) -> str:
    cfg = load_runtime_config()
    db = database or cfg["database"]
    if cfg["auth_type"] == "sql" and cfg["username"]:
        return f"DRIVER={SQL_DRIVER};SERVER={cfg['server']};DATABASE={db};UID={cfg['username']};PWD={cfg['password']};TrustServerCertificate=yes;"
    return f"DRIVER={SQL_DRIVER};SERVER={cfg['server']};DATABASE={db};Trusted_Connection=yes;TrustServerCertificate=yes;"

def get_backup_target_dir() -> str:
    return load_runtime_config().get("backup_dir", "") or ""

app = FastAPI()

REPORT_CACHE_TTL_SEC = 300
report_cache = {}

def cache_get(key):
    entry = report_cache.get(key)
    if not entry:
        return None
    ts, data = entry
    if time.time() - ts > REPORT_CACHE_TTL_SEC:
        report_cache.pop(key, None)
        return None
    return data

def cache_set(key, data):
    report_cache[key] = (time.time(), data)

def invalidate_report_cache():
    report_cache.clear()

def parse_date_str(value: Optional[str]) -> Optional[datetime.date]:
    if not value:
        return None
    try:
        return datetime.datetime.strptime(value, "%Y-%m-%d").date()
    except Exception:
        return None

def resolve_date_range(start: Optional[str], end: Optional[str], days: int = 30):
    end_date = parse_date_str(end) or datetime.date.today()
    start_date = parse_date_str(start) or (end_date - datetime.timedelta(days=max(days, 1) - 1))
    if start_date > end_date:
        start_date, end_date = end_date, start_date
    return start_date, end_date

current_company = None
initialized_dbs = set()  # Cache to track initialized databases

@app.on_event("startup")
def startup_init_db():
    try:
        init_db(SQL_DATABASE)
    except Exception:
        pass

def normalize_company(name: str) -> str:
    base = re.sub(r"\s+", "_", name.strip().lower())
    return re.sub(r"[^a-z0-9_]+", "", base) or "default"

def init_db(company_name: str):
    # Skip if already initialized in this session
    db_key = normalize_company(company_name)
    if db_key in initialized_dbs:
        return
    
    conn = pyodbc.connect(build_connection_string(), autocommit=True)
    cursor = conn.cursor()

    # Create tables using SQL Server syntax
    cursor.execute("""
        IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'users')
        CREATE TABLE users (
            username NVARCHAR(255) PRIMARY KEY,
            password_hash NVARCHAR(255),
            role NVARCHAR(50)
        )
    """)
    cursor.execute("""
        IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'audit_logs')
        CREATE TABLE audit_logs (
            id INT PRIMARY KEY IDENTITY(1,1),
            timestamp DATETIME DEFAULT GETDATE(),
            username NVARCHAR(255),
            action NVARCHAR(255),
            details NVARCHAR(MAX),
            company NVARCHAR(255)
        )
    """)
    cursor.execute("""
        IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'app_settings')
        CREATE TABLE app_settings (
            setting_key NVARCHAR(255) PRIMARY KEY,
            setting_value NVARCHAR(MAX)
        )
    """)
    cursor.execute("""
        IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'daily_cash')
        CREATE TABLE daily_cash (
            cash_date DATE PRIMARY KEY,
            cash_in_hand DECIMAL(18,2),
            updated_at DATETIME DEFAULT GETDATE()
        )
    """)
    cursor.execute("""
        IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'parties')
        CREATE TABLE parties (
            party_id INT PRIMARY KEY IDENTITY(1,1),
            name NVARCHAR(255),
            normalized_name NVARCHAR(255) UNIQUE,
            type NVARCHAR(100),
            credit_allowed BIT
        )
    """)
    cursor.execute("""
        IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'transactions')
        CREATE TABLE transactions (
            txn_id INT PRIMARY KEY IDENTITY(1,1),
            txn_date DATE,
            bill_no NVARCHAR(255),
            party_id INT,
            txn_type NVARCHAR(50),
            payment_mode NVARCHAR(50),
            amount DECIMAL(18,2),
            FOREIGN KEY (party_id) REFERENCES parties (party_id)
        )
    """)
    
    # Create indexes for faster queries
    cursor.execute("""
        IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_transactions_party_id' AND object_id = OBJECT_ID('transactions'))
        CREATE INDEX idx_transactions_party_id ON transactions(party_id)
    """)
    cursor.execute("""
        IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_transactions_date' AND object_id = OBJECT_ID('transactions'))
        CREATE INDEX idx_transactions_date ON transactions(txn_date)
    """)
    cursor.execute("""
        IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_transactions_type' AND object_id = OBJECT_ID('transactions'))
        CREATE INDEX idx_transactions_type ON transactions(txn_type)
    """)
    cursor.execute("""
        IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_transactions_mode' AND object_id = OBJECT_ID('transactions'))
        CREATE INDEX idx_transactions_mode ON transactions(payment_mode)
    """)
    cursor.execute("""
        IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_transactions_bill_no' AND object_id = OBJECT_ID('transactions'))
        CREATE INDEX idx_transactions_bill_no ON transactions(bill_no)
    """)
    cursor.execute("""
        IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_transactions_date_id' AND object_id = OBJECT_ID('transactions'))
        CREATE INDEX idx_transactions_date_id ON transactions(txn_date DESC, txn_id DESC)
    """)
    cursor.execute("""
        IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_transactions_date_type_mode' AND object_id = OBJECT_ID('transactions'))
        CREATE INDEX idx_transactions_date_type_mode ON transactions(txn_date, txn_type, payment_mode)
    """)
    cursor.execute("""
        IF NOT EXISTS (SELECT * FROM sys.indexes WHERE name = 'idx_parties_normalized' AND object_id = OBJECT_ID('parties'))
        CREATE INDEX idx_parties_normalized ON parties(normalized_name)
    """)

    # Default admin/user
    cursor.execute("SELECT COUNT(*) FROM users WHERE username='admin'")
    if cursor.fetchone()[0] == 0:
        default_hash = hashlib.sha256("admin1020".encode()).hexdigest()
        cursor.execute("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)", ('admin', default_hash, 'admin'))

    cursor.execute("SELECT COUNT(*) FROM users WHERE username='user'")
    if cursor.fetchone()[0] == 0:
        default_hash = hashlib.sha256("user123".encode()).hexdigest()
        cursor.execute("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)", ('user', default_hash, 'accounts'))

    # Insert default company setting if not exists
    cursor.execute("IF NOT EXISTS (SELECT 1 FROM app_settings WHERE setting_key='company_name') INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?)", ("company_name", company_name))

    # Migration: Add company column to audit_logs if it doesn't exist
    # Check if column exists first
    cursor.execute("SELECT COUNT(*) FROM sys.columns WHERE object_id = OBJECT_ID('audit_logs') AND name = 'company'")
    column_exists = cursor.fetchone()[0] > 0
    
    if not column_exists:
        # Add column with default value
        cursor.execute(f"ALTER TABLE audit_logs ADD company NVARCHAR(255) DEFAULT '{company_name}'")
        # Update existing NULL values
        cursor.execute("UPDATE audit_logs SET company = ? WHERE company IS NULL", (company_name,))

    conn.close()
    
    # Mark as initialized
    initialized_dbs.add(db_key)

def get_db_connection(company: Optional[str] = None):
    comp = company or current_company or "default"
    # Don't call init_db on every connection - it's already initialized at startup
    # Use autocommit=True to prevent lock waits and improve performance
    conn = pyodbc.connect(build_connection_string(), autocommit=True, timeout=5)
    # Set fast execution mode
    conn.setdecoding(pyodbc.SQL_CHAR, encoding='utf-8')
    conn.setdecoding(pyodbc.SQL_WCHAR, encoding='utf-8')
    conn.setencoding(encoding='utf-8')
    return conn

def get_master_connection():
    conn = pyodbc.connect(build_connection_string("master"), autocommit=True, timeout=5)
    conn.setdecoding(pyodbc.SQL_CHAR, encoding='utf-8')
    conn.setdecoding(pyodbc.SQL_WCHAR, encoding='utf-8')
    conn.setencoding(encoding='utf-8')
    return conn

def get_default_backup_dir(cursor=None):
    # Always use C:\Finlogs for simplicity and consistency
    return "C:\\Finlogs"

def escape_sql_path(path: str) -> str:
    return path.replace("'", "''")

def get_desktop_company_backup_dir(company_name: str) -> str:
    desktop = os.path.join(os.path.expanduser("~"), "Desktop")
    folder = normalize_company(company_name) or "default"
    return os.path.join(desktop, folder)

# Remove Global conn
# conn = ... (Removed)

# init_db("default")  # Commented out - database should already exist

# Auth Models
class LoginRequest(BaseModel):
    username: str
    password: str

class CreateUserRequest(BaseModel):
    username: str
    password: str
    role: str

class AuditLogRequest(BaseModel):
    username: str
    action: str
    details: str

class OpeningCashRequest(BaseModel):
    amount: float
    admin_user: str

class CashInHandRequest(BaseModel):
    date: str
    cash_in_hand: float
    admin_user: str

class ChangePasswordRequest(BaseModel):
    username: str
    new_password: str
    admin_user: str

class CompanyCreateRequest(BaseModel):
    name: str

class CompanySelectRequest(BaseModel):
    name: str

# Helper for Audit (Needs its own conn if called separately, but usually called within context? 
# Actually log_audit is a helper. Let's make it open its own conn to be safe and independent)
def log_audit(username, action, details, company=None):
    try:
        comp = company or current_company or "default"
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("INSERT INTO audit_logs (username, action, details, company) VALUES (?, ?, ?, ?)", (username, action, details, comp))
        conn.close()
        invalidate_report_cache()
    except:
        pass

def get_setting(key: str, default_val: float = 0.0) -> float:
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT setting_value FROM app_settings WHERE setting_key=?", (key,))
        row = cursor.fetchone()
        conn.close()
        if row and row[0] is not None:
            return float(row[0])
    except:
        pass
    return float(default_val)

def set_setting(key: str, value: float):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT COUNT(*) FROM app_settings WHERE setting_key=?", (key,))
    exists = cursor.fetchone()[0] > 0
    if exists:
        cursor.execute("UPDATE app_settings SET setting_value=? WHERE setting_key=?", (str(value), key))
    else:
        cursor.execute("INSERT INTO app_settings (setting_key, setting_value) VALUES (?, ?)", (key, str(value)))
    conn.close()

@app.get("/companies")
def list_companies():
    # In SQL Server, we store company info in app_settings table
    # For simplicity, return the current company
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT setting_value FROM app_settings WHERE setting_key='company_name'")
        row = cursor.fetchone()
        conn.close()
        company_name = row[0] if row and row[0] else "default"
        return [{"name": company_name, "key": normalize_company(company_name)}]
    except:
        return [{"name": "default", "key": "default"}]

@app.post("/companies")
def create_company(req: CompanyCreateRequest):
    name = (req.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Company name required")
    init_db(name)
    return {"status": "Created"}

@app.post("/company/select")
def select_company(req: CompanySelectRequest):
    global current_company
    name = (req.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="Company name required")
    current_company = name
    init_db(name)
    return {"status": "Selected", "company": name}

class PartyCreate(BaseModel):
    name: str
    ptype: str
    credit: bool

@app.post("/party")
def create_party(party: PartyCreate):
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # Logic Fix: Only one Bank allowed
    if party.ptype == "Bank":
        count = cursor.execute("SELECT COUNT(*) FROM parties WHERE type = 'Bank'").fetchone()[0]
        if count > 0:
             conn.close()
             raise HTTPException(status_code=400, detail="Only one Bank account is allowed.")

    normalized = party.name.lower().replace(" ", "_")
    try:
        cursor.execute(
            "INSERT INTO parties (name, normalized_name, type, credit_allowed) VALUES (?, ?, ?, ?)",
            (party.name, normalized, party.ptype, 1 if party.credit else 0)
        )
        conn.close()
        return {"status": "Party Created"}
    except Exception as e:
        conn.close()
        return {"status": "Error", "detail": str(e)}

@app.post("/transaction")
def add_transaction(date: str, bill_no: str, party: str, txn_type: str, mode: str, amount: float):
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute("SELECT party_id FROM parties WHERE normalized_name=?", (party.lower().replace(" ","_"),))
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Party not found")
            
        party_id = row[0]

        cursor.execute(
            "INSERT INTO transactions (txn_date, bill_no, party_id, txn_type, payment_mode, amount) VALUES (?, ?, ?, ?, ?, ?)",
            (date, bill_no, party_id, txn_type, mode, amount)
        )
        conn.close()
        invalidate_report_cache()
        return {"status": "Transaction Added"}
    except Exception as e:
        conn.close()
        return {"status": "Error", "detail": str(e)}

@app.get("/ledger/{party}")
def get_ledger(party: str, start: str = None, end: str = None):
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("SELECT party_id FROM parties WHERE normalized_name=?", (party,))
        row = cursor.fetchone()
        if not row:
            conn.close()
            # If party doesn't exist, return empty ledger instead of crashing
            return []
            
        party_id = row[0]

        # Use txn_id
        query = "SELECT txn_id, txn_date, bill_no, txn_type, payment_mode, amount FROM transactions WHERE party_id=?"
        params = [party_id]

        if start:
            query += " AND txn_date >= ?"
            params.append(start)
        if end:
            query += " AND txn_date <= ?"
            params.append(end)

        query += " ORDER BY txn_date"
        cursor.execute(query, params)
        data = cursor.fetchall()
        conn.close() 

        balance = 0
        ledger = []

        for dim, d, b, t, m, a in data:
            # Logic: Sale/Receipt(if form customer) vs. Payment
            # Assuming Sale increases balance (Receivable), Receipt decreases it
            # But earlier logic was Sale +, everything else - ?
            # Let's align with get_mode_report: 
            # In (Sale) = +, In (Receipt) = - (Decreases receivable)?
            # Wait, Standard Ledger for Customer:
            # Debit (Sale) +, Credit (Receipt) -
            
            if t == "Sale":
                balance += float(a)
            elif t in ["Receipt", "Sale Return"]:
                balance -= float(a) 
            else: 
                # Expense, etc? Default to minus for now if not Sale
                 balance -= float(a)

            ledger.append({
                "id": dim, # This is txn_id
                "date": str(d),
                "bill_no": b if b else "",
                "type": t,
                "mode": m,
                "amount": float(a),
                "balance": float(balance)
            })

        return ledger
    except Exception as e:
        try: conn.close()
        except: pass
        return []


@app.get("/parties")
def get_parties():
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT name, type FROM parties ORDER BY name")
    data = [{"name": r[0], "type": r[1]} for r in cursor.fetchall()]
    conn.close()
    return data
@app.get("/transactions")
def get_transactions(page: int = 1, limit: int = 50, days: int = 30, from_date: Optional[str] = None, to_date: Optional[str] = None):
    conn = get_db_connection()
    cursor = conn.cursor()

    where_clauses = []
    params = []

    if from_date:
        where_clauses.append("t.txn_date >= ?")
        params.append(from_date)
    if to_date:
        where_clauses.append("t.txn_date <= ?")
        params.append(to_date)

    if not where_clauses and days and days > 0:
        where_clauses.append("t.txn_date >= DATEADD(day, ?, CAST(GETDATE() AS date))")
        params.append(-days)

    where_sql = f"WHERE {' AND '.join(where_clauses)}" if where_clauses else ""
    
    # Get total count
    cursor.execute(f"SELECT COUNT(*) FROM transactions t WITH (NOLOCK) {where_sql}", params)
    total = cursor.fetchone()[0]
    
    offset = (page - 1) * limit
    cursor.execute(f"""
        SELECT t.txn_id, t.txn_date, t.bill_no, p.name, t.txn_type, t.payment_mode, t.amount
        FROM transactions t WITH (NOLOCK)
        JOIN parties p WITH (NOLOCK) ON t.party_id = p.party_id
        {where_sql}
        ORDER BY t.txn_date DESC, t.txn_id DESC
        OFFSET ? ROWS FETCH NEXT ? ROWS ONLY
    """, (*params, offset, limit))
    rows = cursor.fetchall()
    conn.close()
    
    total_pages = (total + limit - 1) // limit

    return {
        "transactions": [
        {
            "id": r[0],
            "date": str(r[1]),
            "bill_no": r[2] if r[2] else "",
            "party": r[3],
            "type": r[4],
            "mode": r[5],
            "amount": float(r[6])
        }
        for r in rows
        ],
        "page": page,
        "limit": limit,
        "total": total,
        "total_pages": total_pages
    }

@app.get("/transactions/by-date")
def get_transactions_by_date(date: str):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT t.txn_id, t.txn_date, t.bill_no, p.name, t.txn_type, t.payment_mode, t.amount
        FROM transactions t WITH (NOLOCK)
        JOIN parties p WITH (NOLOCK) ON t.party_id = p.party_id
        WHERE t.txn_date = ?
        ORDER BY t.txn_date DESC, t.txn_id DESC
    """, (date,))
    rows = cursor.fetchall()
    conn.close()

    return [
        {
            "id": r[0],
            "date": str(r[1]),
            "bill_no": r[2] if r[2] else "",
            "party": r[3],
            "type": r[4],
            "mode": r[5],
            "amount": float(r[6])
        }
        for r in rows
    ]

@app.get("/transaction/{txn_id}")
def get_single_transaction(txn_id: int):
    """Get a single transaction by ID for efficient edit modal loading"""
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT t.txn_id, t.txn_date, t.bill_no, p.name, t.txn_type, t.payment_mode, t.amount
        FROM transactions t WITH (NOLOCK)
        JOIN parties p WITH (NOLOCK) ON t.party_id = p.party_id
        WHERE t.txn_id = ?
    """, (txn_id,))
    row = cursor.fetchone()
    conn.close()
    
    if not row:
        raise HTTPException(status_code=404, detail="Transaction not found")
    
    return {
        "id": row[0],
        "date": str(row[1]),
        "bill_no": row[2] if row[2] else "",
        "party": row[3],
        "type": row[4],
        "mode": row[5],
        "amount": float(row[6])
    }

@app.get("/transactions/by-date")
def get_transactions_by_date(date: str):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT t.txn_id, t.txn_date, t.bill_no, p.name, t.txn_type, t.payment_mode, t.amount
        FROM transactions t WITH (NOLOCK)
        JOIN parties p WITH (NOLOCK) ON t.party_id = p.party_id
        WHERE t.txn_date = ?
        ORDER BY t.txn_date DESC, t.txn_id DESC
    """, (date,))
    rows = cursor.fetchall()
    conn.close()

    return [
        {
            "id": r[0],
            "date": str(r[1]),
            "bill_no": r[2] if r[2] else "",
            "party": r[3],
            "type": r[4],
            "mode": r[5],
            "amount": float(r[6])
        }
        for r in rows
    ]

@app.get("/summary/daily")
def get_daily_summary():
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT txn_date, payment_mode, txn_type, SUM(amount)
        FROM transactions
        WHERE payment_mode IN ('Cash', 'Bank', 'UPI', 'GPay', 'GPAY', 'Google Pay', 'GooglePay')
        GROUP BY txn_date, payment_mode, txn_type
        ORDER BY txn_date DESC
    """)
    rows = cursor.fetchall()
    conn.close()

    summary = {}
    
    for date, mode, ttype, amount in rows:
        d_str = str(date)
        if d_str not in summary:
            summary[d_str] = {
                "date": d_str,
                "cash_in": 0, "cash_out": 0,
                "bank_in": 0, "bank_out": 0,
                "upi_in": 0, "upi_out": 0
            }
        
        # Logic: Sale/Receipt = In, Expense = Out
        is_in = ttype in ["Sale", "Receipt"]
        val = float(amount)

        if mode == "Cash":
            if is_in: summary[d_str]["cash_in"] += val
            else: summary[d_str]["cash_out"] += val
        elif mode == "Bank":
            if is_in: summary[d_str]["bank_in"] += val
            else: summary[d_str]["bank_out"] += val
        elif mode == "UPI":
            if is_in: summary[d_str]["upi_in"] += val
            else: summary[d_str]["upi_out"] += val

    return list(summary.values())

@app.get("/report/mode/{mode}")
def get_mode_report(mode: str):
    conn = get_db_connection()
    cursor = conn.cursor()
    if mode.lower() == "bank":
        cursor.execute("""
            SELECT t.txn_date, t.bill_no, p.name, t.txn_type, t.amount
            FROM transactions t
            JOIN parties p ON t.party_id = p.party_id
            WHERE t.payment_mode IN ('Bank', 'UPI', 'GPay', 'GPAY', 'Google Pay', 'GooglePay')
            ORDER BY t.txn_date
        """)
    else:
        cursor.execute("""
            SELECT t.txn_date, t.bill_no, p.name, t.txn_type, t.amount
            FROM transactions t
            JOIN parties p ON t.party_id = p.party_id
            WHERE t.payment_mode = ?
            ORDER BY t.txn_date
        """, (mode,))
    rows = cursor.fetchall()
    
    # Calculate running balance for the account (Cash/Bank/UPI)
    # In = Sale/Receipt (+), Out = Expense (-)
    balance = 0
    result = []
    
    for r in rows:
        date, bill, party, ttype, amount = r
        amt = float(amount)
        if ttype in ["Sale", "Receipt"]:
            balance += amt
            debit = amt  # Debit the Cash Account (Increase Asset)
            credit = 0
        else:
            balance -= amt
            debit = 0
            credit = amt # Credit the Cash Account (Decrease Asset)
            
        result.append({
            "date": str(date),
            "bill_no": bill if bill else "",
            "party": party,
            "type": ttype,
            "debit": debit,   # In
            "credit": credit, # Out
            "balance": balance
        })
    return result

@app.get("/report/type/{txn_type}")
def get_type_report(txn_type: str):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT t.txn_date, t.bill_no, p.name, t.payment_mode, t.amount
        FROM transactions t
        JOIN parties p ON t.party_id = p.party_id
        WHERE t.txn_type = ?
        ORDER BY t.txn_date
    """, (txn_type,))
    rows = cursor.fetchall()
    conn.close()
    
    result = []
    total = 0
    for r in rows:
        total += float(r[4])
        result.append({
            "date": str(r[0]),
            "bill_no": r[1] if r[1] else "",
            "party": r[2],
            "mode": r[3],
            "amount": float(r[4])
        })
    return result
@app.get("/report/outstanding")
def get_outstanding_report():
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("""
        SELECT p.name, 
               SUM(CASE WHEN t.txn_type = 'Sale' THEN t.amount ELSE 0 END) as sales,
               SUM(CASE WHEN t.txn_type = 'Receipt' THEN t.amount ELSE 0 END) as receipts
        FROM parties p
        LEFT JOIN transactions t ON p.party_id = t.party_id
        WHERE p.type = 'Credit Customer'
        GROUP BY p.name
    """)
    rows = cursor.fetchall()
    conn.close()

    outstanding = []
    total_outstanding = 0.0
    for name, sales, receipts in rows:
        s = float(sales or 0)
        r = float(receipts or 0)
        balance = s - r
        if balance > 0:
            outstanding.append({"party": name, "balance": balance})
            total_outstanding += balance
    
    return {"data": outstanding, "total": total_outstanding}

@app.get("/report/trial-balance")
def get_trial_balance():
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # helper to get sum
    def get_sum(query):
        cursor.execute(query)
        val = cursor.fetchone()[0]
        return float(val or 0)

    # 1. Cash/Bank/UPI Balances
    def get_account_balance(mode):
        if mode == 'Bank':
            inflow = get_sum("SELECT SUM(amount) FROM transactions WHERE payment_mode IN ('Bank','UPI','GPay','GPAY','Google Pay','GooglePay') AND txn_type IN ('Sale', 'Receipt')")
            outflow = get_sum("SELECT SUM(amount) FROM transactions WHERE payment_mode IN ('Bank','UPI','GPay','GPAY','Google Pay','GooglePay') AND txn_type = 'Expense'")
        else:
            inflow = get_sum(f"SELECT SUM(amount) FROM transactions WHERE payment_mode='{mode}' AND txn_type IN ('Sale', 'Receipt')")
            outflow = get_sum(f"SELECT SUM(amount) FROM transactions WHERE payment_mode='{mode}' AND txn_type = 'Expense'")
        return inflow - outflow

    cash_bal = get_account_balance('Cash')
    bank_bal = get_account_balance('Bank')
    upi_bal = get_account_balance('UPI')
    
    # Debtors
    debtors = get_sum("""
        SELECT SUM(CASE WHEN t.txn_type = 'Sale' THEN t.amount ELSE -t.amount END)
        FROM transactions t JOIN parties p ON t.party_id = p.party_id
    """) # Removed invalid SQL comment
    # Note: Using simple Sum logic here matching get_ledger mostly
    
    # Creditors
    creditors = get_sum("""
        SELECT SUM(CASE WHEN t.txn_type = 'Purchase' THEN t.amount ELSE -t.amount END)
        FROM transactions t JOIN parties p ON t.party_id = p.party_id
    """) # Removed invalid SQL comment
    
    # Sales (Revenue)
    total_sales = get_sum("SELECT SUM(amount) FROM transactions WHERE txn_type='Sale'")
    
    # Expenses (Direct/Indirect)
    total_expenses = get_sum("SELECT SUM(amount) FROM transactions WHERE txn_type='Expense'")
    
    conn.close()
    
    return [
        {"account": "Cash Account", "debit": cash_bal if cash_bal > 0 else 0, "credit": -cash_bal if cash_bal < 0 else 0},
        {"account": "Bank Account", "debit": bank_bal if bank_bal > 0 else 0, "credit": -bank_bal if bank_bal < 0 else 0},
        {"account": "UPI Account", "debit": upi_bal if upi_bal > 0 else 0, "credit": -upi_bal if upi_bal < 0 else 0},
        {"account": "Sundry Debtors", "debit": debtors if debtors > 0 else 0, "credit": -debtors if debtors < 0 else 0},
        {"account": "Sundry Creditors", "debit": creditors if creditors > 0 else 0, "credit": -creditors if creditors < 0 else 0},
        {"account": "Sales Account", "debit": 0, "credit": total_sales},
        {"account": "Expense Account", "debit": total_expenses, "credit": 0}
    ]

@app.get("/report/pnl")
def get_pnl_report():
    conn = get_db_connection()
    cursor = conn.cursor()
    sales = float(cursor.execute("SELECT SUM(amount) FROM transactions WHERE txn_type='Sale'").fetchone()[0] or 0)
    expenses = float(cursor.execute("SELECT SUM(amount) FROM transactions WHERE txn_type='Expense'").fetchone()[0] or 0)
    conn.close()
    
    net_profit = sales - expenses
    
    return {
        "sales": sales,
        "expenses": expenses,
        "net_profit": net_profit
    }

@app.get("/report/dashboard")
def get_dashboard_metrics():
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # helper
    def get_val(q):
        try:
            val = cursor.execute(q).fetchone()[0]
            return float(val or 0)
        except:
            return 0.0

    # 1. Total Sales Today (SQL Server syntax)
    sales_today = get_val("SELECT ISNULL(SUM(amount), 0) FROM transactions WHERE txn_type='Sale' AND txn_date = CAST(GETDATE() AS DATE)")
    
    # 2. Total Sales Month (SQL Server syntax)
    sales_month = get_val("SELECT ISNULL(SUM(amount), 0) FROM transactions WHERE txn_type='Sale' AND MONTH(txn_date) = MONTH(GETDATE()) AND YEAR(txn_date) = YEAR(GETDATE())")

    # 3. Cash & Bank Balances
    cash_in = get_val("SELECT SUM(amount) FROM transactions WHERE payment_mode='Cash' AND txn_type IN ('Sale', 'Receipt')")
    cash_out = get_val("SELECT SUM(amount) FROM transactions WHERE payment_mode='Cash' AND txn_type='Expense'")
    cash_bal = cash_in - cash_out

    bank_in = get_val("SELECT SUM(amount) FROM transactions WHERE payment_mode IN ('Bank','UPI','GPay','GPAY','Google Pay','GooglePay') AND txn_type IN ('Sale', 'Receipt')")
    bank_out = get_val("SELECT SUM(amount) FROM transactions WHERE payment_mode IN ('Bank','UPI','GPay','GPAY','Google Pay','GooglePay') AND txn_type='Expense'")
    bank_bal = bank_in - bank_out

    # 4. Total Receivables (Simplistic)
    cust_sales = get_val("SELECT SUM(amount) FROM transactions t JOIN parties p ON t.party_id=p.party_id WHERE p.type='Customer' AND t.txn_type='Sale'")
    cust_receipts = get_val("SELECT SUM(amount) FROM transactions t JOIN parties p ON t.party_id=p.party_id WHERE p.type='Customer' AND t.txn_type='Receipt'")
    receivables = cust_sales - cust_receipts

    conn.close()

    return {
        "sales_today": sales_today,
        "sales_month": sales_month,
        "cash_balance": cash_bal,
        "bank_balance": bank_bal,
        "receivables": receivables
    }

@app.post("/backup")
def backup_database(path: str = None):
    """SQL Server backup - requires administrative privileges"""
    try:
        import datetime
        import shutil
        timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        database = SQL_DATABASE
        conn = get_master_connection()
        cursor = conn.cursor()
        
        # Always use C:\Finlogs for backups
        backup_dir = "C:\\Finlogs"
        os.makedirs(backup_dir, exist_ok=True)
        server_backup_path = os.path.join(backup_dir, f"{database}_{timestamp}.bak")
        # SQL Server BACKUP command
        safe_path = escape_sql_path(server_backup_path)
        backup_query = f"BACKUP DATABASE [{database}] TO DISK = '{safe_path}' WITH FORMAT, INIT"
        cursor.execute(backup_query)
        conn.close()
        
        # If user provided a path, try to copy the backup there
        if path:
            try:
                shutil.copy2(server_backup_path, path)
                return {"status": "Backup Successful", "path": path}
            except Exception as copy_err:
                return {
                    "status": "Backup Successful",
                    "path": server_backup_path,
                    "warning": f"Backup saved on server at {server_backup_path}, but copy to selected path failed: {copy_err}"
                }

        return {"status": "Backup Successful", "path": server_backup_path}
    except Exception as e:
        return {"status": "Error", "detail": f"Backup failed: {str(e)}. Note: SQL Server backups require admin privileges."}

@app.post("/backup/auto")
def backup_database_auto():
    """Automatic SQL Server backup"""
    try:
        import datetime
        import shutil
        import tempfile
        timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
        conn = get_master_connection()
        cursor = conn.cursor()
        
        # Auto backups go to C:\Finlogs\Auto
        backup_dir = "C:\\Finlogs\\Auto"
        os.makedirs(backup_dir, exist_ok=True)

        # Permission check (create + delete test file)
        try:
            test_file = os.path.join(backup_dir, f".perm_test_{timestamp}.tmp")
            with open(test_file, "w") as f:
                f.write("test")
            os.remove(test_file)
        except Exception as perm_err:
            return {"status": "Error", "detail": f"Auto backup failed: No write permission on {backup_dir}. {perm_err}"}
        
        database = SQL_DATABASE
        backup_path = os.path.join(backup_dir, f"auto_{database}_{timestamp}.bak")
        
        safe_path = escape_sql_path(backup_path)
        backup_query = f"BACKUP DATABASE [{database}] TO DISK = '{safe_path}' WITH FORMAT, INIT"
        cursor.execute(backup_query)
        conn.close()

        # Prune old backups, keep latest 10
        try:
            files = [
                os.path.join(backup_dir, f)
                for f in os.listdir(backup_dir)
                if f.lower().endswith('.bak') and f.startswith('auto_')
            ]
            files.sort(key=lambda p: os.path.getmtime(p))
            while len(files) > 10:
                old = files.pop(0)
                try:
                    os.remove(old)
                except Exception:
                    pass
        except Exception:
            pass
        
        return {"status": "Backup Successful", "path": backup_path}
    except Exception as e:
        return {"status": "Error", "detail": f"Auto backup failed: {str(e)}"}

@app.post("/restore")
def restore_database(path: str):
    """SQL Server restore - requires administrative privileges"""
    try:
        if not os.path.exists(path):
            return {"status": "Error", "detail": "Backup file not found"}
        
        database = SQL_DATABASE
        
        conn = get_master_connection()
        cursor = conn.cursor()
        
        # Set database to single user mode before restore
        cursor.execute(f"ALTER DATABASE [{database}] SET SINGLE_USER WITH ROLLBACK IMMEDIATE")
        # Restore database
        safe_path = escape_sql_path(path)
        restore_query = f"RESTORE DATABASE [{database}] FROM DISK = '{safe_path}' WITH REPLACE"
        cursor.execute(restore_query)
        # Set back to multi-user mode
        cursor.execute(f"ALTER DATABASE [{database}] SET MULTI_USER")
        conn.close()
        
        return {"status": "Restore Successful"}
    except Exception as e:
        return {"status": "Error", "detail": f"Restore failed: {str(e)}. Note: SQL Server restores require admin privileges."}

from fastapi import UploadFile, File

@app.post("/import")
async def import_transactions(file: UploadFile = File(...)):
    try:
        import shutil
        import os
        
        file_loc = f"temp_{file.filename}"
        with open(file_loc, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
            
        import pandas as pd
        
        if file.filename.endswith('.csv'):
            df = pd.read_csv(file_loc)
        else:
            df = pd.read_excel(file_loc)
            
        os.remove(file_loc)
        
        conn = get_db_connection()
        cursor = conn.cursor()
        success = 0
        errors = 0
        failed_rows = []  # Track which rows failed and why
        
        for idx, row in df.iterrows():
            row_num = idx + 2  # +2 because: 0-indexed + 1 header row
            try:
                # helper to safely get val
                def safe_get(keys, default=None):
                    for k in keys:
                        if k in row and pd.notna(row[k]):
                            return row[k]
                    return default

                date_val = safe_get(['Date', 'date', 'txn_date'])
                if not date_val:
                    failed_rows.append({"row": row_num, "reason": "Missing date"})
                    errors += 1
                    continue 
                
                # Parse Date (Handle DD.MM.YY)
                try:
                    # dayfirst=True for 17.01.26
                    dt = pd.to_datetime(date_val, dayfirst=True)
                    date = dt.strftime("%Y-%m-%d")
                except Exception as date_err:
                    failed_rows.append({"row": row_num, "reason": f"Invalid date format: {date_val}"})
                    errors += 1
                    continue

                bill = safe_get(['Bill No / Invoice', 'BillNo', 'Bill No', 'bill_no'], "")
                party = safe_get(['Customer Name', 'Party', 'party', 'Name'])
                if not party:
                    failed_rows.append({"row": row_num, "reason": "Missing party name"})
                    errors += 1
                    continue

                ttype_raw = safe_get(['Transaction Type', 'Type', 'txn_type'], "Sale")
                ttype = ttype_raw.title() if ttype_raw else "Sale" # SALE -> Sale

                mode_raw = safe_get(['Payment Mode', 'payment Mode', 'yment Mo', 'Mode', 'payment_mode'], "Cash")
                # Handle cut off header "yment Mo" just in case, though usually pandas reads full header if just invisible
                mode = mode_raw.title() if mode_raw else "Cash" # CREDIT -> Credit
                
                amt_val = safe_get(['Amount', 'amount'], 0)
                try:
                    amount = float(amt_val)
                except:
                    amount = 0.0
                
                cursor.execute("SELECT party_id FROM parties WHERE normalized_name=?", (str(party).lower().replace(" ","_"),))
                res = cursor.fetchone()
                if res:
                    pid = res[0]
                else:
                    norm = str(party).lower().replace(" ","_")
                    cursor.execute("INSERT INTO parties (name, normalized_name, type, credit_allowed) VALUES (?, ?, 'Customer', 1)", (str(party), norm))
                    pid = cursor.lastrowid
                
                cursor.execute(
                    "INSERT INTO transactions (txn_date, bill_no, party_id, txn_type, payment_mode, amount) VALUES (?, ?, ?, ?, ?, ?)",
                    (date, bill, pid, ttype, mode, amount)
                )
                success += 1
            except Exception as row_err:
                failed_rows.append({"row": row_num, "reason": str(row_err)})
                errors += 1
        
        conn.close()
        
        # Build detailed response
        response_detail = f"✓ Imported: {success} rows"
        if errors > 0:
            response_detail += f" | ✗ Failed: {errors} rows"
            if len(failed_rows) <= 20:  # Show details if not too many
                response_detail += "\n\nFailed rows:\n"
                for fail in failed_rows:
                    response_detail += f"• Line {fail['row']}: {fail['reason']}\n"
            else:
                response_detail += f"\n\nShowing first 20 failed rows:\n"
                for fail in failed_rows[:20]:
                    response_detail += f"• Line {fail['row']}: {fail['reason']}\n"
                response_detail += f"... and {len(failed_rows) - 20} more"
        
        return {"status": "Imported", "detail": response_detail, "success": success, "errors": errors, "failed_rows": failed_rows}

    except ImportError:
         return {"status": "Error", "detail": "pandas/openpyxl libraries not installed."}
    except Exception as e:
        return {"status": "Error", "detail": str(e)}

def get_opening_cash_before_date(cursor, start_date: datetime.date, opening_seed: float) -> float:
    cursor.execute(
        "SELECT TOP 1 cash_date, cash_in_hand FROM daily_cash WHERE cash_date < ? ORDER BY cash_date DESC",
        (start_date,)
    )
    row = cursor.fetchone()
    if row and row[1] is not None:
        return float(row[1])

    cursor.execute(
        """
        SELECT
            SUM(CASE WHEN payment_mode='Cash' AND txn_type IN ('Sale','Receipt') THEN amount ELSE 0 END)
            + SUM(CASE WHEN payment_mode='Credit' AND txn_type='Receipt' THEN amount ELSE 0 END) AS cash_in,
            SUM(CASE WHEN payment_mode='Cash' AND txn_type='Expense' THEN amount ELSE 0 END) AS cash_expense
        FROM transactions
        WHERE txn_date < ?
        """,
        (start_date,)
    )
    sums = cursor.fetchone()
    cash_in = float(sums[0] or 0)
    cash_expense = float(sums[1] or 0)
    return opening_seed + cash_in - cash_expense

@app.get("/report/daily-summary")
def get_daily_summary_report(start: Optional[str] = None, end: Optional[str] = None, days: int = 30):
    start_date, end_date = resolve_date_range(start, end, days)
    cache_key = (current_company or "default", "daily_summary", str(start_date), str(end_date))
    cached = cache_get(cache_key)
    if cached is not None:
        return cached

    conn = get_db_connection()
    cursor = conn.cursor()

    cursor.execute(
        """
        SELECT DISTINCT d FROM (
            SELECT txn_date AS d FROM transactions WHERE txn_date BETWEEN ? AND ?
            UNION
            SELECT cash_date AS d FROM daily_cash WHERE cash_date BETWEEN ? AND ?
        ) dates
        """,
        (start_date, end_date, start_date, end_date)
    )
    date_rows = cursor.fetchall()
    dates = sorted([r[0] for r in date_rows])
    if not dates:
        conn.close()
        cache_set(cache_key, [])
        return []

    cursor.execute(
        """
        SELECT cash_date, cash_in_hand
        FROM daily_cash
        WHERE cash_date BETWEEN ? AND ?
        """,
        (start_date, end_date)
    )
    cash_rows = cursor.fetchall()
    cash_map = {r[0]: float(r[1]) for r in cash_rows}

    cursor.execute(
        """
        SELECT
            t.txn_date,
            SUM(CASE WHEN t.txn_type='Sale' THEN t.amount ELSE 0 END) AS total_sales,
            SUM(CASE WHEN t.payment_mode='Cash' AND t.txn_type IN ('Sale','Receipt') THEN t.amount ELSE 0 END)
              + SUM(CASE WHEN t.payment_mode='Credit' AND t.txn_type='Receipt' THEN t.amount ELSE 0 END) AS cash_in,
            SUM(CASE WHEN t.payment_mode='Cash' AND t.txn_type='Expense' THEN t.amount ELSE 0 END) AS cash_expense,
            SUM(CASE WHEN t.payment_mode IN ('Bank','UPI','GPay','GPAY','Google Pay','GooglePay') AND t.txn_type IN ('Sale','Receipt') THEN t.amount ELSE 0 END) AS bank_in,
            SUM(CASE WHEN t.txn_type='Sale' AND (p.type='Credit Customer' OR t.payment_mode='Credit') THEN t.amount ELSE 0 END) AS credit_sales,
            SUM(CASE WHEN t.txn_type='Receipt' AND p.type='Credit Customer' THEN t.amount ELSE 0 END) AS credit_receipts
        FROM transactions t
        LEFT JOIN parties p ON t.party_id = p.party_id
        WHERE t.txn_date BETWEEN ? AND ?
        GROUP BY t.txn_date
        """,
        (start_date, end_date)
    )
    agg_rows = cursor.fetchall()

    opening_seed = get_setting("opening_cash_seed", 0.0)
    opening_cash_seed = get_opening_cash_before_date(cursor, start_date, opening_seed) if dates else opening_seed
    conn.close()

    agg_map = {}
    for row in agg_rows:
        agg_map[row[0]] = {
            "total_sales": float(row[1] or 0),
            "cash_in": float(row[2] or 0),
            "cash_expense": float(row[3] or 0),
            "bank": float(row[4] or 0),
            "credit_sales": float(row[5] or 0),
            "credit_receipts": float(row[6] or 0)
        }

    summary = []
    prev_cash_in_hand = None
    prev_closing = opening_cash_seed

    for idx, d in enumerate(dates):
        if idx == 0:
            opening_cash = opening_cash_seed
        else:
            opening_cash = prev_cash_in_hand if prev_cash_in_hand is not None else prev_closing

        agg = agg_map.get(d, {})
        cash_in = agg.get("cash_in", 0.0)
        cash_expense = agg.get("cash_expense", 0.0)
        bank = agg.get("bank", 0.0)
        total_sales = agg.get("total_sales", 0.0)
        credit_sale = agg.get("credit_sales", 0.0) - agg.get("credit_receipts", 0.0)

        computed_closing = opening_cash + cash_in - cash_expense
        cash_in_hand = cash_map.get(d)
        cash_short_excess = 0.0
        closing_cash = computed_closing

        if cash_in_hand is not None:
            cash_short_excess = cash_in_hand - computed_closing
            closing_cash = cash_in_hand

        summary.append({
            "date": str(d),
            "opening_cash": opening_cash,
            "cash_in": cash_in,
            "cash_expense": cash_expense,
            "cash_needed": computed_closing,
            "closing_cash": closing_cash,
            "cash_in_hand": cash_in_hand,
            "cash_short_excess": cash_short_excess,
            "bank": bank,
            "credit_sale": credit_sale,
            "total_sales": total_sales
        })

        prev_cash_in_hand = cash_in_hand
        prev_closing = computed_closing

    summary = sorted(summary, key=lambda x: x["date"], reverse=True)
    cache_set(cache_key, summary)
    return summary

@app.get("/report/short-excess")
def get_short_excess_report(start: Optional[str] = None, end: Optional[str] = None, days: int = 30):
    data = get_daily_summary_report(start=start, end=end, days=days)
    return [
        {
            "date": row["date"],
            "opening_cash": row["opening_cash"],
            "cash_in": row["cash_in"],
            "cash_expense": row["cash_expense"],
            "cash_needed": row["cash_needed"],
            "cash_in_hand": row["cash_in_hand"],
            "cash_short_excess": row["cash_short_excess"]
        }
        for row in data
    ]

@app.get("/settings/opening-cash")
def get_opening_cash():
    return {"opening_cash": get_setting("opening_cash_seed", 0.0)}

@app.post("/settings/opening-cash")
def set_opening_cash(req: OpeningCashRequest):
    try:
        set_setting("opening_cash_seed", float(req.amount))
        invalidate_report_cache()
        log_audit(req.admin_user, "Set Opening Cash", f"Opening Cash Seed set to {req.amount}")
        return {"status": "Saved"}
    except Exception as e:
        return {"status": "Error", "detail": str(e)}

@app.post("/cash/hand")
def set_cash_in_hand(req: CashInHandRequest):
    try:
        conn = get_db_connection()
        cursor = conn.cursor()
        cursor.execute("SELECT COUNT(*) FROM daily_cash WHERE cash_date=?", (req.date,))
        exists = cursor.fetchone()[0] > 0
        if exists:
            cursor.execute("UPDATE daily_cash SET cash_in_hand=?, updated_at=CURRENT_TIMESTAMP WHERE cash_date=?", (req.cash_in_hand, req.date))
        else:
            cursor.execute("INSERT INTO daily_cash (cash_date, cash_in_hand) VALUES (?, ?)", (req.date, req.cash_in_hand))
        conn.close()
        invalidate_report_cache()
        log_audit(req.admin_user, "Set Cash In Hand", f"{req.date} = {req.cash_in_hand}")
        return {"status": "Saved"}
    except Exception as e:
        return {"status": "Error", "detail": str(e)}

# Duplicate log_audit removed


class RenamePartyRequest(BaseModel):
    old_name: str
    new_name: str
    admin_user: str

@app.post("/party/rename")
def rename_party(req: RenamePartyRequest):
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        # Check if old exists
        cursor.execute("SELECT party_id FROM parties WHERE normalized_name=?", (req.old_name.lower().replace(" ","_"),))
        row = cursor.fetchone()
        if not row:
            conn.close()
            raise HTTPException(status_code=404, detail="Party not found")
        
        party_id = row[0]
        new_norm = req.new_name.lower().replace(" ","_")
        
        # Check if new name taken
        cursor.execute("SELECT COUNT(*) FROM parties WHERE normalized_name=? AND party_id != ?", (new_norm, party_id))
        if cursor.fetchone()[0] > 0:
            conn.close()
            raise HTTPException(status_code=400, detail="New name already exists")
            
        cursor.execute("UPDATE parties SET name=?, normalized_name=? WHERE party_id=?", (req.new_name, new_norm, party_id))
        conn.close()
        
        log_audit(req.admin_user, "Rename Party", f"Renamed {req.old_name} to {req.new_name}")
        return {"status": "Renamed Successfully"}
    except Exception as e:
        # conn.close() # Might fail if conn not open? No, local. 
        # Safe to let garbage collector handle if we return, but explicitly closing is better.
        try: conn.close() 
        except: pass
        return {"status": "Error", "detail": str(e)}

class CheckUserRequest(BaseModel):
    username: str

@app.post("/check-user")
def check_user(req: CheckUserRequest):
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT COUNT(*) FROM users WHERE username=?", (req.username,))
    exists = cursor.fetchone()[0] > 0
    conn.close()
    return {"exists": exists}

@app.post("/login")
def login(req: LoginRequest):
    conn = get_db_connection()
    cursor = conn.cursor()
    hashed = hashlib.sha256(req.password.encode()).hexdigest()
    cursor.execute("SELECT role FROM users WHERE username=? AND password_hash=?", (req.username, hashed))
    row = cursor.fetchone()
    conn.close()
    
    if row:
        log_audit(req.username, "Login", "User logged in")
        return {"status": "Success", "username": req.username, "role": row[0]}
    else:
        raise HTTPException(status_code=401, detail="Invalid Credentials")

@app.get("/users")
def get_users():
    conn = get_db_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT username, role FROM users")
    data = [{"username": r[0], "role": r[1]} for r in cursor.fetchall()]
    conn.close()
    return data

@app.post("/users")
def create_user(req: CreateUserRequest):
    conn = get_db_connection()
    cursor = conn.cursor()
    # Check if exists
    cursor.execute("SELECT COUNT(*) FROM users WHERE username=?", (req.username,))
    if cursor.fetchone()[0] > 0:
        conn.close()
        raise HTTPException(status_code=400, detail="User already exists")
    
    hashed = hashlib.sha256(req.password.encode()).hexdigest()
    try:
        cursor.execute("INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)", (req.username, hashed, req.role))
        conn.close()
        log_audit("admin", "Create User", f"Created user {req.username} as {req.role}") # Assuming admin context for now
        return {"status": "User Created"}
    except Exception as e:
        try: conn.close() 
        except: pass
        return {"status": "Error", "detail": str(e)}

@app.post("/users/password")
def change_user_password(req: ChangePasswordRequest):
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("SELECT COUNT(*) FROM users WHERE username=?", (req.username,))
        if cursor.fetchone()[0] == 0:
            conn.close()
            raise HTTPException(status_code=404, detail="User not found")

        hashed = hashlib.sha256(req.new_password.encode()).hexdigest()
        cursor.execute("UPDATE users SET password_hash=? WHERE username=?", (hashed, req.username))
        conn.close()

        log_audit(req.admin_user, "Change Password", f"Password changed for {req.username}")
        return {"status": "Password Updated"}
    except Exception as e:
        try: conn.close()
        except: pass
        return {"status": "Error", "detail": str(e)}

@app.delete("/users/{username}")
def delete_user(username: str):
    conn = get_db_connection()
    cursor = conn.cursor()
    if username == "admin":
        conn.close()
        raise HTTPException(status_code=400, detail="Cannot delete default admin")
    
    cursor.execute("DELETE FROM users WHERE username=?", (username,))
    conn.close()
    log_audit("admin", "Delete User", f"Deleted user {username}")
    return {"status": "User Deleted"}

@app.get("/audit")
def get_audit_logs():
    conn = get_db_connection()
    cursor = conn.cursor()
    comp = current_company or "default"
    # Show all audit logs for the current company
    cursor.execute("SELECT timestamp, username, action, details FROM audit_logs WHERE company=? ORDER BY timestamp DESC", (comp,))
    data = [{"timestamp": str(r[0]), "username": r[1], "action": r[2], "details": r[3]} for r in cursor.fetchall()]
    conn.close()
    return data

# Transaction Editing (Admin Only)
class EditTxnRequest(BaseModel):
    txn_id: int
    admin_user: str
    field: str
    new_value: str

@app.post("/transaction/edit")
def edit_transaction(req: EditTxnRequest):
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        # Whitelist fields
        allowed_fields = ["txn_date", "bill_no", "txn_type", "payment_mode", "amount"]
        if req.field not in allowed_fields:
            raise HTTPException(status_code=400, detail="Invalid field")

        # Get old value for audit
        # Note: field name in SELECT must be safe because we whitelisted it above
        cursor.execute(f"SELECT {req.field} FROM transactions WHERE txn_id=?", (req.txn_id,))
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Transaction not found")
        
        old_val = str(row[0])
            
        cursor.execute(f"UPDATE transactions SET {req.field}=? WHERE txn_id=?", (req.new_value, req.txn_id))
        conn.close()
        invalidate_report_cache()
        
        log_audit(req.admin_user, "Edit Transaction", f"Changed {req.field} from {old_val} to {req.new_value} for Txn ID {req.txn_id}")
        return {"status": "Updated Successfully"}
    except Exception as e:
        conn.close() # Ensure close on error
        return {"status": "Error", "detail": str(e)}

class DeleteTxnRequest(BaseModel):
    txn_id: int
    admin_user: str

@app.post("/transaction/delete")
def delete_transaction(req: DeleteTxnRequest):
    conn = get_db_connection()
    cursor = conn.cursor()
    try:
        # Fetch details for audit
        cursor.execute("SELECT txn_date, bill_no, amount, party_id FROM transactions WHERE txn_id=?", (req.txn_id,))
        row = cursor.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Transaction not found")
            
        details = f"Date: {row[0]}, Bill: {row[1]}, Amount: {row[2]}"
        
        cursor.execute("DELETE FROM transactions WHERE txn_id=?", (req.txn_id,))
        conn.close()
        invalidate_report_cache()
        
        log_audit(req.admin_user, "Delete Transaction", f"Deleted Txn ID {req.txn_id}. {details}")
        return {"status": "Deleted Successfully"}
    except Exception as e:
        conn.close()
        return {"status": "Error", "detail": str(e)}

# Database Configuration Endpoints
class DbConfigRequest(BaseModel):
    server: str
    database: str
    auth_type: str  # 'windows' or 'sql'
    username: str = ""
    password: str = ""
    backup_dir: str = ""

@app.get("/config/database")
def get_db_config():
    """Get current database configuration"""
    cfg = load_runtime_config()
    return {
        "server": cfg["server"],
        "database": cfg["database"],
        "auth_type": cfg["auth_type"],
        "username": cfg["username"],
        "backup_dir": cfg["backup_dir"]
    }

@app.post("/config/database/test")
def test_db_config(req: DbConfigRequest):
    """Test database connection with provided settings"""
    try:
        if req.auth_type == "windows":
            conn_str = f"DRIVER={{ODBC Driver 17 for SQL Server}};SERVER={req.server};DATABASE={req.database};Trusted_Connection=yes;TrustServerCertificate=yes;"
        else:
            conn_str = f"DRIVER={{ODBC Driver 17 for SQL Server}};SERVER={req.server};DATABASE={req.database};UID={req.username};PWD={req.password};TrustServerCertificate=yes;"
        
        # Test connection
        test_conn = pyodbc.connect(conn_str, timeout=5, autocommit=True)
        test_conn.close()
        
        return {"success": True, "message": "Connection successful"}
    except Exception as e:
        return {"success": False, "error": str(e)}

@app.post("/config/database")
def save_db_config(req: DbConfigRequest):
    """Save database configuration to file"""
    try:
        import json
        
        config_data = {
            "server": req.server,
            "database": req.database,
            "auth_type": req.auth_type,
            "username": req.username if req.auth_type == "sql" else "",
            "password": req.password if req.auth_type == "sql" else "",
            "backup_dir": req.backup_dir
        }
        
        # Save to config.py
        auth_comment = 'SQL Server' if req.auth_type == 'sql' else 'Windows'
        safe_backup_dir = (req.backup_dir or "").replace("\\", "\\\\")
        config_content = f"""# SQL Server Configuration
# Update these values with your SQL Server connection details

# Common values:
# - "localhost" or "(local)" for default instance
# - "localhost\\SQLEXPRESS" for SQL Express
# - "localhost\\MSSQLSERVER" for named instance
# - "." for local default instance
SQL_SERVER = "{req.server}"  # Your SQL Server instance

SQL_DATABASE = "{req.database}"  # database name
SQL_USERNAME = "{req.username if req.auth_type == 'sql' else ''}"  # SQL Server username (leave empty for Windows Auth)
SQL_PASSWORD = "{req.password if req.auth_type == 'sql' else ''}"  # SQL Server password (leave empty for Windows Auth)
SQL_DRIVER = "{{ODBC Driver 17 for SQL Server}}"  # or "{{SQL Server}}" for older versions
BACKUP_TARGET_DIR = "{safe_backup_dir}"  # UNC share path for SQL Server backups (optional)

# Connection string - {auth_comment} Authentication
"""
        if req.auth_type == "windows":
            config_content += f'CONNECTION_STRING = f"DRIVER={{SQL_DRIVER}};SERVER={{SQL_SERVER}};DATABASE={{SQL_DATABASE}};Trusted_Connection=yes;TrustServerCertificate=yes;"\n'
        else:
            config_content += f'CONNECTION_STRING = f"DRIVER={{SQL_DRIVER}};SERVER={{SQL_SERVER}};DATABASE={{SQL_DATABASE}};UID={{SQL_USERNAME}};PWD={{SQL_PASSWORD}};TrustServerCertificate=yes;"\n'
        
        try:
            with open("config.py", "w") as f:
                f.write(config_content)
        except Exception:
            pass
        
        # Also save to JSON for easy retrieval
        os.makedirs(CONFIG_DIR, exist_ok=True)
        with open(CONFIG_FILE, "w") as f:
            json.dump(config_data, f, indent=2)
        
        return {"success": True, "message": "Configuration saved. Please restart the application."}
    except Exception as e:
        return {"success": False, "error": str(e)}


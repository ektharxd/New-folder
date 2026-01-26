import pyodbc
from config import CONNECTION_STRING

conn = pyodbc.connect(CONNECTION_STRING, autocommit=True, timeout=5)
cursor = conn.cursor()

print("Testing Outstanding Report Query:")
print("-" * 80)

# Exact query from backend
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
print(f"Found {len(rows)} Credit Customer parties")
print()

outstanding = []
for name, sales, receipts in rows:
    s = float(sales or 0)
    r = float(receipts or 0)
    balance = s - r
    if balance > 0:
        outstanding.append({"party": name, "balance": balance})
        print(f"{name}: Sales={s:.2f}, Receipts={r:.2f}, Balance={balance:.2f}")

print()
print(f"Total parties with outstanding balance: {len(outstanding)}")

# Also check what Customer type shows
print("\n" + "="*80)
print("Checking regular 'Customer' type:")
cursor.execute("""
    SELECT p.name, p.type,
           SUM(CASE WHEN t.txn_type = 'Sale' THEN t.amount ELSE 0 END) as sales,
           SUM(CASE WHEN t.txn_type = 'Receipt' THEN t.amount ELSE 0 END) as receipts
    FROM parties p
    LEFT JOIN transactions t ON p.party_id = t.party_id
    WHERE p.type = 'Customer'
    GROUP BY p.name, p.type
""")
rows = cursor.fetchall()
for row in rows:
    s = float(row[2] or 0)
    r = float(row[3] or 0)
    balance = s - r
    print(f"{row[0]} ({row[1]}): Sales={s:.2f}, Receipts={r:.2f}, Balance={balance:.2f}")

conn.close()

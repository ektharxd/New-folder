import pyodbc
from config import CONNECTION_STRING

try:
    print(f"Connecting to: {CONNECTION_STRING}")
    conn = pyodbc.connect(CONNECTION_STRING, timeout=5)
    cursor = conn.cursor()
    
    print("Executing query...")
    cursor.execute('SELECT * FROM parties')
    rows = cursor.fetchall()
    
    print(f'\nFound {len(rows)} parties:')
    print('party_id | name | normalized_name | type | credit_allowed')
    print('-' * 80)

    for row in rows:
        print(f'{row[0]} | {row[1]} | {row[2]} | {row[3]} | {row[4]}')

    conn.close()
except Exception as e:
    print(f"Error: {e}")

# SQL Server Migration Guide

## Prerequisites

1. **SQL Server Installation**
   - Install SQL Server (Express, Developer, or Standard edition)
   - Install SQL Server Management Studio (SSMS) - optional but recommended

2. **ODBC Driver**
   - Download and install "ODBC Driver 17 for SQL Server" from Microsoft
   - https://learn.microsoft.com/en-us/sql/connect/odbc/download-odbc-driver-for-sql-server

## Setup Steps

### 1. Create Database

Open SQL Server Management Studio or use sqlcmd and run:

```sql
CREATE DATABASE finlogs;
GO

USE finlogs;
GO
```

### 2. Configure Connection

Edit `config.py` file with your SQL Server details:

```python
SQL_SERVER = "localhost"  # or your server name/IP (e.g., "localhost\\SQLEXPRESS")
SQL_DATABASE = "finlogs"
SQL_USERNAME = "sa"  # or your SQL Server username
SQL_PASSWORD = "YourStrongPassword123!"  # your SQL Server password
SQL_DRIVER = "{ODBC Driver 17 for SQL Server}"
```

**Connection String Examples:**

- **Windows Authentication:**
  ```python
  CONNECTION_STRING = f"DRIVER={SQL_DRIVER};SERVER={SQL_SERVER};DATABASE={SQL_DATABASE};Trusted_Connection=yes;"
  ```

- **SQL Server Authentication (default in config.py):**
  ```python
  CONNECTION_STRING = f"DRIVER={SQL_DRIVER};SERVER={SQL_SERVER};DATABASE={SQL_DATABASE};UID={SQL_USERNAME};PWD={SQL_PASSWORD};TrustServerCertificate=yes;"
  ```

### 3. Install Python Dependencies

```bash
pip install -r requirements.txt
```

This will install `pyodbc` and other required packages.

### 4. Initialize Database

When you first run the backend, it will automatically create all required tables and indexes.

```bash
python -m uvicorn backend:app --host 127.0.0.1 --port 8000
```

### 5. Enable SQL Server Authentication (if needed)

If using SQL Authentication, ensure SQL Server is configured for mixed mode:

1. Open SSMS
2. Right-click on server → Properties
3. Go to Security page
4. Select "SQL Server and Windows Authentication mode"
5. Restart SQL Server service

### 6. Create SQL Server Login (if needed)

```sql
-- Create login
CREATE LOGIN finlogs_user WITH PASSWORD = 'YourStrongPassword123!';
GO

-- Create user in database
USE finlogs;
GO
CREATE USER finlogs_user FOR LOGIN finlogs_user;
GO

-- Grant permissions
ALTER ROLE db_owner ADD MEMBER finlogs_user;
GO
```

## Key Changes from SQLite

1. **Data Types:**
   - `TEXT` → `NVARCHAR(255)` or `NVARCHAR(MAX)`
   - `INTEGER` → `INT`
   - `REAL` → `DECIMAL(18,2)`
   - `PRIMARY KEY AUTOINCREMENT` → `PRIMARY KEY IDENTITY(1,1)`

2. **Date Functions:**
   - SQLite `date('now')` → SQL Server `CAST(GETDATE() AS DATE)`
   - SQLite `strftime()` → SQL Server `MONTH()`, `YEAR()`, `DAY()`

3. **Table Creation:**
   - `CREATE TABLE IF NOT EXISTS` → `IF NOT EXISTS (...) CREATE TABLE`

4. **NULL Handling:**
   - SQLite `IFNULL()` or `COALESCE()` → SQL Server `ISNULL()` or `COALESCE()`

5. **Boolean Values:**
   - SQLite `0/1` → SQL Server `BIT` type (0/1)

6. **Backup/Restore:**
   - File-based SQLite backups not applicable
   - Use SQL Server BACKUP/RESTORE commands or SSMS

## Testing the Connection

Run this Python script to test your connection:

```python
import pyodbc
from config import CONNECTION_STRING

try:
    conn = pyodbc.connect(CONNECTION_STRING, timeout=5)
    print("✓ Successfully connected to SQL Server!")
    cursor = conn.cursor()
    cursor.execute("SELECT @@VERSION")
    row = cursor.fetchone()
    print(f"SQL Server Version: {row[0][:50]}...")
    conn.close()
except Exception as e:
    print(f"✗ Connection failed: {e}")
```

## Troubleshooting

### Error: "Data source name not found"
- Install ODBC Driver 17 for SQL Server
- Or change driver to `{SQL Server}` in config.py

### Error: "Login failed for user"
- Check username and password in config.py
- Ensure SQL Server authentication is enabled
- Verify user has permissions on the database

### Error: "Cannot open database"
- Ensure the database exists (CREATE DATABASE finlogs)
- Check database name in config.py matches

### Connection Timeout
- Check SQL Server is running
- Verify firewall allows connection on port 1433
- Check server name/IP is correct

## Performance Tips

1. **Indexes** - Already created automatically by init_db()
2. **Connection Pooling** - pyodbc handles this internally
3. **Query Optimization** - Use parameterized queries (already implemented)
4. **Regular Maintenance** - Run SQL Server maintenance plans for index optimization

## Migrating Existing SQLite Data (Optional)

If you have existing SQLite data to migrate:

1. Export from SQLite to CSV using the existing export feature
2. Import CSV using the application's import feature
3. Or manually using SQL Server's BULK INSERT or Import Wizard

---

**Note:** The application will automatically create all tables and indexes on first run. Make sure your SQL Server is running and accessible before starting the backend.

# SQL Server Configuration
# Update these values with your SQL Server connection details

# Common values:
# - "localhost" or "(local)" for default instance
# - "localhost\SQLEXPRESS" for SQL Express
# - "localhost\MSSQLSERVER" for named instance
# - "." for local default instance
SQL_SERVER = "localhost"  # Your SQL Server instance

SQL_DATABASE = "finlogs"  # database name
SQL_USERNAME = ""  # SQL Server username (leave empty for Windows Auth)
SQL_PASSWORD = ""  # SQL Server password (leave empty for Windows Auth)
SQL_DRIVER = "{ODBC Driver 17 for SQL Server}"  # or "{SQL Server}" for older versions
BACKUP_TARGET_DIR = ""  # UNC share path for SQL Server backups (optional)

# Connection string - Windows Authentication
CONNECTION_STRING = f"DRIVER={SQL_DRIVER};SERVER={SQL_SERVER};DATABASE={SQL_DATABASE};Trusted_Connection=yes;TrustServerCertificate=yes;"

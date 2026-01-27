# M-Finlogs
To make it flawless:

Run backend on server 24/7
python -m uvicorn backend:app --host 0.0.0.0 --port 8000
Set API base URL in the client (e.g., http://SERVER_IP:8000).
Right now it’s hardcoded to 127.0.0.1. I can make this configurable in the login screen so each client sets the server IP once.
Open firewall on server for port 8000.

What changed

Added API Server URL field to the Configure Database modal.
The client saves config to a writable location (user profile), not inside app.asar.
All fetch('http://127.0.0.1:8000/...') calls are automatically rewritten to the saved API base.
Client config is always saved locally—even if backend is reachable.
How to use

Run npm run dist and install on client.
Open Configure Database:
API Server URL: http://SERVER_IP:8000
SQL Server details (if needed for server config)
Save and restart the app.


For server installation you only need the backend files:

Required (source‑run):

backend.py
config.py
requirements.txt
db_config.json (optional, created on first save)
If packaged server:

backend.exe
db_config.json (optional)
Also required on server:

Python (if running source)
ODBC Driver 17 for SQL Server
SQL Server (or reachable DB)
Added Server Mode so the server keeps running after the app closes.

What you get:

Install Server Mode button (creates a Windows Scheduled Task)
Uninstall Server Mode button
Backend can run headless on startup
How it works:

On server machine, click Install Server Mode in Settings.
It registers a task named M-FinlogsServer.
Backend starts at boot on 0.0.0.0:8000.
Notes:

For packaged app: it runs backend.exe with FINLOGS_HOST=0.0.0.0.
For dev mode: it runs python -m uvicorn backend:app.
Restart the app, then go to Settings → Server Mode and click Install Server Mode.
Windows install checklist (short):

SQL Server

Install Microsoft SQL Server (Database Engine).
Choose Mixed Mode if you want SQL logins.
SSMS (SQL Server Management Studio)

Install SSMS separately from Microsoft’s SSMS download page.
ODBC Driver

Install Microsoft ODBC Driver 17 or 18 for SQL Server.
Python

Install Python 3.11+ (ensure “Add Python to PATH” is checked).
After that, open SSMS to create/verify the database, and the app will connect using the driver.

SQL Server (Database Engine)

Install Microsoft SQL Server (Developer or Express).
Enable Mixed Mode if you need SQL logins.
SSMS

Install SQL Server Management Studio (SSMS) separately.
ODBC Driver

Install ODBC Driver 17 or 18 for SQL Server.
Python

Install Python 3.11+ and tick Add Python to PATH.
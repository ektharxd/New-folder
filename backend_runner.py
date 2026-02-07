"""
Backend runner for PyInstaller
This ensures all routes are registered before starting uvicorn
"""
import os

if __name__ == "__main__":
    # Import backend module to register all routes
    import backend
    
    # Now start uvicorn with the app
    import uvicorn
    host = os.environ.get("FINLOGS_HOST", "127.0.0.1")
    port = int(os.environ.get("FINLOGS_PORT", "8000"))
    uvicorn.run(backend.app, host=host, port=port, reload=False)

const { app, BrowserWindow, ipcMain, dialog, globalShortcut } = require('electron');
const path = require('path');
const { execFile, spawn } = require('child_process');
const net = require('net');

let mainWindow;
let splashWindow;
let backendProcess = null;

function createSplashWindow() {
    splashWindow = new BrowserWindow({
        width: 500,
        height: 300,
        frame: false,
        alwaysOnTop: true,
        transparent: true,
        resizable: false,
        webPreferences: {
            nodeIntegration: true
        }
    });
    splashWindow.loadFile('splash.html');
}

function createMainWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        title: "M-Finlogs",
        autoHideMenuBar: true,
        show: false,
        icon: path.join(__dirname, 'assets', 'finlogs.ico'),
        roundedCorners: true,
        titleBarStyle: 'hidden',
        titleBarOverlay: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    mainWindow.loadFile('index.html');

    

    mainWindow.once('ready-to-show', () => {
        setTimeout(() => {
            if (splashWindow) splashWindow.close();
            mainWindow.show();
        }, 2500);
    });
}

function isPortFree(port, host = '127.0.0.1') {
    return new Promise((resolve) => {
        const tester = net.createServer()
            .once('error', () => resolve(false))
            .once('listening', () => tester.once('close', () => resolve(true)).close())
            .listen(port, host);
    });
}

async function startBackend() {
    // Start backend in both dev and production mode
    const { spawn } = require('child_process');
    
    const envVars = { ...process.env, FINLOGS_CONFIG_DIR: app.getPath('userData') };

    const portFree = await isPortFree(8000, '127.0.0.1');
    if (!portFree) {
        console.warn('Backend not started: port 8000 already in use.');
        return false;
    }

    if (app.isPackaged) {
        // Production: use compiled backend.exe
        const backendPath = path.join(process.resourcesPath, 'backend.exe');
        console.log("Starting backend:", backendPath);
        backendProcess = execFile(backendPath, { env: envVars }, (error) => {
            if (error) {
                console.error("Backend failed:", error);
            }
        });
        return true;
    } else {
        // Development: start uvicorn server
        console.log("Dev Mode: Starting uvicorn backend server...");
        backendProcess = spawn('python', [
            '-m', 'uvicorn', 
            'backend:app', 
            '--host', '127.0.0.1', 
            '--port', '8000'
        ], {
            cwd: __dirname,
            shell: false,
            env: envVars
        });
        
        backendProcess.stdout.on('data', (data) => {
            console.log(`Backend: ${data}`);
        });
        
        backendProcess.stderr.on('data', (data) => {
            console.error(`Backend Error: ${data}`);
        });
        return true;
    }
}

function killBackend() {
    if (backendProcess) {
        backendProcess.kill();
        backendProcess = null;
    }
}

app.whenReady().then(async () => {
    await startBackend(); // Start Python Server
    createSplashWindow();
    createMainWindow();

    globalShortcut.register('Alt+E', () => {
        if (!mainWindow) return;
        if (mainWindow.webContents.isDevToolsOpened()) {
            mainWindow.webContents.closeDevTools();
        } else {
            mainWindow.webContents.openDevTools({ mode: 'detach' });
        }
    });
}).catch((err) => {
    console.error('App startup error:', err);
});

app.on('will-quit', () => {
    globalShortcut.unregisterAll();
    killBackend();
});

app.on('window-all-closed', () => {
    killBackend();
    if (process.platform !== 'darwin') app.quit();
});

// IPC
ipcMain.handle('dialog:save', async (event, defaultName) => {
    const { canceled, filePath } = await dialog.showSaveDialog({
        defaultPath: defaultName,
        filters: [{ name: 'Excel Files', extensions: ['xlsx'] }]
    });
    if (canceled) return null;
    return filePath;
});

ipcMain.handle('dialog:saveBackup', async (event, defaultName) => {
    const { canceled, filePath } = await dialog.showSaveDialog({
        defaultPath: defaultName,
        filters: [{ name: 'SQL Server Backup', extensions: ['bak'] }]
    });
    if (canceled) return null;
    return filePath;
});

ipcMain.handle('dialog:open', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'Backup Files', extensions: ['db'] }]
    });
    if (canceled || !filePaths.length) return null;
    return filePaths[0];
});

ipcMain.handle('dialog:openBackup', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
        properties: ['openFile'],
        filters: [{ name: 'SQL Server Backup', extensions: ['bak'] }]
    });
    if (canceled || !filePaths.length) return null;
    return filePaths[0];
});

ipcMain.handle('app:getUserDataPath', async () => {
    return app.getPath('userData');
});


ipcMain.handle('server:restart', async () => {
    try {
        killBackend();
        await new Promise((r) => setTimeout(r, 300));
        const portFree = await isPortFree(8000, '127.0.0.1');
        if (!portFree) {
            return { success: false, error: 'Port 8000 is still in use. Stop the existing backend and try again.' };
        }
        const started = await startBackend();
        if (!started) {
            return { success: false, error: 'Backend did not start. Port may be in use.' };
        }
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('server:stop', async () => {
    try {
        killBackend();
        const { exec } = require('child_process');

        const command = 'powershell -NoProfile -ExecutionPolicy Bypass -Command "' +
            'Get-NetTCPConnection -LocalPort 8000 -ErrorAction SilentlyContinue | ' +
            'Select-Object -First 1 -ExpandProperty OwningProcess | ' +
            'ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"';

        return await new Promise((resolve) => {
            exec(command, (err) => {
                if (err) return resolve({ success: false, error: err.message });
                resolve({ success: true });
            });
        });
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('server:install', async () => {
    try {
        const taskName = 'M-FinlogsServer';
        const fs = require('fs');
        const userDataPath = app.getPath('userData');
        
        // Create a startup script instead of inline command
        const scriptPath = path.join(userDataPath, 'start_server.bat');
        
        let scriptContent;
        if (app.isPackaged) {
            const backendPath = path.join(process.resourcesPath, 'backend.exe');
            scriptContent = `@echo off
set FINLOGS_CONFIG_DIR=${userDataPath}
set FINLOGS_HOST=0.0.0.0
set FINLOGS_PORT=8000
"${backendPath}"`;
        } else {
            scriptContent = `@echo off
cd /d "${__dirname}"
set FINLOGS_CONFIG_DIR=${userDataPath}
set FINLOGS_HOST=0.0.0.0
set FINLOGS_PORT=8000
python -m uvicorn backend:app --host 0.0.0.0 --port 8000`;
        }
        
        // Write the script file
        fs.writeFileSync(scriptPath, scriptContent, 'utf8');
        
        const { exec } = require('child_process');
        return await new Promise((resolve) => {
            // Create scheduled task that runs the script
            exec(`schtasks /Create /F /SC ONSTART /RL HIGHEST /TN "${taskName}" /TR "\\"${scriptPath}\\""`, (err, stdout, stderr) => {
                if (err) return resolve({ success: false, error: stderr || err.message });
                resolve({ success: true });
            });
        });
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('server:uninstall', async () => {
    try {
        const { exec } = require('child_process');
        const fs = require('fs');
        const userDataPath = app.getPath('userData');
        const scriptPath = path.join(userDataPath, 'start_server.bat');
        
        return await new Promise((resolve) => {
            exec(`schtasks /Delete /F /TN "M-FinlogsServer"`, (err, stdout, stderr) => {
                // Try to delete the script file (ignore errors if it doesn't exist)
                try {
                    if (fs.existsSync(scriptPath)) {
                        fs.unlinkSync(scriptPath);
                    }
                } catch (e) {
                    console.error('Could not delete script file:', e);
                }
                
                if (err) return resolve({ success: false, error: stderr || err.message });
                resolve({ success: true });
            });
        });
    } catch (e) {
        return { success: false, error: e.message };
    }
});

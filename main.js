const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const { execFile, spawn } = require('child_process');

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
        title: "Finlogs",
        autoHideMenuBar: true,
        show: false,
        icon: path.join(__dirname, 'assets', 'finlogs.svg'),
        roundedCorners: true,
        titleBarStyle: 'hidden',
        titleBarOverlay: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });
    mainWindow.loadFile('index.html');

    
    mainWindow.webContents.openDevTools();

    mainWindow.once('ready-to-show', () => {
        setTimeout(() => {
            if (splashWindow) splashWindow.close();
            mainWindow.show();
        }, 2500);
    });
}

function startBackend() {
    // Start backend in both dev and production mode
    const { spawn } = require('child_process');
    
    const envVars = { ...process.env, FINLOGS_CONFIG_DIR: app.getPath('userData') };

    if (app.isPackaged) {
        // Production: use compiled backend.exe
        const backendPath = path.join(process.resourcesPath, 'backend.exe');
        console.log("Starting backend:", backendPath);
        backendProcess = execFile(backendPath, { env: envVars }, (error) => {
            if (error) {
                console.error("Backend failed:", error);
            }
        });
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
            shell: true,
            env: envVars
        });
        
        backendProcess.stdout.on('data', (data) => {
            console.log(`Backend: ${data}`);
        });
        
        backendProcess.stderr.on('data', (data) => {
            console.error(`Backend Error: ${data}`);
        });
    }
}

function killBackend() {
    if (backendProcess) {
        backendProcess.kill();
        backendProcess = null;
    }
}

app.whenReady().then(() => {
    startBackend(); // Start Python Server
    createSplashWindow();
    createMainWindow();
});

app.on('will-quit', killBackend);

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

ipcMain.handle('server:install', async () => {
    try {
        const taskName = 'FinlogsServer';
        const backendPath = app.isPackaged
            ? path.join(process.resourcesPath, 'backend.exe')
            : path.join(__dirname, 'backend.py');

        const command = app.isPackaged
            ? `cmd /c "set FINLOGS_HOST=0.0.0.0& set FINLOGS_PORT=8000& \"${backendPath}\""`
            : `cmd /c "cd /d \"${__dirname}\" & set FINLOGS_HOST=0.0.0.0& set FINLOGS_PORT=8000& python -m uvicorn backend:app --host 0.0.0.0 --port 8000"`;

        const { exec } = require('child_process');
        return await new Promise((resolve) => {
            exec(`schtasks /Create /F /SC ONSTART /RL HIGHEST /TN "${taskName}" /TR "${command}"`, (err, stdout, stderr) => {
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
        return await new Promise((resolve) => {
            exec(`schtasks /Delete /F /TN "FinlogsServer"`, (err, stdout, stderr) => {
                if (err) return resolve({ success: false, error: stderr || err.message });
                resolve({ success: true });
            });
        });
    } catch (e) {
        return { success: false, error: e.message };
    }
});

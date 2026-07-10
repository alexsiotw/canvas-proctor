const { app, BrowserWindow, ipcMain, screen, session } = require('electron');
const path = require('path');
const { exec } = require('child_process');
const https = require('https');
const fs = require('fs');
// Register custom protocol handler
if (process.defaultApp) {
    if (process.argv.length >= 2) {
        app.setAsDefaultProtocolClient('canvasproctor', process.execPath, [path.resolve(process.argv[1])]);
    }
} else {
    app.setAsDefaultProtocolClient('canvasproctor');
}

let mainWindow = null;
let monitorInterval = null;
let isMonitoringActive = false;
let allowedUrlsList = [];
let allowedAppsList = [];
let childWindow = null;

function isUrlAllowed(urlStr) {
    if (!isMonitoringActive) {
        return true;
    }
    try {
        const urlObj = new URL(urlStr);
        const hostname = urlObj.hostname.toLowerCase();
        
        // Always allow localhost
        if (hostname === 'localhost' || hostname === '127.0.0.1') {
            return true;
        }
        
        // Always allow Canvas and Proctor servers
        if (hostname.endsWith('canvas.siotw.net') || hostname === 'canvas.siotw.net') {
            return true;
        }
        if (hostname.endsWith('proctor.siotw.net') || hostname === 'proctor.siotw.net') {
            return true;
        }
        
        // Check allowed URLs list
        for (const allowed of allowedUrlsList) {
            const cleanAllowed = allowed.toLowerCase().trim();
            if (!cleanAllowed) continue;
            
            if (hostname === cleanAllowed || hostname.endsWith('.' + cleanAllowed)) {
                return true;
            }
        }
        
        return false;
    } catch (e) {
        return false;
    }
}

function isExternalAllowedUrl(urlStr) {
    try {
        const urlObj = new URL(urlStr);
        const hostname = urlObj.hostname.toLowerCase();
        
        if (hostname.endsWith('canvas.siotw.net') || hostname === 'canvas.siotw.net' ||
            hostname.endsWith('proctor.siotw.net') || hostname === 'proctor.siotw.net' ||
            hostname === 'localhost' || hostname === '127.0.0.1') {
            return false;
        }
        
        return isUrlAllowed(urlStr);
    } catch (e) {
        return false;
    }
}

function openAllowedUrlInChildWindow(url) {
    if (childWindow) {
        childWindow.loadURL(url);
        childWindow.focus();
        return;
    }
    
    childWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        alwaysOnTop: true,
        frame: true,
        webPreferences: {
            contextIsolation: true,
            nodeIntegration: false
        }
    });
    
    childWindow.maximize();
    childWindow.loadURL(url);
    
    childWindow.webContents.on('will-navigate', (event, childUrl) => {
        if (!isUrlAllowed(childUrl)) {
            event.preventDefault();
            console.log(`[Companion Child] Blocked navigation to: ${childUrl}`);
        }
    });
    
    childWindow.webContents.on('will-frame-navigate', (event) => {
        if (!isUrlAllowed(event.url)) {
            event.preventDefault();
        }
    });
    
    childWindow.on('closed', () => {
        childWindow = null;
    });
}


function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        kiosk: true,
        fullscreen: true,
        alwaysOnTop: true,
        frame: false,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            webviewTag: true
        }
    });

    mainWindow.loadFile(path.join(__dirname, 'browser.html'));

    // Check for updates shortly after loading the window
    mainWindow.webContents.once('did-finish-load', () => {
        setTimeout(checkForUpdates, 3000);
    });

    mainWindow.webContents.on('before-input-event', (event, input) => {
        const key = input.key.toLowerCase();
        
        // Block F5 and Ctrl+R (page refresh)
        if (key === 'f5' || ((input.control || input.meta) && key === 'r')) {
            event.preventDefault();
        }
        // Block F12 and Ctrl+Shift+I (developer tools)
        if (key === 'f12' || ((input.control || input.meta) && input.shift && key === 'i')) {
            event.preventDefault();
        }
        // Block F11 and Escape (fullscreen toggles)
        if (key === 'f11' || key === 'escape') {
            event.preventDefault();
        }
        // Block Alt+F4 (window close)
        if (input.alt && key === 'f4') {
            event.preventDefault();
        }
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
        isMonitoringActive = false;
        if (monitorInterval) {
            clearInterval(monitorInterval);
        }
    });
}

// Function to fetch list of running processes in a lightweight, cross-platform way
function getRunningProcesses() {
    return new Promise((resolve, reject) => {
        if (process.platform === 'win32') {
            exec('tasklist /NH /FO CSV', (err, stdout, stderr) => {
                if (err) return reject(err);
                const processes = [];
                const lines = stdout.split('\n');
                for (let line of lines) {
                    line = line.trim();
                    if (!line) continue;
                    const parts = line.split('","');
                    if (parts.length > 0) {
                        let procName = parts[0];
                        if (procName.startsWith('"')) procName = procName.slice(1);
                        if (procName.endsWith('"')) procName = procName.slice(0, -1);
                        processes.push(procName.toLowerCase());
                    }
                }
                resolve(processes);
            });
        } else {
            exec('ps -ax -o comm', (err, stdout, stderr) => {
                if (err) return reject(err);
                const processes = stdout.split('\n')
                    .map(p => p.trim())
                    .filter(Boolean)
                    .map(p => p.split('/').pop().toLowerCase());
                resolve(processes);
            });
        }
    });
}

// Monitor IPC start/stop monitoring events from LTI page
ipcMain.on('start-monitoring', (event, { blockedApps, allowedApps, allowedUrls }) => {
    if (monitorInterval) clearInterval(monitorInterval);
    isMonitoringActive = true;

    allowedUrlsList = [];
    allowedAppsList = [];
    if (allowedApps) {
        try {
            if (typeof allowedApps === 'string') {
                allowedAppsList = allowedApps.split(',').map(a => a.trim()).filter(Boolean);
            } else {
                allowedAppsList = allowedApps;
            }
        } catch (e) {
            allowedAppsList = [];
        }
    }
    console.log('[Companion] Loaded allowed Apps:', allowedAppsList);

    if (mainWindow) {
        mainWindow.webContents.send('monitoring-started');
    }

    if (allowedUrls) {
        try {
            if (typeof allowedUrls === 'string') {
                allowedUrlsList = allowedUrls.split(/[\r\n,]+/).map(u => {
                    let trimmed = u.trim().toLowerCase();
                    if (!trimmed) return '';
                    try {
                        if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) {
                            const urlObj = new URL('https://' + trimmed);
                            return urlObj.hostname;
                        } else {
                            const urlObj = new URL(trimmed);
                            return urlObj.hostname;
                        }
                    } catch (err) {
                        return trimmed;
                    }
                }).filter(Boolean);
            } else {
                allowedUrlsList = allowedUrls;
            }
        } catch (e) {
            allowedUrlsList = [];
        }
    }
    console.log('[Companion] Loaded allowed URLs:', allowedUrlsList);

    let blacklist = [];
    if (blockedApps) {
        try {
            blacklist = typeof blockedApps === 'string' ? JSON.parse(blockedApps) : blockedApps;
        } catch (e) {
            blacklist = blockedApps.split(',').map(a => a.trim().toLowerCase());
        }
    }

    // Default prohibited applications if none are specified
    if (!blacklist || blacklist.length === 0) {
        blacklist = ['discord', 'zoom', 'obs64', 'obs', 'skype', 'teams', 'anydesk', 'teamviewer', 'chrome', 'msedge', 'firefox', 'opera'];
    }

    // Normalize entries
    blacklist = blacklist.map(app => app.toLowerCase().replace(/\.exe$/, ''));

    console.log('[Companion] Starting process monitoring. Blacklist:', blacklist);

    monitorInterval = setInterval(async () => {
        try {
            if (!mainWindow) return;
            
            // 1. Process Monitoring Check
            const running = await getRunningProcesses();
            for (const proc of running) {
                const procNameNoExt = proc.replace(/\.exe$/, '');
                if (blacklist.some(item => procNameNoExt.includes(item))) {
                    console.log(`[Companion] Violation detected: ${proc} is running`);
                    mainWindow.webContents.send('violation-detected', {
                        type: 'prohibited_process',
                        process: proc
                    });
                    break;
                }
            }

            // 2. Multiple Displays Check
            const displays = screen.getAllDisplays();
            if (displays.length > 1) {
                console.log(`[Companion] Violation detected: Multiple screens detected (${displays.length})`);
                mainWindow.webContents.send('violation-detected', {
                    type: 'multiple_displays',
                    count: displays.length
                });
            }

        } catch (err) {
            console.error('Process monitor execution failed:', err);
        }
    }, 3000);
});

ipcMain.on('stop-monitoring', () => {
    console.log('[Companion] Stopping process monitoring.');
    isMonitoringActive = false;
    if (monitorInterval) {
        clearInterval(monitorInterval);
        monitorInterval = null;
    }
    if (childWindow) {
        childWindow.close();
        childWindow = null;
    }
});

// System Details check API for preload.js
ipcMain.handle('get-system-details', async () => {
    const displays = screen.getAllDisplays();
    return {
        platform: process.platform,
        screenCount: displays.length,
        displays: displays.map(d => ({
            id: d.id,
            bounds: d.bounds
        }))
    };
});

ipcMain.handle('get-allowed-urls', () => {
    return allowedUrlsList;
});

ipcMain.handle('get-allowed-apps', () => {
    return allowedAppsList;
});

ipcMain.on('launch-app', (event, appName) => {
    const isAllowed = allowedAppsList.some(allowed => {
        const cleanAllowed = allowed.toLowerCase().replace(/\.exe$/, '').trim();
        const cleanTarget = appName.toLowerCase().replace(/\.exe$/, '').trim();
        return cleanAllowed === cleanTarget;
    });
    
    if (isAllowed) {
        console.log(`[Companion] Launching permitted app: ${appName}`);
        const safeAppName = appName.replace(/[^a-zA-Z0-9.-]/g, '');
        exec(`start ${safeAppName}`, (err) => {
            if (err) {
                console.error(`[Companion] Failed to launch ${safeAppName}:`, err);
            }
        });
    } else {
        console.warn(`[Companion] Blocked attempt to launch unallowed app: ${appName}`);
    }
});

ipcMain.on('open-url', (event, url) => {
    if (isUrlAllowed(url)) {
        openAllowedUrlInChildWindow(url);
    } else {
        event.reply('open-url-blocked', url);
    }
});

ipcMain.on('exit-app', () => {
    console.log('[Companion] Exiting application.');
    if (monitorInterval) {
        clearInterval(monitorInterval);
    }
    if (childWindow) {
        childWindow.close();
        childWindow = null;
    }
    app.quit();
});

app.whenReady().then(() => {
    // Grant media permissions (webcam/mic) to allowed websites (like Google Meet)
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
        const url = details.requestingUrl || webContents.getURL();
        if (permission === 'media') {
            if (isUrlAllowed(url)) {
                return callback(true);
            }
        }
        callback(false);
    });

    createWindow();

    app.on('activate', function () {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
});

app.on('web-contents-created', (event, contents) => {
    if (contents.getType() === 'webview') {
        contents.on('will-navigate', (event, url) => {
            if (isExternalAllowedUrl(url)) {
                event.preventDefault();
                openAllowedUrlInChildWindow(url);
            } else if (!isUrlAllowed(url)) {
                event.preventDefault();
                console.log(`[Companion Webview] Blocked navigation to: ${url}`);
            }
        });
        
        contents.on('will-frame-navigate', (event) => {
            const url = event.url;
            if (isExternalAllowedUrl(url)) {
                event.preventDefault();
                openAllowedUrlInChildWindow(url);
            } else if (!isUrlAllowed(url)) {
                event.preventDefault();
                console.log(`[Companion Webview] Blocked frame navigation to: ${url}`);
            }
        });

        contents.setWindowOpenHandler(({ url }) => {
            if (isExternalAllowedUrl(url)) {
                openAllowedUrlInChildWindow(url);
                return { action: 'deny' };
            } else if (isUrlAllowed(url)) {
                contents.loadURL(url);
                return { action: 'deny' };
            }
            return { action: 'deny' };
        });

        contents.on('before-input-event', (event, input) => {
            const key = input.key.toLowerCase();
            if (key === 'f5' || ((input.control || input.meta) && key === 'r')) {
                event.preventDefault();
            }
            if (key === 'f12' || ((input.control || input.meta) && input.shift && key === 'i')) {
                event.preventDefault();
            }
            if (key === 'f11' || key === 'escape') {
                event.preventDefault();
            }
            if (input.alt && key === 'f4') {
                event.preventDefault();
            }
        });
    }
});

function checkForUpdates() {
    const options = {
        hostname: 'proctor.siotw.net',
        port: 443,
        path: '/companion/version.json',
        method: 'GET',
        headers: {
            'User-Agent': 'CanvasProctorUpdater/1.0.0'
        }
    };

    const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
            try {
                const serverConfig = JSON.parse(data);
                const latestVersion = serverConfig.version;
                const currentVersion = app.getVersion();
                
                console.log(`[Updater] Current version: ${currentVersion}, Latest version: ${latestVersion}`);
                if (compareVersions(latestVersion, currentVersion) > 0) {
                    console.log(`[Updater] Update available: ${latestVersion}`);
                    if (mainWindow) {
                        mainWindow.webContents.send('update-available', {
                            current: currentVersion,
                            latest: latestVersion
                        });
                    }
                }
            } catch (e) {
                console.error('[Updater] Failed to parse version JSON:', e);
            }
        });
    });

    req.on('error', (e) => {
        console.error('[Updater] Version check request failed:', e);
    });
    req.end();
}

function compareVersions(v1, v2) {
    const parts1 = v1.split('.').map(Number);
    const parts2 = v2.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if (parts1[i] > parts2[i]) return 1;
        if (parts1[i] < parts2[i]) return -1;
    }
    return 0;
}

ipcMain.on('trigger-update', () => {
    console.log('[Updater] Update triggered. Downloading MSI Installer...');
    const tempMsi = path.join(app.getPath('temp'), 'CanvasProctorSetup.msi');
    const file = fs.createWriteStream(tempMsi);
    
    https.get('https://proctor.siotw.net/companion/CanvasProctorSetup.msi', (response) => {
        response.pipe(file);
        file.on('finish', () => {
            file.close(() => {
                console.log('[Updater] MSI Installer download finished. Spawning msiexec...');
                const { spawn } = require('child_process');
                const child = spawn('msiexec.exe', ['/i', tempMsi, '/qn'], {
                    detached: true,
                    stdio: 'ignore'
                });
                child.unref();
                app.quit();
            });
        });
    }).on('error', (err) => {
        fs.unlink(tempMsi, () => {});
        console.error('[Updater] Download failed:', err);
        if (mainWindow) {
            mainWindow.webContents.send('update-failed', err.message);
        }
    });
});

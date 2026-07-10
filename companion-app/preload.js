const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('companionAPI', {
    startMonitoring: (params) => ipcRenderer.send('start-monitoring', params),
    stopMonitoring: () => ipcRenderer.send('stop-monitoring'),
    onViolation: (callback) => ipcRenderer.on('violation-detected', (event, data) => callback(data)),
    getSystemDetails: () => ipcRenderer.invoke('get-system-details'),
    exitApp: () => ipcRenderer.send('exit-app'),
    getAllowedUrls: () => ipcRenderer.invoke('get-allowed-urls'),
    openUrl: (url) => ipcRenderer.send('open-url', url),
    onUrlBlocked: (callback) => ipcRenderer.on('open-url-blocked', (event, data) => callback(data)),
    getAllowedApps: () => ipcRenderer.invoke('get-allowed-apps'),
    launchApp: (appName) => ipcRenderer.send('launch-app', appName),
    onMonitoringStarted: (callback) => ipcRenderer.on('monitoring-started', () => callback()),
    onUpdateAvailable: (callback) => ipcRenderer.on('update-available', (event, data) => callback(data)),
    onUpdateFailed: (callback) => ipcRenderer.on('update-failed', (event, data) => callback(data)),
    triggerUpdate: () => ipcRenderer.send('trigger-update')
});

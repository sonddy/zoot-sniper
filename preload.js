const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods to the renderer process
contextBridge.exposeInMainWorld('electronAPI', {
    // Window controls
    minimizeWindow: () => ipcRenderer.send('minimize-window'),
    maximizeWindow: () => ipcRenderer.send('maximize-window'),
    closeWindow: () => ipcRenderer.send('close-window'),

    // License management
    getLicenseStatus: () => ipcRenderer.invoke('get-license-status'),
    activateLicense: (licenseKey) => ipcRenderer.invoke('activate-license', licenseKey),
    getMachineId: () => ipcRenderer.invoke('get-machine-id'),

    // Configuration
    getConfig: () => ipcRenderer.invoke('get-config'),
    saveConfig: (config) => ipcRenderer.invoke('save-config', config),

    // Bot control
    startBot: (config) => ipcRenderer.invoke('start-bot', config),
    stopBot: () => ipcRenderer.invoke('stop-bot'),
    getBalance: () => ipcRenderer.invoke('get-balance'),
    quickBuy: (tokenAddress, config) => ipcRenderer.invoke('quick-buy', tokenAddress, config),
    quickSell: (tokenAddress, sellPercent, config) => ipcRenderer.invoke('quick-sell', tokenAddress, sellPercent, config),
    lookupToken: (tokenAddress) => ipcRenderer.invoke('lookup-token', tokenAddress),
    getPositions: () => ipcRenderer.invoke('get-positions'),
    getWalletHoldings: (config) => ipcRenderer.invoke('get-wallet-holdings', config),

    // Bundle trading
    generateWallets: (count) => ipcRenderer.invoke('generate-wallets', count),
    fundBundleWallets: (walletAddresses, amount, config) => ipcRenderer.invoke('fund-bundle-wallets', walletAddresses, amount, config),
    collectBundleFunds: (wallets, config) => ipcRenderer.invoke('collect-bundle-funds', wallets, config),
    getBundleWalletBalances: (walletAddresses) => ipcRenderer.invoke('get-bundle-wallet-balances', walletAddresses),
    bundleBuy: (tokenAddress, amount, privateKey, config) => ipcRenderer.invoke('bundle-buy', tokenAddress, amount, privateKey, config),
    bundleSell: (tokenAddress, percent, privateKey, config) => ipcRenderer.invoke('bundle-sell', tokenAddress, percent, privateKey, config),

    // Image fetching (bypasses browser security)
    fetchImageAsBase64: (imageUrl) => ipcRenderer.invoke('fetch-image-base64', imageUrl),

    // Live Feed
    startLiveFeed: (platform, minMcap) => ipcRenderer.invoke('start-live-feed', platform, minMcap),
    stopLiveFeed: () => ipcRenderer.invoke('stop-live-feed'),
    onLiveFeedToken: (callback) => {
        ipcRenderer.on('live-feed-token', (event, data) => callback(data));
    },
    onLiveFeedStatus: (callback) => {
        ipcRenderer.on('live-feed-status', (event, status) => callback(status));
    },
    onLiveFeedIconUpdate: (callback) => {
        ipcRenderer.on('live-feed-icon-update', (event, data) => callback(data));
    },
    onLiveFeedSocialsUpdate: (callback) => {
        ipcRenderer.on('live-feed-socials-update', (event, data) => callback(data));
    },

    // Simple Launch (token creation)
    simpleLaunchToken: (launchData) => ipcRenderer.invoke('simple-launch-token', launchData),
    openExternal: (url) => ipcRenderer.invoke('open-external', url),
    selectImageFile: () => ipcRenderer.invoke('select-image-file'),

    // Event listeners
    onBotLog: (callback) => {
        ipcRenderer.on('bot-log', (event, log) => callback(log));
    },
    onBotStats: (callback) => {
        ipcRenderer.on('bot-stats', (event, stats) => callback(stats));
    },

    // Remove listeners
    removeAllListeners: (channel) => {
        ipcRenderer.removeAllListeners(channel);
    }
});


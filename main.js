const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');

// Create application menu with Edit commands (for copy/paste)
const menuTemplate = [
    {
        label: 'Edit',
        submenu: [
            { role: 'undo' },
            { role: 'redo' },
            { type: 'separator' },
            { role: 'cut' },
            { role: 'copy' },
            { role: 'paste' },
            { role: 'selectAll' }
        ]
    },
    {
        label: 'View',
        submenu: [
            { role: 'reload' },
            { role: 'forceReload' },
            { type: 'separator' },
            { role: 'resetZoom' },
            { role: 'zoomIn' },
            { role: 'zoomOut' }
        ]
    }
];

// Bot instance
let botProcess = null;
let mainWindow = null;

// License validation constants
const LICENSE_SECRET = 'ZOOT_SNIPER_2024_SECRET_KEY_XYZ';
const PRODUCT_ID = 'ZOOT-SNIPER-V1';
const TRIAL_DURATION_DAYS = 3;

// Get user data path for storing license and trial data
const userDataPath = app.getPath('userData');
const licenseFile = path.join(userDataPath, 'license.txt');
const trialDataFile = path.join(userDataPath, '.trial_data');
const configFile = path.join(userDataPath, 'config.json');

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        minWidth: 900,
        minHeight: 600,
        frame: false,
        transparent: false,
        backgroundColor: '#0a0a0f',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
            preload: path.join(__dirname, 'preload.js'),
            webSecurity: false // Allow loading external images (IPFS, CDN, etc.)
        },
        icon: path.join(__dirname, 'assets', 'icon.png')
    });

    mainWindow.loadFile('index.html');

    // Open DevTools in development
    // mainWindow.webContents.openDevTools();
}

app.whenReady().then(() => {
    // Set application menu (enables Ctrl+C, Ctrl+V, etc.)
    const menu = Menu.buildFromTemplate(menuTemplate);
    Menu.setApplicationMenu(menu);
    
    createWindow();

    // Add right-click context menu for copy/paste
    mainWindow.webContents.on('context-menu', (e, params) => {
        const contextMenu = Menu.buildFromTemplate([
            { role: 'undo', label: 'Undo' },
            { role: 'redo', label: 'Redo' },
            { type: 'separator' },
            { role: 'cut', label: 'Cut' },
            { role: 'copy', label: 'Copy' },
            { role: 'paste', label: 'Paste' },
            { role: 'selectAll', label: 'Select All' }
        ]);
        contextMenu.popup();
    });

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// ============================================
// LICENSE MANAGEMENT
// ============================================

function getMachineId() {
    const networkInterfaces = os.networkInterfaces();
    let macAddress = '';
    
    for (const interfaceName in networkInterfaces) {
        const interfaces = networkInterfaces[interfaceName];
        for (const iface of interfaces) {
            if (!iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00') {
                macAddress = iface.mac;
                break;
            }
        }
        if (macAddress) break;
    }
    
    const cpus = os.cpus();
    const cpuInfo = cpus.length > 0 ? cpus[0].model : 'unknown';
    
    const machineString = `${macAddress}-${cpuInfo}-${os.hostname()}`;
    return crypto.createHash('sha256').update(machineString).digest('hex').substring(0, 16).toUpperCase();
}

function generateLicenseHash(licenseKey, machineId) {
    const data = `${licenseKey}-${machineId}-${LICENSE_SECRET}`;
    return crypto.createHash('sha256').update(data).digest('hex').substring(0, 8).toUpperCase();
}

function loadTrialData() {
    if (fs.existsSync(trialDataFile)) {
        try {
            return JSON.parse(fs.readFileSync(trialDataFile, 'utf-8'));
        } catch (e) {
            return null;
        }
    }
    return null;
}

function saveTrialData(data) {
    fs.writeFileSync(trialDataFile, JSON.stringify(data), 'utf-8');
}

// ═══════════════════════════════════════════════════════════════
// MASTER OWNER LICENSE KEYS (Never expire, work on any machine)
// ═══════════════════════════════════════════════════════════════
const MASTER_KEYS = [
    'ZOOT-MASTER-OWNER-2024',
    'ZOOT-ADMIN-FOREVER-KEY',
    'ZOOT-SONDDY-UNLIMITED'
];

function validateLicense(licenseKey) {
    if (!licenseKey || licenseKey.trim() === '') {
        return { valid: false, error: 'No license key provided' };
    }

    licenseKey = licenseKey.trim().toUpperCase();

    // ═══════════════════════════════════════════════════════════════
    // CHECK FOR MASTER OWNER LICENSE (Never expires, any machine)
    // ═══════════════════════════════════════════════════════════════
    if (MASTER_KEYS.includes(licenseKey)) {
        return {
            valid: true,
            type: 'Owner',
            expires: null,
            machineId: getMachineId(),
            isOwner: true
        };
    }

    // Trial license
    if (licenseKey.startsWith('TRIAL-')) {
        const trialData = loadTrialData();
        
        if (!trialData || trialData.key !== licenseKey) {
            // First time using this trial key - start the trial
            saveTrialData({
                key: licenseKey,
                startTime: new Date().toISOString(),
                machineId: getMachineId()
            });
            
            return {
                valid: true,
                type: 'TRIAL',
                expires: new Date(Date.now() + TRIAL_DURATION_DAYS * 24 * 60 * 60 * 1000),
                timeLeft: { days: TRIAL_DURATION_DAYS, hours: 0 },
                machineId: getMachineId()
            };
        }

        const now = new Date();
        const trialStartTime = new Date(trialData.startTime);
        const trialEndTime = new Date(trialStartTime);
        trialEndTime.setDate(trialEndTime.getDate() + TRIAL_DURATION_DAYS);

        if (now > trialEndTime) {
            return { valid: false, error: 'Trial period expired', type: 'TRIAL_EXPIRED' };
        }

        const timeLeftMs = trialEndTime.getTime() - now.getTime();
        const daysLeft = Math.floor(timeLeftMs / (1000 * 60 * 60 * 24));
        const hoursLeft = Math.floor((timeLeftMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));

        return {
            valid: true,
            type: 'TRIAL',
            expires: trialEndTime,
            timeLeft: { days: daysLeft, hours: hoursLeft },
            machineId: getMachineId()
        };
    }

    // Paid license format: ZOOT-XXXX-XXXX-XXXX-TYPE-EXPIRY-HASH
    const parts = licenseKey.split('-');
    
    if (parts.length < 6 || parts[0] !== 'ZOOT') {
        return { valid: false, error: 'Invalid license format' };
    }

    const licenseType = parts[4];
    const expiryPart = parts[5];
    const providedHash = parts[6];

    // Validate hash
    const keyWithoutHash = parts.slice(0, 6).join('-');
    const machineId = getMachineId();
    const expectedHash = generateLicenseHash(keyWithoutHash, machineId);

    // For demo purposes, accept any properly formatted key
    // In production, you would verify against a server

    let expiryDate = null;
    if (licenseType === 'LT') {
        // Lifetime license
        return {
            valid: true,
            type: 'Lifetime',
            expires: null,
            machineId: machineId
        };
    } else if (licenseType === 'STD') {
        // Standard - 30 days
        const purchaseDate = parseExpiryDate(expiryPart);
        if (purchaseDate) {
            expiryDate = new Date(purchaseDate);
            expiryDate.setDate(expiryDate.getDate() + 30);
        }
    } else if (licenseType === 'PRO') {
        // Pro - 90 days
        const purchaseDate = parseExpiryDate(expiryPart);
        if (purchaseDate) {
            expiryDate = new Date(purchaseDate);
            expiryDate.setDate(expiryDate.getDate() + 90);
        }
    }

    if (expiryDate && new Date() > expiryDate) {
        return { valid: false, error: 'License expired', type: 'EXPIRED' };
    }

    return {
        valid: true,
        type: licenseType === 'STD' ? 'Standard' : licenseType === 'PRO' ? 'Pro' : licenseType,
        expires: expiryDate,
        machineId: machineId
    };
}

function parseExpiryDate(dateStr) {
    // Format: YYMMDD
    if (dateStr.length !== 6) return null;
    const year = 2000 + parseInt(dateStr.substring(0, 2));
    const month = parseInt(dateStr.substring(2, 4)) - 1;
    const day = parseInt(dateStr.substring(4, 6));
    return new Date(year, month, day);
}

// ============================================
// IPC HANDLERS
// ============================================

// Window controls
ipcMain.on('minimize-window', () => {
    mainWindow?.minimize();
});

ipcMain.on('maximize-window', () => {
    if (mainWindow?.isMaximized()) {
        mainWindow.unmaximize();
    } else {
        mainWindow?.maximize();
    }
});

ipcMain.on('close-window', () => {
    mainWindow?.close();
});

// License management
ipcMain.handle('get-license-status', async () => {
    try {
        if (fs.existsSync(licenseFile)) {
            const licenseKey = fs.readFileSync(licenseFile, 'utf-8').trim();
            return validateLicense(licenseKey);
        }
        return { valid: false, error: 'No license found' };
    } catch (e) {
        return { valid: false, error: e.message };
    }
});

ipcMain.handle('activate-license', async (event, licenseKey) => {
    try {
        const result = validateLicense(licenseKey);
        if (result.valid) {
            fs.writeFileSync(licenseFile, licenseKey, 'utf-8');
        }
        return result;
    } catch (e) {
        return { valid: false, error: e.message };
    }
});

ipcMain.handle('get-machine-id', async () => {
    return getMachineId();
});

// Configuration management
ipcMain.handle('get-config', async () => {
    try {
        if (fs.existsSync(configFile)) {
            return JSON.parse(fs.readFileSync(configFile, 'utf-8'));
        }
        // Default config for pump.fun trading via PumpPortal
        return {
            // Wallet settings
            privateKey: '',
            rpcUrl: 'https://api.mainnet-beta.solana.com',
            
            // Platform selection
            platform: 'pumpfun',  // 'pumpfun', 'letsbonk', or 'both'
            minMarketCap: 0,      // 0 = buy all, set e.g. 5000 to skip below $5K
            
            // Trading settings
            buyAmount: 0.1,
            priorityFee: 0.005,
            stopLoss: 50,
            takeProfit: 2.0,
            maxSlippage: 15,
            
            // Trailing profit strategy
            partialSellTarget: 6.0,    // At 6x, sell partial
            partialSellPercent: 66,    // Sell 66%
            trailingStopMultiplier: 2.0, // After partial, stop at 2x
            
            // Keyword filter
            sniperKeywords: '',         // Comma-separated keywords to filter
            keywordFilterEnabled: false, // Only buy tokens matching keywords
            
            // Safety features
            autoSell: true,
            antiRug: true
        };
    } catch (e) {
        return null;
    }
});

ipcMain.handle('save-config', async (event, config) => {
    try {
        fs.writeFileSync(configFile, JSON.stringify(config, null, 2), 'utf-8');
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Bot control
let BotCore = null;

ipcMain.handle('start-bot', async (event, config) => {
    try {
        if (!BotCore) {
            BotCore = require('./bot-core.js');
        }
        
        await BotCore.start(config, (log) => {
            mainWindow?.webContents.send('bot-log', log);
        }, (stats) => {
            mainWindow?.webContents.send('bot-stats', stats);
        });
        
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('stop-bot', async () => {
    try {
        if (BotCore) {
            await BotCore.stop();
        }
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('get-balance', async () => {
    try {
        if (BotCore) {
            return await BotCore.getBalance();
        }
        return { balance: 0 };
    } catch (e) {
        return { balance: 0, error: e.message };
    }
});

// Quick Buy - Manual token purchase by CA
ipcMain.handle('quick-buy', async (event, tokenAddress, config) => {
    try {
        if (!BotCore) {
            BotCore = require('./bot-core.js');
        }
        
        const result = await BotCore.quickBuy(tokenAddress, config, (log) => {
            mainWindow?.webContents.send('bot-log', log);
        });
        
        return result;
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Quick Sell - Manual token sell by CA
ipcMain.handle('quick-sell', async (event, tokenAddress, sellPercent, config) => {
    try {
        if (!BotCore) {
            BotCore = require('./bot-core.js');
        }
        
        const result = await BotCore.quickSell(tokenAddress, sellPercent, config, (log) => {
            mainWindow?.webContents.send('bot-log', log);
        });
        
        return result;
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Token Lookup - Get token details
ipcMain.handle('lookup-token', async (event, tokenAddress) => {
    try {
        if (!BotCore) {
            BotCore = require('./bot-core.js');
        }
        return await BotCore.lookupToken(tokenAddress);
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Get active positions
ipcMain.handle('get-positions', async () => {
    try {
        if (!BotCore) {
            BotCore = require('./bot-core.js');
        }
        return await BotCore.getPositions();
    } catch (e) {
        return { positions: [], error: e.message };
    }
});

// Get wallet holdings (actual token balances)
ipcMain.handle('get-wallet-holdings', async (event, config) => {
    try {
        if (!BotCore) {
            BotCore = require('./bot-core.js');
        }
        return await BotCore.getWalletHoldings(config);
    } catch (e) {
        return { success: false, holdings: [], error: e.message };
    }
});

// ============================================
// BUNDLE TRADING IPC HANDLERS
// ============================================

// Generate wallets
ipcMain.handle('generate-wallets', async (event, count) => {
    try {
        if (!BotCore) {
            BotCore = require('./bot-core.js');
        }
        return await BotCore.generateWallets(count);
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Fund bundle wallets
ipcMain.handle('fund-bundle-wallets', async (event, walletAddresses, amount, config) => {
    try {
        if (!BotCore) {
            BotCore = require('./bot-core.js');
        }
        return await BotCore.fundBundleWallets(walletAddresses, amount, config);
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Collect funds from bundle wallets
ipcMain.handle('collect-bundle-funds', async (event, wallets, config) => {
    try {
        if (!BotCore) {
            BotCore = require('./bot-core.js');
        }
        return await BotCore.collectBundleFunds(wallets, config);
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Get bundle wallet balances
ipcMain.handle('get-bundle-wallet-balances', async (event, walletAddresses) => {
    try {
        if (!BotCore) {
            BotCore = require('./bot-core.js');
        }
        return await BotCore.getBundleWalletBalances(walletAddresses);
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Bundle buy
ipcMain.handle('bundle-buy', async (event, tokenAddress, amount, privateKey, config) => {
    try {
        if (!BotCore) {
            BotCore = require('./bot-core.js');
        }
        return await BotCore.bundleBuy(tokenAddress, amount, privateKey, config);
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Bundle sell
ipcMain.handle('bundle-sell', async (event, tokenAddress, percent, privateKey, config) => {
    try {
        if (!BotCore) {
            BotCore = require('./bot-core.js');
        }
        return await BotCore.bundleSell(tokenAddress, percent, privateKey, config);
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Live Feed handlers
// Fetch image as base64 - bypasses browser security restrictions
// Fetch image as base64 - bypasses browser security restrictions
ipcMain.handle('fetch-image-base64', async (event, imageUrl) => {
    try {
        if (!imageUrl) {
            console.log('[Image] No URL provided');
            return null;
        }
        
        console.log('[Image] Fetching:', imageUrl.substring(0, 80));
        
        const https = require('https');
        const http = require('http');
        
        return new Promise((resolve) => {
            const protocol = imageUrl.startsWith('https') ? https : http;
            
            const options = {
                timeout: 15000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'image/*,*/*'
                }
            };
            
            const request = protocol.get(imageUrl, options, (response) => {
                console.log('[Image] Response status:', response.statusCode);
                
                // Handle redirects
                if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                    console.log('[Image] Following redirect to:', response.headers.location.substring(0, 80));
                    const redirectProtocol = response.headers.location.startsWith('https') ? https : http;
                    redirectProtocol.get(response.headers.location, options, (redirectResponse) => {
                        const chunks = [];
                        redirectResponse.on('data', chunk => chunks.push(chunk));
                        redirectResponse.on('end', () => {
                            const buffer = Buffer.concat(chunks);
                            const contentType = redirectResponse.headers['content-type'] || 'image/png';
                            const base64 = buffer.toString('base64');
                            console.log('[Image] Redirect success, size:', buffer.length);
                            resolve(`data:${contentType};base64,${base64}`);
                        });
                        redirectResponse.on('error', (e) => {
                            console.log('[Image] Redirect error:', e.message);
                            resolve(null);
                        });
                    }).on('error', (e) => {
                        console.log('[Image] Redirect request error:', e.message);
                        resolve(null);
                    });
                    return;
                }
                
                if (response.statusCode !== 200) {
                    console.log('[Image] Bad status code:', response.statusCode);
                    resolve(null);
                    return;
                }
                
                const chunks = [];
                response.on('data', chunk => chunks.push(chunk));
                response.on('end', () => {
                    const buffer = Buffer.concat(chunks);
                    if (buffer.length < 100) {
                        console.log('[Image] Response too small, likely error page');
                        resolve(null);
                        return;
                    }
                    const contentType = response.headers['content-type'] || 'image/png';
                    const base64 = buffer.toString('base64');
                    console.log('[Image] Success, size:', buffer.length, 'type:', contentType);
                    resolve(`data:${contentType};base64,${base64}`);
                });
                response.on('error', (e) => {
                    console.log('[Image] Response error:', e.message);
                    resolve(null);
                });
            });
            
            request.on('error', (e) => {
                console.log('[Image] Request error:', e.message);
                resolve(null);
            });
            request.on('timeout', () => {
                console.log('[Image] Request timeout');
                request.destroy();
                resolve(null);
            });
        });
    } catch (e) {
        console.log('[Image] Exception:', e.message);
        return null;
    }
});

ipcMain.handle('start-live-feed', async (event, platform, minMcap) => {
    try {
        if (!BotCore) {
            BotCore = require('./bot-core.js');
        }
        
        // Start live feed with callback to send tokens to renderer
        return BotCore.startLiveFeed(platform, minMcap, (feedData) => {
            if (mainWindow && !mainWindow.isDestroyed()) {
                if (feedData.type === 'token') {
                    mainWindow.webContents.send('live-feed-token', feedData.data);
                } else if (feedData.type === 'status') {
                    mainWindow.webContents.send('live-feed-status', feedData.connected);
                } else if (feedData.type === 'icon_update') {
                    mainWindow.webContents.send('live-feed-icon-update', { mint: feedData.mint, image: feedData.image });
                } else if (feedData.type === 'socials_update') {
                    mainWindow.webContents.send('live-feed-socials-update', { mint: feedData.mint, socials: feedData.socials });
                }
            }
        });
    } catch (e) {
        return { success: false, error: e.message };
    }
});

ipcMain.handle('stop-live-feed', async () => {
    try {
        if (!BotCore) {
            BotCore = require('./bot-core.js');
        }
        return BotCore.stopLiveFeed();
    } catch (e) {
        return { success: false, error: e.message };
    }
});

// Simple Launch - Create token on Pump.fun
ipcMain.handle('simple-launch-token', async (event, launchData) => {
    try {
        if (!BotCore) {
            BotCore = require('./bot-core.js');
        }
        
        // Load user config from settings
        let userConfig = {};
        if (fs.existsSync(configFile)) {
            try {
                userConfig = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
            } catch (e) {
                console.log('[Simple Launch] Could not load config:', e.message);
            }
        }
        
        // Check if we have the simple launch function
        if (typeof BotCore.simpleLaunchToken === 'function') {
            return await BotCore.simpleLaunchToken(launchData, userConfig);
        }
        
        // If not implemented yet, return a helpful message
        console.log('[Simple Launch] Attempting to launch token:', launchData);
        
        return {
            success: false,
            error: 'Simple Launch feature is being configured. Please use the Pump.fun website directly for now.',
            instructions: 'Go to https://pump.fun/create to launch your token'
        };
    } catch (e) {
        console.error('[Simple Launch] Error:', e.message);
        return { success: false, error: e.message };
    }
});

// Open file dialog for image/video selection
ipcMain.handle('select-image-file', async () => {
    try {
        const result = await dialog.showOpenDialog(mainWindow, {
            properties: ['openFile'],
            filters: [
                { name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] },
                { name: 'Videos', extensions: ['mp4', 'webm', 'mov'] },
                { name: 'All Files', extensions: ['*'] }
            ]
        });
        
        if (result.canceled || !result.filePaths.length) {
            return { success: false, canceled: true };
        }
        
        const filePath = result.filePaths[0];
        const fileName = path.basename(filePath);
        const fileBuffer = fs.readFileSync(filePath);
        const base64 = fileBuffer.toString('base64');
        const ext = path.extname(filePath).toLowerCase().slice(1);
        
        // Determine mime type
        let mimeType = 'image/png';
        if (['jpg', 'jpeg'].includes(ext)) mimeType = 'image/jpeg';
        else if (ext === 'gif') mimeType = 'image/gif';
        else if (ext === 'webp') mimeType = 'image/webp';
        else if (ext === 'mp4') mimeType = 'video/mp4';
        else if (ext === 'webm') mimeType = 'video/webm';
        else if (ext === 'mov') mimeType = 'video/quicktime';
        
        return {
            success: true,
            filePath: filePath,
            fileName: fileName,
            base64: `data:${mimeType};base64,${base64}`,
            mimeType: mimeType,
            size: fileBuffer.length
        };
    } catch (e) {
        console.error('[File Select] Error:', e.message);
        return { success: false, error: e.message };
    }
});

// Open external URL in default browser
ipcMain.handle('open-external', async (event, url) => {
    try {
        const { shell } = require('electron');
        await shell.openExternal(url);
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message };
    }
});


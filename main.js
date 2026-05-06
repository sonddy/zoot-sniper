const { app, BrowserWindow, ipcMain, dialog, Menu, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const https = require('https');
const journal = require('./trade-journal');

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

// ═══════════════════════════════════════════════════════════════
// LICENSE VALIDATION
// All trust now lives on the licensing server (see ./licensing-server). The
// shipped client only knows the API URL + a public key for verifying signed
// JWTs. No master keys, no shared secret — what's in the asar is no longer
// enough to bypass licensing.
//
// LICENSE_API_URL can be overridden at runtime so we can point a build at a
// staging/self-hosted server without re-shipping. Falls back to the
// production endpoint baked in below.
// ═══════════════════════════════════════════════════════════════
const LICENSE_API_URL = process.env.ZOOT_LICENSE_API_URL ||
    'https://license.zoot.bot/v1';
const PRODUCT_ID = 'ZOOT-SNIPER-V2';
const TRIAL_DURATION_DAYS = 3;
const OFFLINE_GRACE_HOURS = 72; // keep working for 72h if the API is unreachable

// Get user data path for storing license and trial data
const userDataPath = app.getPath('userData');
const licenseFile = path.join(userDataPath, 'license.txt');
const licenseCacheFile = path.join(userDataPath, '.license_cache');
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

    // Initialize the trade journal in userData so bot-core / IPC handlers
    // share a singleton instance (require cache).
    journal.init(userDataPath);

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

function loadLicenseCache() {
    try {
        if (!fs.existsSync(licenseCacheFile)) return null;
        return JSON.parse(fs.readFileSync(licenseCacheFile, 'utf-8'));
    } catch (e) {
        return null;
    }
}

function saveLicenseCache(payload) {
    try {
        fs.writeFileSync(licenseCacheFile, JSON.stringify(payload), 'utf-8');
    } catch (e) {}
}

/**
 * Hit the licensing API. Throws on network or server error so callers can
 * decide between rejecting and falling back to cached state.
 */
function fetchLicenseStatusRemote(licenseKey, machineId) {
    return new Promise((resolve, reject) => {
        try {
            const u = new URL(`${LICENSE_API_URL}/validate`);
            const body = JSON.stringify({
                licenseKey,
                machineId,
                product: PRODUCT_ID,
                appVersion: app.getVersion ? app.getVersion() : '2.0.0'
            });
            const req = https.request({
                hostname: u.hostname,
                port: u.port || 443,
                path: u.pathname + u.search,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body),
                    'User-Agent': `ZootSniper/${PRODUCT_ID}`
                },
                timeout: 5000
            }, (res) => {
                const chunks = [];
                res.on('data', c => chunks.push(c));
                res.on('end', () => {
                    try {
                        const text = Buffer.concat(chunks).toString();
                        if (res.statusCode >= 200 && res.statusCode < 300) {
                            resolve(JSON.parse(text));
                        } else {
                            reject(new Error(`HTTP ${res.statusCode}: ${text.slice(0, 200)}`));
                        }
                    } catch (e) { reject(e); }
                });
            });
            req.on('error', reject);
            req.on('timeout', () => { req.destroy(new Error('License request timed out')); });
            req.write(body);
            req.end();
        } catch (e) {
            reject(e);
        }
    });
}

async function validateLicense(licenseKey) {
    if (!licenseKey || licenseKey.trim() === '') {
        return { valid: false, error: 'No license key provided' };
    }

    licenseKey = licenseKey.trim().toUpperCase();
    const machineId = getMachineId();

    // Local-only: TRIAL keys still bootstrap themselves so a brand-new install
    // can be evaluated without first hitting the server.
    if (licenseKey.startsWith('TRIAL-')) {
        const trialData = loadTrialData();
        if (!trialData || trialData.key !== licenseKey) {
            saveTrialData({
                key: licenseKey,
                startTime: new Date().toISOString(),
                machineId
            });
            return {
                valid: true,
                type: 'TRIAL',
                expires: new Date(Date.now() + TRIAL_DURATION_DAYS * 86400_000),
                timeLeft: { days: TRIAL_DURATION_DAYS, hours: 0 },
                machineId
            };
        }
        const trialEnd = new Date(new Date(trialData.startTime).getTime() + TRIAL_DURATION_DAYS * 86400_000);
        if (Date.now() > trialEnd.getTime()) {
            return { valid: false, error: 'Trial period expired', type: 'TRIAL_EXPIRED' };
        }
        const msLeft = trialEnd.getTime() - Date.now();
        return {
            valid: true,
            type: 'TRIAL',
            expires: trialEnd,
            timeLeft: {
                days: Math.floor(msLeft / 86400_000),
                hours: Math.floor((msLeft % 86400_000) / 3600_000)
            },
            machineId
        };
    }

    // Paid keys go through the server.
    try {
        const remote = await fetchLicenseStatusRemote(licenseKey, machineId);
        if (remote && remote.valid) {
            saveLicenseCache({
                key: licenseKey,
                machineId,
                payload: remote,
                cachedAt: Date.now()
            });
            return {
                valid: true,
                type: remote.type || 'Standard',
                expires: remote.expires ? new Date(remote.expires) : null,
                machineId
            };
        }
        return { valid: false, error: remote?.error || 'License rejected by server' };
    } catch (netErr) {
        // Offline grace: if we have a recent (<72h) cached approval for this
        // exact key + machine, keep working. Otherwise fail closed.
        const cached = loadLicenseCache();
        const ageMs = cached ? (Date.now() - (cached.cachedAt || 0)) : Infinity;
        if (cached && cached.key === licenseKey && cached.machineId === machineId &&
            ageMs <= OFFLINE_GRACE_HOURS * 3600_000 && cached.payload?.valid) {
            const hoursLeft = Math.max(0, OFFLINE_GRACE_HOURS - Math.floor(ageMs / 3600_000));
            return {
                valid: true,
                type: (cached.payload.type || 'Standard') + ' (offline)',
                expires: cached.payload.expires ? new Date(cached.payload.expires) : null,
                machineId,
                offline: true,
                offlineHoursRemaining: hoursLeft
            };
        }
        return {
            valid: false,
            error: `Licensing server unreachable and no offline grace available: ${netErr.message}`
        };
    }
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
            return await validateLicense(licenseKey);
        }
        return { valid: false, error: 'No license found' };
    } catch (e) {
        return { valid: false, error: e.message };
    }
});

ipcMain.handle('activate-license', async (event, licenseKey) => {
    try {
        const result = await validateLicense(licenseKey);
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

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION + ENCRYPTED PRIVATE KEY STORAGE
//
// Private keys are sealed with Electron `safeStorage` (DPAPI on Windows,
// Keychain on macOS, libsecret on Linux). The on-disk format stores only
// the encrypted blob; we never write a plaintext key back. Configs from
// the v1 build are auto-migrated on first read.
// ═══════════════════════════════════════════════════════════════
const DEFAULT_CONFIG = {
    privateKey: '',
    rpcUrl: 'https://api.mainnet-beta.solana.com',

    platform: 'pumpfun',  // 'pumpfun' | 'letsbonk' | 'both'
    minMarketCap: 0,

    buyAmount: 0.1,
    priorityFee: 0.005,
    stopLoss: 50,
    takeProfit: 2.0,
    maxSlippage: 15,

    partialSellTarget: 6.0,
    partialSellPercent: 66,
    trailingStopMultiplier: 2.0,

    sniperKeywords: '',
    keywordFilterEnabled: false,

    autoSell: true,
    antiRug: true,

    // v2: paper trade / dry run
    paperTrade: false,

    // v2: circuit breakers
    dailyLossCapSOL: 0,          // 0 = off
    maxConcurrentPositions: 0,   // 0 = unlimited
    cooldownAfterLosses: 0,      // 0 = off
    cooldownSeconds: 0,

    // v2: Jito bundles
    useJitoBundles: false,
    jitoTipSOL: 0.001,

    // v2.1: copy-trade mode
    copyTradeEnabled: false,
    copyTradeWallets: '',           // comma- or newline-separated wallet pubkeys
    copyTradeSizeMultiplier: 1.0,   // 1.0 = same size, 0.5 = half the source buy
    copyTradeMaxBuySOL: 0.5,        // hard cap regardless of multiplier
    copyTradeMinSourceBuySOL: 0.1,  // ignore source buys below this (skip dust / test trades)
    copyTradeOnlyPumpFun: true,     // skip other DEXes

    // v2.2: Telegram alerts (opt-in; off until both token + chatId are set)
    telegramEnabled: false,
    telegramBotToken: '',
    telegramChatId: '',
    telegramAlertOnBuy: true,
    telegramAlertOnSell: true,
    telegramAlertOnError: true,
    telegramDailySummary: true,
    telegramAlertOnCircuitBreaker: true
};

function decryptPrivateKey(stored) {
    if (!stored) return '';
    if (typeof stored !== 'string') return '';
    if (!stored.startsWith('enc:')) return stored; // legacy plaintext, will be re-encrypted on next save
    try {
        if (!safeStorage.isEncryptionAvailable()) return '';
        return safeStorage.decryptString(Buffer.from(stored.slice(4), 'base64'));
    } catch (e) {
        return '';
    }
}

function encryptPrivateKey(plain) {
    if (!plain) return '';
    try {
        if (!safeStorage.isEncryptionAvailable()) {
            // Encryption isn't available yet (rare; happens before app.whenReady on Linux).
            // Storing plaintext on disk here is unacceptable, so refuse.
            throw new Error('OS keychain not available; cannot store private key');
        }
        const buf = safeStorage.encryptString(plain);
        return 'enc:' + buf.toString('base64');
    } catch (e) {
        throw e;
    }
}

ipcMain.handle('get-config', async () => {
    try {
        if (fs.existsSync(configFile)) {
            const raw = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
            const merged = { ...DEFAULT_CONFIG, ...raw };

            // Decrypt the private key for the renderer; if it's still plaintext
            // (legacy v1 config), it'll come back as-is and get re-encrypted on
            // the very next save-config.
            merged.privateKey = decryptPrivateKey(merged.privateKey);

            // One-time migration: if we just read a plaintext key, persist an
            // encrypted version immediately so we never write it again.
            const original = raw.privateKey;
            if (original && typeof original === 'string' && !original.startsWith('enc:')) {
                try {
                    raw.privateKey = encryptPrivateKey(original);
                    fs.writeFileSync(configFile, JSON.stringify(raw, null, 2), 'utf-8');
                } catch (e) {
                    console.warn('[config] could not migrate plaintext key:', e.message);
                }
            }
            return merged;
        }
        return { ...DEFAULT_CONFIG };
    } catch (e) {
        return null;
    }
});

ipcMain.handle('save-config', async (event, config) => {
    try {
        const persisted = { ...config };
        if (persisted.privateKey) {
            persisted.privateKey = encryptPrivateKey(persisted.privateKey);
        } else {
            persisted.privateKey = '';
        }
        fs.writeFileSync(configFile, JSON.stringify(persisted, null, 2), 'utf-8');
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

// Trade journal — stats panel & history table read from these
ipcMain.handle('get-trade-stats', async () => {
    try {
        return journal.stats();
    } catch (e) {
        return { error: e.message };
    }
});

ipcMain.handle('get-trade-history', async (event, limit) => {
    try {
        return journal.readAll(typeof limit === 'number' ? limit : 100);
    } catch (e) {
        return [];
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


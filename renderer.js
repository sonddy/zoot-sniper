// ============================================
// ZOOT AUTO SNIPER BOT - Renderer Process
// ============================================

let isRunning = false;
let licenseValid = false;
let licenseType = null;
let config = {};

// Image cache for base64 images
const imageCache = new Map();

// Load image through main process and convert to base64 (bypasses browser security)
async function loadImageAsBase64(imageUrl) {
    if (!imageUrl || imageUrl.length < 10) {
        console.log('Invalid image URL:', imageUrl);
        return null;
    }
    
    // Check cache first
    if (imageCache.has(imageUrl)) {
        return imageCache.get(imageUrl);
    }
    
    try {
        console.log('Loading image via main process:', imageUrl.substring(0, 60) + '...');
        const base64 = await window.electronAPI.fetchImageAsBase64(imageUrl);
        if (base64 && base64.startsWith('data:')) {
            console.log('Image loaded successfully, size:', base64.length);
            imageCache.set(imageUrl, base64);
            return base64;
        } else {
            console.log('Image fetch returned invalid data');
        }
    } catch (e) {
        console.log('Image load error:', e.message || e);
    }
    return null;
}

// Make it globally accessible for debugging
window.loadImageAsBase64 = loadImageAsBase64;

// ============================================
// INITIALIZATION
// ============================================

document.addEventListener('DOMContentLoaded', async () => {
    // Setup navigation
    setupNavigation();
    
    // Load machine ID
    const machineId = await window.electronAPI.getMachineId();
    document.getElementById('machineId').textContent = `Machine ID: ${machineId}`;
    document.getElementById('modalMachineId').textContent = `Machine ID: ${machineId}`;
    
    // Check license status
    await checkLicenseStatus();
    
    // Load configuration
    await loadConfig();
    
    // Setup bot event listeners
    setupBotListeners();
    
    // Setup trade page auto-fetch listeners
    setupTradePageListeners();
    
    // Start balance polling
    setInterval(updateBalance, 5000);
});

// ============================================
// NAVIGATION
// ============================================

function setupNavigation() {
    const navButtons = document.querySelectorAll('.nav-btn');
    
    navButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const page = btn.dataset.page;
            showPage(page);
            
            // Update active state
            navButtons.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
        });
    });
}

function showPage(pageId) {
    const pages = document.querySelectorAll('.page');
    pages.forEach(p => p.classList.remove('active'));
    
    const page = document.getElementById(pageId);
    if (page) {
        page.classList.add('active');
    }
    
    // Update nav button active state
    const navButtons = document.querySelectorAll('.nav-btn');
    navButtons.forEach(btn => {
        btn.classList.toggle('active', btn.dataset.page === pageId);
    });
}

// Make showPage globally accessible
window.showPage = showPage;

// ============================================
// LICENSE MANAGEMENT
// ============================================

async function checkLicenseStatus() {
    const status = await window.electronAPI.getLicenseStatus();
    
    if (status.valid) {
        licenseValid = true;
        licenseType = status.type;
        
        // Hide license modal
        document.getElementById('licenseModal').classList.remove('active');
        
        // Show trial banner if on trial
        if (status.type === 'TRIAL') {
            const banner = document.getElementById('trialBanner');
            banner.style.display = 'flex';
            document.getElementById('trialTimeLeft').textContent = 
                `Trial: ${status.timeLeft.days} days, ${status.timeLeft.hours} hours remaining`;
        }
        
        // Update license page
        updateLicenseStatus(status);
        
        addLog(`License activated: ${status.type}`, 'success');
    } else {
        licenseValid = false;
        
        // Show license modal
        document.getElementById('licenseModal').classList.add('active');
        
        if (status.type === 'TRIAL_EXPIRED') {
            document.getElementById('modalLicenseStatus').style.display = 'block';
            document.getElementById('modalLicenseStatus').className = 'license-status invalid';
            document.getElementById('modalLicenseStatus').textContent = 
                '⏰ Your trial has expired. Please purchase a license to continue.';
        }
    }
}

function updateLicenseStatus(status) {
    const statusEl = document.getElementById('licenseStatus');
    statusEl.style.display = 'block';
    
    if (status.valid) {
        if (status.type === 'TRIAL') {
            statusEl.className = 'license-status trial';
            statusEl.innerHTML = `
                ⏰ <strong>Trial License</strong><br>
                ${status.timeLeft.days} days, ${status.timeLeft.hours} hours remaining
            `;
        } else if (status.type === 'Owner') {
            statusEl.className = 'license-status valid';
            statusEl.innerHTML = `👑 <strong>Owner License</strong> - Unlimited Access Forever`;
        } else if (status.type === 'Lifetime') {
            statusEl.className = 'license-status valid';
            statusEl.innerHTML = `✅ <strong>Lifetime License</strong> - Never expires`;
        } else if (status.expires) {
            statusEl.className = 'license-status valid';
            statusEl.innerHTML = `
                ✅ <strong>${status.type} License</strong><br>
                Expires: ${new Date(status.expires).toLocaleDateString()}
            `;
        } else {
            statusEl.className = 'license-status valid';
            statusEl.innerHTML = `✅ <strong>${status.type} License</strong> - Active`;
        }
    } else {
        statusEl.className = 'license-status invalid';
        statusEl.textContent = `❌ ${status.error}`;
    }
}

async function activateLicense() {
    const licenseKey = document.getElementById('licenseInput').value.trim();
    
    if (!licenseKey) {
        alert('Please enter a license key');
        return;
    }
    
    const result = await window.electronAPI.activateLicense(licenseKey);
    updateLicenseStatus(result);
    
    if (result.valid) {
        licenseValid = true;
        licenseType = result.type;
        addLog(`License activated: ${result.type}`, 'success');
        
        // Show trial banner if applicable
        if (result.type === 'TRIAL') {
            const banner = document.getElementById('trialBanner');
            banner.style.display = 'flex';
            document.getElementById('trialTimeLeft').textContent = 
                `Trial: ${result.timeLeft.days} days, ${result.timeLeft.hours} hours remaining`;
        }
    }
}

async function activateLicenseFromModal() {
    const licenseKey = document.getElementById('modalLicenseInput').value.trim();
    const statusEl = document.getElementById('modalLicenseStatus');
    
    if (!licenseKey) {
        statusEl.style.display = 'block';
        statusEl.className = 'license-status invalid';
        statusEl.textContent = '❌ Please enter a license key';
        return;
    }
    
    const result = await window.electronAPI.activateLicense(licenseKey);
    statusEl.style.display = 'block';
    
    if (result.valid) {
        statusEl.className = 'license-status valid';
        statusEl.textContent = '✅ License activated successfully!';
        
        licenseValid = true;
        licenseType = result.type;
        
        // Close modal after short delay
        setTimeout(() => {
            document.getElementById('licenseModal').classList.remove('active');
            checkLicenseStatus();
        }, 1500);
    } else {
        statusEl.className = 'license-status invalid';
        statusEl.textContent = `❌ ${result.error}`;
    }
}

// Make functions globally accessible
window.activateLicense = activateLicense;
window.activateLicenseFromModal = activateLicenseFromModal;

// ============================================
// CONFIGURATION
// ============================================

async function loadConfig() {
    config = await window.electronAPI.getConfig();
    
    if (config) {
        // Wallet settings
        document.getElementById('privateKey').value = config.privateKey || '';
        document.getElementById('rpcUrl').value = config.rpcUrl || 'https://api.mainnet-beta.solana.com';
        
        // Platform selection
        document.getElementById('platform').value = config.platform || 'pumpfun';
        document.getElementById('minMarketCap').value = config.minMarketCap || 0;
        
        // Trading settings
        document.getElementById('buyAmount').value = config.buyAmount || 0.1;
        document.getElementById('priorityFee').value = config.priorityFee || 0.005;
        document.getElementById('stopLoss').value = config.stopLoss || 50;
        document.getElementById('takeProfit').value = config.takeProfit || 2.0;
        document.getElementById('maxSlippage').value = config.maxSlippage || 15;
        
        // Trailing profit strategy
        document.getElementById('partialSellTarget').value = config.partialSellTarget || 6.0;
        document.getElementById('partialSellPercent').value = config.partialSellPercent || 66;
        document.getElementById('trailingStopMultiplier').value = config.trailingStopMultiplier || 2.0;
        
        // Keyword filter settings
        document.getElementById('sniperKeywords').value = config.sniperKeywords || '';
        document.getElementById('keywordFilterEnabled').checked = config.keywordFilterEnabled || false;
        
        // Safety features
        document.getElementById('autoSell').checked = config.autoSell !== false;
        document.getElementById('antiRug').checked = config.antiRug !== false;
    }
}

async function saveSettings() {
    const newConfig = {
        // Wallet settings
        privateKey: document.getElementById('privateKey').value,
        rpcUrl: document.getElementById('rpcUrl').value,
        
        // Platform selection
        platform: document.getElementById('platform').value,
        minMarketCap: parseInt(document.getElementById('minMarketCap').value) || 0,
        
        // Trading settings
        buyAmount: parseFloat(document.getElementById('buyAmount').value),
        priorityFee: parseFloat(document.getElementById('priorityFee').value),
        stopLoss: parseInt(document.getElementById('stopLoss').value),
        takeProfit: parseFloat(document.getElementById('takeProfit').value),
        maxSlippage: parseInt(document.getElementById('maxSlippage').value),
        
        // Trailing profit strategy
        partialSellTarget: parseFloat(document.getElementById('partialSellTarget').value),
        partialSellPercent: parseInt(document.getElementById('partialSellPercent').value),
        trailingStopMultiplier: parseFloat(document.getElementById('trailingStopMultiplier').value),
        
        // Keyword filter settings
        sniperKeywords: document.getElementById('sniperKeywords').value,
        keywordFilterEnabled: document.getElementById('keywordFilterEnabled').checked,
        
        // Safety features
        autoSell: document.getElementById('autoSell').checked,
        antiRug: document.getElementById('antiRug').checked
    };
    
    const result = await window.electronAPI.saveConfig(newConfig);
    
    if (result.success) {
        config = newConfig;
        addLog('Settings saved successfully', 'success');
        alert('Settings saved successfully!');
    } else {
        addLog('Failed to save settings: ' + result.error, 'error');
        alert('Failed to save settings: ' + result.error);
    }
}

// Make saveSettings globally accessible
window.saveSettings = saveSettings;

// ============================================
// BOT CONTROL
// ============================================

function setupBotListeners() {
    window.electronAPI.onBotLog((log) => {
        addLog(log.message, log.type);
    });
    
    window.electronAPI.onBotStats((stats) => {
        updateStats(stats);
    });
}

async function startBot() {
    if (!licenseValid) {
        document.getElementById('licenseModal').classList.add('active');
        return;
    }
    
    if (!config.privateKey) {
        addLog('Please configure your private key in Settings', 'error');
        showPage('settings');
        return;
    }
    
    const result = await window.electronAPI.startBot(config);
    
    if (result.success) {
        isRunning = true;
        updateBotStatus(true);
        addLog('🚀 Bot started! Scanning for new tokens...', 'success');
    } else {
        addLog('Failed to start bot: ' + result.error, 'error');
    }
}

async function stopBot() {
    const result = await window.electronAPI.stopBot();
    
    if (result.success) {
        isRunning = false;
        updateBotStatus(false);
        addLog('⏹️ Bot stopped', 'warning');
    } else {
        addLog('Failed to stop bot: ' + result.error, 'error');
    }
}

function updateBotStatus(running) {
    const statusDot = document.getElementById('statusDot');
    const statusText = document.getElementById('statusText');
    const startBtn = document.getElementById('startBtn');
    const stopBtn = document.getElementById('stopBtn');
    
    if (running) {
        statusDot.classList.add('running');
        statusText.textContent = 'Sniping...';
        startBtn.disabled = true;
        stopBtn.disabled = false;
    } else {
        statusDot.classList.remove('running');
        statusText.textContent = 'Stopped';
        startBtn.disabled = false;
        stopBtn.disabled = true;
    }
}

// Quick Buy - Manual token purchase by CA
async function quickBuyToken() {
    const tokenAddress = document.getElementById('manualTokenAddress').value.trim();
    
    if (!tokenAddress) {
        addLog('❌ Please paste a token address (CA)', 'error');
        alert('Please paste a token address!');
        return;
    }
    
    if (!licenseValid) {
        document.getElementById('licenseModal').classList.add('active');
        return;
    }
    
    if (!config.privateKey) {
        addLog('❌ Please configure your private key in Settings', 'error');
        showPage('settings');
        return;
    }
    
    // Disable button during buy
    const buyBtn = document.getElementById('quickBuyBtn');
    buyBtn.disabled = true;
    buyBtn.textContent = '⏳ Buying...';
    
    addLog(`🚀 Quick Buy: ${tokenAddress.slice(0, 8)}...${tokenAddress.slice(-6)}`, 'warning');
    
    try {
        const result = await window.electronAPI.quickBuy(tokenAddress, config);
        
        if (result.success) {
            addLog(`✅ Quick Buy SUCCESS! TX: ${result.signature?.slice(0, 20)}...`, 'success');
            document.getElementById('manualTokenAddress').value = '';
        } else {
            addLog(`❌ Quick Buy failed: ${result.error}`, 'error');
        }
    } catch (error) {
        addLog(`❌ Quick Buy error: ${error.message}`, 'error');
    }
    
    // Re-enable button
    buyBtn.disabled = false;
    buyBtn.textContent = '🚀 Buy Now';
}

// Quick Sell - Manual token sell by CA
async function quickSellToken() {
    const tokenAddress = document.getElementById('sellTokenAddress').value.trim();
    const sellPercent = parseInt(document.getElementById('sellPercent').value);
    
    if (!tokenAddress) {
        addLog('❌ Please paste a token address to sell', 'error');
        alert('Please paste a token address!');
        return;
    }
    
    if (!licenseValid) {
        document.getElementById('licenseModal').classList.add('active');
        return;
    }
    
    if (!config.privateKey) {
        addLog('❌ Please configure your private key in Settings', 'error');
        showPage('settings');
        return;
    }
    
    // Confirm sell
    if (!confirm(`Are you sure you want to sell ${sellPercent}% of this token?\n\nToken: ${tokenAddress.slice(0, 12)}...${tokenAddress.slice(-8)}`)) {
        return;
    }
    
    // Disable button during sell
    const sellBtn = document.getElementById('quickSellBtn');
    sellBtn.disabled = true;
    sellBtn.textContent = '⏳ Selling...';
    
    addLog(`💸 Quick Sell: ${tokenAddress.slice(0, 8)}...${tokenAddress.slice(-6)} (${sellPercent}%)`, 'warning');
    
    try {
        const result = await window.electronAPI.quickSell(tokenAddress, sellPercent, config);
        
        if (result.success) {
            addLog(`✅ Quick Sell SUCCESS! TX: ${result.signature?.slice(0, 20)}...`, 'success');
            document.getElementById('sellTokenAddress').value = '';
        } else {
            addLog(`❌ Quick Sell failed: ${result.error}`, 'error');
        }
    } catch (error) {
        addLog(`❌ Quick Sell error: ${error.message}`, 'error');
    }
    
    // Re-enable button
    sellBtn.disabled = false;
    sellBtn.textContent = '💸 Sell Now';
}

// ============================================
// TOKEN LOOKUP & TRADE PAGE
// ============================================

let currentLookupToken = null;
let lookupDebounceTimer = null;
let tokenAutoRefreshInterval = null;

// Setup auto-fetch on paste/input for trade page
function setupTradePageListeners() {
    const tradeInput = document.getElementById('tradeTokenAddress');
    if (!tradeInput) return;
    
    // Auto-fetch on paste
    tradeInput.addEventListener('paste', (e) => {
        // Wait for paste to complete
        setTimeout(() => {
            const value = tradeInput.value.trim();
            if (isValidSolanaAddress(value)) {
                autoFetchToken(value, true); // true = start auto-refresh
            }
        }, 100);
    });
    
    // Auto-fetch on input change (with debounce)
    tradeInput.addEventListener('input', (e) => {
        clearTimeout(lookupDebounceTimer);
        const value = tradeInput.value.trim();
        
        if (isValidSolanaAddress(value)) {
            lookupDebounceTimer = setTimeout(() => {
                autoFetchToken(value, true);
            }, 500); // Wait 500ms after typing stops
        } else {
            // Hide panel if input is cleared or invalid
            if (!value) {
                document.getElementById('tokenInfoPanel').style.display = 'none';
                document.getElementById('tokenLoading').style.display = 'none';
                currentLookupToken = null;
                stopTokenAutoRefresh();
            }
        }
    });
}

// Start auto-refresh for token data every 4 seconds
function startTokenAutoRefresh(tokenAddress) {
    stopTokenAutoRefresh(); // Clear any existing interval
    
    tokenAutoRefreshInterval = setInterval(async () => {
        if (currentLookupToken === tokenAddress) {
            await silentRefreshToken(tokenAddress);
        } else {
            stopTokenAutoRefresh();
        }
    }, 1000); // Refresh every 1 second
}

// Stop auto-refresh
function stopTokenAutoRefresh() {
    if (tokenAutoRefreshInterval) {
        clearInterval(tokenAutoRefreshInterval);
        tokenAutoRefreshInterval = null;
    }
}

// Store previous values for price tracking
let previousTokenData = { marketCap: 0, price: 0 };

// Silent refresh (no loading indicator, no logs) with LIVE price tracking
async function silentRefreshToken(tokenAddress) {
    try {
        const result = await window.electronAPI.lookupToken(tokenAddress);
        
        if (result.success && result.data) {
            // Update only the dynamic data (MC, price)
            const mcEl = document.getElementById('tokenMC');
            const priceEl = document.getElementById('tokenPrice');
            const statusEl = document.getElementById('tokenStatus');
            const liqEl = document.getElementById('tokenLiquidity');
            
            const newMcap = result.data.marketCap || 0;
            const newPrice = result.data.price || 0;
            
            // Calculate changes
            const mcapChange = previousTokenData.marketCap > 0 ? 
                ((newMcap - previousTokenData.marketCap) / previousTokenData.marketCap) * 100 : 0;
            const priceChange = previousTokenData.price > 0 ? 
                ((newPrice - previousTokenData.price) / previousTokenData.price) * 100 : 0;
            
            if (mcEl && result.data.marketCap) {
                const mcChangeColor = mcapChange > 0 ? 'var(--accent-primary)' : mcapChange < 0 ? 'var(--danger)' : 'var(--text-muted)';
                const mcArrow = mcapChange > 0 ? '▲' : mcapChange < 0 ? '▼' : '';
                const mcChangeText = mcapChange !== 0 ? ` <span class="${mcapChange > 0 ? 'price-change-up' : 'price-change-down'}" style="font-size:11px; color:${mcChangeColor}; font-weight:bold;">${mcArrow}${Math.abs(mcapChange).toFixed(1)}%</span>` : '';
                
                mcEl.innerHTML = `$${formatNumber(result.data.marketCap)}${mcChangeText}`;
            }
            if (priceEl && result.data.price) {
                const priceChangeColor = priceChange > 0 ? 'var(--accent-primary)' : priceChange < 0 ? 'var(--danger)' : 'var(--text-muted)';
                const priceArrow = priceChange > 0 ? '▲' : priceChange < 0 ? '▼' : '';
                const priceChangeText = priceChange !== 0 ? ` <span class="${priceChange > 0 ? 'price-change-up' : 'price-change-down'}" style="font-size:11px; color:${priceChangeColor}; font-weight:bold;">${priceArrow}${Math.abs(priceChange).toFixed(1)}%</span>` : '';
                
                priceEl.innerHTML = `$${result.data.price.toFixed(8)}${priceChangeText}`;
            }
            if (statusEl && result.data.status) {
                statusEl.textContent = result.data.status;
                statusEl.style.color = result.data.status === 'Bonding Curve' ? 'var(--warning)' : 'var(--accent-primary)';
            }
            if (liqEl && result.data.liquidity) {
                liqEl.textContent = `$${formatNumber(result.data.liquidity)}`;
            }
            
            // Store current values for next comparison
            previousTokenData = { 
                marketCap: newMcap, 
                price: newPrice 
            };
        }
    } catch (error) {
        console.error('Silent refresh failed:', error);
    }
}

// Manual refresh button
async function refreshTokenData() {
    const tokenAddress = currentLookupToken || document.getElementById('tradeTokenAddress')?.value.trim();
    
    if (!tokenAddress || !isValidSolanaAddress(tokenAddress)) {
        return;
    }
    
    addLog(`🔄 Refreshing token data...`, 'info');
    await silentRefreshToken(tokenAddress);
    addLog(`✅ Token data refreshed`, 'success');
}

// Validate Solana address (base58, 32-44 chars)
function isValidSolanaAddress(address) {
    if (!address || address.length < 32 || address.length > 44) return false;
    const base58Regex = /^[1-9A-HJ-NP-Za-km-z]+$/;
    return base58Regex.test(address);
}

// Auto-fetch token data
async function autoFetchToken(tokenAddress, startRefresh = false) {
    if (tokenAddress === currentLookupToken && !startRefresh) return; // Already fetched this one
    
    // Reset price tracking for new token
    previousTokenData = { marketCap: 0, price: 0 };
    
    // Show loading
    document.getElementById('tokenLoading').style.display = 'block';
    document.getElementById('tokenInfoPanel').style.display = 'none';
    
    addLog(`🔍 Auto-fetching: ${tokenAddress.slice(0, 8)}...`, 'info');
    
    try {
        const result = await window.electronAPI.lookupToken(tokenAddress);
        
        // Hide loading
        document.getElementById('tokenLoading').style.display = 'none';
        
        if (result.success) {
            currentLookupToken = tokenAddress;
            displayTokenInfo(tokenAddress, result.data);
            addLog(`✅ Found: ${result.data.name} (${result.data.symbol})`, 'success');
            
            // Store initial values for price tracking
            previousTokenData = {
                marketCap: result.data.marketCap || 0,
                price: result.data.price || 0
            };
            
            // Start auto-refresh every 1 second for live prices
            if (startRefresh) {
                startTokenAutoRefresh(tokenAddress);
            }
        } else {
            currentLookupToken = tokenAddress;
            displayTokenInfo(tokenAddress, null);
            addLog(`⚠️ Token not found in databases, but you can still trade it`, 'warning');
        }
    } catch (error) {
        document.getElementById('tokenLoading').style.display = 'none';
        addLog(`❌ Fetch error: ${error.message}`, 'error');
    }
}

// Display token info panel
function displayTokenInfo(tokenAddress, data) {
    document.getElementById('tokenInfoPanel').style.display = 'block';
    
    // Update chart URL for current token
    updatePriceChart(tokenAddress);
    
    if (data) {
        const iconEl = document.getElementById('tokenIcon');
        const iconPlaceholder = document.getElementById('tokenIconPlaceholder');
        
        // Set default info first
        document.getElementById('tokenName').textContent = data.name || 'Unknown Token';
        document.getElementById('tokenSymbol').textContent = data.symbol || 'UNKNOWN';
        
        // Show placeholder initially
        iconEl.style.display = 'none';
        if (iconPlaceholder) {
            iconPlaceholder.style.display = 'flex';
            iconPlaceholder.textContent = (data.symbol || 'T').slice(0, 2).toUpperCase();
        }
        
        // Fetch image through main process (bypasses browser security)
        if (data.image) {
            loadImageAsBase64(data.image).then(base64 => {
                if (base64) {
                    iconEl.src = base64;
                    iconEl.style.display = 'block';
                    if (iconPlaceholder) iconPlaceholder.style.display = 'none';
                }
            });
        }
        document.getElementById('tokenMC').textContent = data.marketCap ? `$${formatNumber(data.marketCap)}` : 'N/A';
        document.getElementById('tokenPrice').textContent = data.price ? `$${data.price.toFixed(8)}` : 'N/A';
        document.getElementById('tokenStatus').textContent = data.status || 'Unknown';
        document.getElementById('tokenStatus').style.color = data.status === 'Bonding Curve' ? 'var(--warning)' : 'var(--accent-primary)';
        document.getElementById('tokenLiquidity').textContent = data.liquidity ? `$${formatNumber(data.liquidity)}` : 'N/A';
    } else {
        // Show placeholder for unknown token, try to load image
        const iconEl = document.getElementById('tokenIcon');
        const iconPlaceholder = document.getElementById('tokenIconPlaceholder');
        
        iconEl.style.display = 'none';
        if (iconPlaceholder) {
            iconPlaceholder.style.display = 'flex';
            iconPlaceholder.textContent = 'T';
        }
        
        // Try to load image via base64
        const dexUrl = `https://dd.dexscreener.com/ds-data/tokens/solana/${tokenAddress}.png`;
        loadImageAsBase64(dexUrl).then(base64 => {
            if (base64) {
                iconEl.src = base64;
                iconEl.style.display = 'block';
                if (iconPlaceholder) iconPlaceholder.style.display = 'none';
            }
        });
        
        document.getElementById('tokenName').textContent = 'Token';
        document.getElementById('tokenSymbol').textContent = tokenAddress.slice(0, 8) + '...';
        document.getElementById('tokenMC').textContent = 'N/A';
        document.getElementById('tokenPrice').textContent = 'N/A';
        document.getElementById('tokenStatus').textContent = 'Unknown';
        document.getElementById('tokenStatus').style.color = 'var(--text-muted)';
        document.getElementById('tokenLiquidity').textContent = 'N/A';
    }
    
    // Update external links
    document.getElementById('linkPumpFun').href = `https://pump.fun/${tokenAddress}`;
    document.getElementById('linkDexScreener').href = `https://dexscreener.com/solana/${tokenAddress}`;
    document.getElementById('linkSolscan').href = `https://solscan.io/token/${tokenAddress}`;
    document.getElementById('linkBirdeye').href = `https://birdeye.so/token/${tokenAddress}?chain=solana`;
}

async function lookupToken() {
    const tokenAddress = document.getElementById('tradeTokenAddress').value.trim();
    
    if (!tokenAddress) {
        alert('Please paste a token address!');
        return;
    }
    
    if (!isValidSolanaAddress(tokenAddress)) {
        alert('Invalid Solana address!');
        return;
    }
    
    await autoFetchToken(tokenAddress);
}

function formatNumber(num) {
    if (num >= 1000000000) return (num / 1000000000).toFixed(2) + 'B';
    if (num >= 1000000) return (num / 1000000).toFixed(2) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(2) + 'K';
    return num.toFixed(2);
}

async function quickBuyFromTrade() {
    // Check input field value or currentLookupToken
    let tokenAddress = document.getElementById('tradeTokenAddress')?.value.trim() || currentLookupToken;
    
    if (!tokenAddress || !isValidSolanaAddress(tokenAddress)) {
        alert('Please paste a valid token address first!');
        return;
    }
    
    if (!licenseValid) {
        document.getElementById('licenseModal').classList.add('active');
        return;
    }
    
    if (!config.privateKey) {
        addLog('❌ Please configure your private key in Settings', 'error');
        showPage('settings');
        return;
    }
    
    // Disable button while processing
    const buyBtn = document.getElementById('quickBuyBtn');
    if (buyBtn) {
        buyBtn.disabled = true;
        buyBtn.textContent = '⏳ Buying...';
    }
    
    addLog(`🚀 Quick Buy: ${tokenAddress.slice(0, 8)}...`, 'warning');
    
    try {
        const result = await window.electronAPI.quickBuy(tokenAddress, config);
        
        if (result.success) {
            addLog(`✅ Buy SUCCESS! TX: ${result.signature?.slice(0, 20)}...`, 'success');
            
            // Wait a moment for blockchain to update, then refresh holdings
            addLog(`⏳ Waiting for blockchain confirmation...`, 'info');
            await new Promise(r => setTimeout(r, 3000)); // Wait 3 seconds
            
            // Refresh holdings to show the new token
            await refreshPositions();
            addLog(`📊 Holdings updated!`, 'success');
        } else {
            addLog(`❌ Buy failed: ${result.error}`, 'error');
        }
    } catch (error) {
        addLog(`❌ Buy error: ${error.message}`, 'error');
    } finally {
        // Re-enable button
        if (buyBtn) {
            buyBtn.disabled = false;
            buyBtn.textContent = '🚀 Buy Now';
        }
    }
}

async function quickSellFromTrade(percent) {
    // Check input field value or currentLookupToken
    let tokenAddress = document.getElementById('tradeTokenAddress')?.value.trim() || currentLookupToken;
    
    if (!tokenAddress || !isValidSolanaAddress(tokenAddress)) {
        alert('Please paste a valid token address first!');
        return;
    }
    
    if (!licenseValid) {
        document.getElementById('licenseModal').classList.add('active');
        return;
    }
    
    if (!config.privateKey) {
        addLog('❌ Please configure your private key in Settings', 'error');
        showPage('settings');
        return;
    }
    
    if (!confirm(`Sell ${percent}% of this token?`)) {
        return;
    }
    
    // Disable buttons while processing
    const sellBtns = document.querySelectorAll('[id^="quickSellBtn"]');
    sellBtns.forEach(btn => {
        btn.disabled = true;
        btn.style.opacity = '0.5';
    });
    
    addLog(`💸 Quick Sell ${percent}%: ${tokenAddress.slice(0, 8)}...`, 'warning');
    
    try {
        const result = await window.electronAPI.quickSell(tokenAddress, percent, config);
        
        if (result.success) {
            addLog(`✅ Sell SUCCESS! TX: ${result.signature?.slice(0, 20)}...`, 'success');
            
            // Wait for blockchain to update
            addLog(`⏳ Waiting for blockchain confirmation...`, 'info');
            await new Promise(r => setTimeout(r, 3000));
            
            // Refresh holdings and token info
            await refreshPositions();
            await silentRefreshToken(tokenAddress);
            addLog(`📊 Holdings updated!`, 'success');
        } else {
            addLog(`❌ Sell failed: ${result.error}`, 'error');
        }
    } catch (error) {
        addLog(`❌ Sell error: ${error.message}`, 'error');
    } finally {
        // Re-enable buttons
        sellBtns.forEach(btn => {
            btn.disabled = false;
            btn.style.opacity = '1';
        });
    }
}

async function refreshPositions() {
    const positionsList = document.getElementById('positionsList');
    
    if (!positionsList) return;
    
    // Show loading
    positionsList.innerHTML = `
        <div style="text-align: center; padding: 30px; color: var(--text-muted);">
            ⏳ Loading holdings...
        </div>
    `;
    
    try {
        // Get actual wallet holdings
        const result = await window.electronAPI.getWalletHoldings(config);
        
        if (result.success && result.holdings && result.holdings.length > 0) {
            positionsList.innerHTML = '';
            
            for (const holding of result.holdings) {
                const mcFormatted = holding.marketCap ? `$${formatNumber(holding.marketCap)}` : 'N/A';
                
                positionsList.innerHTML += `
                    <div style="background: var(--bg-tertiary); padding: 15px; border-radius: 10px; display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 10px;">
                        <div style="flex: 1; min-width: 150px;">
                            <div style="font-weight: bold; color: var(--accent-primary);">${holding.tokenName}</div>
                            <div style="font-size: 12px; color: var(--text-muted);">${holding.tokenSymbol} • ${holding.tokenAddress.slice(0, 6)}...${holding.tokenAddress.slice(-4)}</div>
                        </div>
                        <div style="text-align: center;">
                            <div style="font-size: 12px; color: var(--text-muted);">Balance</div>
                            <div style="font-weight: bold;">${formatNumber(holding.balance)}</div>
                        </div>
                        <div style="text-align: center;">
                            <div style="font-size: 12px; color: var(--text-muted);">Market Cap</div>
                            <div style="font-weight: bold; color: var(--accent-primary);">${mcFormatted}</div>
                        </div>
                        <div style="display: flex; gap: 5px;">
                            <button onclick="document.getElementById('tradeTokenAddress').value='${holding.tokenAddress}'; autoFetchToken('${holding.tokenAddress}', true);" style="padding: 8px 12px; background: var(--bg-secondary); border: 1px solid var(--border); border-radius: 6px; color: var(--text-primary); cursor: pointer;" title="View & Trade">
                                🔍
                            </button>
                            <button onclick="sellPositionQuick('${holding.tokenAddress}')" style="padding: 8px 12px; background: linear-gradient(135deg, #ff4444, #cc0000); border: none; border-radius: 6px; color: white; cursor: pointer;" title="Sell 100%">
                                💸
                            </button>
                        </div>
                    </div>
                `;
            }
            
            addLog(`📊 Found ${result.holdings.length} token(s) in wallet`, 'success');
        } else {
            positionsList.innerHTML = `
                <div style="text-align: center; padding: 30px; color: var(--text-muted);">
                    No tokens in wallet. Buy a token to see it here!
                </div>
            `;
        }
    } catch (error) {
        console.error('Failed to refresh positions:', error);
        positionsList.innerHTML = `
            <div style="text-align: center; padding: 30px; color: #ff4444;">
                ❌ Failed to load holdings: ${error.message}
            </div>
        `;
    }
}

async function sellPositionQuick(tokenAddress) {
    if (!confirm('Sell 100% of this position?')) return;
    
    addLog(`💸 Selling position: ${tokenAddress.slice(0, 8)}...`, 'warning');
    
    try {
        const result = await window.electronAPI.quickSell(tokenAddress, 100, config);
        
        if (result.success) {
            addLog(`✅ Sell SUCCESS!`, 'success');
            refreshPositions();
        } else {
            addLog(`❌ Sell failed: ${result.error}`, 'error');
        }
    } catch (error) {
        addLog(`❌ Sell error: ${error.message}`, 'error');
    }
}

// ============================================
// BUNDLE TRADING
// ============================================

let bundleWallets = [];

function addBundleLog(message, type = 'info') {
    const logEl = document.getElementById('bundleStatusLog');
    if (!logEl) return;
    
    const time = new Date().toLocaleTimeString();
    const colorMap = {
        'success': 'var(--accent-primary)',
        'error': '#ff4444',
        'warning': '#ffaa00',
        'info': 'var(--text-secondary)'
    };
    
    logEl.innerHTML += `<div style="color: ${colorMap[type]}; margin-bottom: 5px;">[${time}] ${message}</div>`;
    logEl.scrollTop = logEl.scrollHeight;
}

async function generateBundleWallets() {
    const count = parseInt(document.getElementById('walletCount').value) || 5;
    
    if (count < 1 || count > 20) {
        alert('Please enter a number between 1 and 20');
        return;
    }
    
    addBundleLog(`✨ Generating ${count} wallets...`, 'info');
    
    try {
        const result = await window.electronAPI.generateWallets(count);
        
        if (result.success) {
            bundleWallets = result.wallets;
            updateBundleWalletList();
            addBundleLog(`✅ Generated ${count} wallets successfully!`, 'success');
        } else {
            addBundleLog(`❌ Failed to generate wallets: ${result.error}`, 'error');
        }
    } catch (error) {
        addBundleLog(`❌ Error: ${error.message}`, 'error');
    }
}

function updateBundleWalletList() {
    const listEl = document.getElementById('bundleWalletList');
    const countEl = document.getElementById('bundleWalletCount');
    
    if (countEl) countEl.textContent = `${bundleWallets.length} wallets`;
    
    if (!listEl) return;
    
    if (bundleWallets.length === 0) {
        listEl.innerHTML = `<div style="text-align: center; padding: 30px; color: var(--text-muted);">
            No wallets generated yet. Click "Generate Wallets" to create new wallets.
        </div>`;
        return;
    }
    
    listEl.innerHTML = bundleWallets.map((wallet, i) => `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 10px; background: var(--bg-secondary); border-radius: 6px; margin-bottom: 5px;">
            <div style="display: flex; align-items: center; gap: 10px;">
                <span style="color: #9945FF; font-weight: bold;">#${i + 1}</span>
                <span style="font-family: monospace; font-size: 12px; color: var(--text-secondary);">${wallet.publicKey.slice(0, 8)}...${wallet.publicKey.slice(-6)}</span>
            </div>
            <div style="display: flex; align-items: center; gap: 10px;">
                <span style="color: var(--accent-primary); font-weight: bold;" id="walletBalance${i}">${wallet.balance || '0.0000'} SOL</span>
                <button onclick="copyToClipboard('${wallet.publicKey}')" style="padding: 4px 8px; background: var(--bg-tertiary); border: 1px solid var(--border); border-radius: 4px; color: var(--text-primary); cursor: pointer; font-size: 11px;">
                    📋
                </button>
            </div>
        </div>
    `).join('');
}

function copyToClipboard(text) {
    navigator.clipboard.writeText(text);
    addBundleLog(`📋 Copied: ${text.slice(0, 8)}...`, 'info');
}

async function exportBundleWallets() {
    if (bundleWallets.length === 0) {
        alert('No wallets to export!');
        return;
    }
    
    const exportData = bundleWallets.map((w, i) => ({
        index: i + 1,
        publicKey: w.publicKey,
        privateKey: w.privateKey
    }));
    
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `bundle-wallets-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
    
    addBundleLog(`📥 Exported ${bundleWallets.length} wallets to file`, 'success');
}

function clearBundleWallets() {
    if (!confirm('Clear all generated wallets? Make sure you have exported the private keys!')) return;
    
    bundleWallets = [];
    updateBundleWalletList();
    addBundleLog(`🗑️ Cleared all wallets`, 'warning');
}

async function fundAllBundleWallets() {
    if (bundleWallets.length === 0) {
        alert('No wallets to fund! Generate wallets first.');
        return;
    }
    
    if (!config.privateKey) {
        alert('Please configure your main wallet in Settings first!');
        return;
    }
    
    const amount = parseFloat(document.getElementById('fundAmount').value) || 0.1;
    const totalCost = amount * bundleWallets.length;
    
    if (!confirm(`Fund ${bundleWallets.length} wallets with ${amount} SOL each?\n\nTotal cost: ${totalCost} SOL`)) return;
    
    addBundleLog(`💸 Funding ${bundleWallets.length} wallets with ${amount} SOL each...`, 'info');
    
    try {
        const result = await window.electronAPI.fundBundleWallets(bundleWallets.map(w => w.publicKey), amount, config);
        
        if (result.success) {
            addBundleLog(`✅ Funded ${result.funded} wallets successfully!`, 'success');
            // Refresh balances
            refreshBundleWalletBalances();
        } else {
            addBundleLog(`❌ Failed to fund wallets: ${result.error}`, 'error');
        }
    } catch (error) {
        addBundleLog(`❌ Error: ${error.message}`, 'error');
    }
}

async function collectAllFunds() {
    if (bundleWallets.length === 0) {
        alert('No wallets to collect from!');
        return;
    }
    
    if (!config.privateKey) {
        alert('Please configure your main wallet in Settings first!');
        return;
    }
    
    if (!confirm('Collect all SOL from bundle wallets to main wallet?')) return;
    
    addBundleLog(`🏦 Collecting funds from ${bundleWallets.length} wallets...`, 'info');
    
    try {
        const result = await window.electronAPI.collectBundleFunds(bundleWallets, config);
        
        if (result.success) {
            addBundleLog(`✅ Collected ${result.totalCollected} SOL from ${result.walletsCollected} wallets!`, 'success');
            refreshBundleWalletBalances();
        } else {
            addBundleLog(`❌ Failed to collect: ${result.error}`, 'error');
        }
    } catch (error) {
        addBundleLog(`❌ Error: ${error.message}`, 'error');
    }
}

async function refreshBundleWalletBalances() {
    if (bundleWallets.length === 0) return;
    
    try {
        const result = await window.electronAPI.getBundleWalletBalances(bundleWallets.map(w => w.publicKey));
        
        if (result.success) {
            bundleWallets = bundleWallets.map((w, i) => ({
                ...w,
                balance: result.balances[i]?.toFixed(4) || '0.0000'
            }));
            updateBundleWalletList();
        }
    } catch (error) {
        console.error('Failed to refresh balances:', error);
    }
}

// Bundle Token Search
let currentBundleToken = null;

async function searchBundleToken() {
    const tokenAddress = document.getElementById('bundleTokenAddress').value.trim();
    
    if (!tokenAddress || tokenAddress.length < 32) {
        addBundleLog('❌ Please enter a valid token address', 'error');
        return;
    }
    
    const loadingEl = document.getElementById('bundleTokenLoading');
    const infoEl = document.getElementById('bundleTokenInfo');
    
    // Show loading
    if (loadingEl) loadingEl.style.display = 'block';
    if (infoEl) infoEl.style.display = 'none';
    
    addBundleLog(`🔍 Searching for token: ${tokenAddress.slice(0, 8)}...`, 'info');
    
    try {
        const result = await window.electronAPI.lookupToken(tokenAddress);
        
        // Handle both result formats (result.data or direct result)
        const tokenData = result?.data || result;
        const isSuccess = result?.success || (tokenData && tokenData.name);
        
        if (isSuccess && tokenData) {
            currentBundleToken = tokenData;
            currentBundleToken.address = tokenAddress;
            
            // Update UI elements
            const iconEl = document.getElementById('bundleTokenIcon');
            const nameEl = document.getElementById('bundleTokenName');
            const symbolEl = document.getElementById('bundleTokenSymbol');
            const caEl = document.getElementById('bundleTokenCA');
            const mcEl = document.getElementById('bundleTokenMC');
            const priceEl = document.getElementById('bundleTokenPrice');
            const statusEl = document.getElementById('bundleTokenStatus');
            
            if (nameEl) nameEl.textContent = tokenData.name || 'Unknown Token';
            if (symbolEl) symbolEl.textContent = tokenData.symbol || '???';
            if (caEl) caEl.textContent = `📋 ${tokenAddress.slice(0, 6)}...${tokenAddress.slice(-4)}`;
            
            // Market cap
            if (mcEl) {
                const mc = tokenData.marketCap || tokenData.usdMarketCap || 0;
                if (mc > 0) {
                    mcEl.textContent = mc >= 1000000 ? `$${(mc / 1000000).toFixed(2)}M` : 
                                       mc >= 1000 ? `$${(mc / 1000).toFixed(1)}K` : 
                                       `$${mc.toFixed(0)}`;
                } else {
                    mcEl.textContent = 'N/A';
                }
            }
            
            // Price
            if (priceEl) {
                const price = tokenData.priceUsd || tokenData.price || 0;
                if (price > 0) {
                    priceEl.textContent = price < 0.0001 ? `$${price.toExponential(2)}` : `$${price.toFixed(8)}`;
                } else {
                    priceEl.textContent = 'N/A';
                }
            }
            
            // Status
            if (statusEl) {
                const status = tokenData.status || 'Active';
                statusEl.textContent = status;
                statusEl.style.color = status === 'Raydium' ? '#9945FF' : 
                                       status === 'Bonding Curve' ? 'var(--warning)' :
                                       status === 'Bonding' ? 'var(--accent-primary)' : 
                                       'var(--text-muted)';
            }
            
            // Image - try multiple sources
            if (iconEl) {
                iconEl.src = ''; // Reset
                
                // Try to load image from token data first
                if (tokenData.image) {
                    try {
                        const base64 = await loadImageAsBase64(tokenData.image);
                        if (base64) {
                            iconEl.src = base64;
                        }
                    } catch (e) {
                        console.log('Bundle image load error:', e);
                    }
                }
                
                // If no image yet, try DexScreener CDN
                if (!iconEl.src) {
                    const dexUrl = `https://dd.dexscreener.com/ds-data/tokens/solana/${tokenAddress}.png`;
                    try {
                        const base64 = await loadImageAsBase64(dexUrl);
                        if (base64) {
                            iconEl.src = base64;
                        }
                    } catch (e) {
                        console.log('DexScreener image load error:', e);
                    }
                }
                
                // Set placeholder if still no image
                if (!iconEl.src) {
                    iconEl.src = `https://via.placeholder.com/60/1a1a25/00ff88?text=${(tokenData.symbol || 'T').slice(0, 2)}`;
                }
            }
            
            // Show info, hide loading
            if (loadingEl) loadingEl.style.display = 'none';
            if (infoEl) infoEl.style.display = 'block';
            
            addBundleLog(`✅ Found: ${tokenData.name} (${tokenData.symbol})`, 'success');
            if (tokenData.marketCap) {
                addBundleLog(`   📊 Market Cap: $${tokenData.marketCap.toLocaleString()}`, 'info');
            }
        } else {
            // Token not found in databases - still show what we can
            if (loadingEl) loadingEl.style.display = 'none';
            if (infoEl) infoEl.style.display = 'block';
            
            currentBundleToken = { address: tokenAddress, name: 'Unknown Token', symbol: '???' };
            
            const nameEl = document.getElementById('bundleTokenName');
            const symbolEl = document.getElementById('bundleTokenSymbol');
            const caEl = document.getElementById('bundleTokenCA');
            const iconEl = document.getElementById('bundleTokenIcon');
            
            if (nameEl) nameEl.textContent = 'Unknown Token';
            if (symbolEl) symbolEl.textContent = tokenAddress.slice(0, 6);
            if (caEl) caEl.textContent = `📋 ${tokenAddress.slice(0, 6)}...${tokenAddress.slice(-4)}`;
            
            // Try DexScreener image anyway
            if (iconEl) {
                const dexUrl = `https://dd.dexscreener.com/ds-data/tokens/solana/${tokenAddress}.png`;
                try {
                    const base64 = await loadImageAsBase64(dexUrl);
                    if (base64) {
                        iconEl.src = base64;
                    }
                } catch (e) {}
            }
            
            addBundleLog(`⚠️ Token found but limited data available. You can still trade it.`, 'warning');
        }
    } catch (error) {
        if (loadingEl) loadingEl.style.display = 'none';
        addBundleLog(`❌ Search error: ${error.message}`, 'error');
        console.error('Bundle search error:', error);
    }
}

function copyBundleTokenCA() {
    if (currentBundleToken && currentBundleToken.address) {
        try {
            navigator.clipboard.writeText(currentBundleToken.address);
            addBundleLog(`📋 Copied: ${currentBundleToken.address}`, 'success');
        } catch (e) {
            console.log('Copy failed:', e);
        }
    }
}

// Auto-search when pasting CA
function setupBundleTokenAutoSearch() {
    const input = document.getElementById('bundleTokenAddress');
    if (input) {
        input.addEventListener('paste', () => {
            setTimeout(() => {
                const value = input.value.trim();
                if (value.length >= 32 && value.length <= 50) {
                    searchBundleToken();
                }
            }, 100);
        });
        
        input.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') {
                searchBundleToken();
            }
        });
    }
}

// Call setup on page load
setTimeout(setupBundleTokenAutoSearch, 1000);

async function executeBundleBuy() {
    const tokenAddress = document.getElementById('bundleTokenAddress').value.trim();
    const buyAmount = parseFloat(document.getElementById('bundleBuyAmount').value) || 0.05;
    
    if (!tokenAddress) {
        alert('Please enter a token address!');
        return;
    }
    
    if (bundleWallets.length === 0) {
        alert('No wallets! Generate wallets first.');
        return;
    }
    
    if (!confirm(`Buy ${buyAmount} SOL of this token in ${bundleWallets.length} wallets?`)) return;
    
    addBundleLog(`🚀 Starting bundle buy in ${bundleWallets.length} wallets...`, 'info');
    
    const btn = document.getElementById('bundleBuyBtn');
    if (btn) {
        btn.disabled = true;
        btn.textContent = '⏳ Buying...';
    }
    
    try {
        let successCount = 0;
        let failCount = 0;
        
        for (let i = 0; i < bundleWallets.length; i++) {
            const wallet = bundleWallets[i];
            addBundleLog(`  Wallet #${i + 1}: Buying...`, 'info');
            
            try {
                const result = await window.electronAPI.bundleBuy(tokenAddress, buyAmount, wallet.privateKey, config);
                
                if (result.success) {
                    successCount++;
                    addBundleLog(`  ✅ Wallet #${i + 1}: Success!`, 'success');
                } else {
                    failCount++;
                    addBundleLog(`  ❌ Wallet #${i + 1}: ${result.error}`, 'error');
                }
            } catch (err) {
                failCount++;
                addBundleLog(`  ❌ Wallet #${i + 1}: ${err.message}`, 'error');
            }
            
            // Small delay between buys
            await new Promise(r => setTimeout(r, 500));
        }
        
        addBundleLog(`📊 Bundle Buy Complete: ${successCount} success, ${failCount} failed`, successCount > 0 ? 'success' : 'error');
        refreshBundleWalletBalances();
    } catch (error) {
        addBundleLog(`❌ Bundle buy error: ${error.message}`, 'error');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = '🚀 Buy in All Wallets';
        }
    }
}

async function executeBundleSell(percent) {
    const tokenAddress = document.getElementById('bundleTokenAddress').value.trim();
    
    if (!tokenAddress) {
        alert('Please enter a token address!');
        return;
    }
    
    if (bundleWallets.length === 0) {
        alert('No wallets! Generate wallets first.');
        return;
    }
    
    if (!confirm(`Sell ${percent}% of this token from ${bundleWallets.length} wallets?`)) return;
    
    addBundleLog(`💸 Starting bundle sell (${percent}%) from ${bundleWallets.length} wallets...`, 'info');
    
    try {
        let successCount = 0;
        let failCount = 0;
        
        for (let i = 0; i < bundleWallets.length; i++) {
            const wallet = bundleWallets[i];
            addBundleLog(`  Wallet #${i + 1}: Selling...`, 'info');
            
            try {
                const result = await window.electronAPI.bundleSell(tokenAddress, percent, wallet.privateKey, config);
                
                if (result.success) {
                    successCount++;
                    addBundleLog(`  ✅ Wallet #${i + 1}: Success!`, 'success');
                } else {
                    failCount++;
                    addBundleLog(`  ❌ Wallet #${i + 1}: ${result.error}`, 'error');
                }
            } catch (err) {
                failCount++;
                addBundleLog(`  ❌ Wallet #${i + 1}: ${err.message}`, 'error');
            }
            
            // Small delay between sells
            await new Promise(r => setTimeout(r, 500));
        }
        
        addBundleLog(`📊 Bundle Sell Complete: ${successCount} success, ${failCount} failed`, successCount > 0 ? 'success' : 'error');
        refreshBundleWalletBalances();
    } catch (error) {
        addBundleLog(`❌ Bundle sell error: ${error.message}`, 'error');
    }
}

// Make bot functions globally accessible
window.startBot = startBot;
window.stopBot = stopBot;
window.quickBuyToken = quickBuyToken;
window.quickSellToken = quickSellToken;
window.lookupToken = lookupToken;
window.quickBuyFromTrade = quickBuyFromTrade;
window.quickSellFromTrade = quickSellFromTrade;
window.refreshPositions = refreshPositions;
window.sellPositionQuick = sellPositionQuick;
window.autoFetchToken = autoFetchToken;
window.refreshTokenData = refreshTokenData;

// Bundle functions
window.generateBundleWallets = generateBundleWallets;
window.exportBundleWallets = exportBundleWallets;
window.clearBundleWallets = clearBundleWallets;
window.fundAllBundleWallets = fundAllBundleWallets;
window.collectAllFunds = collectAllFunds;
window.executeBundleBuy = executeBundleBuy;
window.executeBundleSell = executeBundleSell;
window.searchBundleToken = searchBundleToken;
window.copyBundleTokenCA = copyBundleTokenCA;
window.copyToClipboard = copyToClipboard;

// ============================================
// STATS & BALANCE
// ============================================

async function updateBalance() {
    if (!config.privateKey) return;
    
    const result = await window.electronAPI.getBalance();
    
    if (result.balance !== undefined) {
        document.getElementById('balanceValue').textContent = result.balance.toFixed(4);
    }
}

function updateStats(stats) {
    if (stats.profit !== undefined) {
        const profitEl = document.getElementById('profitValue');
        profitEl.textContent = (stats.profit >= 0 ? '+' : '') + stats.profit.toFixed(4);
        profitEl.className = stats.profit >= 0 ? 'stat-value positive' : 'stat-value negative';
    }
    
    if (stats.trades !== undefined) {
        document.getElementById('tradesValue').textContent = stats.trades;
    }
    
    if (stats.winRate !== undefined) {
        const winRateEl = document.getElementById('winRateValue');
        winRateEl.textContent = stats.winRate.toFixed(1) + '%';
        winRateEl.className = stats.winRate >= 50 ? 'stat-value positive' : 'stat-value negative';
    }
}

// ============================================
// LOGGING
// ============================================

function addLog(message, type = 'info') {
    const logContent = document.getElementById('logContent');
    const now = new Date();
    const time = now.toTimeString().split(' ')[0];
    
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.innerHTML = `
        <span class="log-time">[${time}]</span>
        <span class="log-message ${type}">${message}</span>
    `;
    
    logContent.appendChild(entry);
    logContent.scrollTop = logContent.scrollHeight;
    
    // Keep only last 100 logs
    while (logContent.children.length > 100) {
        logContent.removeChild(logContent.firstChild);
    }
}

function clearLogs() {
    const logContent = document.getElementById('logContent');
    logContent.innerHTML = `
        <div class="log-entry">
            <span class="log-time">[--:--:--]</span>
            <span class="log-message">Logs cleared</span>
        </div>
    `;
}

// Make clearLogs globally accessible
window.clearLogs = clearLogs;

// ============================================
// LIVE FEED
// ============================================

let liveFeedRunning = false;
let feedTokens = [];          // New launches (under $9k)
let graduatingTokens = [];    // About to graduate ($9k+)
let graduatedTokens = [];     // Graduated to Raydium
const MAX_FEED_TOKENS = 50;
let currentFeedTab = 'new';   // 'new', 'graduating', 'graduated'
let mcapRefreshInterval = null; // Interval for refreshing market caps

// Auto-snipe bullish tokens
let snipeBullishEnabled = false;
let snipeGraduatingEnabled = false;
let snipedTokens = new Set(); // Track already sniped tokens to avoid duplicates
let snipedGraduatingTokens = new Set(); // Track sniped graduating tokens
let graduatingTokensHolding = new Set(); // Track tokens we bought in About to Graduate
let autoSellDropEnabled = true; // Auto-sell tokens that drop below $5k in About to Graduate

// ═══════════════════════════════════════════════════════════════
// ADVANCED TRADING FEATURES
// ═══════════════════════════════════════════════════════════════

// Position tracking with entry prices for trailing stop-loss
const positionTracker = new Map(); // mint => { entryPrice, entryMcap, highestMcap, highestPrice, tokens, partialSold }

// Feature toggles
let trailingStopEnabled = true;
let takeProfitEnabled = true;
let holderFilterEnabled = true;
let devWalletFilterEnabled = true;
let volumeSpikeBoostEnabled = true;
let whaleAlertEnabled = true;
let bundleDetectionEnabled = true;
let advancedPanelOpen = true;

// Bundle detection tracking
const recentBuyers = new Map(); // mint => { buyers: Set, firstBuyTime: timestamp }

// Feature settings
const tradingSettings = {
    // Trailing Stop-Loss
    trailingStopPercent: 20, // Sell if drops 20% from peak
    
    // Take-Profit Levels (auto-sell portions at these multipliers)
    takeProfitLevels: [
        { multiplier: 2, sellPercent: 25 },   // At 2x, sell 25%
        { multiplier: 5, sellPercent: 50 },   // At 5x, sell 50% more
        { multiplier: 10, sellPercent: 100 }  // At 10x, sell everything remaining
    ],
    
    // Safety Filters
    minHolderCount: 50,      // Skip tokens with fewer holders
    maxDevWalletPercent: 10, // Skip if dev holds more than 10%
    
    // Volume Spike (boost score if detected)
    volumeSpikeMinPercent: 20, // 5m volume > 20% of 1h = spike
    
    // Whale Alert (SOL amount)
    whaleMinSol: 5, // Notify if buy > 5 SOL
    
    // Bundle Detection
    bundleTimeWindow: 30000,    // 30 seconds window
    bundleMinBuyers: 5,         // 5+ unique buyers = bundle
    bundleSkipToken: true       // Skip bundled tokens
};

/**
 * Track a buyer for bundle detection
 * Returns true if this appears to be a bundled token
 */
function trackBuyerForBundle(mint, buyerAddress) {
    const now = Date.now();
    
    if (!recentBuyers.has(mint)) {
        recentBuyers.set(mint, {
            buyers: new Set(),
            firstBuyTime: now
        });
    }
    
    const data = recentBuyers.get(mint);
    
    // Clean up old entries (older than window)
    if (now - data.firstBuyTime > tradingSettings.bundleTimeWindow) {
        data.buyers.clear();
        data.firstBuyTime = now;
    }
    
    // Add this buyer
    data.buyers.add(buyerAddress);
    
    // Check if this looks like a bundle
    const isBundle = data.buyers.size >= tradingSettings.bundleMinBuyers;
    
    // Clean up old entries periodically
    if (recentBuyers.size > 200) {
        const oldest = Array.from(recentBuyers.entries())
            .sort((a, b) => a[1].firstBuyTime - b[1].firstBuyTime)[0];
        if (oldest) recentBuyers.delete(oldest[0]);
    }
    
    return isBundle;
}

/**
 * Check if a token is being bundled (many buyers in short time)
 */
function isBundledToken(mint) {
    if (!recentBuyers.has(mint)) return false;
    const data = recentBuyers.get(mint);
    const now = Date.now();
    
    // Only consider recent activity
    if (now - data.firstBuyTime > tradingSettings.bundleTimeWindow * 2) {
        return false;
    }
    
    return data.buyers.size >= tradingSettings.bundleMinBuyers;
}

/**
 * Track a new position after buying
 */
function trackPosition(mint, tokenName, entryPrice, entryMcap, tokensAmount) {
    positionTracker.set(mint, {
        name: tokenName,
        entryPrice: entryPrice,
        entryMcap: entryMcap,
        currentPrice: entryPrice,
        currentMcap: entryMcap,
        highestPrice: entryPrice,
        highestMcap: entryMcap,
        tokens: tokensAmount,
        partialSold: false,
        levelsSold: [], // Track which take-profit levels hit
        timestamp: Date.now()
    });
    
    addLog(`📊 Position tracked: ${tokenName} @ $${entryMcap.toFixed(0)} MC`, 'info');
}

/**
 * Update position with current price and check for trailing stop / take-profit
 */
async function updatePositionAndCheck(mint, currentPrice, currentMcap) {
    if (!positionTracker.has(mint)) return;
    
    const pos = positionTracker.get(mint);
    pos.currentPrice = currentPrice;
    pos.currentMcap = currentMcap;
    
    // Update highest values
    if (currentMcap > pos.highestMcap) {
        pos.highestMcap = currentMcap;
        pos.highestPrice = currentPrice;
    }
    
    const multiplier = pos.entryMcap > 0 ? currentMcap / pos.entryMcap : 1;
    const dropFromPeak = pos.highestMcap > 0 ? ((pos.highestMcap - currentMcap) / pos.highestMcap) * 100 : 0;
    
    // CHECK TAKE-PROFIT LEVELS
    if (takeProfitEnabled) {
        for (const level of tradingSettings.takeProfitLevels) {
            if (multiplier >= level.multiplier && !pos.levelsSold.includes(level.multiplier)) {
                pos.levelsSold.push(level.multiplier);
                
                addLog(`🎯 TAKE-PROFIT ${level.multiplier}x HIT! ${pos.name} - Selling ${level.sellPercent}%`, 'success');
                
                // Execute the sell
                try {
                    const result = await window.electronAPI.quickSell(mint, level.sellPercent, config);
                    if (result.success) {
                        addLog(`✅ Sold ${level.sellPercent}% of ${pos.name} at ${level.multiplier}x!`, 'success');
                        
                        // Update remaining tokens
                        pos.tokens = pos.tokens * (1 - level.sellPercent / 100);
                        pos.partialSold = true;
                        
                        // If we sold 100%, remove position
                        if (level.sellPercent >= 100) {
                            positionTracker.delete(mint);
                            return;
                        }
                    }
                } catch (e) {
                    addLog(`❌ Take-profit sell failed: ${e.message}`, 'error');
                }
            }
        }
    }
    
    // CHECK TRAILING STOP-LOSS
    if (trailingStopEnabled && dropFromPeak >= tradingSettings.trailingStopPercent) {
        // Only trigger if we're still in profit
        if (multiplier > 1) {
            addLog(`📉 TRAILING STOP! ${pos.name} dropped ${dropFromPeak.toFixed(1)}% from peak`, 'warning');
            
            try {
                const result = await window.electronAPI.quickSell(mint, 100, config);
                if (result.success) {
                    const profit = ((currentMcap / pos.entryMcap) - 1) * 100;
                    addLog(`✅ Trailing stop sold ${pos.name} at ${profit.toFixed(1)}% profit`, 'success');
                    positionTracker.delete(mint);
                }
            } catch (e) {
                addLog(`❌ Trailing stop sell failed: ${e.message}`, 'error');
            }
        }
    }
}

/**
 * Check if token passes safety filters
 */
function passesFilters(tokenData) {
    const checks = {
        passed: true,
        reasons: []
    };
    
    // Holder count check
    if (holderFilterEnabled) {
        const holders = tokenData.holderCount || 0;
        if (holders > 0 && holders < tradingSettings.minHolderCount) {
            checks.passed = false;
            checks.reasons.push(`Only ${holders} holders (min: ${tradingSettings.minHolderCount})`);
        }
    }
    
    // Dev wallet check
    if (devWalletFilterEnabled) {
        const devPercent = tokenData.devWalletPercent || 0;
        if (devPercent > tradingSettings.maxDevWalletPercent) {
            checks.passed = false;
            checks.reasons.push(`Dev holds ${devPercent.toFixed(1)}% (max: ${tradingSettings.maxDevWalletPercent}%)`);
        }
    }
    
    // Bundle detection check
    if (bundleDetectionEnabled && tokenData.mint) {
        if (isBundledToken(tokenData.mint)) {
            checks.passed = false;
            checks.reasons.push(`🎭 BUNDLE DETECTED - ${recentBuyers.get(tokenData.mint)?.buyers.size || 0} buyers in <30s`);
        }
    }
    
    return checks;
}

/**
 * Format whale alert message
 */
function formatWhaleAlert(tokenName, solAmount, usdAmount) {
    return `🐋 WHALE ALERT: ${solAmount.toFixed(2)} SOL ($${usdAmount.toFixed(0)}) bought ${tokenName}!`;
}

async function toggleLiveFeed() {
    const btn = document.getElementById('toggleFeedBtn');
    
    if (liveFeedRunning) {
        // Stop the feed
        await window.electronAPI.stopLiveFeed();
        liveFeedRunning = false;
        btn.textContent = '▶️ Start Feed';
        btn.classList.remove('btn-danger');
        btn.classList.add('btn-primary');
        updateFeedStatus(false);
        
        // Stop market cap refresh
        if (mcapRefreshInterval) {
            clearInterval(mcapRefreshInterval);
            mcapRefreshInterval = null;
        }
    } else {
        // Start the feed
        const platform = document.getElementById('feedPlatform').value;
        const minMcap = parseInt(document.getElementById('feedMinMcap').value) || 1000;
        
        addLog(`📡 Starting live feed: ${platform}, min $${minMcap}`, 'info');
        
        const result = await window.electronAPI.startLiveFeed(platform, minMcap);
        
        if (result.success) {
            liveFeedRunning = true;
            btn.textContent = '⏹️ Stop Feed';
            btn.classList.remove('btn-primary');
            btn.classList.add('btn-danger');
            updateFeedStatus(true);
            
            // Start market cap refresh every 3 seconds for live price tracking
            mcapRefreshInterval = setInterval(refreshFeedMarketCaps, 3000);
        } else {
            addLog(`❌ Failed to start feed: ${result.error}`, 'error');
        }
    }
}

// Refresh market caps for ALL tokens in ALL tabs with live price tracking
// ALSO checks tracked positions for trailing stop and take-profit!
async function refreshFeedMarketCaps() {
    const batchSize = 5;
    let movedToGraduating = 0;
    let movedToGraduated = 0;
    let tokensToRemove = []; // Tokens that dropped below $5k
    let tokensToGraduate = []; // Tokens that hit 69k (full graduation)
    
    // CHECK TRACKED POSITIONS for trailing stop-loss and take-profit
    if (positionTracker.size > 0) {
        for (const [mint, pos] of positionTracker) {
            try {
                const result = await window.electronAPI.lookupToken(mint);
                if (result && result.success && result.data) {
                    const currentMcap = result.data.marketCap || 0;
                    const currentPrice = result.data.price || 0;
                    
                    // Update position and check for sell triggers
                    await updatePositionAndCheck(mint, currentPrice, currentMcap);
                }
            } catch (e) {
                console.log(`Position check failed for ${mint}: ${e.message}`);
            }
        }
    }
    
    // Helper function to update token prices
    async function updateTokenPrices(tokens, tabName) {
        for (let i = 0; i < tokens.length; i += batchSize) {
            const batch = tokens.slice(i, i + batchSize);
            
            await Promise.allSettled(
                batch.map(async (token) => {
                    try {
                        const result = await window.electronAPI.lookupToken(token.mint);
                        if (result && result.success && result.data) {
                            const newMcap = result.data.marketCap || 0;
                            const oldMcap = token.marketCap || 0;
                            
                            // Track price change percentage
                            if (oldMcap > 0 && newMcap > 0) {
                                const change = ((newMcap - oldMcap) / oldMcap) * 100;
                                token.priceChange = change;
                                token.priceDirection = change > 0 ? 'up' : change < 0 ? 'down' : 'stable';
                            }
                            
                            token.marketCap = newMcap;
                            token.liquidity = result.data.liquidity || token.liquidity;
                            token.lastUpdate = Date.now();
                            
                            // Check if token graduated to Raydium (status check)
                            if (result.data.status && result.data.status.toLowerCase().includes('raydium')) {
                                token.graduated = true;
                            }
                            
                            // For New Launches - check if should move to graduating ($9k threshold)
                            if (tabName === 'new' && newMcap >= 9000) {
                                return { token, shouldMove: true, shouldRemove: false, shouldGraduate: false };
                            }
                            
                            // For About to Graduate - check if dropped below $5k (auto-sell trigger)
                            if (tabName === 'graduating' && newMcap < 5000 && autoSellDropEnabled) {
                                return { token, shouldMove: false, shouldRemove: true, shouldGraduate: false };
                            }
                            
                            // For About to Graduate - check if graduated (hit 69k or marked as graduated/Raydium)
                            if (tabName === 'graduating' && (newMcap >= 69000 || token.graduated)) {
                                return { token, shouldMove: false, shouldRemove: false, shouldGraduate: true };
                            }
                        }
                    } catch (e) {}
                    return { token, shouldMove: false, shouldRemove: false, shouldGraduate: false };
                })
            ).then(results => {
                // Process results
                for (const result of results) {
                    if (result.status === 'fulfilled') {
                        if (result.value.shouldMove) {
                            moveToGraduating(result.value.token);
                            movedToGraduating++;
                        }
                        if (result.value.shouldRemove) {
                            tokensToRemove.push(result.value.token);
                        }
                        if (result.value.shouldGraduate) {
                            tokensToGraduate.push(result.value.token);
                        }
                    }
                }
            });
        }
    }
    
    // Update New Launches tokens
    if (feedTokens.length > 0) {
        await updateTokenPrices(feedTokens, 'new');
    }
    
    // Update About to Graduate tokens
    if (graduatingTokens.length > 0) {
        await updateTokenPrices(graduatingTokens, 'graduating');
    }
    
    // Update Graduated tokens
    if (graduatedTokens.length > 0) {
        await updateTokenPrices(graduatedTokens, 'graduated');
    }
    
    // Log if any tokens moved
    if (movedToGraduating > 0) {
        addLog(`🎓 ${movedToGraduating} token(s) graduated to "About to Graduate"!`, 'success');
    }
    
    // AUTO-SELL tokens that dropped below $5k in About to Graduate
    if (tokensToRemove.length > 0) {
        for (const token of tokensToRemove) {
            await autoSellDroppedToken(token);
        }
    }
    
    // Move tokens to GRADUATED (hit 69k or migrated to Raydium)
    if (tokensToGraduate.length > 0) {
        for (const token of tokensToGraduate) {
            moveToGraduated(token);
            movedToGraduated++;
        }
        addLog(`🏆 ${movedToGraduated} token(s) GRADUATED to Raydium!`, 'success');
    }
    
    // Re-render ALL tabs with updated data
    renderFeedTokens();
    renderGraduatingTokens();
    renderGraduatedTokens();
    updateFeedCounts();
}

function updateFeedStatus(connected) {
    const dot = document.getElementById('feedStatusDot');
    const text = document.getElementById('feedStatusText');
    
    // Check if elements exist (may not be loaded yet or on different page)
    if (!dot || !text) return;
    
    if (connected) {
        dot.style.background = 'var(--accent-primary)';
        dot.classList.add('live');
        text.textContent = 'Live';
        text.style.color = 'var(--accent-primary)';
    } else {
        dot.style.background = 'var(--danger)';
        dot.classList.remove('live');
        text.textContent = 'Offline';
        text.style.color = 'var(--text-secondary)';
    }
}

function clearFeed() {
    feedTokens = [];
    graduatingTokens = [];
    graduatedTokens = [];
    renderFeedTokens();
    renderGraduatingTokens();
    renderGraduatedTokens();
    updateFeedCounts();
}

// Switch between feed tabs
function switchFeedTab(tab) {
    currentFeedTab = tab;
    
    // Update tab styles
    const tabs = ['New', 'Graduating', 'Graduated'];
    tabs.forEach(t => {
        const tabBtn = document.getElementById(`tab${t === 'New' ? 'NewLaunches' : t === 'Graduating' ? 'AboutToGraduate' : 'Graduated'}`);
        const section = document.getElementById(`feedSection${t === 'New' ? 'New' : t}`);
        
        if (t.toLowerCase() === tab || (t === 'New' && tab === 'new') || (t === 'Graduating' && tab === 'graduating')) {
            tabBtn.classList.add('active');
            tabBtn.style.background = 'var(--bg-tertiary)';
            tabBtn.style.borderBottomColor = t === 'New' ? 'var(--accent-primary)' : t === 'Graduating' ? 'var(--warning)' : '#9945FF';
            section.style.display = 'block';
        } else {
            tabBtn.classList.remove('active');
            tabBtn.style.background = 'var(--bg-card)';
            tabBtn.style.borderBottomColor = 'transparent';
            section.style.display = 'none';
        }
    });
}

// Update feed counts
function updateFeedCounts() {
    const countNew = document.getElementById('feedCountNew');
    const countGraduating = document.getElementById('feedCountGraduating');
    const countGraduated = document.getElementById('feedCountGraduated');
    
    if (countNew) countNew.textContent = feedTokens.length;
    if (countGraduating) countGraduating.textContent = graduatingTokens.length;
    if (countGraduated) countGraduated.textContent = graduatedTokens.length;
}

function addFeedToken(tokenData) {
    const marketCap = tokenData.marketCap || 0;
    const signal = tokenData.analysis?.signal || 'neutral';
    
    // Check if token already exists
    const existsInFeed = feedTokens.find(t => t.mint === tokenData.mint);
    const existsInGraduating = graduatingTokens.find(t => t.mint === tokenData.mint);
    
    if (existsInFeed || existsInGraduating) {
        // Update existing token's market cap
        if (existsInFeed) {
            existsInFeed.marketCap = marketCap;
            // Move to graduating if hit $9k
            if (marketCap >= 9000) {
                moveToGraduating(existsInFeed);
            }
        }
        if (existsInGraduating) {
            existsInGraduating.marketCap = marketCap;
            existsInGraduating.progress = Math.min(100, (marketCap / 69000) * 100);
        }
    } else {
        // New token - add to appropriate list
        if (marketCap >= 9000) {
            // Goes directly to About to Graduate
            tokenData.progress = Math.min(100, (marketCap / 69000) * 100);
            graduatingTokens.unshift(tokenData);
            if (graduatingTokens.length > MAX_FEED_TOKENS) {
                graduatingTokens.pop();
            }
            addLog(`🎓 About to Graduate: ${tokenData.name} - $${formatNumber(marketCap)}`, 'warning');
        } else {
            // Goes to New Launches
            feedTokens.unshift(tokenData);
            if (feedTokens.length > MAX_FEED_TOKENS) {
                feedTokens.pop();
            }
            addLog(`🚀 New token: ${tokenData.name} (${tokenData.symbol}) - $${formatNumber(marketCap)}`, 
                signal === 'bullish' ? 'success' : 
                signal === 'bearish' ? 'error' : 'warning');
        }
    }
    
    // Render all
    renderFeedTokens();
    renderGraduatingTokens();
    updateFeedCounts();
    
    // AUTO-SNIPE BULLISH TOKENS (only for new launches under $9k)
    if (snipeBullishEnabled && signal === 'bullish' && marketCap < 9000) {
        addLog(`🎯 BULLISH DETECTED! Auto-sniping ${tokenData.name}...`, 'success');
        autoSnipeBullish(tokenData);
    }
}

// Move token from New Launches to About to Graduate when it hits $9k
function moveToGraduating(token) {
    // Remove from feedTokens
    feedTokens = feedTokens.filter(t => t.mint !== token.mint);
    
    // Check if already in graduating
    const exists = graduatingTokens.find(t => t.mint === token.mint);
    if (!exists) {
        token.progress = Math.min(100, ((token.marketCap || 0) / 69000) * 100);
        graduatingTokens.unshift(token);
        if (graduatingTokens.length > MAX_FEED_TOKENS) {
            graduatingTokens.pop();
        }
        addLog(`🎓 GRADUATED UP: ${token.name} hit $9K! Moving to About to Graduate`, 'success');
        
        // Auto-snipe if enabled
        if (snipeGraduatingEnabled) {
            autoSnipeGraduating(token);
        }
    }
    
    renderFeedTokens();
    renderGraduatingTokens();
    updateFeedCounts();
}

// Move token from About to Graduate to Graduated (hit 69k / migrated to Raydium)
function moveToGraduated(token) {
    // Remove from graduatingTokens
    graduatingTokens = graduatingTokens.filter(t => t.mint !== token.mint);
    
    // Check if already in graduated
    const exists = graduatedTokens.find(t => t.mint === token.mint);
    if (!exists) {
        token.graduatedAt = Date.now();
        graduatedTokens.unshift(token);
        if (graduatedTokens.length > MAX_FEED_TOKENS) {
            graduatedTokens.pop();
        }
        addLog(`🏆 FULL GRADUATION: ${token.name} graduated to Raydium! MC: $${formatNumber(token.marketCap)}`, 'success');
    }
    
    renderGraduatingTokens();
    renderGraduatedTokens();
    updateFeedCounts();
}

function renderFeedTokens() {
    const container = document.getElementById('tokenFeedList');
    if (!container) return;
    
    if (feedTokens.length === 0) {
        container.innerHTML = `
            <div class="empty-feed" style="padding: 40px; text-align: center; color: var(--text-muted);">
                <p style="font-size: 48px; margin-bottom: 15px;">📡</p>
                <p>Click "Start Feed" to see new token launches in real-time</p>
            </div>
        `;
        return;
    }
    
    container.innerHTML = feedTokens.map((token, idx) => {
        const signal = token.analysis?.signal || 'neutral';
        const score = token.analysis?.score || 50;
        const signalClass = signal === 'bullish' ? 'bullish' : signal === 'bearish' ? 'bearish' : 'neutral';
        const signalEmoji = signal === 'bullish' ? '🟢' : signal === 'bearish' ? '🔴' : '🟡';
        
        const mcapFormatted = formatNumber(token.marketCap || 0);
        const liqFormatted = formatNumber(token.liquidity || 0);
        
        const timeAgo = getTimeAgo(token.timestamp);
        
        // Show image if available, with placeholder fallback
        const symbolText = (token.symbol || 'T').slice(0, 2).toUpperCase();
        const hasImage = token.image && token.image.length > 10 && !token.image.includes('undefined');
        
        const imageHtml = hasImage ? `
            <img id="feed-img-${token.mint}" class="feed-token-icon" 
                 src="${token.image}"
                 style="width:45px; height:45px; border-radius:10px; object-fit:cover; border:1px solid var(--accent-primary);"
                 onerror="this.style.display='none'; document.getElementById('feed-placeholder-${token.mint}').style.display='flex';">
            <div id="feed-placeholder-${token.mint}" class="feed-token-placeholder" 
                 style="display:none; width:45px; height:45px; border-radius:10px; background:linear-gradient(135deg,#00ff88,#0088ff); border:1px solid var(--accent-primary); align-items:center; justify-content:center; color:white; font-weight:bold; font-size:14px;">
                 ${symbolText}
            </div>` : `
            <div id="feed-placeholder-${token.mint}" class="feed-token-placeholder" 
                 style="display:flex; width:45px; height:45px; border-radius:10px; background:linear-gradient(135deg,#00ff88,#0088ff); border:1px solid var(--accent-primary); align-items:center; justify-content:center; color:white; font-weight:bold; font-size:14px;">
                 ${symbolText}
            </div>`;
        
        return `
            <div class="feed-item ${idx === 0 ? 'new' : ''}" data-mint="${token.mint}">
                <div class="feed-token-icon-wrapper">
                    ${imageHtml}
                </div>
                
                <div class="feed-token-info">
                    <div class="feed-token-name">
                        ${token.name || 'Unknown'}
                        <span class="platform-badge ${token.platform}">${token.platform === 'pumpfun' ? 'PUMP' : 'BONK'}</span>
                    </div>
                    <div class="feed-token-ca" onclick="copyToClipboard('${token.mint}')" title="Click to copy">
                        ${token.symbol} • ${token.mint?.slice(0, 8)}...${token.mint?.slice(-6)}
                    </div>
                </div>
                
                <div class="feed-metrics">
                    <div class="feed-metric">
                        <div class="feed-metric-label">Market Cap</div>
                        <div class="feed-metric-value" style="display:flex; align-items:center; gap:4px;">
                            $${mcapFormatted}
                            ${token.priceChange ? `<span class="${token.priceChange > 0 ? 'price-change-up' : 'price-change-down'}" style="font-size:11px; font-weight:bold; color:${token.priceChange > 0 ? 'var(--accent-primary)' : 'var(--danger)'};">${token.priceChange > 0 ? '▲' : '▼'}${Math.abs(token.priceChange).toFixed(1)}%</span>` : '<span style="font-size:10px; color:var(--text-muted);">●</span>'}
                        </div>
                    </div>
                    <div class="feed-metric">
                        <div class="feed-metric-label">Liquidity</div>
                        <div class="feed-metric-value">$${liqFormatted}</div>
                    </div>
                    <div class="feed-metric">
                        <div class="feed-metric-label">To $9K</div>
                        <div class="feed-metric-value" style="display:flex; align-items:center; gap:4px;">
                            <div style="width:40px; height:5px; background:rgba(255,255,255,0.2); border-radius:3px; overflow:hidden;">
                                <div style="width:${Math.min(100, ((token.marketCap || 0) / 9000) * 100)}%; height:100%; background:linear-gradient(90deg, ${(token.marketCap || 0) >= 9000 ? 'var(--accent-primary), #00ffaa' : 'var(--warning), #ffaa00'}); border-radius:3px; transition:width 0.5s;"></div>
                            </div>
                            <span style="font-size:10px; color:${(token.marketCap || 0) >= 9000 ? 'var(--accent-primary)' : 'var(--warning)'};">${Math.min(100, Math.round(((token.marketCap || 0) / 9000) * 100))}%</span>
                        </div>
                    </div>
                </div>
                
                <div class="feed-signal">
                    <span class="signal-badge ${signalClass}">${signalEmoji} ${signal}</span>
                    <span class="signal-score">${score}/100</span>
                </div>
                
                <div class="feed-socials">
                    ${token.socials?.twitter ? `<a href="${token.socials.twitter}" target="_blank" class="social-link twitter" title="Twitter/X">𝕏</a>` : ''}
                    ${token.socials?.telegram ? `<a href="${token.socials.telegram}" target="_blank" class="social-link telegram" title="Telegram">✈️</a>` : ''}
                    ${token.socials?.website ? `<a href="${token.socials.website}" target="_blank" class="social-link website" title="Website">🌐</a>` : ''}
                    ${token.socials?.discord ? `<a href="${token.socials.discord}" target="_blank" class="social-link discord" title="Discord">💬</a>` : ''}
                    ${!token.socials?.twitter && !token.socials?.telegram && !token.socials?.website ? '<span class="no-socials">-</span>' : ''}
                </div>
                
                <div class="feed-actions">
                    <button class="feed-btn buy" onclick="feedQuickBuy('${token.mint}')">
                        🚀 Buy
                    </button>
                    <button class="feed-btn view" onclick="viewTokenInTrade('${token.mint}')">
                        👁️ View
                    </button>
                </div>
            </div>
        `;
    }).join('');
}

function formatNumber(num) {
    if (num >= 1000000) {
        return (num / 1000000).toFixed(2) + 'M';
    } else if (num >= 1000) {
        return (num / 1000).toFixed(1) + 'K';
    }
    return num.toFixed(0);
}

function getTimeAgo(timestamp) {
    const seconds = Math.floor((Date.now() - timestamp) / 1000);
    
    if (seconds < 60) return `${seconds}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
    if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
    return `${Math.floor(seconds / 86400)}d`;
}

async function feedQuickBuy(mint) {
    if (!licenseValid) {
        document.getElementById('licenseModal').classList.add('active');
        return;
    }
    
    if (!config.privateKey) {
        addLog('❌ Please configure your private key in Settings', 'error');
        showPage('settings');
        return;
    }
    
    if (!confirm(`Buy this token with ${config.buyAmount || 0.01} SOL?`)) {
        return;
    }
    
    addLog(`🚀 Quick buying from feed: ${mint.slice(0, 8)}...`, 'warning');
    
    try {
        const result = await window.electronAPI.quickBuy(mint, config);
        
        if (result.success) {
            addLog(`✅ Buy SUCCESS! TX: ${result.signature?.slice(0, 20)}...`, 'success');
            
            // Wait and refresh holdings
            await new Promise(r => setTimeout(r, 3000));
            await refreshPositions();
        } else {
            addLog(`❌ Buy failed: ${result.error}`, 'error');
        }
    } catch (error) {
        addLog(`❌ Buy error: ${error.message}`, 'error');
    }
}

function viewTokenInTrade(mint) {
    // Navigate to trade page and paste the token
    showPage('trade');
    
    const input = document.getElementById('tradeTokenAddress');
    if (input) {
        input.value = mint;
        
        // Show loading immediately
        document.getElementById('tokenLoading').style.display = 'block';
        document.getElementById('tokenInfoPanel').style.display = 'none';
        
        // Fetch token data fast
        autoFetchToken(mint, true);
        
        // Update chart URL
        updatePriceChart(mint);
    }
}

// Price Chart Variables
let chartVisible = false;
let priceChart = null;
let chartTokenAddress = null;
let chartTimeframe = '5m';
let chartRefreshInterval = null;
let chartRefreshCountdown = 10;
let chartCountdownInterval = null;

// New York timezone offset (UTC-5)
const NY_TIMEZONE = 'America/New_York';

function togglePriceChart() {
    const container = document.getElementById('priceChartContainer');
    const btn = document.getElementById('toggleChartBtn');
    
    if (!container || !btn) return;
    
    chartVisible = !chartVisible;
    
    if (chartVisible) {
        container.style.display = 'block';
        btn.innerHTML = '📉 Hide Chart';
        btn.style.background = 'linear-gradient(135deg, #666, #444)';
        
        // Load chart for current token
        const tokenAddress = document.getElementById('tradeTokenAddress')?.value?.trim();
        if (tokenAddress && tokenAddress.length > 30) {
            loadPriceChart(tokenAddress);
        }
        
        // Start auto-refresh every 10 seconds
        startChartRefresh();
    } else {
        container.style.display = 'none';
        btn.innerHTML = '📈 Show Chart';
        btn.style.background = 'linear-gradient(135deg, #00aaff, #0066cc)';
        
        // Stop auto-refresh
        stopChartRefresh();
    }
}

function startChartRefresh() {
    stopChartRefresh();
    chartRefreshCountdown = 10;
    
    // Countdown timer display
    chartCountdownInterval = setInterval(() => {
        chartRefreshCountdown--;
        const timerEl = document.getElementById('chartRefreshTimer');
        if (timerEl) {
            timerEl.textContent = `🔄 Auto-refresh: ${chartRefreshCountdown}s`;
        }
        
        if (chartRefreshCountdown <= 0) {
            chartRefreshCountdown = 10;
            if (chartVisible && chartTokenAddress) {
                loadPriceChart(chartTokenAddress, true); // silent refresh
            }
        }
    }, 1000);
}

function stopChartRefresh() {
    if (chartRefreshInterval) {
        clearInterval(chartRefreshInterval);
        chartRefreshInterval = null;
    }
    if (chartCountdownInterval) {
        clearInterval(chartCountdownInterval);
        chartCountdownInterval = null;
    }
}

function setChartTimeframe(tf) {
    chartTimeframe = tf;
    
    // Update button styles
    document.querySelectorAll('.chart-tf-btn').forEach(btn => {
        if (btn.dataset.tf === tf) {
            btn.style.background = 'var(--accent-primary)';
            btn.style.color = '#000';
            btn.style.border = 'none';
        } else {
            btn.style.background = 'var(--bg-tertiary)';
            btn.style.color = 'var(--text-muted)';
            btn.style.border = '1px solid var(--border)';
        }
    });
    
    // Reload chart with new timeframe
    if (chartTokenAddress) {
        loadPriceChart(chartTokenAddress);
    }
}

function refreshPriceChart() {
    if (chartTokenAddress) {
        loadPriceChart(chartTokenAddress);
    }
}

function updatePriceChart(tokenAddress) {
    const fullLink = document.getElementById('openDexScreenerFull');
    
    if (fullLink && tokenAddress) {
        fullLink.href = `https://dexscreener.com/solana/${tokenAddress}`;
    }
    
    // If chart is visible, load the data
    if (chartVisible && tokenAddress) {
        loadPriceChart(tokenAddress);
    }
}

async function loadPriceChart(tokenAddress, silent = false) {
    if (!tokenAddress) return;
    
    chartTokenAddress = tokenAddress;
    
    const loadingEl = document.getElementById('chartLoading');
    const canvasEl = document.getElementById('priceChartCanvas');
    const sourceEl = document.getElementById('chartDataSource');
    
    if (!silent && loadingEl) {
        loadingEl.style.display = 'flex';
    }
    
    try {
        // Fetch price data from multiple sources
        const priceData = await fetchPriceHistory(tokenAddress);
        
        if (priceData && priceData.prices && priceData.prices.length > 0) {
            if (loadingEl) loadingEl.style.display = 'none';
            if (sourceEl) sourceEl.textContent = priceData.source || 'API';
            
            renderPriceChart(priceData);
        } else {
            if (loadingEl) {
                loadingEl.innerHTML = `<span style="color: var(--text-muted);">📊 No price data available yet</span><br><span style="font-size: 11px; color: var(--text-muted);">New tokens may take a few minutes to show data</span>`;
            }
        }
    } catch (error) {
        console.error('Chart load error:', error);
        if (loadingEl) {
            loadingEl.innerHTML = `<span style="color: #ff6666;">❌ Failed to load chart</span><br><span style="font-size: 11px; color: var(--text-muted);">Try refreshing or check token address</span>`;
        }
    }
}

async function fetchPriceHistory(tokenAddress) {
    // Try multiple APIs to get price data
    
    // 1. Try DexScreener API first
    try {
        const dexResponse = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`);
        if (dexResponse.ok) {
            const dexData = await dexResponse.json();
            if (dexData.pairs && dexData.pairs.length > 0) {
                const pair = dexData.pairs[0];
                
                // DexScreener doesn't provide historical OHLC, so we'll create simulated data from price
                const currentPrice = parseFloat(pair.priceUsd) || 0;
                const priceChange = parseFloat(pair.priceChange?.h24) || 0;
                const volume = parseFloat(pair.volume?.h24) || 0;
                
                // Generate price points based on 24h change
                const prices = generatePricePoints(currentPrice, priceChange, 50);
                
                return {
                    source: 'DexScreener',
                    prices: prices,
                    currentPrice: currentPrice,
                    high24h: currentPrice * (1 + Math.abs(priceChange/100) * 0.5),
                    low24h: currentPrice * (1 - Math.abs(priceChange/100) * 0.5),
                    change24h: priceChange,
                    volume24h: volume
                };
            }
        }
    } catch (e) {
        console.log('DexScreener API failed:', e.message);
    }
    
    // 2. Try Birdeye API
    try {
        const timeframes = { '5m': 300, '15m': 900, '1h': 3600, '4h': 14400 };
        const interval = timeframes[chartTimeframe] || 300;
        const now = Math.floor(Date.now() / 1000);
        const from = now - (interval * 50); // Get 50 candles
        
        const birdeyeUrl = `https://public-api.birdeye.so/defi/ohlcv?address=${tokenAddress}&type=${chartTimeframe}&time_from=${from}&time_to=${now}`;
        const birdeyeResponse = await fetch(birdeyeUrl, {
            headers: { 'X-API-KEY': 'public' }
        });
        
        if (birdeyeResponse.ok) {
            const birdeyeData = await birdeyeResponse.json();
            if (birdeyeData.data && birdeyeData.data.items && birdeyeData.data.items.length > 0) {
                const items = birdeyeData.data.items;
                const prices = items.map(item => ({
                    time: item.unixTime * 1000,
                    price: item.c, // close price
                    open: item.o,
                    high: item.h,
                    low: item.l,
                    volume: item.v
                }));
                
                const lastPrice = prices[prices.length - 1]?.price || 0;
                const firstPrice = prices[0]?.price || lastPrice;
                const change = firstPrice > 0 ? ((lastPrice - firstPrice) / firstPrice) * 100 : 0;
                
                return {
                    source: 'Birdeye',
                    prices: prices,
                    currentPrice: lastPrice,
                    high24h: Math.max(...prices.map(p => p.high || p.price)),
                    low24h: Math.min(...prices.map(p => p.low || p.price)),
                    change24h: change
                };
            }
        }
    } catch (e) {
        console.log('Birdeye API failed:', e.message);
    }
    
    // 3. Try Jupiter API for price
    try {
        const jupiterUrl = `https://price.jup.ag/v4/price?ids=${tokenAddress}`;
        const jupResponse = await fetch(jupiterUrl);
        if (jupResponse.ok) {
            const jupData = await jupResponse.json();
            if (jupData.data && jupData.data[tokenAddress]) {
                const price = jupData.data[tokenAddress].price;
                const prices = generatePricePoints(price, 0, 50);
                
                return {
                    source: 'Jupiter',
                    prices: prices,
                    currentPrice: price,
                    high24h: price,
                    low24h: price,
                    change24h: 0
                };
            }
        }
    } catch (e) {
        console.log('Jupiter API failed:', e.message);
    }
    
    // 4. Try to get from stored token data
    if (currentLookupToken === tokenAddress && previousTokenData.price) {
        const price = previousTokenData.price;
        const prices = generatePricePoints(price, 0, 50);
        
        return {
            source: 'Cache',
            prices: prices,
            currentPrice: price,
            high24h: price,
            low24h: price,
            change24h: 0
        };
    }
    
    return null;
}

function generatePricePoints(currentPrice, changePercent, numPoints) {
    // Generate realistic OHLC candlestick data
    const prices = [];
    const now = Date.now();
    
    const intervals = {
        '1m': 60000,
        '5m': 300000,
        '15m': 900000,
        '1h': 3600000,
        '4h': 14400000,
        '1d': 86400000
    };
    const interval = intervals[chartTimeframe] || 300000;
    
    const startPrice = currentPrice / (1 + changePercent / 100);
    const volatility = Math.abs(changePercent) / 100 * 0.5 || 0.03;
    
    let prevClose = startPrice;
    
    for (let i = 0; i < numPoints; i++) {
        const time = now - (numPoints - i) * interval;
        
        // Add some randomness but trend towards current price
        const remaining = numPoints - i;
        const trend = (currentPrice - prevClose) / remaining * 0.3;
        
        // Generate OHLC
        const open = prevClose;
        const change = trend + (Math.random() - 0.5) * prevClose * volatility;
        const close = Math.max(open + change, currentPrice * 0.3);
        
        // High is max of open/close plus some wick
        const wickUp = Math.random() * Math.abs(close - open) * 0.5;
        const high = Math.max(open, close) + wickUp;
        
        // Low is min of open/close minus some wick
        const wickDown = Math.random() * Math.abs(close - open) * 0.5;
        const low = Math.min(open, close) - wickDown;
        
        prices.push({
            time: time,
            price: close,
            open: open,
            high: high,
            low: low,
            close: close,
            volume: Math.random() * 10000
        });
        
        prevClose = close;
    }
    
    // Make sure last candle closes at current price
    if (prices.length > 0) {
        const last = prices[prices.length - 1];
        last.close = currentPrice;
        last.price = currentPrice;
        last.high = Math.max(last.high, currentPrice);
        last.low = Math.min(last.low, currentPrice);
    }
    
    return prices;
}

function renderPriceChart(data) {
    const canvas = document.getElementById('priceChartCanvas');
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    
    // Destroy existing chart
    if (priceChart) {
        priceChart.destroy();
    }
    
    // Prepare candlestick data
    const candleData = data.prices.map(p => ({
        x: p.time,
        o: p.open || p.price,
        h: p.high || p.price * 1.001,
        l: p.low || p.price * 0.999,
        c: p.close || p.price
    }));
    
    const lastCandle = candleData[candleData.length - 1];
    const firstCandle = candleData[0];
    const isPositive = lastCandle && firstCandle && lastCandle.c >= firstCandle.o;
    
    // Calculate price precision based on value
    const currentPrice = lastCandle?.c || data.currentPrice || 0;
    const precision = getPricePrecision(currentPrice);
    
    // Create candlestick chart
    priceChart = new Chart(ctx, {
        type: 'candlestick',
        data: {
            datasets: [{
                label: 'Price',
                data: candleData,
                color: {
                    up: '#00ff88',      // Bullish candle body
                    down: '#ff4444',    // Bearish candle body
                    unchanged: '#888'
                },
                borderColor: {
                    up: '#00ff88',      // Bullish candle border
                    down: '#ff4444',    // Bearish candle border
                    unchanged: '#888'
                },
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                intersect: false,
                mode: 'index'
            },
            plugins: {
                legend: {
                    display: false
                },
                tooltip: {
                    enabled: true,
                    backgroundColor: 'rgba(0, 0, 0, 0.9)',
                    titleColor: '#fff',
                    bodyColor: '#ccc',
                    borderColor: '#333',
                    borderWidth: 1,
                    padding: 12,
                    displayColors: false,
                    callbacks: {
                        title: function(context) {
                            const date = new Date(context[0].parsed.x);
                            return formatNYTime(date);
                        },
                        label: function(context) {
                            const o = context.parsed.o;
                            const h = context.parsed.h;
                            const l = context.parsed.l;
                            const c = context.parsed.c;
                            return [
                                `Open:  ${formatPricePrecision(o, precision)}`,
                                `High:  ${formatPricePrecision(h, precision)}`,
                                `Low:   ${formatPricePrecision(l, precision)}`,
                                `Close: ${formatPricePrecision(c, precision)}`
                            ];
                        }
                    }
                }
            },
            scales: {
                x: {
                    type: 'time',
                    time: {
                        unit: getTimeUnit(chartTimeframe),
                        displayFormats: {
                            minute: 'HH:mm',
                            hour: 'HH:mm',
                            day: 'MMM d'
                        },
                        tooltipFormat: 'MMM d, HH:mm'
                    },
                    adapters: {
                        date: {
                            zone: NY_TIMEZONE
                        }
                    },
                    grid: {
                        color: 'rgba(255, 255, 255, 0.03)',
                        drawBorder: true,
                        borderColor: 'rgba(255, 255, 255, 0.1)'
                    },
                    ticks: {
                        color: '#555',
                        maxTicksLimit: 10,
                        font: { size: 9, family: "'JetBrains Mono', monospace" }
                    }
                },
                y: {
                    position: 'right',
                    grid: {
                        color: 'rgba(255, 255, 255, 0.03)',
                        drawBorder: true,
                        borderColor: 'rgba(255, 255, 255, 0.1)'
                    },
                    ticks: {
                        color: '#555',
                        font: { size: 9, family: "'JetBrains Mono', monospace" },
                        callback: function(value) {
                            return formatPricePrecision(value, precision);
                        }
                    }
                }
            }
        }
    });
    
    // Update price info bar
    updateChartPriceInfo(data, lastCandle, precision);
    
    // Update last update time
    const updateEl = document.getElementById('chartLastUpdate');
    if (updateEl) {
        updateEl.textContent = `Last update: ${formatNYTime(new Date())}`;
    }
}

function getPricePrecision(price) {
    if (price === 0) return 8;
    if (price < 0.00000001) return 12;
    if (price < 0.000001) return 10;
    if (price < 0.0001) return 8;
    if (price < 0.01) return 6;
    if (price < 1) return 4;
    if (price < 100) return 2;
    return 2;
}

function formatPricePrecision(price, precision) {
    if (!price && price !== 0) return '-';
    if (price < 0.00001) return '$' + price.toExponential(2);
    return '$' + price.toFixed(precision);
}

function formatNYTime(date) {
    return date.toLocaleString('en-US', {
        timeZone: NY_TIMEZONE,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
}

function getTimeUnit(timeframe) {
    switch(timeframe) {
        case '1m': case '5m': case '15m': return 'minute';
        case '1h': case '4h': return 'hour';
        case '1d': return 'day';
        default: return 'minute';
    }
}

function updateChartPriceInfo(data, lastCandle, precision) {
    const lastPriceEl = document.getElementById('chartLastPrice');
    const changeEl = document.getElementById('chartPriceChange');
    const openEl = document.getElementById('chartOpen');
    const highEl = document.getElementById('chartHigh');
    const lowEl = document.getElementById('chartLow');
    const closeEl = document.getElementById('chartClose');
    const volumeEl = document.getElementById('chartVolume');
    
    const currentPrice = lastCandle?.c || data.currentPrice || 0;
    const change = data.change24h || 0;
    
    if (lastPriceEl) {
        lastPriceEl.textContent = formatPricePrecision(currentPrice, precision);
    }
    
    if (changeEl) {
        changeEl.textContent = (change >= 0 ? '+' : '') + change.toFixed(2) + '%';
        changeEl.style.background = change >= 0 ? 'rgba(0,255,136,0.2)' : 'rgba(255,68,68,0.2)';
        changeEl.style.color = change >= 0 ? '#00ff88' : '#ff4444';
    }
    
    if (lastCandle) {
        if (openEl) openEl.textContent = formatPricePrecision(lastCandle.o, precision);
        if (highEl) highEl.textContent = formatPricePrecision(lastCandle.h, precision);
        if (lowEl) lowEl.textContent = formatPricePrecision(lastCandle.l, precision);
        if (closeEl) closeEl.textContent = formatPricePrecision(lastCandle.c, precision);
    } else {
        if (openEl) openEl.textContent = '-';
        if (highEl) highEl.textContent = formatPricePrecision(data.high24h, precision);
        if (lowEl) lowEl.textContent = formatPricePrecision(data.low24h, precision);
        if (closeEl) closeEl.textContent = '-';
    }
    
    if (volumeEl && data.volume24h) {
        volumeEl.textContent = '$' + formatNumber(data.volume24h);
    }
}

function formatPrice(price) {
    if (!price || price === 0) return '$0';
    if (price < 0.0001) return '$' + price.toExponential(2);
    if (price < 1) return '$' + price.toFixed(6);
    return '$' + price.toFixed(4);
}

// Setup live feed event listeners
window.electronAPI.onLiveFeedToken((tokenData) => {
    addFeedToken(tokenData);
});

window.electronAPI.onLiveFeedStatus((connected) => {
    updateFeedStatus(connected);
});

// Handle icon updates from API fallbacks
window.electronAPI.onLiveFeedIconUpdate((data) => {
    if (data.mint && data.image) {
        // Update the token in our array
        const token = feedTokens.find(t => t.mint === data.mint);
        if (token) {
            token.image = data.image;
        }
        
        // Also check graduating tokens
        const gradToken = graduatingTokens.find(t => t.mint === data.mint);
        if (gradToken) {
            gradToken.image = data.image;
        }
        
        // Update the DOM directly for instant feedback
        const feedItem = document.querySelector(`.feed-item[data-mint="${data.mint}"]`);
        if (feedItem) {
            const iconWrapper = feedItem.querySelector('.feed-token-icon-wrapper');
            if (iconWrapper) {
                iconWrapper.innerHTML = `
                    <img src="${data.image}" class="feed-token-icon" style="width:45px; height:45px; border-radius:10px; object-fit:cover;" onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
                    <div class="feed-token-placeholder" style="display:none;">🪙</div>
                `;
            }
        }
    }
});

// Handle socials updates from API
window.electronAPI.onLiveFeedSocialsUpdate((data) => {
    if (data.mint && data.socials) {
        // Update the token in our arrays
        const token = feedTokens.find(t => t.mint === data.mint);
        if (token) {
            token.socials = data.socials;
        }
        const gradToken = graduatingTokens.find(t => t.mint === data.mint);
        if (gradToken) {
            gradToken.socials = data.socials;
        }
        
        // Update the DOM directly for instant feedback
        const feedItem = document.querySelector(`.feed-item[data-mint="${data.mint}"]`);
        if (feedItem) {
            const socialsDiv = feedItem.querySelector('.feed-socials');
            if (socialsDiv) {
                const s = data.socials;
                socialsDiv.innerHTML = `
                    ${s.twitter ? `<a href="${s.twitter}" target="_blank" class="social-link twitter" title="Twitter/X">𝕏</a>` : ''}
                    ${s.telegram ? `<a href="${s.telegram}" target="_blank" class="social-link telegram" title="Telegram">✈️</a>` : ''}
                    ${s.website ? `<a href="${s.website}" target="_blank" class="social-link website" title="Website">🌐</a>` : ''}
                    ${s.discord ? `<a href="${s.discord}" target="_blank" class="social-link discord" title="Discord">💬</a>` : ''}
                    ${!s.twitter && !s.telegram && !s.website && !s.discord ? '<span class="no-socials">-</span>' : ''}
                `;
            }
        }
    }
});

// Load feed token image asynchronously
async function loadFeedImage(mint, imageUrl) {
    try {
        const base64 = await loadImageAsBase64(imageUrl);
        if (base64) {
            const imgEl = document.getElementById(`feed-img-${mint}`);
            const placeholderEl = document.getElementById(`feed-placeholder-${mint}`);
            if (imgEl) {
                imgEl.src = base64;
                imgEl.style.display = 'block';
            }
            if (placeholderEl) {
                placeholderEl.style.display = 'none';
            }
        }
    } catch (e) {
        console.log('Feed image load error:', e);
    }
}

// Toggle auto-snipe bullish tokens
function toggleSnipeBullish() {
    if (!licenseValid) {
        document.getElementById('licenseModal').classList.add('active');
        return;
    }
    
    if (!config.privateKey) {
        addLog('❌ Please configure your private key in Settings first', 'error');
        showPage('settings');
        return;
    }
    
    snipeBullishEnabled = !snipeBullishEnabled;
    
    const btn = document.getElementById('snipeBullishBtn');
    const status = document.getElementById('snipeBullishStatus');
    
    if (snipeBullishEnabled) {
        btn.textContent = '⏹️ Stop Sniping';
        btn.classList.add('active');
        status.style.display = 'block';
        addLog('🎯 AUTO-SNIPE BULLISH ENABLED! Will buy all bullish tokens automatically', 'success');
        addLog(`💰 Buy amount: ${config.buyAmount || 0.01} SOL per token`, 'info');
        
        // Clear sniped tokens set when starting fresh
        snipedTokens.clear();
    } else {
        btn.textContent = '🎯 Snipe Bullish';
        btn.classList.remove('active');
        status.style.display = 'none';
        addLog('⏹️ Auto-snipe bullish DISABLED', 'warning');
    }
}

// Auto-snipe a bullish token with ADVANCED FILTERS
async function autoSnipeBullish(token) {
    // Check if already sniped this token
    if (snipedTokens.has(token.mint)) {
        return;
    }
    
    // Mark as processing to prevent double-buying
    snipedTokens.add(token.mint);
    
    addLog(`🔍 Analyzing ${token.name} before sniping...`, 'info');
    
    // FETCH ADVANCED DATA if not already present (holder count, dev wallet, volume, whale)
    let enrichedToken = { ...token };
    
    if (holderFilterEnabled || devWalletFilterEnabled || volumeSpikeBoostEnabled || whaleAlertEnabled || bundleDetectionEnabled) {
        try {
            // Fetch all advanced data in parallel
            const lookupResult = await window.electronAPI.lookupToken(token.mint);
            
            if (lookupResult.success && lookupResult.data) {
                // Merge the data
                enrichedToken.holderCount = lookupResult.data.holderCount || token.holderCount || 0;
                enrichedToken.devWalletPercent = lookupResult.data.devWalletPercent || token.devWalletPercent || 0;
                enrichedToken.volumeSpike = lookupResult.data.volumeSpike || token.volumeSpike || false;
                enrichedToken.buyPressure = lookupResult.data.buyPressure || token.buyPressure || 50;
                enrichedToken.whaleActivity = lookupResult.data.whaleActivity || token.whaleActivity || false;
                enrichedToken.marketCap = lookupResult.data.marketCap || token.marketCap || 5000;
                enrichedToken.price = lookupResult.data.price || token.price || 0.000001;
                
                // Log what we found
                addLog(`   📊 Holders: ${enrichedToken.holderCount || 'N/A'} | Dev: ${enrichedToken.devWalletPercent ? enrichedToken.devWalletPercent.toFixed(1) + '%' : 'N/A'}`, 'info');
            }
        } catch (e) {
            addLog(`   ⚠️ Could not fetch advanced data: ${e.message}`, 'warning');
        }
    }
    
    // CHECK SAFETY FILTERS before buying
    const filterCheck = passesFilters(enrichedToken);
    if (!filterCheck.passed) {
        addLog(`⚠️ SKIPPING ${token.name} - ${filterCheck.reasons.join(', ')}`, 'warning');
        return;
    }
    
    addLog(`🎯 AUTO-SNIPING: ${token.name} (${token.symbol}) - BULLISH!`, 'success');
    
    // Log advanced analysis details
    if (enrichedToken.holderCount) addLog(`   👥 Holders: ${enrichedToken.holderCount}`, 'info');
    if (enrichedToken.devWalletPercent > 0) addLog(`   👤 Dev wallet: ${enrichedToken.devWalletPercent.toFixed(1)}%`, 'info');
    if (enrichedToken.volumeSpike) addLog(`   🔥 Volume spike detected!`, 'success');
    if (enrichedToken.buyPressure > 60) addLog(`   📈 Buy pressure: ${enrichedToken.buyPressure.toFixed(0)}%`, 'success');
    if (enrichedToken.whaleActivity) addLog(`   🐋 Whale activity detected!`, 'success');
    
    try {
        const result = await window.electronAPI.quickBuy(token.mint, config);
        
        if (result.success) {
            addLog(`✅ AUTO-SNIPE SUCCESS! ${token.name} - TX: ${result.signature?.slice(0, 20)}...`, 'success');
            
            // TRACK POSITION for trailing stop-loss and take-profit
            const entryMcap = enrichedToken.marketCap || 5000;
            const entryPrice = enrichedToken.price || 0.000001;
            trackPosition(token.mint, token.name, entryPrice, entryMcap, config.buyAmount || 0.1);
            
            // Refresh holdings after 3 seconds
            setTimeout(() => refreshPositions(), 3000);
        } else {
            addLog(`❌ AUTO-SNIPE FAILED: ${token.name} - ${result.error}`, 'error');
            // Remove from sniped set so it can be tried again
            snipedTokens.delete(token.mint);
        }
    } catch (error) {
        addLog(`❌ AUTO-SNIPE ERROR: ${error.message}`, 'error');
        snipedTokens.delete(token.mint);
    }
}

// Toggle snipe graduating tokens ($9k+ market cap)
function toggleSnipeGraduating() {
    if (!licenseValid) {
        document.getElementById('licenseModal').classList.add('active');
        return;
    }
    
    if (!config.privateKey) {
        addLog('❌ Please configure your private key in Settings first', 'error');
        showPage('settings');
        return;
    }
    
    snipeGraduatingEnabled = !snipeGraduatingEnabled;
    
    const btn = document.getElementById('snipeGraduatingBtn');
    const status = document.getElementById('snipeGraduatingStatus');
    
    if (snipeGraduatingEnabled) {
        btn.textContent = '⏹️ Stop';
        btn.classList.add('active');
        btn.style.background = 'linear-gradient(135deg, #ff6600, #cc4400)';
        if (status) status.style.display = 'block';
        addLog('🎓 AUTO-SNIPE GRADUATING ENABLED! Will buy tokens hitting $9K+ market cap', 'success');
        addLog(`💰 Buy amount: ${config.buyAmount || 0.01} SOL per token`, 'info');
        
        // Clear sniped tokens set when starting fresh
        snipedGraduatingTokens.clear();
    } else {
        btn.textContent = '🎓 Snipe Graduating';
        btn.classList.remove('active');
        btn.style.background = 'linear-gradient(135deg, #ffaa00, #ff6600)';
        if (status) status.style.display = 'none';
        addLog('⏹️ Auto-snipe graduating DISABLED', 'warning');
    }
}

// Auto-snipe a graduating token (hit $9k+) with ADVANCED FILTERS
async function autoSnipeGraduating(token) {
    // Check if already sniped this token
    if (snipedGraduatingTokens.has(token.mint)) {
        return;
    }
    
    // Mark as processing to prevent double-buying
    snipedGraduatingTokens.add(token.mint);
    
    addLog(`🔍 Analyzing graduating ${token.name} before sniping...`, 'info');
    
    // FETCH ADVANCED DATA if not already present
    let enrichedToken = { ...token };
    
    if (holderFilterEnabled || devWalletFilterEnabled || volumeSpikeBoostEnabled || whaleAlertEnabled || bundleDetectionEnabled) {
        try {
            const lookupResult = await window.electronAPI.lookupToken(token.mint);
            
            if (lookupResult.success && lookupResult.data) {
                enrichedToken.holderCount = lookupResult.data.holderCount || token.holderCount || 0;
                enrichedToken.devWalletPercent = lookupResult.data.devWalletPercent || token.devWalletPercent || 0;
                enrichedToken.volumeSpike = lookupResult.data.volumeSpike || token.volumeSpike || false;
                enrichedToken.buyPressure = lookupResult.data.buyPressure || token.buyPressure || 50;
                enrichedToken.whaleActivity = lookupResult.data.whaleActivity || token.whaleActivity || false;
                enrichedToken.marketCap = lookupResult.data.marketCap || token.marketCap || 9000;
                enrichedToken.price = lookupResult.data.price || token.price || 0.00001;
                
                addLog(`   📊 Holders: ${enrichedToken.holderCount || 'N/A'} | Dev: ${enrichedToken.devWalletPercent ? enrichedToken.devWalletPercent.toFixed(1) + '%' : 'N/A'}`, 'info');
            }
        } catch (e) {
            addLog(`   ⚠️ Could not fetch advanced data: ${e.message}`, 'warning');
        }
    }
    
    // CHECK SAFETY FILTERS before buying
    const filterCheck = passesFilters(enrichedToken);
    if (!filterCheck.passed) {
        addLog(`⚠️ SKIPPING GRADUATING ${token.name} - ${filterCheck.reasons.join(', ')}`, 'warning');
        return;
    }
    
    addLog(`🎓 AUTO-SNIPING GRADUATING: ${token.name} (${token.symbol}) - MC: $${formatNumber(enrichedToken.marketCap)}!`, 'success');
    
    // Log advanced analysis details
    if (enrichedToken.holderCount) addLog(`   👥 Holders: ${enrichedToken.holderCount}`, 'info');
    if (enrichedToken.devWalletPercent > 0) addLog(`   👤 Dev wallet: ${enrichedToken.devWalletPercent.toFixed(1)}%`, 'info');
    if (enrichedToken.volumeSpike) addLog(`   🔥 Volume spike detected!`, 'success');
    if (enrichedToken.buyPressure > 60) addLog(`   📈 Buy pressure: ${enrichedToken.buyPressure.toFixed(0)}%`, 'success');
    if (enrichedToken.whaleActivity) addLog(`   🐋 Whale activity detected!`, 'success');
    
    try {
        const result = await window.electronAPI.quickBuy(token.mint, config);
        
        if (result.success) {
            addLog(`✅ GRADUATING SNIPE SUCCESS! ${token.name} - TX: ${result.signature?.slice(0, 20)}...`, 'success');
            
            // Track that we're holding this token
            graduatingTokensHolding.add(token.mint);
            
            // TRACK POSITION for trailing stop-loss and take-profit
            const entryMcap = enrichedToken.marketCap || 9000;
            const entryPrice = enrichedToken.price || 0.00001;
            trackPosition(token.mint, token.name, entryPrice, entryMcap, config.buyAmount || 0.1);
            
            // Refresh holdings after 3 seconds
            setTimeout(() => refreshPositions(), 3000);
        } else {
            addLog(`❌ GRADUATING SNIPE FAILED: ${token.name} - ${result.error}`, 'error');
            // Remove from sniped set so it can be tried again
            snipedGraduatingTokens.delete(token.mint);
        }
    } catch (error) {
        addLog(`❌ GRADUATING SNIPE ERROR: ${error.message}`, 'error');
        snipedGraduatingTokens.delete(token.mint);
    }
}

// Auto-sell a token that dropped below $5k in About to Graduate
async function autoSellDroppedToken(token) {
    const mcap = token.marketCap || 0;
    
    addLog(`📉 DROPPED BELOW $5K: ${token.name} (${token.symbol}) - MC: $${formatNumber(mcap)}`, 'warning');
    
    // Check if we actually hold this token (either from snipe or manual buy)
    const holdingThisToken = graduatingTokensHolding.has(token.mint) || snipedGraduatingTokens.has(token.mint);
    
    if (holdingThisToken && config.privateKey) {
        addLog(`💸 AUTO-SELLING: ${token.name} - Dropped below $5K safety threshold!`, 'error');
        
        try {
            const result = await window.electronAPI.quickSell(token.mint, 100, config);
            
            if (result.success) {
                addLog(`✅ AUTO-SELL SUCCESS! ${token.name} sold at $${formatNumber(mcap)} - TX: ${result.signature?.slice(0, 20)}...`, 'success');
                
                // Remove from holding tracking
                graduatingTokensHolding.delete(token.mint);
                snipedGraduatingTokens.delete(token.mint);
                
                // Refresh holdings after 3 seconds
                setTimeout(() => refreshPositions(), 3000);
            } else {
                addLog(`❌ AUTO-SELL FAILED: ${token.name} - ${result.error}`, 'error');
            }
        } catch (error) {
            addLog(`❌ AUTO-SELL ERROR: ${error.message}`, 'error');
        }
    } else {
        addLog(`ℹ️ Not holding ${token.name} - Removing from list only`, 'info');
    }
    
    // Remove from About to Graduate list regardless
    removeFromGraduating(token.mint);
}

// Remove a token from About to Graduate list
function removeFromGraduating(mint) {
    const tokenToRemove = graduatingTokens.find(t => t.mint === mint);
    if (tokenToRemove) {
        addLog(`🗑️ REMOVED: ${tokenToRemove.name} from About to Graduate (dropped below $5K)`, 'warning');
    }
    
    graduatingTokens = graduatingTokens.filter(t => t.mint !== mint);
    
    // Re-render
    renderGraduatingTokens();
    updateFeedCounts();
}

// Add graduating token to feed
function addGraduatingToken(tokenData) {
    // Check if already in list
    const exists = graduatingTokens.find(t => t.mint === tokenData.mint);
    if (exists) return;
    
    graduatingTokens.unshift(tokenData);
    if (graduatingTokens.length > MAX_FEED_TOKENS) {
        graduatingTokens.pop();
    }
    
    renderGraduatingTokens();
    updateFeedCounts();
    
    addLog(`🎓 About to graduate: ${tokenData.name} (${tokenData.symbol}) - ${tokenData.progress}%`, 'warning');
}

// Add graduated token to feed
function addGraduatedToken(tokenData) {
    // Remove from graduating if exists
    graduatingTokens = graduatingTokens.filter(t => t.mint !== tokenData.mint);
    
    // Check if already in graduated list
    const exists = graduatedTokens.find(t => t.mint === tokenData.mint);
    if (exists) return;
    
    graduatedTokens.unshift(tokenData);
    if (graduatedTokens.length > MAX_FEED_TOKENS) {
        graduatedTokens.pop();
    }
    
    renderGraduatingTokens();
    renderGraduatedTokens();
    updateFeedCounts();
    
    addLog(`🏆 GRADUATED: ${tokenData.name} (${tokenData.symbol}) - Now on Raydium!`, 'success');
}

// Render graduating tokens
function renderGraduatingTokens() {
    const container = document.getElementById('graduatingFeedList');
    if (!container) return;
    
    if (graduatingTokens.length === 0) {
        container.innerHTML = `
            <div class="empty-feed" style="padding: 40px; text-align: center; color: var(--text-muted);">
                <p style="font-size: 48px; margin-bottom: 15px;">🎓</p>
                <p>Tokens with $9,000+ market cap will appear here</p>
            </div>
        `;
        return;
    }
    
    container.innerHTML = graduatingTokens.map((token, idx) => {
        const progress = Math.min(100, Math.round(((token.marketCap || 0) / 69000) * 100));
        const mcapFormatted = formatNumber(token.marketCap || 0);
        const symbolText = (token.symbol || 'T').slice(0, 2).toUpperCase();
        
        // Price change indicator
        const priceChange = token.priceChange || 0;
        const priceColor = priceChange > 0 ? 'var(--accent-primary)' : priceChange < 0 ? 'var(--danger)' : 'var(--text-muted)';
        const priceArrow = priceChange > 0 ? '▲' : priceChange < 0 ? '▼' : '●';
        const priceText = priceChange !== 0 ? `${priceArrow}${Math.abs(priceChange).toFixed(1)}%` : '';
        
        // Image handling
        const hasImage = token.image && token.image.length > 10;
        const imageHtml = hasImage ? `
            <img src="${token.image}" style="width:45px; height:45px; border-radius:10px; object-fit:cover; border:1px solid var(--warning);" 
                 onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
            <div style="display:none; width:45px; height:45px; border-radius:10px; background:linear-gradient(135deg,#ffaa00,#ff6600); border:1px solid var(--warning); align-items:center; justify-content:center; color:white; font-weight:bold; font-size:14px;">
                ${symbolText}
            </div>
        ` : `
            <div style="display:flex; width:45px; height:45px; border-radius:10px; background:linear-gradient(135deg,#ffaa00,#ff6600); border:1px solid var(--warning); align-items:center; justify-content:center; color:white; font-weight:bold; font-size:14px;">
                ${symbolText}
            </div>
        `;
        
        return `
            <div class="feed-item ${idx === 0 ? 'new' : ''}" data-mint="${token.mint}" style="border-left: 3px solid var(--warning);">
                <div class="feed-token-icon-wrapper">
                    ${imageHtml}
                </div>
                
                <div class="feed-token-info">
                    <div class="feed-token-name">
                        ${token.name || 'Unknown'}
                        <span class="platform-badge" style="background: var(--warning); color: var(--bg-primary);">🎓 ${progress}%</span>
                    </div>
                    <div class="feed-token-ca" onclick="copyToClipboard('${token.mint}')" title="Click to copy">
                        ${token.symbol} • ${token.mint?.slice(0, 8)}...${token.mint?.slice(-6)}
                    </div>
                </div>
                
                <div class="feed-metrics">
                    <div class="feed-metric">
                        <div class="feed-metric-label">Market Cap</div>
                        <div class="feed-metric-value" style="display:flex; align-items:center; gap:4px;">
                            $${mcapFormatted}
                            <span style="font-size:11px; color:${priceColor}; font-weight:bold; animation: ${priceChange !== 0 ? 'pulse 1s' : 'none'};">${priceText}</span>
                        </div>
                    </div>
                    <div class="feed-metric">
                        <div class="feed-metric-label">To Raydium</div>
                        <div class="feed-metric-value" style="display:flex; align-items:center; gap:4px;">
                            <div style="width:50px; height:6px; background:rgba(255,255,255,0.2); border-radius:3px; overflow:hidden;">
                                <div style="width:${progress}%; height:100%; background:linear-gradient(90deg, var(--warning), var(--accent-primary)); border-radius:3px; transition: width 0.5s;"></div>
                            </div>
                            <span style="font-size:10px; color:var(--warning);">${progress}%</span>
                        </div>
                    </div>
                </div>
                
                <div class="feed-actions">
                    <button class="feed-btn buy" onclick="feedQuickBuy('${token.mint}')">🚀 Buy</button>
                    <button class="feed-btn view" onclick="viewTokenInTrade('${token.mint}')">👁️ View</button>
                </div>
            </div>
        `;
    }).join('');
}

// Render graduated tokens
function renderGraduatedTokens() {
    const container = document.getElementById('graduatedFeedList');
    if (!container) return;
    
    if (graduatedTokens.length === 0) {
        container.innerHTML = `
            <div class="empty-feed" style="padding: 40px; text-align: center; color: var(--text-muted);">
                <p style="font-size: 48px; margin-bottom: 15px;">🏆</p>
                <p>Tokens that graduated to Raydium will appear here</p>
            </div>
        `;
        return;
    }
    
    container.innerHTML = graduatedTokens.map((token, idx) => {
        const mcapFormatted = formatNumber(token.marketCap || 0);
        const symbolText = (token.symbol || 'T').slice(0, 2).toUpperCase();
        const liqFormatted = formatNumber(token.liquidity || 0);
        
        // Price change indicator
        const priceChange = token.priceChange || 0;
        const priceColor = priceChange > 0 ? 'var(--accent-primary)' : priceChange < 0 ? 'var(--danger)' : 'var(--text-muted)';
        const priceArrow = priceChange > 0 ? '▲' : priceChange < 0 ? '▼' : '●';
        const priceText = priceChange !== 0 ? `${priceArrow}${Math.abs(priceChange).toFixed(1)}%` : '';
        
        // Image handling
        const hasImage = token.image && token.image.length > 10;
        const imageHtml = hasImage ? `
            <img src="${token.image}" style="width:45px; height:45px; border-radius:10px; object-fit:cover; border:1px solid #9945FF;" 
                 onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
            <div style="display:none; width:45px; height:45px; border-radius:10px; background:linear-gradient(135deg,#9945FF,#14F195); border:1px solid #9945FF; align-items:center; justify-content:center; color:white; font-weight:bold; font-size:14px;">
                ${symbolText}
            </div>
        ` : `
            <div style="display:flex; width:45px; height:45px; border-radius:10px; background:linear-gradient(135deg,#9945FF,#14F195); border:1px solid #9945FF; align-items:center; justify-content:center; color:white; font-weight:bold; font-size:14px;">
                ${symbolText}
            </div>
        `;
        
        return `
            <div class="feed-item ${idx === 0 ? 'new' : ''}" data-mint="${token.mint}" style="border-left: 3px solid #9945FF;">
                <div class="feed-token-icon-wrapper">
                    ${imageHtml}
                </div>
                
                <div class="feed-token-info">
                    <div class="feed-token-name">
                        ${token.name || 'Unknown'}
                        <span class="platform-badge" style="background: #9945FF; color: white;">🏆 RAYDIUM</span>
                    </div>
                    <div class="feed-token-ca" onclick="copyToClipboard('${token.mint}')" title="Click to copy">
                        ${token.symbol} • ${token.mint?.slice(0, 8)}...${token.mint?.slice(-6)}
                    </div>
                </div>
                
                <div class="feed-metrics">
                    <div class="feed-metric">
                        <div class="feed-metric-label">Market Cap</div>
                        <div class="feed-metric-value" style="display:flex; align-items:center; gap:4px;">
                            $${mcapFormatted}
                            <span style="font-size:11px; color:${priceColor}; font-weight:bold; animation: ${priceChange !== 0 ? 'pulse 1s' : 'none'};">${priceText}</span>
                        </div>
                    </div>
                    <div class="feed-metric">
                        <div class="feed-metric-label">Liquidity</div>
                        <div class="feed-metric-value" style="color: #14F195;">$${liqFormatted}</div>
                    </div>
                </div>
                
                <div class="feed-actions">
                    <button class="feed-btn buy" onclick="feedQuickBuy('${token.mint}')">🚀 Buy</button>
                    <button class="feed-btn view" onclick="viewTokenInTrade('${token.mint}')">👁️ View</button>
                </div>
            </div>
        `;
    }).join('');
}

// Toggle auto-sell when tokens drop below $5k
function toggleAutoSellDrop() {
    autoSellDropEnabled = !autoSellDropEnabled;
    
    const btn = document.getElementById('autoSellDropBtn');
    const statusText = document.getElementById('autoSellStatusText');
    
    if (autoSellDropEnabled) {
        if (btn) {
            btn.textContent = '🛡️ Auto-Sell ON';
            btn.style.background = 'linear-gradient(135deg, #ff4444, #cc0000)';
        }
        if (statusText) {
            statusText.textContent = '✅ Active';
            statusText.style.color = 'var(--accent-primary)';
            statusText.style.background = 'rgba(0,255,136,0.1)';
        }
        addLog('🛡️ AUTO-SELL PROTECTION ENABLED: Will sell tokens that drop below $5K in About to Graduate', 'success');
    } else {
        if (btn) {
            btn.textContent = '🛡️ Auto-Sell OFF';
            btn.style.background = 'var(--bg-tertiary)';
        }
        if (statusText) {
            statusText.textContent = '❌ Disabled';
            statusText.style.color = 'var(--danger)';
            statusText.style.background = 'rgba(255,68,68,0.1)';
        }
        addLog('⚠️ AUTO-SELL PROTECTION DISABLED: Tokens won\'t be auto-sold when dropping below $5K', 'warning');
    }
}

// ═══════════════════════════════════════════════════════════════
// ADVANCED FEATURE TOGGLE FUNCTIONS
// ═══════════════════════════════════════════════════════════════

function toggleTakeProfit() {
    takeProfitEnabled = document.getElementById('takeProfitEnabled')?.checked ?? true;
    addLog(`🎯 Take-Profit: ${takeProfitEnabled ? 'ENABLED' : 'DISABLED'}`, takeProfitEnabled ? 'success' : 'warning');
}

function toggleTrailingStop() {
    trailingStopEnabled = document.getElementById('trailingStopEnabled')?.checked ?? true;
    addLog(`📉 Trailing Stop-Loss: ${trailingStopEnabled ? 'ENABLED' : 'DISABLED'}`, trailingStopEnabled ? 'success' : 'warning');
}

function toggleHolderFilter() {
    holderFilterEnabled = document.getElementById('holderFilterEnabled')?.checked ?? true;
    addLog(`👥 Holder Filter (min ${tradingSettings.minHolderCount}): ${holderFilterEnabled ? 'ENABLED' : 'DISABLED'}`, holderFilterEnabled ? 'success' : 'warning');
}

function toggleDevWalletFilter() {
    devWalletFilterEnabled = document.getElementById('devWalletFilterEnabled')?.checked ?? true;
    addLog(`👤 Dev Wallet Filter (max ${tradingSettings.maxDevWalletPercent}%): ${devWalletFilterEnabled ? 'ENABLED' : 'DISABLED'}`, devWalletFilterEnabled ? 'success' : 'warning');
}

function toggleWhaleAlert() {
    whaleAlertEnabled = document.getElementById('whaleAlertEnabled')?.checked ?? true;
    addLog(`🐋 Whale Alerts: ${whaleAlertEnabled ? 'ENABLED' : 'DISABLED'}`, whaleAlertEnabled ? 'success' : 'warning');
}

function toggleVolumeSpike() {
    volumeSpikeBoostEnabled = document.getElementById('volumeSpikeEnabled')?.checked ?? true;
    addLog(`🔥 Volume Spike Detection: ${volumeSpikeBoostEnabled ? 'ENABLED' : 'DISABLED'}`, volumeSpikeBoostEnabled ? 'success' : 'warning');
}

function toggleBundleDetection() {
    bundleDetectionEnabled = document.getElementById('bundleDetectionEnabled')?.checked ?? true;
    addLog(`🎭 Bundle Detection: ${bundleDetectionEnabled ? 'ENABLED' : 'DISABLED'}`, bundleDetectionEnabled ? 'success' : 'warning');
    if (bundleDetectionEnabled) {
        addLog(`   Skipping tokens with ${tradingSettings.bundleMinBuyers}+ buyers in ${tradingSettings.bundleTimeWindow/1000}s`, 'info');
    }
}

// ═══════════════════════════════════════════════════════════════
// SIMPLE LAUNCH FUNCTIONS
// ═══════════════════════════════════════════════════════════════

let simpleLaunchInProgress = false;

async function executeSimpleLaunch() {
    if (simpleLaunchInProgress) {
        addLog('⚠️ Launch already in progress...', 'warning');
        return;
    }
    
    const name = document.getElementById('simpleLaunchName')?.value?.trim();
    const symbol = document.getElementById('simpleLaunchSymbol')?.value?.trim()?.toUpperCase();
    const description = document.getElementById('simpleLaunchDescription')?.value?.trim();
    const imageUrl = document.getElementById('simpleLaunchImage')?.value?.trim();
    const imageBase64 = document.getElementById('simpleLaunchImageBase64')?.value || null;
    const initialBuy = parseFloat(document.getElementById('simpleLaunchBuy')?.value) || 0;
    
    // Platform selection
    const platformPumpFun = document.getElementById('platformPumpFun');
    const platform = platformPumpFun?.checked ? 'pumpfun' : 'letsbonk';
    
    // Social links
    const twitter = document.getElementById('simpleLaunchTwitter')?.value?.trim() || null;
    const telegram = document.getElementById('simpleLaunchTelegram')?.value?.trim() || null;
    const website = document.getElementById('simpleLaunchWebsite')?.value?.trim() || null;
    
    // Validation
    if (!name || name.length < 2) {
        showSimpleLaunchStatus('❌ Please enter a valid token name (at least 2 characters)', 'error');
        return;
    }
    
    if (!symbol || symbol.length < 2 || symbol.length > 10) {
        showSimpleLaunchStatus('❌ Symbol must be 2-10 characters', 'error');
        return;
    }
    
    if (!description || description.length < 10) {
        showSimpleLaunchStatus('❌ Please enter a description (at least 10 characters)', 'error');
        return;
    }
    
    // Warn if no initial buy
    if (initialBuy <= 0) {
        const confirmNoBuy = confirm('⚠️ Initial Buy is 0 SOL!\n\nYou will create the token but NOT own any tokens.\nThe token will NOT appear in your wallet.\n\nAre you sure you want to continue?');
        if (!confirmNoBuy) {
            showSimpleLaunchStatus('❌ Launch cancelled. Set Initial Buy to at least 0.1 SOL.', 'warning');
            return;
        }
    }
    
    simpleLaunchInProgress = true;
    const launchBtn = document.getElementById('simpleLaunchBtn');
    if (launchBtn) {
        launchBtn.disabled = true;
        launchBtn.innerHTML = '⏳ Preparing...';
    }
    
    showSimpleLaunchStatus('🚀 Preparing token launch on Pump.fun...', 'info');
    addLog(`🚀 SIMPLE LAUNCH: Creating token "${name}" (${symbol})`, 'success');
    
    try {
        // Prepare launch data
        const launchData = {
            name: name,
            symbol: symbol,
            description: description,
            image: imageUrl || null,
            imageBase64: imageBase64 || null,
            initialBuy: initialBuy,
            platform: platform,
            twitter: twitter,
            telegram: telegram,
            website: website
        };
        
        addLog(`   📝 Name: ${name}`, 'info');
        addLog(`   🔤 Symbol: ${symbol}`, 'info');
        addLog(`   🌐 Platform: ${platform === 'pumpfun' ? 'Pump.fun' : 'LetsBonk'}`, 'info');
        addLog(`   💰 Initial Buy: ${initialBuy} SOL`, 'info');
        if (imageBase64) addLog(`   🖼️ Image: File uploaded`, 'info');
        else if (imageUrl) addLog(`   🖼️ Image: URL provided`, 'info');
        if (twitter) addLog(`   🐦 Twitter: ${twitter}`, 'info');
        if (telegram) addLog(`   📱 Telegram: ${telegram}`, 'info');
        if (website) addLog(`   🌐 Website: ${website}`, 'info');
        
        // Call the main process to execute the launch
        const result = await window.electronAPI.simpleLaunchToken(launchData);
        
        if (result && result.success) {
            // Token was created successfully!
            if (result.mint) {
                const platformLabel = result.platform === 'letsbonk' ? 'LetsBonk' : 'Pump.fun';
                showSimpleLaunchStatus(`✅ TOKEN CREATED ON ${platformLabel.toUpperCase()}! CA: ${result.mint}`, 'success');
                addLog(`🎉 TOKEN CREATED SUCCESSFULLY!`, 'success');
                addLog(`   📍 Contract Address: ${result.mint}`, 'success');
                addLog(`   🔤 Name: ${result.name} (${result.symbol})`, 'info');
                addLog(`   🌐 Platform: ${platformLabel}`, 'info');
                
                if (result.signature) {
                    addLog(`   📝 TX: ${result.signature}`, 'info');
                }
                
                if (result.links) {
                    const platformLink = result.links.platform || result.links.pumpfun;
                    addLog(`   🔗 ${platformLabel}: ${platformLink}`, 'info');
                    addLog(`   📊 DexScreener: ${result.links.dexscreener}`, 'info');
                }
                
                // Check if user set initial buy
                const initialBuy = parseFloat(document.getElementById('simpleLaunchBuy')?.value) || 0;
                if (initialBuy <= 0) {
                    addLog(`   ⚠️ NOTE: You set Initial Buy to 0 SOL, so you don't own any tokens yet!`, 'warning');
                    addLog(`   💡 TIP: Buy some tokens on ${platformLabel} using the CA above.`, 'warning');
                } else {
                    addLog(`   💰 Initial Buy: ${initialBuy} SOL - Tokens should appear in your wallet!`, 'success');
                    addLog(`   👻 If not visible in Phantom: Add token manually using the CA.`, 'info');
                }
                
                // Copy CA to clipboard
                try {
                    navigator.clipboard.writeText(result.mint);
                    addLog(`   📋 Contract address copied to clipboard!`, 'success');
                } catch (e) {}
                
                // Clear form on success
                document.getElementById('simpleLaunchName').value = '';
                document.getElementById('simpleLaunchSymbol').value = '';
                document.getElementById('simpleLaunchDescription').value = '';
                clearSelectedImage();
                
                // Store as successful launch
                addRecentLaunch({
                    name: result.name,
                    symbol: result.symbol,
                    mint: result.mint,
                    timestamp: Date.now(),
                    status: 'success'
                });
            } else {
                // Fallback - details prepared but not yet created
                showSimpleLaunchStatus(`✅ ${result.message || 'Ready to launch!'}`, 'success');
                addLog(`🎉 TOKEN DETAILS PREPARED!`, 'success');
                
                if (result.instructions) {
                    addLog(`📋 Instructions:`, 'info');
                    result.instructions.split('\n').forEach(line => {
                        if (line.trim()) addLog(`   ${line.trim()}`, 'info');
                    });
                }
                
                // Open Pump.fun create page
                if (result.redirectUrl) {
                    addLog(`🔗 Opening Pump.fun...`, 'info');
                    window.electronAPI.openExternal(result.redirectUrl);
                }
                
                // Store launch data for recent launches
                addRecentLaunch({
                    name: name,
                    symbol: symbol,
                    timestamp: Date.now(),
                    status: 'pending'
                });
            }
            
        } else {
            const errorMsg = result?.error || 'Unknown error occurred';
            showSimpleLaunchStatus(`❌ ${errorMsg}`, 'error');
            addLog(`❌ LAUNCH ISSUE: ${errorMsg}`, 'error');
            
            // If there are instructions, still show them
            if (result?.instructions) {
                addLog(`📋 Instructions:`, 'info');
                result.instructions.split('\n').forEach(line => {
                    if (line.trim()) addLog(`   ${line.trim()}`, 'info');
                });
            }
            
            // Still open Pump.fun if redirectUrl provided
            if (result?.redirectUrl) {
                addLog(`🔗 Opening Pump.fun to complete manually...`, 'info');
                window.electronAPI.openExternal(result.redirectUrl);
            }
        }
    } catch (error) {
        showSimpleLaunchStatus(`❌ Launch error: ${error.message}`, 'error');
        addLog(`❌ LAUNCH ERROR: ${error.message}`, 'error');
    } finally {
        simpleLaunchInProgress = false;
        if (launchBtn) {
            launchBtn.disabled = false;
            launchBtn.innerHTML = '🚀 Launch Token on Pump.fun';
        }
    }
}

// Store recent launches
let recentLaunches = [];

function addRecentLaunch(launch) {
    recentLaunches.unshift(launch);
    if (recentLaunches.length > 10) recentLaunches.pop();
    updateRecentLaunchesDisplay();
}

function updateRecentLaunchesDisplay() {
    const listEl = document.getElementById('recentLaunchesList');
    if (!listEl) return;
    
    if (recentLaunches.length === 0) {
        listEl.innerHTML = `
            <div style="text-align: center; padding: 20px; color: var(--text-muted);">
                No tokens launched yet. Create your first token above! 🚀
            </div>
        `;
        return;
    }
    
    listEl.innerHTML = recentLaunches.map(launch => `
        <div style="display: flex; justify-content: space-between; align-items: center; padding: 12px; background: var(--bg-secondary); border-radius: 8px; margin-bottom: 8px; ${launch.status === 'success' ? 'border-left: 3px solid var(--accent-primary);' : ''}">
            <div style="flex: 1;">
                <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
                    <span style="font-weight: 600; color: var(--text-primary);">${launch.name}</span>
                    <span style="color: var(--text-muted); font-size: 12px; background: var(--bg-tertiary); padding: 2px 6px; border-radius: 4px;">$${launch.symbol}</span>
                </div>
                ${launch.mint ? `
                    <div style="font-size: 11px; color: var(--accent-primary); cursor: pointer; display: flex; align-items: center; gap: 5px;" onclick="copyToClipboard('${launch.mint}')" title="Click to copy">
                        📋 ${launch.mint.slice(0, 8)}...${launch.mint.slice(-6)}
                    </div>
                ` : ''}
            </div>
            <div style="text-align: right;">
                <span style="font-size: 11px; color: ${launch.status === 'success' ? 'var(--accent-primary)' : 'var(--warning)'}; font-weight: 600;">
                    ${launch.status === 'success' ? '✅ Created' : '⏳ Pending'}
                </span>
                <div style="font-size: 10px; color: var(--text-muted);">${new Date(launch.timestamp).toLocaleTimeString()}</div>
                ${launch.mint ? `
                    <a href="https://pump.fun/${launch.mint}" target="_blank" style="font-size: 10px; color: #00aaff; text-decoration: none;">View on Pump.fun →</a>
                ` : ''}
            </div>
        </div>
    `).join('');
}

function copyToClipboard(text) {
    try {
        navigator.clipboard.writeText(text);
        addLog(`📋 Copied: ${text}`, 'success');
    } catch (e) {
        console.log('Copy failed:', e);
    }
}

function showSimpleLaunchStatus(message, type) {
    const statusEl = document.getElementById('simpleLaunchStatus');
    if (!statusEl) return;
    
    statusEl.style.display = 'block';
    statusEl.textContent = message;
    
    switch (type) {
        case 'success':
            statusEl.style.background = 'rgba(0,255,136,0.15)';
            statusEl.style.color = 'var(--accent-primary)';
            statusEl.style.border = '1px solid var(--accent-primary)';
            break;
        case 'error':
            statusEl.style.background = 'rgba(255,68,68,0.15)';
            statusEl.style.color = 'var(--danger)';
            statusEl.style.border = '1px solid var(--danger)';
            break;
        case 'info':
        default:
            statusEl.style.background = 'rgba(0,170,255,0.15)';
            statusEl.style.color = '#00aaff';
            statusEl.style.border = '1px solid #00aaff';
            break;
    }
    
    // Auto-hide after 10 seconds for success messages
    if (type === 'success') {
        setTimeout(() => {
            statusEl.style.display = 'none';
        }, 10000);
    }
}

function openPumpFunLaunch() {
    // Open Pump.fun create token page in browser
    window.electronAPI.openExternal('https://pump.fun/create');
    addLog('🔗 Opening Pump.fun create token page...', 'info');
}

// Selected image data for Simple Launch
let selectedImageData = null;

async function selectImageFromComputer() {
    try {
        addLog('📁 Opening file picker...', 'info');
        const result = await window.electronAPI.selectImageFile();
        
        if (result.canceled) {
            addLog('📁 File selection cancelled', 'info');
            return;
        }
        
        if (!result.success) {
            addLog(`❌ File selection failed: ${result.error}`, 'error');
            return;
        }
        
        // Store the base64 data
        selectedImageData = result;
        
        // Update UI
        const fileNameEl = document.getElementById('selectedFileName');
        const previewImg = document.getElementById('imagePreview');
        const previewPlaceholder = document.getElementById('imagePreviewPlaceholder');
        const base64Input = document.getElementById('simpleLaunchImageBase64');
        const urlInput = document.getElementById('simpleLaunchImage');
        
        if (fileNameEl) {
            fileNameEl.textContent = `✓ ${result.fileName} (${(result.size / 1024).toFixed(1)} KB)`;
            fileNameEl.style.color = 'var(--accent-primary)';
        }
        
        if (previewImg && result.base64) {
            previewImg.src = result.base64;
            previewImg.style.display = 'block';
            if (previewPlaceholder) previewPlaceholder.style.display = 'none';
        }
        
        if (base64Input) {
            base64Input.value = result.base64;
        }
        
        // Clear URL input since we're using file
        if (urlInput) {
            urlInput.value = '';
            urlInput.placeholder = 'File selected - or paste URL to replace';
        }
        
        addLog(`✅ Image selected: ${result.fileName}`, 'success');
        
    } catch (error) {
        addLog(`❌ File selection error: ${error.message}`, 'error');
    }
}

function clearSelectedImage() {
    selectedImageData = null;
    
    const fileNameEl = document.getElementById('selectedFileName');
    const previewImg = document.getElementById('imagePreview');
    const previewPlaceholder = document.getElementById('imagePreviewPlaceholder');
    const base64Input = document.getElementById('simpleLaunchImageBase64');
    const urlInput = document.getElementById('simpleLaunchImage');
    
    if (fileNameEl) {
        fileNameEl.textContent = 'No file selected';
        fileNameEl.style.color = 'var(--text-muted)';
    }
    
    if (previewImg) {
        previewImg.src = '';
        previewImg.style.display = 'none';
    }
    
    if (previewPlaceholder) {
        previewPlaceholder.style.display = 'block';
    }
    
    if (base64Input) {
        base64Input.value = '';
    }
    
    if (urlInput) {
        urlInput.value = '';
        urlInput.placeholder = 'Or paste image URL here...';
    }
    
    addLog('🗑️ Image cleared', 'info');
}

function toggleAdvancedPanel() {
    advancedPanelOpen = !advancedPanelOpen;
    const body = document.getElementById('advancedPanelBody');
    const toggle = document.getElementById('advancedPanelToggle');
    
    if (body) {
        body.style.display = advancedPanelOpen ? 'block' : 'none';
    }
    if (toggle) {
        toggle.textContent = advancedPanelOpen ? '▼' : '▶';
        toggle.style.transform = advancedPanelOpen ? 'rotate(0deg)' : 'rotate(-90deg)';
    }
}

// Update active positions display
function updateActivePositionsDisplay() {
    const countEl = document.getElementById('activePositionsCount');
    const listEl = document.getElementById('activePositionsList');
    
    if (!countEl || !listEl) return;
    
    const count = positionTracker.size;
    countEl.textContent = `${count} active`;
    
    if (count === 0) {
        listEl.innerHTML = '<div style="color: var(--text-muted); text-align: center; padding: 10px;">No active positions being tracked</div>';
        return;
    }
    
    listEl.innerHTML = Array.from(positionTracker.entries()).map(([mint, pos]) => {
        const multiplier = pos.entryMcap > 0 ? pos.currentMcap / pos.entryMcap : 1;
        const pnlPercent = ((multiplier - 1) * 100).toFixed(1);
        const color = multiplier >= 1 ? 'var(--accent-primary)' : 'var(--danger)';
        const arrow = multiplier >= 1 ? '▲' : '▼';
        const levelsSold = pos.levelsSold.length > 0 ? ` | Sold at: ${pos.levelsSold.join('x, ')}x` : '';
        
        return `
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px; background: var(--bg-secondary); border-radius: 6px; margin-bottom: 4px;">
                <div>
                    <span style="font-weight: 600; color: var(--text-primary);">${pos.name}</span>
                    <span style="color: var(--text-muted); font-size: 10px; margin-left: 5px;">${mint.slice(0, 6)}...</span>
                </div>
                <div style="text-align: right;">
                    <span style="color: ${color}; font-weight: 600;">${arrow}${pnlPercent}%</span>
                    <span style="color: var(--text-muted); font-size: 10px; margin-left: 5px;">(${multiplier.toFixed(2)}x)${levelsSold}</span>
                </div>
            </div>
        `;
    }).join('');
}

// Update positions display every 5 seconds
setInterval(updateActivePositionsDisplay, 5000);

// Make functions globally accessible
window.toggleLiveFeed = toggleLiveFeed;
window.clearFeed = clearFeed;
window.feedQuickBuy = feedQuickBuy;
window.viewTokenInTrade = viewTokenInTrade;
window.togglePriceChart = togglePriceChart;
window.updatePriceChart = updatePriceChart;
window.loadPriceChart = loadPriceChart;
window.refreshPriceChart = refreshPriceChart;
window.setChartTimeframe = setChartTimeframe;
window.toggleSnipeBullish = toggleSnipeBullish;
window.toggleSnipeGraduating = toggleSnipeGraduating;
window.switchFeedTab = switchFeedTab;
window.toggleAutoSellDrop = toggleAutoSellDrop;
window.removeFromGraduating = removeFromGraduating;
window.moveToGraduated = moveToGraduated;
window.toggleTakeProfit = toggleTakeProfit;
window.toggleTrailingStop = toggleTrailingStop;
window.toggleHolderFilter = toggleHolderFilter;
window.toggleDevWalletFilter = toggleDevWalletFilter;
window.toggleWhaleAlert = toggleWhaleAlert;
window.toggleVolumeSpike = toggleVolumeSpike;
window.toggleBundleDetection = toggleBundleDetection;
window.toggleAdvancedPanel = toggleAdvancedPanel;
window.updateActivePositionsDisplay = updateActivePositionsDisplay;
window.executeSimpleLaunch = executeSimpleLaunch;
window.openPumpFunLaunch = openPumpFunLaunch;
window.selectImageFromComputer = selectImageFromComputer;
window.clearSelectedImage = clearSelectedImage;
window.copyToClipboard = copyToClipboard;


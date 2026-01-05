/**
 * ═══════════════════════════════════════════════════════════════
 * ⚡ ZOOT AUTO SNIPER BOT - Core Trading Engine
 * Full Pump Portal WebSocket + API Integration
 * ═══════════════════════════════════════════════════════════════
 */

const { Connection, Keypair, VersionedTransaction, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const axios = require('axios');
const bs58 = require('bs58');
const WebSocket = require('ws');

// ═══════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════

let wallet = null;
let connection = null;
let isRunning = false;
let config = {};
let logCallback = null;
let statsCallback = null;

// WebSocket for instant detection
let pumpWebSocket = null;
let wsConnected = false;
let wsReconnectAttempts = 0;

const seenTokens = new Set();
const activePositions = new Map();
let totalProfitSOL = 0;
let totalBuys = 0;
let totalSells = 0;
let winningTrades = 0;

// Interval references
let tokenCheckInterval = null;
let positionCheckInterval = null;
let statusInterval = null;

// RPC fallbacks
const RPC_ENDPOINTS = [
    'https://api.mainnet-beta.solana.com',
    'https://rpc.ankr.com/solana',
    'https://solana.public-rpc.com'
];

// Trailing profit config (will be updated from user settings)
let TRAILING_CONFIG = {
    partialSellTarget: 6.0,    // At 6x, sell 66%
    partialSellPercent: 66,    // Sell 66%
    trailingStopAfterPartial: 2.0, // After partial sell, stop at 2x
    initialStopLoss: 0.5       // Initial stop loss at 50%
};

// ═══════════════════════════════════════════════════════════════
// LOGGING
// ═══════════════════════════════════════════════════════════════

function log(message, type = 'info') {
    if (logCallback) {
        logCallback({ message, type, timestamp: Date.now() });
    }
    console.log(`[${type}] ${message}`);
}

function updateStats() {
    if (statsCallback) {
        const winRate = totalSells > 0 ? (winningTrades / totalSells) * 100 : 0;
        statsCallback({
            profit: totalProfitSOL,
            trades: totalBuys,
            winRate: winRate,
            positions: activePositions.size
        });
    }
}

// ═══════════════════════════════════════════════════════════════
// WALLET SETUP
// ═══════════════════════════════════════════════════════════════

function parsePrivateKey(input) {
    input = input.trim();
    
    // Try JSON array format
    if (input.startsWith('[')) {
        try {
            const parsed = JSON.parse(input);
            if (Array.isArray(parsed) && parsed.length === 64) {
                return new Uint8Array(parsed);
            }
        } catch (e) {}
    }
    
    // Try Base58 format
    try {
        const decoded = bs58.decode(input);
        if (decoded.length === 64) {
            return decoded;
        }
    } catch (e) {}
    
    throw new Error('Invalid private key format. Use Base58 or JSON array.');
}

async function setupWallet(privateKey) {
    try {
        const secretKey = parsePrivateKey(privateKey);
        wallet = Keypair.fromSecretKey(secretKey);
        log(`✅ Wallet loaded: ${wallet.publicKey.toString().slice(0, 8)}...`, 'success');
        return true;
    } catch (error) {
        log(`❌ Invalid private key: ${error.message}`, 'error');
        throw error;
    }
}

async function setupConnection(customRpc) {
    const endpoints = customRpc ? [customRpc, ...RPC_ENDPOINTS] : RPC_ENDPOINTS;
    
    for (const rpcUrl of endpoints) {
        try {
            log(`Connecting to RPC: ${rpcUrl.split('/')[2]}...`, 'info');
            connection = new Connection(rpcUrl, 'confirmed');
            const balance = await connection.getBalance(wallet.publicKey);
            log(`✅ Connected! Balance: ${(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`, 'success');
            return true;
        } catch (error) {
            log(`⚠️ RPC failed: ${rpcUrl.split('/')[2]}`, 'warning');
        }
    }
    
    throw new Error('All RPC endpoints failed');
}

// ═══════════════════════════════════════════════════════════════
// WEBSOCKET - INSTANT TOKEN DETECTION (from Pump Portal)
// ═══════════════════════════════════════════════════════════════

// Store WebSocket references for both platforms
let bonkWebSocket = null;

function connectWebSocket() {
    const platform = config.platform || 'pumpfun';
    
    // Connect to Pump.fun if selected
    if (platform === 'pumpfun' || platform === 'both') {
        connectPumpFunWebSocket();
    }
    
    // Connect to LetsBonk if selected
    if (platform === 'letsbonk' || platform === 'both') {
        connectLetsBonkWebSocket();
    }
}

function connectPumpFunWebSocket() {
    if (pumpWebSocket && pumpWebSocket.readyState === WebSocket.OPEN) {
        return;
    }
    
    log('🔌 Connecting to Pump.fun WebSocket...', 'info');
    
    try {
        pumpWebSocket = new WebSocket('wss://pumpportal.fun/api/data');
        
        pumpWebSocket.on('open', () => {
            wsConnected = true;
            wsReconnectAttempts = 0;
            log('✅ Connected to Pump.fun (PumpPortal)!', 'success');
            
            // Subscribe to new token events
            pumpWebSocket.send(JSON.stringify({
                method: "subscribeNewToken"
            }));
            
            log('🟢 Listening for NEW Pump.fun tokens...', 'warning');
        });
        
        pumpWebSocket.on('message', async (data) => {
            if (!isRunning) return;
            
            try {
                const parsed = JSON.parse(data.toString());
                
                // New token created event from Pump Portal!
                if (parsed.mint || parsed.token || parsed.signature) {
                    const tokenAddress = parsed.mint || parsed.token;
                    if (!tokenAddress) return;
                    
                    // CHECK PLATFORM SELECTION - Only process if user selected pumpfun or both
                    const selectedPlatform = config.platform || 'pumpfun';
                    if (selectedPlatform !== 'pumpfun' && selectedPlatform !== 'both') {
                        // User only wants LetsBonk, skip pump.fun tokens
                        return;
                    }
                    
                    // Skip if already seen or already have position
                    if (activePositions.has(tokenAddress)) return;
                    if (seenTokens.has(tokenAddress)) return;
                    
                    // Mark as seen immediately
                    seenTokens.add(tokenAddress);
                    
                    // Keep set manageable
                    if (seenTokens.size > 500) {
                        const first = seenTokens.values().next().value;
                        seenTokens.delete(first);
                    }
                    
                    // Get token name/symbol for logging and filtering
                    const tokenName = parsed.name || parsed.symbol || 'PumpToken';
                    const tokenSymbol = parsed.symbol || '';
                    
                    // CHECK KEYWORD FILTER
                    if (config.keywordFilterEnabled && config.sniperKeywords) {
                        if (!matchesKeywordFilter(tokenName, tokenSymbol, config.sniperKeywords)) {
                            log(`⏭️ Skipping ${tokenName} - doesn't match keywords`, 'info');
                            return;
                        }
                        log(`✅ ${tokenName} matches keyword filter!`, 'success');
                    }
                    
                    // INSTANT DETECTION!
                    log('', 'info');
                    log('═══════════════════════════════════════════', 'error');
                    log('🟢⚡ NEW PUMP.FUN TOKEN! ⚡🟢', 'error');
                    log('═══════════════════════════════════════════', 'error');
                    log(`🪙 ${tokenName} (${tokenSymbol})`, 'info');
                    log(`🔗 https://pump.fun/${tokenAddress}`, 'info');
                    
                    // Execute buy with token data
                    const tokenData = {
                        platform: 'pumpfun',
                        name: parsed.name,
                        symbol: parsed.symbol,
                        marketCapSol: parsed.marketCapSol,
                        marketCapUsd: parsed.usdMarketCap || (parsed.marketCapSol ? parsed.marketCapSol * 200 : 0),
                        vSolInBondingCurve: parsed.vSolInBondingCurve,
                        uri: parsed.uri
                    };
                    
                    await executeBuy(tokenAddress, tokenName, tokenData);
                }
            } catch (e) {
                // Silently ignore parse errors
            }
        });
        
        pumpWebSocket.on('error', (error) => {
            log(`⚠️ Pump.fun WebSocket error: ${error.message}`, 'warning');
        });
        
        pumpWebSocket.on('close', () => {
            // Reconnect with exponential backoff
            if (isRunning && (config.platform === 'pumpfun' || config.platform === 'both')) {
                wsReconnectAttempts++;
                const delay = Math.min(wsReconnectAttempts * 5000, 30000);
                log(`🔄 Pump.fun reconnecting in ${delay/1000}s...`, 'warning');
                setTimeout(connectPumpFunWebSocket, delay);
            }
        });
        
    } catch (e) {
        log(`⚠️ Pump.fun WebSocket unavailable: ${e.message}`, 'warning');
    }
}

function connectLetsBonkWebSocket() {
    if (bonkWebSocket && bonkWebSocket.readyState === WebSocket.OPEN) {
        return;
    }
    
    log('🔌 Connecting to LetsBonk WebSocket...', 'info');
    
    try {
        // LetsBonk uses the same PumpPortal API
        bonkWebSocket = new WebSocket('wss://pumpportal.fun/api/data');
        
        bonkWebSocket.on('open', () => {
            wsConnected = true;
            log('✅ Connected to LetsBonk (PumpPortal)!', 'success');
            
            // Subscribe to new token events - LetsBonk tokens also come through PumpPortal
            bonkWebSocket.send(JSON.stringify({
                method: "subscribeNewToken"
            }));
            
            log('🟠 Listening for NEW LetsBonk tokens...', 'warning');
        });
        
        bonkWebSocket.on('message', async (data) => {
            if (!isRunning) return;
            
            try {
                const parsed = JSON.parse(data.toString());
                
                // Check for LetsBonk tokens (they have different characteristics)
                if (parsed.mint || parsed.token) {
                    const tokenAddress = parsed.mint || parsed.token;
                    if (!tokenAddress) return;
                    
                    // CHECK PLATFORM SELECTION - Only process if user selected letsbonk or both
                    const selectedPlatform = config.platform || 'pumpfun';
                    if (selectedPlatform !== 'letsbonk' && selectedPlatform !== 'both') {
                        // User only wants Pump.fun, skip letsbonk tokens
                        return;
                    }
                    
                    // Determine if this is a LetsBonk token (not ending in 'pump')
                    const isPumpFunToken = tokenAddress.toLowerCase().endsWith('pump');
                    
                    // If this looks like a pump.fun token, skip it (handled by pump websocket)
                    if (isPumpFunToken) {
                        return; // Already handled by pumpfun websocket
                    }
                    
                    // Skip if already seen
                    if (activePositions.has(tokenAddress)) return;
                    if (seenTokens.has(tokenAddress)) return;
                    
                    seenTokens.add(tokenAddress);
                    
                    if (seenTokens.size > 500) {
                        const first = seenTokens.values().next().value;
                        seenTokens.delete(first);
                    }
                    
                    // Get token name/symbol for logging and filtering
                    const tokenName = parsed.name || parsed.symbol || 'BonkToken';
                    const tokenSymbol = parsed.symbol || '';
                    
                    // CHECK KEYWORD FILTER
                    if (config.keywordFilterEnabled && config.sniperKeywords) {
                        if (!matchesKeywordFilter(tokenName, tokenSymbol, config.sniperKeywords)) {
                            log(`⏭️ Skipping ${tokenName} - doesn't match keywords`, 'info');
                            return;
                        }
                        log(`✅ ${tokenName} matches keyword filter!`, 'success');
                    }
                    
                    // INSTANT DETECTION!
                    log('', 'info');
                    log('═══════════════════════════════════════════', 'warning');
                    log('🟠⚡ NEW LETSBONK TOKEN! ⚡🟠', 'warning');
                    log('═══════════════════════════════════════════', 'warning');
                    log(`🪙 ${tokenName} (${tokenSymbol})`, 'info');
                    log(`🔗 https://letsbonk.fun/${tokenAddress}`, 'info');
                    
                    const tokenData = {
                        platform: 'letsbonk',
                        name: parsed.name,
                        symbol: parsed.symbol,
                        marketCapSol: parsed.marketCapSol,
                        marketCapUsd: parsed.usdMarketCap || (parsed.marketCapSol ? parsed.marketCapSol * 200 : 0),
                        vSolInBondingCurve: parsed.vSolInBondingCurve,
                        uri: parsed.uri
                    };
                    
                    await executeBuy(tokenAddress, tokenName, tokenData);
                }
            } catch (e) {
                // Silently ignore
            }
        });
        
        bonkWebSocket.on('error', (error) => {
            log(`⚠️ LetsBonk WebSocket error: ${error.message}`, 'warning');
        });
        
        bonkWebSocket.on('close', () => {
            if (isRunning && (config.platform === 'letsbonk' || config.platform === 'both')) {
                const delay = Math.min(wsReconnectAttempts * 5000, 30000);
                log(`🔄 LetsBonk reconnecting in ${delay/1000}s...`, 'warning');
                setTimeout(connectLetsBonkWebSocket, delay);
            }
        });
        
    } catch (e) {
        log(`⚠️ LetsBonk WebSocket unavailable: ${e.message}`, 'warning');
    }
}

// ═══════════════════════════════════════════════════════════════
// BACKUP: API POLLING (if WebSocket fails)
// ═══════════════════════════════════════════════════════════════

async function checkForNewTokens() {
    if (!isRunning) return;
    
    // If WebSocket is connected, don't poll
    if (wsConnected) return;
    
    try {
        const response = await axios.get(
            'https://api.dexscreener.com/token-profiles/latest/v1',
            { timeout: 10000 }
        );
        
        if (!response.data || !Array.isArray(response.data)) return;
        
        // Filter for pump.fun tokens
        const pumpTokens = response.data.filter(t => 
            t.chainId === 'solana' && 
            t.tokenAddress?.toLowerCase().endsWith('pump')
        );
        
        for (const token of pumpTokens) {
            const address = token.tokenAddress;
            if (!address) continue;
            
            // Skip if already seen
            if (seenTokens.has(address)) continue;
            if (activePositions.has(address)) continue;
            
            seenTokens.add(address);
            
            // Keep set manageable
            if (seenTokens.size > 1000) {
                const first = seenTokens.values().next().value;
                seenTokens.delete(first);
            }
            
            // NEW TOKEN FOUND!
            const tokenName = token.description?.split(' ')[0] || 'New Token';
            log('🚨 NEW PUMP.FUN TOKEN!', 'warning');
            log(`   Address: ${address.slice(0, 12)}...${address.slice(-8)}`, 'info');
            
            // Execute buy
            await executeBuy(address, tokenName);
        }
        
    } catch (error) {
        // Silently handle errors
    }
}

// ═══════════════════════════════════════════════════════════════
// TRADING - BUY (via Pump Portal bonding curve)
// ═══════════════════════════════════════════════════════════════

async function executeBuy(tokenAddress, tokenName, tokenData = {}) {
    const platform = tokenData.platform || 'pumpfun';
    const platformEmoji = platform === 'letsbonk' ? '🟠' : '🟢';
    const platformName = platform === 'letsbonk' ? 'LETSBONK' : 'PUMP.FUN';
    const platformUrl = platform === 'letsbonk' ? 'letsbonk.fun' : 'pump.fun';
    
    log(``, 'info');
    log(`${platformEmoji} NEW ${platformName} TOKEN DETECTED!`, 'warning');
    log(`   🪙 ${tokenName}`, 'info');
    log(`   📍 ${tokenAddress.slice(0, 12)}...${tokenAddress.slice(-8)}`, 'info');
    log(`   🔗 https://${platformUrl}/${tokenAddress}`, 'info');
    
    // Get market cap - from WebSocket data or fetch from API
    let marketCapUSD = tokenData.marketCapUsd || 0;
    let marketCapSOL = tokenData.marketCapSol || 0;
    
    // If we have SOL market cap but not USD, estimate it
    if (marketCapSOL > 0 && marketCapUSD === 0) {
        marketCapUSD = marketCapSOL * 200; // Rough estimate at ~$200/SOL
    }
    
    // Try to get market cap from pump.fun API if still missing
    if (marketCapUSD === 0) {
        try {
            log(`   📊 Fetching market cap...`, 'info');
            const pumpData = await getPumpFunPrice(tokenAddress);
            if (pumpData && pumpData.marketCap > 0) {
                marketCapUSD = pumpData.marketCap;
            }
        } catch (e) {
            // Continue without market cap data
        }
    }
    
    // Log market cap info
    if (marketCapUSD > 0) {
        log(`   💎 Market Cap: $${Math.round(marketCapUSD).toLocaleString()}`, 'info');
    } else {
        log(`   💎 Market Cap: Unknown (new token)`, 'info');
    }
    
    if (tokenData.vSolInBondingCurve) {
        log(`   🔄 Bonding Curve: ${tokenData.vSolInBondingCurve.toFixed(2)} SOL`, 'info');
    }
    
    // CHECK MINIMUM MARKET CAP FILTER
    const minMarketCap = config.minMarketCap || 0;
    
    if (minMarketCap > 0) {
        if (marketCapUSD > 0 && marketCapUSD < minMarketCap) {
            log(``, 'warning');
            log(`⏭️ SKIPPING - Market cap too low!`, 'warning');
            log(`   Market Cap: $${Math.round(marketCapUSD).toLocaleString()}`, 'warning');
            log(`   Your Minimum: $${minMarketCap.toLocaleString()}`, 'warning');
            log(`   Token needs to reach $${minMarketCap.toLocaleString()} first`, 'info');
            return;
        } else if (marketCapUSD >= minMarketCap) {
            log(`   ✅ Market Cap OK: $${Math.round(marketCapUSD).toLocaleString()} >= $${minMarketCap.toLocaleString()}`, 'success');
        } else {
            // Market cap unknown but filter is set - skip for safety
            log(`   ⚠️ Market cap unknown, filter is $${minMarketCap.toLocaleString()} - SKIPPING for safety`, 'warning');
            return;
        }
    } else {
        log(`   ℹ️ No market cap filter (buying all new tokens)`, 'info');
    }
    
    log(``, 'info');
    log(`🚀 EXECUTING INSTANT BUY ON BONDING CURVE...`, 'warning');
    log(`   Platform: ${platformName}`, 'info');
    log(`   Token: ${tokenName}`, 'info');
    log(`   Amount: ${config.buyAmount} SOL`, 'info');
    
    try {
        // Use Pump Portal for bonding curve trading
        log(`   🎯 Using Pump Portal (bonding curve)...`, 'info');
        
        const response = await axios.post(
            'https://pumpportal.fun/api/trade-local',
            {
                publicKey: wallet.publicKey.toString(),
                action: 'buy',
                mint: tokenAddress,
                amount: config.buyAmount,
                denominatedInSol: 'true',
                slippage: config.maxSlippage || 15,
                priorityFee: config.priorityFee || 0.005,
                pool: 'pump'
            },
            {
                timeout: 20000,
                headers: { 'Content-Type': 'application/json' },
                responseType: 'arraybuffer'
            }
        );
        
        if (response.data) {
            log(`   ✅ Got transaction from Pump Portal!`, 'success');
            
            // Deserialize and sign
            const txBuffer = Buffer.from(response.data);
            const transaction = VersionedTransaction.deserialize(txBuffer);
            transaction.sign([wallet]);
            
            log(`   📤 Sending to blockchain...`, 'info');
            const signature = await connection.sendRawTransaction(
                transaction.serialize(),
                { skipPreflight: true, maxRetries: 3 }
            );
            
            log(`📤 TX sent: ${signature.slice(0, 20)}...`, 'success');
            log(`🔗 https://solscan.io/tx/${signature}`, 'info');
            
            // Confirm
            log(`   Confirming...`, 'info');
            const confirmation = await connection.confirmTransaction(signature, 'confirmed');
            
            if (confirmation.value.err) {
                throw new Error('Transaction failed on chain');
            }
            
            // SUCCESS!
            totalBuys++;
            log(`✅ PUMP.FUN BUY SUCCESS!`, 'success');
            log(`   Spent: ${config.buyAmount} SOL`, 'success');
            
            // Get initial token price
            let initialPrice = 0;
            try {
                const priceData = await getPumpFunPrice(tokenAddress);
                if (priceData && priceData.price > 0) {
                    initialPrice = priceData.price;
                    log(`   📊 Initial price: ${initialPrice.toFixed(12)} SOL per token`, 'info');
                }
            } catch (e) {}
            
            // Track position with trailing profit strategy
            activePositions.set(tokenAddress, {
                tokenAddress,
                tokenName,
                buyPriceSOL: config.buyAmount,
                initialPrice: initialPrice,
                buyTime: Date.now(),
                buySignature: signature,
                currentMultiplier: 1,
                highestMultiplier: 1,
                partialSold: false,
                trailingStop: TRAILING_CONFIG.trailingStopAfterPartial,
                status: 'holding'
            });
            
            log(`   Monitoring for ${TRAILING_CONFIG.partialSellTarget}x partial exit...`, 'info');
            log(`   🛑 Stop loss: ${config.stopLoss}%`, 'info');
            
            updateStats();
            
            // Start checking position immediately (after 5 seconds)
            setTimeout(() => {
                if (activePositions.has(tokenAddress)) {
                    checkPositions();
                }
            }, 5000);
        }
        
    } catch (error) {
        const errorMsg = error.response?.data ? 
            Buffer.from(error.response.data).toString() : 
            error.message;
        log(`❌ BUY FAILED: ${errorMsg}`, 'error');
        log(`   🔗 Manual: https://pump.fun/${tokenAddress}`, 'info');
    }
}

// ═══════════════════════════════════════════════════════════════
// TRADING - PARTIAL SELL (for trailing profit strategy)
// ═══════════════════════════════════════════════════════════════

async function executePartialSell(tokenAddress, position, sellPercent) {
    log(`💎 EXECUTING PARTIAL SELL (${sellPercent}%)...`, 'warning');
    log(`   Token: ${position.tokenName}`, 'info');
    
    try {
        const response = await axios.post(
            'https://pumpportal.fun/api/trade-local',
            {
                publicKey: wallet.publicKey.toString(),
                action: 'sell',
                mint: tokenAddress,
                amount: `${sellPercent}%`,
                denominatedInSol: 'false',
                slippage: config.maxSlippage || 15,
                priorityFee: config.priorityFee || 0.005,
                pool: 'pump'
            },
            {
                timeout: 20000,
                headers: { 'Content-Type': 'application/json' },
                responseType: 'arraybuffer'
            }
        );
        
        if (response.data) {
            log(`   ✅ Got partial sell transaction!`, 'success');
            
            const txBuffer = Buffer.from(response.data);
            const transaction = VersionedTransaction.deserialize(txBuffer);
            transaction.sign([wallet]);
            
            const signature = await connection.sendRawTransaction(
                transaction.serialize(),
                { skipPreflight: true, maxRetries: 3 }
            );
            
            log(`📤 Partial Sell TX: ${signature.slice(0, 20)}...`, 'success');
            
            const confirmation = await connection.confirmTransaction(signature, 'confirmed');
            
            if (confirmation.value.err) {
                throw new Error('Partial sell failed on chain');
            }
            
            // Calculate partial profit
            const partialProfit = position.buyPriceSOL * (position.currentMultiplier - 1) * (sellPercent / 100);
            totalProfitSOL += partialProfit;
            
            log(`✅ PARTIAL SELL SUCCESS!`, 'success');
            log(`   Sold ${sellPercent}% of position`, 'success');
            log(`   💰 Locked profit: +${partialProfit.toFixed(4)} SOL`, 'success');
            log(`   Remaining ${100 - sellPercent}% still riding!`, 'info');
            
            position.partialSellSignature = signature;
            updateStats();
        }
    } catch (error) {
        log(`⚠️ Partial sell failed: ${error.message}`, 'warning');
    }
}

// ═══════════════════════════════════════════════════════════════
// TRADING - FULL SELL
// ═══════════════════════════════════════════════════════════════

async function executeSell(tokenAddress, position, sellPercent = 100) {
    log(`💎 SELLING ${position.tokenName} (${sellPercent}%)...`, 'warning');
    
    try {
        const response = await axios.post(
            'https://pumpportal.fun/api/trade-local',
            {
                publicKey: wallet.publicKey.toString(),
                action: 'sell',
                mint: tokenAddress,
                amount: `${sellPercent}%`,
                denominatedInSol: 'false',
                slippage: config.maxSlippage || 15,
                priorityFee: config.priorityFee || 0.005,
                pool: 'pump'
            },
            {
                timeout: 20000,
                headers: { 'Content-Type': 'application/json' },
                responseType: 'arraybuffer'
            }
        );
        
        if (response.data) {
            const txBuffer = Buffer.from(response.data);
            const transaction = VersionedTransaction.deserialize(txBuffer);
            transaction.sign([wallet]);
            
            const signature = await connection.sendRawTransaction(
                transaction.serialize(),
                { skipPreflight: true, maxRetries: 3 }
            );
            
            log(`📤 Sell TX: ${signature.slice(0, 20)}...`, 'success');
            
            const confirmation = await connection.confirmTransaction(signature, 'confirmed');
            
            if (confirmation.value.err) {
                throw new Error('Sell failed on chain');
            }
            
            // Calculate profit
            const profit = position.buyPriceSOL * (position.currentMultiplier - 1) * (sellPercent / 100);
            totalProfitSOL += profit;
            totalSells++;
            
            if (profit > 0) winningTrades++;
            
            log(`✅ SELL SUCCESS!`, 'success');
            log(`   Profit: ${profit >= 0 ? '+' : ''}${profit.toFixed(4)} SOL`, profit >= 0 ? 'success' : 'error');
            log(`   🎉 Position closed!`, 'success');
            
            if (sellPercent === 100) {
                activePositions.delete(tokenAddress);
            } else {
                position.partialSold = true;
                position.remainingPercent = 100 - sellPercent;
            }
            
            updateStats();
        }
        
    } catch (error) {
        log(`❌ SELL FAILED: ${error.message}`, 'error');
    }
}

// ═══════════════════════════════════════════════════════════════
// PRICE MONITORING (with trailing profit strategy)
// ═══════════════════════════════════════════════════════════════

// Get current price for bonding curve tokens via pump.fun API
async function getPumpFunPrice(tokenAddress) {
    try {
        const response = await axios.get(
            `https://frontend-api.pump.fun/coins/${tokenAddress}`,
            { 
                timeout: 10000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'application/json',
                    'Origin': 'https://pump.fun',
                    'Referer': 'https://pump.fun/'
                }
            }
        );
        
        if (response.data) {
            const token = response.data;
            const virtualSolReserves = parseFloat(token.virtual_sol_reserves || 30) / 1e9;
            const virtualTokenReserves = parseFloat(token.virtual_token_reserves || 1000000000) / 1e6;
            const currentPrice = virtualSolReserves / virtualTokenReserves;
            const marketCap = token.usd_market_cap || 0;
            
            return { 
                price: currentPrice, 
                marketCap,
                complete: token.complete || false,
                bondingCurve: true
            };
        }
    } catch (error) {
        // Token might have graduated to DEX
        return null;
    }
    return null;
}

async function checkPositions() {
    if (activePositions.size === 0) return;
    
    log(`📊 Checking ${activePositions.size} position(s)...`, 'info');
    
    for (const [tokenAddress, position] of activePositions) {
        if (position.status !== 'holding') continue;
        
        let currentPriceSOL = 0;
        let priceSource = '';
        
        try {
            // First try pump.fun API (for bonding curve tokens)
            const pumpData = await getPumpFunPrice(tokenAddress);
            
            if (pumpData && pumpData.price > 0) {
                currentPriceSOL = pumpData.price;
                priceSource = pumpData.complete ? 'Graduated' : 'Bonding Curve';
            } else {
                // Fallback to DexScreener (for graduated tokens)
                const response = await axios.get(
                    `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`,
                    { timeout: 8000 }
                );
                
                if (response.data?.pairs?.length > 0) {
                    const pair = response.data.pairs[0];
                    currentPriceSOL = parseFloat(pair.priceNative) || 0;
                    priceSource = 'DEX';
                }
            }
            
            if (currentPriceSOL > 0) {
                const initialPrice = position.initialPrice || currentPriceSOL;
                if (!position.initialPrice) position.initialPrice = currentPriceSOL;
                
                position.currentMultiplier = currentPriceSOL / initialPrice;
                position.hasLiquidity = true;
                
                // Track highest
                if (position.currentMultiplier > position.highestMultiplier) {
                    position.highestMultiplier = position.currentMultiplier;
                }
                
                const profitPercent = ((position.currentMultiplier - 1) * 100).toFixed(1);
                const statusInfo = position.partialSold ? 
                    `🏃 Trailing (High: ${position.highestMultiplier.toFixed(2)}x)` : 
                    `📈 ${priceSource}`;
                
                log(`   ${position.tokenName}: ${position.currentMultiplier.toFixed(2)}x (${profitPercent >= 0 ? '+' : ''}${profitPercent}%) | ${statusInfo}`, 
                    position.currentMultiplier >= 1 ? 'success' : 'warning');
                
                // ═══════════════════════════════════════════════════════════════
                // TRAILING PROFIT STRATEGY
                // ═══════════════════════════════════════════════════════════════
                
                // STEP 1: At 6x, take partial profit (sell 66%, keep 34% running)
                if (!position.partialSold && position.currentMultiplier >= TRAILING_CONFIG.partialSellTarget) {
                    log('', 'success');
                    log(`🎯💰 PARTIAL PROFIT TARGET (${TRAILING_CONFIG.partialSellTarget}x) REACHED!`, 'success');
                    log(`   ${position.tokenName} hit ${position.currentMultiplier.toFixed(2)}x`, 'success');
                    log(`   Taking ${TRAILING_CONFIG.partialSellPercent}% profit, letting ${100 - TRAILING_CONFIG.partialSellPercent}% ride!`, 'success');
                    
                    position.partialSold = true;
                    position.partialSoldAt = position.currentMultiplier;
                    position.remainingPercent = 100 - TRAILING_CONFIG.partialSellPercent;
                    position.trailingStop = TRAILING_CONFIG.trailingStopAfterPartial;
                    
                    await executePartialSell(tokenAddress, position, TRAILING_CONFIG.partialSellPercent);
                }
                
                // STEP 2: After partial sell, if drops back to 2x, sell remaining
                if (position.partialSold && position.currentMultiplier <= position.trailingStop) {
                    log('', 'warning');
                    log(`🔔 TRAILING STOP HIT!`, 'warning');
                    log(`   ${position.tokenName} dropped to ${position.currentMultiplier.toFixed(2)}x`, 'warning');
                    log(`   Trailing stop was at: ${position.trailingStop.toFixed(2)}x`, 'info');
                    log(`   Selling remaining ${position.remainingPercent}%...`, 'warning');
                    await executeSell(tokenAddress, position, 100);
                }
                
                // STEP 3: Update trailing stop as price goes higher (after partial sell)
                if (position.partialSold && position.currentMultiplier > position.highestMultiplier * 0.9) {
                    const newTrailingStop = Math.max(
                        position.trailingStop,
                        position.currentMultiplier * 0.5
                    );
                    if (newTrailingStop > position.trailingStop) {
                        position.trailingStop = newTrailingStop;
                        log(`   📈 Trailing stop moved up to ${position.trailingStop.toFixed(2)}x`, 'info');
                    }
                }
                
                // ═══════════════════════════════════════════════════════════════
                // STOP LOSS (before any profit taken)
                // ═══════════════════════════════════════════════════════════════
                
                const stopLossMultiplier = 1 - (config.stopLoss / 100);
                if (!position.partialSold && position.currentMultiplier <= stopLossMultiplier) {
                    log('', 'error');
                    log(`🛑 STOP LOSS TRIGGERED!`, 'error');
                    log(`   ${position.tokenName} dropped to ${position.currentMultiplier.toFixed(2)}x`, 'error');
                    log(`   Auto-selling to limit losses...`, 'warning');
                    await executeSell(tokenAddress, position, 100);
                }
            }
            
        } catch (error) {
            // Silently handle - token might not have price data yet
            log(`   ⏳ ${position.tokenName}: Waiting for price data...`, 'info');
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// PUBLIC API
// ═══════════════════════════════════════════════════════════════

async function start(userConfig, onLog, onStats) {
    config = userConfig;
    logCallback = onLog;
    statsCallback = onStats;
    
    // Update trailing config from user settings
    TRAILING_CONFIG = {
        partialSellTarget: config.partialSellTarget || 6.0,
        partialSellPercent: config.partialSellPercent || 66,
        trailingStopAfterPartial: config.trailingStopMultiplier || 2.0,
        initialStopLoss: (100 - config.stopLoss) / 100 || 0.5
    };
    
    log('═══════════════════════════════════════════', 'info');
    log('⚡ ZOOT AUTO SNIPER BOT - STARTING', 'warning');
    log('═══════════════════════════════════════════', 'info');
    
    // Setup wallet
    await setupWallet(config.privateKey);
    
    // Setup connection
    await setupConnection(config.rpcUrl);
    
    // Show platform selection
    const platform = config.platform || 'pumpfun';
    log('', 'info');
    log('🎯 PLATFORM SELECTION:', 'warning');
    if (platform === 'pumpfun') {
        log('   🟢 PUMP.FUN - Sniping pump.fun bonding curve tokens', 'success');
    } else if (platform === 'letsbonk') {
        log('   🟠 LETSBONK - Sniping letsbonk.fun tokens', 'warning');
    } else if (platform === 'both') {
        log('   🔥 BOTH PLATFORMS - Sniping pump.fun AND letsbonk.fun!', 'error');
    }
    log('📡 DETECTION: PumpPortal WebSocket (INSTANT)', 'info');
    log('', 'info');
    log('📊 TRADING SETTINGS:', 'info');
    log(`   💰 Buy Amount: ${config.buyAmount} SOL per token`, 'info');
    log(`   ⚡ Priority Fee: ${config.priorityFee || 0.005} SOL`, 'info');
    log(`   🔄 Max Slippage: ${config.maxSlippage || 15}%`, 'info');
    log(`   📊 Min Market Cap: ${config.minMarketCap > 0 ? '$' + config.minMarketCap.toLocaleString() : 'OFF (buy all)'}`, 'info');
    log(`   🛑 Stop Loss: ${config.stopLoss}% (auto-sell if drops)`, 'info');
    log(`   📈 Take Profit: ${config.takeProfit || 2.0}x target`, 'info');
    log('', 'info');
    log('🎯 PROFIT TAKING STRATEGY:', 'warning');
    log(`   At ${TRAILING_CONFIG.partialSellTarget}x → Sell ${TRAILING_CONFIG.partialSellPercent}% of position`, 'info');
    log(`   Remaining ${100 - TRAILING_CONFIG.partialSellPercent}% → Trailing stop at ${TRAILING_CONFIG.trailingStopAfterPartial}x`, 'info');
    log('', 'info');
    
    // Show keyword filter status
    if (config.keywordFilterEnabled && config.sniperKeywords) {
        log('🔍 KEYWORD FILTER: ENABLED', 'warning');
        log(`   Keywords: ${config.sniperKeywords}`, 'info');
        log(`   Only buying tokens matching these keywords!`, 'info');
    } else {
        log('🔍 KEYWORD FILTER: OFF (buying ALL new tokens)', 'info');
    }
    log('', 'info');
    
    isRunning = true;
    
    // Connect WebSocket for INSTANT detection
    connectWebSocket();
    
    // Initial token scan (mark existing as seen)
    try {
        log('📡 Scanning existing tokens...', 'info');
        const response = await axios.get(
            'https://api.dexscreener.com/token-profiles/latest/v1',
            { timeout: 10000 }
        );
        if (response.data && Array.isArray(response.data)) {
            const pumpTokens = response.data.filter(t => 
                t.chainId === 'solana' && 
                t.tokenAddress?.toLowerCase().endsWith('pump')
            );
            for (const token of pumpTokens) {
                if (token.tokenAddress) seenTokens.add(token.tokenAddress);
            }
            log(`   ✅ Marked ${pumpTokens.length} existing tokens`, 'info');
        }
    } catch (e) {}
    
    log('', 'success');
    log('═══════════════════════════════════════════', 'success');
    log('🚀 BOT RUNNING - LIVE TRADING ACTIVE!', 'success');
    log('═══════════════════════════════════════════', 'success');
    log('', 'info');
    if (platform === 'pumpfun') {
        log('👀 Watching for NEW pump.fun tokens...', 'warning');
    } else if (platform === 'letsbonk') {
        log('👀 Watching for NEW letsbonk.fun tokens...', 'warning');
    } else {
        log('👀 Watching BOTH pump.fun AND letsbonk.fun!', 'warning');
    }
    log('⚡ WebSocket: INSTANT detection at launch!', 'info');
    log('🎯 Trading via Pump Portal bonding curve', 'info');
    
    // Start monitoring loops
    // Backup polling (only if WebSocket fails)
    tokenCheckInterval = setInterval(checkForNewTokens, 5000);
    
    // Check positions every 10 seconds for faster sell triggers
    positionCheckInterval = setInterval(checkPositions, 10000);
    
    // Status update every minute
    statusInterval = setInterval(() => {
        if (isRunning) {
            const wsStatus = wsConnected ? '🟢 WebSocket' : '🟡 Polling';
            log(`${wsStatus} | Positions: ${activePositions.size} | P&L: ${totalProfitSOL >= 0 ? '+' : ''}${totalProfitSOL.toFixed(4)} SOL`, 'info');
            updateStats();
        }
    }, 60000);
    
    updateStats();
}

async function stop() {
    log('', 'warning');
    log('═══════════════════════════════════════════', 'warning');
    log('⏹️ STOPPING BOT...', 'warning');
    log('═══════════════════════════════════════════', 'warning');
    
    isRunning = false;
    
    // Close WebSockets
    if (pumpWebSocket) {
        pumpWebSocket.close();
        pumpWebSocket = null;
    }
    if (bonkWebSocket) {
        bonkWebSocket.close();
        bonkWebSocket = null;
    }
    wsConnected = false;
    
    // Clear intervals
    if (tokenCheckInterval) clearInterval(tokenCheckInterval);
    if (positionCheckInterval) clearInterval(positionCheckInterval);
    if (statusInterval) clearInterval(statusInterval);
    
    log(`📊 Final Stats: ${totalBuys} buys | ${totalSells} sells | P&L: ${totalProfitSOL.toFixed(4)} SOL`, 'info');
    
    // Reset
    tokenCheckInterval = null;
    positionCheckInterval = null;
    statusInterval = null;
}

async function getBalance() {
    if (!wallet || !connection) {
        return { balance: 0 };
    }
    
    try {
        const balance = await connection.getBalance(wallet.publicKey);
        return { balance: balance / LAMPORTS_PER_SOL };
    } catch (error) {
        return { balance: 0, error: error.message };
    }
}

// ═══════════════════════════════════════════════════════════════
// QUICK BUY - Manual token purchase by CA
// ═══════════════════════════════════════════════════════════════

async function quickBuy(tokenAddress, userConfig, onLog) {
    // Set up logging for this quick buy
    const quickLog = (message, type = 'info') => {
        if (onLog) {
            onLog({ message, type, timestamp: Date.now() });
        }
        console.log(`[QuickBuy] ${message}`);
    };
    
    quickLog(`🚀 QUICK BUY: ${tokenAddress}`, 'warning');
    
    try {
        // Setup wallet if not already done
        if (!wallet) {
            const secretKey = parsePrivateKey(userConfig.privateKey);
            wallet = Keypair.fromSecretKey(secretKey);
            quickLog(`✅ Wallet loaded: ${wallet.publicKey.toString().slice(0, 8)}...`, 'success');
        }
        
        // Setup connection if not already done
        if (!connection) {
            const rpcUrl = userConfig.rpcUrl || 'https://api.mainnet-beta.solana.com';
            connection = new Connection(rpcUrl, 'confirmed');
            quickLog(`✅ Connected to RPC`, 'success');
        }
        
        const buyAmount = userConfig.buyAmount || 0.1;
        const slippage = userConfig.maxSlippage || 15;
        const priorityFee = userConfig.priorityFee || 0.005;
        
        quickLog(`💰 Buying ${buyAmount} SOL worth...`, 'info');
        
        // First, check if token is on bonding curve or graduated
        let isOnBondingCurve = true;
        let tokenName = 'Unknown Token';
        
        try {
            quickLog(`🔍 Checking token status...`, 'info');
            const pumpData = await getPumpFunPrice(tokenAddress);
            if (pumpData) {
                isOnBondingCurve = !pumpData.complete;
                quickLog(`📈 Status: ${isOnBondingCurve ? 'Bonding Curve' : 'Graduated to Raydium'}`, 'info');
            }
        } catch (e) {
            quickLog(`⚠️ Could not check token status, trying bonding curve first...`, 'warning');
        }
        
        // Try bonding curve first (pool: pump)
        let response;
        let usedPool = 'pump';
        
        try {
            quickLog(`🚀 Trying ${isOnBondingCurve ? 'Bonding Curve' : 'Raydium'} buy...`, 'info');
            response = await axios.post(
                'https://pumpportal.fun/api/trade-local',
                {
                    publicKey: wallet.publicKey.toString(),
                    action: 'buy',
                    mint: tokenAddress,
                    amount: buyAmount,
                    denominatedInSol: 'true',
                    slippage: slippage,
                    priorityFee: priorityFee,
                    pool: isOnBondingCurve ? 'pump' : 'raydium'
                },
                {
                    timeout: 20000,
                    headers: { 'Content-Type': 'application/json' },
                    responseType: 'arraybuffer'
                }
            );
            usedPool = isOnBondingCurve ? 'pump' : 'raydium';
        } catch (firstError) {
            // If first attempt failed, try the other pool
            const altPool = isOnBondingCurve ? 'raydium' : 'pump';
            quickLog(`⚠️ ${isOnBondingCurve ? 'Bonding curve' : 'Raydium'} failed, trying ${altPool}...`, 'warning');
            
            response = await axios.post(
                'https://pumpportal.fun/api/trade-local',
                {
                    publicKey: wallet.publicKey.toString(),
                    action: 'buy',
                    mint: tokenAddress,
                    amount: buyAmount,
                    denominatedInSol: 'true',
                    slippage: slippage,
                    priorityFee: priorityFee,
                    pool: altPool
                },
                {
                    timeout: 20000,
                    headers: { 'Content-Type': 'application/json' },
                    responseType: 'arraybuffer'
                }
            );
            usedPool = altPool;
        }
        
        if (response.data) {
            quickLog(`✅ Got transaction from ${usedPool === 'pump' ? 'Bonding Curve' : 'Raydium'}!`, 'success');
            
            // Deserialize and sign
            const txBuffer = Buffer.from(response.data);
            const transaction = VersionedTransaction.deserialize(txBuffer);
            transaction.sign([wallet]);
            
            quickLog(`📤 Sending to blockchain...`, 'info');
            const signature = await connection.sendRawTransaction(
                transaction.serialize(),
                { skipPreflight: true, maxRetries: 3 }
            );
            
            quickLog(`📤 TX sent: ${signature.slice(0, 20)}...`, 'success');
            quickLog(`🔗 https://solscan.io/tx/${signature}`, 'info');
            
            // Confirm
            quickLog(`⏳ Confirming...`, 'info');
            const confirmation = await connection.confirmTransaction(signature, 'confirmed');
            
            if (confirmation.value.err) {
                throw new Error('Transaction failed on chain');
            }
            
            quickLog(`✅ QUICK BUY SUCCESS!`, 'success');
            quickLog(`🔗 https://pump.fun/${tokenAddress}`, 'info');
            
            // Track position if bot is running
            if (isRunning) {
                let initialPrice = 0;
                try {
                    const priceData = await getPumpFunPrice(tokenAddress);
                    if (priceData && priceData.price > 0) {
                        initialPrice = priceData.price;
                    }
                } catch (e) {}
                
                activePositions.set(tokenAddress, {
                    tokenAddress,
                    tokenName: 'QuickBuy Token',
                    buyPriceSOL: buyAmount,
                    initialPrice: initialPrice,
                    buyTime: Date.now(),
                    buySignature: signature,
                    currentMultiplier: 1,
                    highestMultiplier: 1,
                    partialSold: false,
                    trailingStop: TRAILING_CONFIG.trailingStopAfterPartial,
                    status: 'holding'
                });
                
                quickLog(`📊 Position tracked for auto-sell`, 'info');
            }
            
            return { success: true, signature };
        }
        
        return { success: false, error: 'No response from Pump Portal' };
        
    } catch (error) {
        let errorMsg = error.response?.data ? 
            Buffer.from(error.response.data).toString() : 
            error.message;
        
        quickLog(`⚠️ Pump Portal failed: ${errorMsg}`, 'warning');
        
        // If Pump Portal failed, try Jupiter as fallback
        if (errorMsg.includes('Bad Request') || error.response?.status === 400) {
            quickLog(``, 'info');
            quickLog(`🪐 Token not on pump.fun - trying JUPITER...`, 'warning');
            
            const jupiterResult = await jupiterBuy(tokenAddress, buyAmount, slippage, quickLog);
            
            if (jupiterResult.success) {
                // Track position if bot is running
                if (isRunning) {
                    activePositions.set(tokenAddress, {
                        tokenAddress,
                        tokenName: 'Jupiter Token',
                        buyPriceSOL: buyAmount,
                        initialPrice: 0,
                        buyTime: Date.now(),
                        buySignature: jupiterResult.signature,
                        currentMultiplier: 1,
                        highestMultiplier: 1,
                        partialSold: false,
                        trailingStop: TRAILING_CONFIG.trailingStopAfterPartial,
                        status: 'holding',
                        source: 'jupiter'
                    });
                    quickLog(`📊 Position tracked for monitoring`, 'info');
                }
                return jupiterResult;
            } else {
                quickLog(`❌ Jupiter also failed: ${jupiterResult.error}`, 'error');
                quickLog(`💡 Check if token address is correct: https://solscan.io/token/${tokenAddress}`, 'info');
                return { success: false, error: `Pump Portal and Jupiter both failed. Token may not exist or have no liquidity.` };
            }
        } else if (errorMsg.includes('insufficient') || errorMsg.includes('balance')) {
            quickLog(`💡 You need more SOL in your wallet`, 'info');
            return { success: false, error: 'Insufficient SOL balance' };
        }
        
        return { success: false, error: errorMsg };
    }
}

// ═══════════════════════════════════════════════════════════════
// QUICK SELL - Manual token sell by CA
// ═══════════════════════════════════════════════════════════════

async function quickSell(tokenAddress, sellPercent, userConfig, onLog) {
    const quickLog = (message, type = 'info') => {
        if (onLog) {
            onLog({ message, type, timestamp: Date.now() });
        }
        console.log(`[QuickSell] ${message}`);
    };
    
    quickLog(`💸 QUICK SELL: ${tokenAddress}`, 'warning');
    quickLog(`📊 Selling ${sellPercent}% of holdings`, 'info');
    
    try {
        // Setup wallet if not already done
        if (!wallet) {
            const secretKey = parsePrivateKey(userConfig.privateKey);
            wallet = Keypair.fromSecretKey(secretKey);
            quickLog(`✅ Wallet loaded: ${wallet.publicKey.toString().slice(0, 8)}...`, 'success');
        }
        
        // Setup connection if not already done
        if (!connection) {
            const rpcUrl = userConfig.rpcUrl || 'https://api.mainnet-beta.solana.com';
            connection = new Connection(rpcUrl, 'confirmed');
            quickLog(`✅ Connected to RPC`, 'success');
        }
        
        const slippage = userConfig.maxSlippage || 15;
        const priorityFee = userConfig.priorityFee || 0.005;
        
        // Check if token is on bonding curve or graduated
        let isOnBondingCurve = true;
        try {
            const pumpData = await getPumpFunPrice(tokenAddress);
            if (pumpData) {
                isOnBondingCurve = !pumpData.complete;
                quickLog(`📈 Status: ${isOnBondingCurve ? 'Bonding Curve' : 'Graduated to Raydium'}`, 'info');
            }
        } catch (e) {}
        
        // Try appropriate pool first, then fallback
        let response;
        let usedPool = isOnBondingCurve ? 'pump' : 'raydium';
        
        try {
            quickLog(`🔄 Trying ${usedPool === 'pump' ? 'Bonding Curve' : 'Raydium'} sell...`, 'info');
            response = await axios.post(
                'https://pumpportal.fun/api/trade-local',
                {
                    publicKey: wallet.publicKey.toString(),
                    action: 'sell',
                    mint: tokenAddress,
                    amount: `${sellPercent}%`,
                    denominatedInSol: 'false',
                    slippage: slippage,
                    priorityFee: priorityFee,
                    pool: usedPool
                },
                {
                    timeout: 20000,
                    headers: { 'Content-Type': 'application/json' },
                    responseType: 'arraybuffer'
                }
            );
        } catch (firstError) {
            // Try the other pool
            const altPool = usedPool === 'pump' ? 'raydium' : 'pump';
            quickLog(`⚠️ ${usedPool} failed, trying ${altPool}...`, 'warning');
            
            response = await axios.post(
                'https://pumpportal.fun/api/trade-local',
                {
                    publicKey: wallet.publicKey.toString(),
                    action: 'sell',
                    mint: tokenAddress,
                    amount: `${sellPercent}%`,
                    denominatedInSol: 'false',
                    slippage: slippage,
                    priorityFee: priorityFee,
                    pool: altPool
                },
                {
                    timeout: 20000,
                    headers: { 'Content-Type': 'application/json' },
                    responseType: 'arraybuffer'
                }
            );
            usedPool = altPool;
        }
        
        if (response.data) {
            quickLog(`✅ Got sell transaction from ${usedPool === 'pump' ? 'Bonding Curve' : 'Raydium'}!`, 'success');
            
            // Deserialize and sign
            const txBuffer = Buffer.from(response.data);
            const transaction = VersionedTransaction.deserialize(txBuffer);
            transaction.sign([wallet]);
            
            quickLog(`📤 Sending to blockchain...`, 'info');
            const signature = await connection.sendRawTransaction(
                transaction.serialize(),
                { skipPreflight: true, maxRetries: 3 }
            );
            
            quickLog(`📤 TX sent: ${signature.slice(0, 20)}...`, 'success');
            quickLog(`🔗 https://solscan.io/tx/${signature}`, 'info');
            
            // Confirm
            quickLog(`⏳ Confirming...`, 'info');
            const confirmation = await connection.confirmTransaction(signature, 'confirmed');
            
            if (confirmation.value.err) {
                throw new Error('Transaction failed on chain');
            }
            
            quickLog(`✅ QUICK SELL SUCCESS!`, 'success');
            quickLog(`💰 Sold ${sellPercent}% of tokens`, 'success');
            
            // Remove from active positions if 100% sold
            if (sellPercent === 100 && activePositions.has(tokenAddress)) {
                activePositions.delete(tokenAddress);
                quickLog(`📊 Position removed from tracking`, 'info');
            }
            
            return { success: true, signature };
        }
        
        return { success: false, error: 'No response from Pump Portal' };
        
    } catch (error) {
        const errorMsg = error.response?.data ? 
            Buffer.from(error.response.data).toString() : 
            error.message;
        quickLog(`⚠️ Pump Portal failed: ${errorMsg}`, 'warning');
        
        // If Pump Portal failed, try Jupiter as fallback
        if (errorMsg.includes('Bad Request') || errorMsg.includes('no tokens') || error.response?.status === 400) {
            quickLog(``, 'info');
            quickLog(`🪐 Token not on pump.fun - trying JUPITER...`, 'warning');
            
            const jupiterResult = await jupiterSell(tokenAddress, sellPercent, slippage, quickLog);
            
            if (jupiterResult.success) {
                // Remove from active positions if 100% sold
                if (sellPercent === 100 && activePositions.has(tokenAddress)) {
                    activePositions.delete(tokenAddress);
                    quickLog(`📊 Position removed from tracking`, 'info');
                }
                return jupiterResult;
            } else {
                quickLog(`❌ Jupiter also failed: ${jupiterResult.error}`, 'error');
                return { success: false, error: `Pump Portal and Jupiter both failed. You may not have any tokens to sell.` };
            }
        }
        
        return { success: false, error: errorMsg };
    }
}

// ═══════════════════════════════════════════════════════════════
// JUPITER SWAP - Buy/Sell ANY Solana token
// ═══════════════════════════════════════════════════════════════

const SOL_MINT = 'So11111111111111111111111111111111111111112';

async function jupiterBuy(tokenAddress, solAmount, slippageBps, quickLog) {
    quickLog(`🪐 JUPITER: Buying ${solAmount} SOL worth of token...`, 'warning');
    
    try {
        // Convert SOL to lamports
        const inputAmount = Math.floor(solAmount * LAMPORTS_PER_SOL);
        
        // Get quote from Jupiter
        quickLog(`📊 Getting Jupiter quote...`, 'info');
        const quoteResponse = await axios.get(
            `https://quote-api.jup.ag/v6/quote?inputMint=${SOL_MINT}&outputMint=${tokenAddress}&amount=${inputAmount}&slippageBps=${slippageBps * 100}`,
            { timeout: 15000 }
        );
        
        if (!quoteResponse.data || quoteResponse.data.error) {
            throw new Error(quoteResponse.data?.error || 'Failed to get Jupiter quote');
        }
        
        const quote = quoteResponse.data;
        const expectedOutput = quote.outAmount / Math.pow(10, quote.outputDecimals || 6);
        quickLog(`✅ Quote: ~${expectedOutput.toLocaleString()} tokens for ${solAmount} SOL`, 'success');
        
        // Get swap transaction
        quickLog(`🔄 Building swap transaction...`, 'info');
        const swapResponse = await axios.post(
            'https://quote-api.jup.ag/v6/swap',
            {
                quoteResponse: quote,
                userPublicKey: wallet.publicKey.toString(),
                wrapAndUnwrapSol: true,
                dynamicComputeUnitLimit: true,
                prioritizationFeeLamports: 'auto'
            },
            { 
                timeout: 20000,
                headers: { 'Content-Type': 'application/json' }
            }
        );
        
        if (!swapResponse.data || !swapResponse.data.swapTransaction) {
            throw new Error('Failed to get swap transaction from Jupiter');
        }
        
        // Deserialize and sign
        const swapTxBuf = Buffer.from(swapResponse.data.swapTransaction, 'base64');
        const transaction = VersionedTransaction.deserialize(swapTxBuf);
        transaction.sign([wallet]);
        
        quickLog(`📤 Sending Jupiter swap to blockchain...`, 'info');
        const signature = await connection.sendRawTransaction(
            transaction.serialize(),
            { skipPreflight: true, maxRetries: 3 }
        );
        
        quickLog(`📤 TX sent: ${signature.slice(0, 20)}...`, 'success');
        quickLog(`🔗 https://solscan.io/tx/${signature}`, 'info');
        
        // Confirm
        quickLog(`⏳ Confirming...`, 'info');
        const confirmation = await connection.confirmTransaction(signature, 'confirmed');
        
        if (confirmation.value.err) {
            throw new Error('Jupiter swap failed on chain');
        }
        
        quickLog(`✅ JUPITER BUY SUCCESS!`, 'success');
        return { success: true, signature };
        
    } catch (error) {
        const errorMsg = error.response?.data?.error || error.message;
        quickLog(`❌ Jupiter buy failed: ${errorMsg}`, 'error');
        return { success: false, error: errorMsg };
    }
}

async function jupiterSell(tokenAddress, sellPercent, slippageBps, quickLog) {
    quickLog(`🪐 JUPITER: Selling ${sellPercent}% of tokens...`, 'warning');
    
    try {
        // First, get token balance
        quickLog(`📊 Getting token balance...`, 'info');
        
        const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
            wallet.publicKey,
            { mint: new PublicKey(tokenAddress) }
        );
        
        if (tokenAccounts.value.length === 0) {
            throw new Error('No tokens found in wallet');
        }
        
        const tokenAccount = tokenAccounts.value[0];
        const balance = tokenAccount.account.data.parsed.info.tokenAmount;
        const totalAmount = parseInt(balance.amount);
        const decimals = balance.decimals;
        
        if (totalAmount === 0) {
            throw new Error('Token balance is zero');
        }
        
        // Calculate sell amount
        const sellAmount = Math.floor(totalAmount * (sellPercent / 100));
        quickLog(`💰 Selling ${sellAmount / Math.pow(10, decimals)} tokens (${sellPercent}%)`, 'info');
        
        // Get quote from Jupiter
        quickLog(`📊 Getting Jupiter quote...`, 'info');
        const quoteResponse = await axios.get(
            `https://quote-api.jup.ag/v6/quote?inputMint=${tokenAddress}&outputMint=${SOL_MINT}&amount=${sellAmount}&slippageBps=${slippageBps * 100}`,
            { timeout: 15000 }
        );
        
        if (!quoteResponse.data || quoteResponse.data.error) {
            throw new Error(quoteResponse.data?.error || 'Failed to get Jupiter quote');
        }
        
        const quote = quoteResponse.data;
        const expectedSol = quote.outAmount / LAMPORTS_PER_SOL;
        quickLog(`✅ Quote: ~${expectedSol.toFixed(4)} SOL for your tokens`, 'success');
        
        // Get swap transaction
        quickLog(`🔄 Building swap transaction...`, 'info');
        const swapResponse = await axios.post(
            'https://quote-api.jup.ag/v6/swap',
            {
                quoteResponse: quote,
                userPublicKey: wallet.publicKey.toString(),
                wrapAndUnwrapSol: true,
                dynamicComputeUnitLimit: true,
                prioritizationFeeLamports: 'auto'
            },
            { 
                timeout: 20000,
                headers: { 'Content-Type': 'application/json' }
            }
        );
        
        if (!swapResponse.data || !swapResponse.data.swapTransaction) {
            throw new Error('Failed to get swap transaction from Jupiter');
        }
        
        // Deserialize and sign
        const swapTxBuf = Buffer.from(swapResponse.data.swapTransaction, 'base64');
        const transaction = VersionedTransaction.deserialize(swapTxBuf);
        transaction.sign([wallet]);
        
        quickLog(`📤 Sending Jupiter swap to blockchain...`, 'info');
        const signature = await connection.sendRawTransaction(
            transaction.serialize(),
            { skipPreflight: true, maxRetries: 3 }
        );
        
        quickLog(`📤 TX sent: ${signature.slice(0, 20)}...`, 'success');
        quickLog(`🔗 https://solscan.io/tx/${signature}`, 'info');
        
        // Confirm
        quickLog(`⏳ Confirming...`, 'info');
        const confirmation = await connection.confirmTransaction(signature, 'confirmed');
        
        if (confirmation.value.err) {
            throw new Error('Jupiter swap failed on chain');
        }
        
        quickLog(`✅ JUPITER SELL SUCCESS!`, 'success');
        quickLog(`💰 Received ~${expectedSol.toFixed(4)} SOL`, 'success');
        return { success: true, signature };
        
    } catch (error) {
        const errorMsg = error.response?.data?.error || error.message;
        quickLog(`❌ Jupiter sell failed: ${errorMsg}`, 'error');
        return { success: false, error: errorMsg };
    }
}

// ═══════════════════════════════════════════════════════════════
// TOKEN LOOKUP - Get token details
// ═══════════════════════════════════════════════════════════════

async function lookupToken(tokenAddress) {
    try {
        let tokenData = {
            name: 'Unknown',
            symbol: 'UNKNOWN',
            image: null,
            marketCap: 0,
            price: 0,
            liquidity: 0,
            status: 'Unknown',
            bondingCurveProgress: 0
        };
        
        console.log(`[Lookup] Looking up token: ${tokenAddress}`);
        
        // Fetch data from MULTIPLE sources in PARALLEL (including Bitquery)
        const [dexResult, pumpResult, bitqueryResult, imageResult] = await Promise.allSettled([
            // DexScreener (best for traded tokens)
            axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, { timeout: 5000 }),
            
            // Pump.fun (for new pump tokens)
            axios.get(`https://frontend-api.pump.fun/coins/${tokenAddress}`, { 
                timeout: 5000,
                headers: { 'User-Agent': 'Mozilla/5.0' }
            }),
            
            // Bitquery (accurate bonding curve data)
            fetchPumpFunFromBitquery(tokenAddress),
            
            // Parallel image fetch from all sources
            fetchTokenIcon(tokenAddress)
        ]);
        
        // Set image from parallel fetch
        if (imageResult.status === 'fulfilled' && imageResult.value) {
            tokenData.image = imageResult.value;
            console.log(`[Lookup] Got image: ${tokenData.image.substring(0, 50)}...`);
        }
        
        // Process Bitquery data FIRST (most accurate for pump.fun)
        if (bitqueryResult.status === 'fulfilled' && bitqueryResult.value?.success) {
            const bqData = bitqueryResult.value;
            tokenData.name = bqData.name || tokenData.name;
            tokenData.symbol = bqData.symbol || tokenData.symbol;
            tokenData.marketCap = bqData.marketCap || tokenData.marketCap;
            tokenData.price = bqData.priceUSD || tokenData.price;
            tokenData.liquidity = bqData.liquidity || tokenData.liquidity;
            tokenData.bondingCurveProgress = bqData.bondingCurveProgress || 0;
            tokenData.status = bqData.graduated ? 'Graduated' : `Bonding ${Math.round(bqData.bondingCurveProgress)}%`;
            console.log(`[Lookup] Bitquery: ${tokenData.name}, MC: $${tokenData.marketCap}, Bonding: ${tokenData.bondingCurveProgress}%`);
        }
        
        // Process DexScreener data (best for graduated/traded tokens)
        if (dexResult.status === 'fulfilled' && dexResult.value?.data?.pairs?.length > 0) {
            const pair = dexResult.value.data.pairs[0];
            
            // DexScreener overrides for traded tokens (more accurate)
            if (pair.fdv > tokenData.marketCap || tokenData.name === 'Unknown') {
                tokenData.name = pair.baseToken?.name || tokenData.name;
                tokenData.symbol = pair.baseToken?.symbol || tokenData.symbol;
                tokenData.marketCap = pair.fdv || pair.marketCap || tokenData.marketCap;
                tokenData.price = parseFloat(pair.priceUsd) || tokenData.price;
                tokenData.liquidity = pair.liquidity?.usd || tokenData.liquidity;
                tokenData.status = 'On DEX';
            }
            
            // Use DexScreener image if better quality
            if (pair.info?.imageUrl) {
                tokenData.image = pair.info.imageUrl;
            }
            console.log(`[Lookup] DexScreener: ${tokenData.name}, MC: $${tokenData.marketCap}`);
        }
        
        // Process Pump.fun data (for image and fallback data)
        if (pumpResult.status === 'fulfilled' && pumpResult.value?.data) {
            const data = pumpResult.value.data;
            
            // Only use pump.fun data if we don't have better data
            if (tokenData.name === 'Unknown') {
                tokenData.name = data.name || tokenData.name;
                tokenData.symbol = data.symbol || tokenData.symbol;
                tokenData.marketCap = data.usd_market_cap || tokenData.marketCap;
                tokenData.status = data.complete ? 'Graduated' : 'Bonding Curve';
                
                // Calculate price and liquidity
                if (data.virtual_sol_reserves && data.virtual_token_reserves) {
                    const solReserves = parseFloat(data.virtual_sol_reserves) / 1e9;
                    const tokenReserves = parseFloat(data.virtual_token_reserves) / 1e6;
                    if (tokenReserves > 0) {
                        tokenData.price = (solReserves / tokenReserves) * 200;
                    }
                }
                tokenData.liquidity = (parseFloat(data.virtual_sol_reserves || 0) / 1e9) * 200;
            }
            
            // Use pump.fun image if we don't have one
            if (!tokenData.image && data.image_uri) {
                tokenData.image = convertIpfsUrl(data.image_uri);
            }
            console.log(`[Lookup] Pump.fun: ${tokenData.name}, MC: $${tokenData.marketCap}`);
        }
        
        // Final image fallback
        if (!tokenData.image) {
            tokenData.image = getDexScreenerImageUrl(tokenAddress);
            console.log(`[Lookup] Using DexScreener CDN fallback for image`);
        }
        
        // FETCH ADVANCED DATA: Holder count, dev wallet %, volume, whale activity
        try {
            const [holderResult, volumeResult] = await Promise.allSettled([
                getTokenHolders(tokenAddress),
                getVolumeData(tokenAddress)
            ]);
            
            // Add holder data
            if (holderResult.status === 'fulfilled' && holderResult.value) {
                tokenData.holderCount = holderResult.value.holderCount || 0;
                tokenData.devWalletPercent = holderResult.value.devWalletPercent || 0;
                tokenData.topHolders = holderResult.value.topHolders || [];
                console.log(`[Lookup] Holders: ${tokenData.holderCount}, Dev: ${tokenData.devWalletPercent.toFixed(1)}%`);
            }
            
            // Add volume data
            if (volumeResult.status === 'fulfilled' && volumeResult.value) {
                tokenData.volumeSpike = volumeResult.value.volumeSpike || false;
                tokenData.buyPressure = volumeResult.value.buyPressure || 50;
                tokenData.volume24h = volumeResult.value.volume24h || 0;
                tokenData.buys = volumeResult.value.buys || 0;
                tokenData.sells = volumeResult.value.sells || 0;
                if (tokenData.volumeSpike) {
                    console.log(`[Lookup] Volume spike detected! Buy pressure: ${tokenData.buyPressure}%`);
                }
            }
        } catch (advancedErr) {
            console.log(`[Lookup] Advanced data fetch failed: ${advancedErr.message}`);
        }
        
        const success = tokenData.name !== 'Unknown' || tokenData.marketCap > 0;
        console.log(`[Lookup] Complete: ${tokenData.name} (${tokenData.symbol}), Image: ${tokenData.image ? 'YES' : 'NO'}, Holders: ${tokenData.holderCount || 'N/A'}`);
        return { success, data: tokenData };
        
    } catch (error) {
        console.log(`[Lookup] Error: ${error.message}`);
        return { success: false, error: error.message, data: { 
            name: 'Unknown', 
            symbol: 'UNKNOWN', 
            image: getDexScreenerImageUrl(tokenAddress),
            marketCap: 0, 
            price: 0, 
            liquidity: 0, 
            status: 'Unknown' 
        }};
    }
}

// ═══════════════════════════════════════════════════════════════
// GET POSITIONS - Return active positions from bot + wallet holdings
// ═══════════════════════════════════════════════════════════════

async function getPositions() {
    try {
        const positions = [];
        
        // First add bot's active positions
        for (const [tokenAddress, pos] of activePositions) {
            positions.push({
                tokenAddress,
                tokenName: pos.tokenName || 'Unknown Token',
                buyPriceSOL: pos.buyPriceSOL || 0,
                currentMultiplier: pos.currentMultiplier || 1,
                highestMultiplier: pos.highestMultiplier || 1,
                status: pos.status || 'holding',
                buyTime: pos.buyTime,
                partialSold: pos.partialSold || false
            });
        }
        
        return { positions };
    } catch (error) {
        return { positions: [], error: error.message };
    }
}

// ═══════════════════════════════════════════════════════════════
// GET WALLET HOLDINGS - Get actual token holdings from wallet
// ═══════════════════════════════════════════════════════════════

async function getWalletHoldings(userConfig) {
    try {
        if (!userConfig.privateKey) {
            return { success: false, holdings: [], error: 'No wallet configured' };
        }
        
        const conn = new Connection(userConfig.rpcUrl || 'https://api.mainnet-beta.solana.com', 'confirmed');
        const walletKeypair = Keypair.fromSecretKey(bs58.decode(userConfig.privateKey));
        const walletPubkey = walletKeypair.publicKey;
        
        // Get all token accounts for this wallet
        const tokenAccounts = await conn.getParsedTokenAccountsByOwner(walletPubkey, {
            programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA')
        });
        
        const holdings = [];
        
        for (const { account, pubkey } of tokenAccounts.value) {
            const tokenData = account.data.parsed.info;
            const balance = tokenData.tokenAmount.uiAmount;
            
            // Only show tokens with balance > 0
            if (balance > 0) {
                const mintAddress = tokenData.mint;
                
                // Try to get token info
                let tokenName = 'Unknown';
                let tokenSymbol = mintAddress.slice(0, 6) + '...';
                let marketCap = 0;
                let currentMultiplier = 1;
                
                try {
                    // Try pump.fun first
                    const pumpRes = await axios.get(`https://frontend-api.pump.fun/coins/${mintAddress}`, { timeout: 5000 });
                    if (pumpRes.data) {
                        tokenName = pumpRes.data.name || tokenName;
                        tokenSymbol = pumpRes.data.symbol || tokenSymbol;
                        marketCap = pumpRes.data.usd_market_cap || 0;
                    }
                } catch (e) {
                    // Try DexScreener
                    try {
                        const dexRes = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${mintAddress}`, { timeout: 5000 });
                        if (dexRes.data?.pairs?.[0]) {
                            const pair = dexRes.data.pairs[0];
                            tokenName = pair.baseToken?.name || tokenName;
                            tokenSymbol = pair.baseToken?.symbol || tokenSymbol;
                            marketCap = pair.marketCap || 0;
                        }
                    } catch (e2) {
                        // Ignore errors, use defaults
                    }
                }
                
                holdings.push({
                    tokenAddress: mintAddress,
                    tokenName,
                    tokenSymbol,
                    balance,
                    marketCap,
                    currentMultiplier,
                    status: 'holding'
                });
            }
        }
        
        return { success: true, holdings };
    } catch (error) {
        log(`❌ Failed to get holdings: ${error.message}`, 'error');
        return { success: false, holdings: [], error: error.message };
    }
}

// ═══════════════════════════════════════════════════════════════
// KEYWORD FILTER HELPER
// ═══════════════════════════════════════════════════════════════

function matchesKeywordFilter(tokenName, tokenSymbol, keywords) {
    if (!keywords || keywords.trim() === '') {
        return true; // No filter, allow all
    }
    
    const keywordList = keywords.toLowerCase().split(',').map(k => k.trim()).filter(k => k.length > 0);
    
    if (keywordList.length === 0) {
        return true; // No valid keywords, allow all
    }
    
    const name = (tokenName || '').toLowerCase();
    const symbol = (tokenSymbol || '').toLowerCase();
    
    for (const keyword of keywordList) {
        if (name.includes(keyword) || symbol.includes(keyword)) {
            return true;
        }
    }
    
    return false;
}

// ═══════════════════════════════════════════════════════════════
// BUNDLE TRADING FUNCTIONS
// ═══════════════════════════════════════════════════════════════

async function generateWallets(count) {
    try {
        const { Keypair } = require('@solana/web3.js');
        const bs58 = require('bs58');
        
        const wallets = [];
        
        for (let i = 0; i < count; i++) {
            const keypair = Keypair.generate();
            wallets.push({
                publicKey: keypair.publicKey.toString(),
                privateKey: bs58.encode(keypair.secretKey),
                balance: '0.0000'
            });
        }
        
        log(`✅ Generated ${count} new wallets`);
        return { success: true, wallets };
    } catch (error) {
        log(`❌ Failed to generate wallets: ${error.message}`, 'error');
        return { success: false, error: error.message };
    }
}

async function getBundleWalletBalances(walletAddresses) {
    try {
        const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
        
        const connection = new Connection(config.rpcUrl || 'https://api.mainnet-beta.solana.com', 'confirmed');
        const balances = [];
        
        for (const address of walletAddresses) {
            try {
                const balance = await connection.getBalance(new PublicKey(address));
                balances.push(balance / LAMPORTS_PER_SOL);
            } catch (e) {
                balances.push(0);
            }
        }
        
        return { success: true, balances };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function fundBundleWallets(walletAddresses, amount, userConfig) {
    try {
        const { Connection, Keypair, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
        const bs58 = require('bs58');
        
        if (!userConfig.privateKey) {
            return { success: false, error: 'No main wallet configured' };
        }
        
        const connection = new Connection(userConfig.rpcUrl || 'https://api.mainnet-beta.solana.com', 'confirmed');
        const mainWallet = Keypair.fromSecretKey(bs58.decode(userConfig.privateKey));
        
        let funded = 0;
        const lamports = Math.floor(amount * LAMPORTS_PER_SOL);
        
        for (const address of walletAddresses) {
            try {
                const transaction = new Transaction().add(
                    SystemProgram.transfer({
                        fromPubkey: mainWallet.publicKey,
                        toPubkey: new PublicKey(address),
                        lamports: lamports
                    })
                );
                
                await sendAndConfirmTransaction(connection, transaction, [mainWallet]);
                funded++;
                log(`💸 Funded wallet ${address.slice(0, 8)}... with ${amount} SOL`);
            } catch (e) {
                log(`❌ Failed to fund ${address.slice(0, 8)}...: ${e.message}`, 'error');
            }
        }
        
        return { success: true, funded };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function collectBundleFunds(wallets, userConfig) {
    try {
        const { Connection, Keypair, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction, LAMPORTS_PER_SOL } = require('@solana/web3.js');
        const bs58 = require('bs58');
        
        if (!userConfig.privateKey) {
            return { success: false, error: 'No main wallet configured' };
        }
        
        const connection = new Connection(userConfig.rpcUrl || 'https://api.mainnet-beta.solana.com', 'confirmed');
        const mainWallet = Keypair.fromSecretKey(bs58.decode(userConfig.privateKey));
        
        let totalCollected = 0;
        let walletsCollected = 0;
        
        for (const wallet of wallets) {
            try {
                const bundleWallet = Keypair.fromSecretKey(bs58.decode(wallet.privateKey));
                const balance = await connection.getBalance(bundleWallet.publicKey);
                
                // Leave some for fees (0.001 SOL)
                const toTransfer = balance - 5000;
                
                if (toTransfer > 0) {
                    const transaction = new Transaction().add(
                        SystemProgram.transfer({
                            fromPubkey: bundleWallet.publicKey,
                            toPubkey: mainWallet.publicKey,
                            lamports: toTransfer
                        })
                    );
                    
                    await sendAndConfirmTransaction(connection, transaction, [bundleWallet]);
                    totalCollected += toTransfer / LAMPORTS_PER_SOL;
                    walletsCollected++;
                    log(`🏦 Collected ${(toTransfer / LAMPORTS_PER_SOL).toFixed(4)} SOL from ${wallet.publicKey.slice(0, 8)}...`);
                }
            } catch (e) {
                log(`❌ Failed to collect from ${wallet.publicKey.slice(0, 8)}...: ${e.message}`, 'error');
            }
        }
        
        return { success: true, totalCollected: totalCollected.toFixed(4), walletsCollected };
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function bundleBuy(tokenAddress, amount, privateKey, userConfig) {
    try {
        const { Keypair } = require('@solana/web3.js');
        const bs58 = require('bs58');
        
        // Create temporary config with bundle wallet's private key
        const bundleConfig = {
            ...userConfig,
            privateKey: privateKey,
            buyAmountSOL: amount
        };
        
        // Use quickBuy with the bundle wallet's config
        return await quickBuy(tokenAddress, bundleConfig);
    } catch (error) {
        return { success: false, error: error.message };
    }
}

async function bundleSell(tokenAddress, percent, privateKey, userConfig) {
    try {
        // Create temporary config with bundle wallet's private key
        const bundleConfig = {
            ...userConfig,
            privateKey: privateKey
        };
        
        // Use quickSell with the bundle wallet's config
        return await quickSell(tokenAddress, percent, bundleConfig);
    } catch (error) {
        return { success: false, error: error.message };
    }
}

// ═══════════════════════════════════════════════════════════════
// LIVE FEED SYSTEM
// ═══════════════════════════════════════════════════════════════

let liveFeedWs = null;
let liveFeedCallback = null;
let liveFeedPlatform = 'both';
let liveFeedMinMcap = 1000;

/**
 * Convert IPFS URLs to accessible gateway URLs
 * Uses ipfs.io as the primary gateway (confirmed working)
 */
function convertIpfsUrl(url) {
    if (!url) return null;
    
    // Extract IPFS CID from any URL format and use ipfs.io
    const extractCid = (str) => {
        // Match IPFS CIDs (Qm... for v0, bafy... for v1)
        const cidMatch = str.match(/(?:\/ipfs\/|ipfs:\/\/|^)(Qm[a-zA-Z0-9]{44,}|bafy[a-zA-Z0-9]{50,})/);
        return cidMatch ? cidMatch[1] : null;
    };
    
    // Check for IPFS content in URL
    const cid = extractCid(url);
    if (cid) {
        return `https://ipfs.io/ipfs/${cid}`;
    }
    
    // Already a regular HTTP/HTTPS URL without IPFS
    if (url.startsWith('http://') || url.startsWith('https://')) {
        // Replace any cf-ipfs, cloudflare-ipfs URLs with ipfs.io for reliability
        if (url.includes('cf-ipfs.com') || url.includes('cloudflare-ipfs.com') || 
            url.includes('ipfs.pump.fun') || url.includes('nftstorage.link')) {
            const hashMatch = url.match(/\/ipfs\/([a-zA-Z0-9]+)/);
            if (hashMatch && hashMatch[1]) {
                return `https://ipfs.io/ipfs/${hashMatch[1]}`;
            }
        }
        return url;
    }
    
    // IPFS protocol URL
    if (url.startsWith('ipfs://')) {
        const hash = url.replace('ipfs://', '').split('/')[0].split('?')[0];
        return `https://ipfs.io/ipfs/${hash}`;
    }
    
    // Just an IPFS hash
    if (url.startsWith('Qm') || url.startsWith('bafy')) {
        return `https://ipfs.io/ipfs/${url}`;
    }
    
    // Arweave URLs - leave as-is, they work
    if (url.includes('arweave.net')) {
        return url;
    }
    
    return url;
}

// Icon cache to avoid re-fetching
const iconCache = new Map();

// Helius API Key for reliable token metadata
const HELIUS_API_KEY = 'a577d3c7-c842-4639-b388-ab1924777eae';
const HELIUS_RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_API_KEY}`;

// ═══════════════════════════════════════════════════════════════
// ADVANCED TOKEN SAFETY CHECKS
// ═══════════════════════════════════════════════════════════════

/**
 * Get token holder count and top holders info
 * @param {string} tokenAddress - Token mint address
 * @returns {Promise<{holderCount: number, topHolders: Array, devWalletPercent: number}>}
 */
async function getTokenHolders(tokenAddress) {
    try {
        // Use Helius DAS API for holder info
        const response = await axios.post(HELIUS_RPC_URL, {
            jsonrpc: '2.0',
            id: 'holder-check',
            method: 'getTokenAccounts',
            params: {
                mint: tokenAddress,
                limit: 20,
                displayOptions: {
                    showZeroBalance: false
                }
            }
        }, { timeout: 5000 });
        
        if (response.data?.result?.token_accounts) {
            const accounts = response.data.result.token_accounts;
            const holderCount = accounts.length;
            
            // Calculate top holder percentages
            let totalSupply = 0;
            accounts.forEach(acc => {
                totalSupply += parseFloat(acc.amount) || 0;
            });
            
            const topHolders = accounts.slice(0, 5).map(acc => ({
                address: acc.owner,
                balance: parseFloat(acc.amount) || 0,
                percent: totalSupply > 0 ? ((parseFloat(acc.amount) || 0) / totalSupply) * 100 : 0
            }));
            
            // Dev wallet is usually the top holder in new tokens
            const devWalletPercent = topHolders[0]?.percent || 0;
            
            return { holderCount, topHolders, devWalletPercent };
        }
        
        // Fallback: Try Solana FM API
        const sfmResp = await axios.get(`https://api.solana.fm/v1/tokens/${tokenAddress}/holders`, {
            timeout: 5000
        });
        
        if (sfmResp.data?.data) {
            const holders = sfmResp.data.data;
            return {
                holderCount: holders.length,
                topHolders: holders.slice(0, 5).map(h => ({
                    address: h.owner,
                    percent: h.percentage || 0
                })),
                devWalletPercent: holders[0]?.percentage || 0
            };
        }
    } catch (e) {
        console.log(`Holder check failed: ${e.message}`);
    }
    
    return { holderCount: 0, topHolders: [], devWalletPercent: 0 };
}

/**
 * Check token safety: mint authority, freeze authority, etc.
 * @param {string} tokenAddress - Token mint address
 * @returns {Promise<{isSafe: boolean, warnings: Array}>}
 */
async function checkTokenSafety(tokenAddress) {
    const warnings = [];
    let isSafe = true;
    
    try {
        // Use Helius to get mint info
        const response = await axios.post(HELIUS_RPC_URL, {
            jsonrpc: '2.0',
            id: 'safety-check',
            method: 'getAsset',
            params: { id: tokenAddress }
        }, { timeout: 5000 });
        
        if (response.data?.result) {
            const asset = response.data.result;
            
            // Check mint authority (should be revoked for safe tokens)
            if (asset.authorities?.find(a => a.scopes?.includes('mint'))) {
                warnings.push('⚠️ Mint authority NOT revoked');
                isSafe = false;
            }
            
            // Check freeze authority
            if (asset.authorities?.find(a => a.scopes?.includes('freeze'))) {
                warnings.push('⚠️ Freeze authority enabled');
                isSafe = false;
            }
        }
    } catch (e) {
        console.log(`Safety check failed: ${e.message}`);
    }
    
    return { isSafe, warnings };
}

/**
 * Get recent trading volume and detect volume spikes
 * @param {string} tokenAddress - Token mint address  
 * @returns {Promise<{volume24h: number, volumeSpike: boolean, buyPressure: number}>}
 */
async function getVolumeData(tokenAddress) {
    try {
        // Use DexScreener for volume data
        const response = await axios.get(
            `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`,
            { timeout: 5000 }
        );
        
        if (response.data?.pairs?.[0]) {
            const pair = response.data.pairs[0];
            const volume24h = pair.volume?.h24 || 0;
            const volume1h = pair.volume?.h1 || 0;
            const volume5m = pair.volume?.m5 || 0;
            
            // Volume spike = 5m volume is more than 20% of 1h volume
            const volumeSpike = volume1h > 0 && (volume5m / volume1h) > 0.2;
            
            // Buy pressure = buys vs sells ratio
            const buys = pair.txns?.h1?.buys || 0;
            const sells = pair.txns?.h1?.sells || 0;
            const buyPressure = (buys + sells) > 0 ? (buys / (buys + sells)) * 100 : 50;
            
            return {
                volume24h,
                volume1h,
                volume5m,
                volumeSpike,
                buyPressure,
                buys,
                sells
            };
        }
    } catch (e) {
        console.log(`Volume check failed: ${e.message}`);
    }
    
    return { volume24h: 0, volume1h: 0, volume5m: 0, volumeSpike: false, buyPressure: 50, buys: 0, sells: 0 };
}

/**
 * Monitor for whale transactions (large buys)
 * @param {string} tokenAddress - Token mint address
 * @param {number} minSolAmount - Minimum SOL to be considered a whale (default 5 SOL)
 * @returns {Promise<{whaleActivity: boolean, recentWhales: Array}>}
 */
async function checkWhaleActivity(tokenAddress, minSolAmount = 5) {
    try {
        // Use Helius to get recent transactions
        const response = await axios.post(HELIUS_RPC_URL, {
            jsonrpc: '2.0',
            id: 'whale-check',
            method: 'getSignaturesForAsset',
            params: {
                id: tokenAddress,
                limit: 20
            }
        }, { timeout: 5000 });
        
        // Also check DexScreener for large trades
        const dexResp = await axios.get(
            `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`,
            { timeout: 5000 }
        );
        
        if (dexResp.data?.pairs?.[0]) {
            const pair = dexResp.data.pairs[0];
            const liquidity = pair.liquidity?.usd || 0;
            const priceUsd = pair.priceUsd || 0;
            
            // If liquidity is high, whales are likely present
            const whaleActivity = liquidity > 50000;
            
            return {
                whaleActivity,
                liquidityUsd: liquidity,
                recentWhales: []
            };
        }
    } catch (e) {
        console.log(`Whale check failed: ${e.message}`);
    }
    
    return { whaleActivity: false, recentWhales: [] };
}

/**
 * Detect bundle buying patterns (coordinated multi-wallet purchases)
 * This checks for many unique buyers in a short time window
 * @param {string} tokenAddress - Token mint address
 * @returns {Promise<{isBundle: boolean, uniqueBuyers: number, timeWindow: number}>}
 */
async function detectBundleBuying(tokenAddress) {
    try {
        // Use Helius to get recent transactions for this token
        const response = await axios.post(HELIUS_RPC_URL, {
            jsonrpc: '2.0',
            id: 'bundle-detect',
            method: 'getAssetTransfers',
            params: {
                id: tokenAddress,
                limit: 50
            }
        }, { timeout: 8000 });
        
        if (response.data?.result) {
            const transfers = response.data.result;
            const now = Date.now();
            const thirtySecondsAgo = now - 30000;
            
            // Get unique buyers in last 30 seconds
            const recentBuyers = new Set();
            const buyTimestamps = [];
            
            for (const tx of transfers) {
                // Check if this is a buy (token going TO a wallet)
                if (tx.timestamp && tx.timestamp * 1000 > thirtySecondsAgo) {
                    if (tx.toUserAccount) {
                        recentBuyers.add(tx.toUserAccount);
                        buyTimestamps.push(tx.timestamp * 1000);
                    }
                }
            }
            
            // If 5+ unique buyers in 30 seconds, this is likely a bundle
            const isBundle = recentBuyers.size >= 5;
            
            return {
                isBundle,
                uniqueBuyers: recentBuyers.size,
                timeWindow: 30,
                buyersAddresses: Array.from(recentBuyers).slice(0, 10)
            };
        }
        
        // Fallback: Check DexScreener for transaction count
        const dexResp = await axios.get(
            `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`,
            { timeout: 5000 }
        );
        
        if (dexResp.data?.pairs?.[0]) {
            const pair = dexResp.data.pairs[0];
            const buys5m = pair.txns?.m5?.buys || 0;
            
            // If more than 10 buys in 5 minutes with low holders, likely bundle
            const isBundle = buys5m > 10;
            
            return {
                isBundle,
                uniqueBuyers: buys5m,
                timeWindow: 300,
                buyersAddresses: []
            };
        }
    } catch (e) {
        console.log(`Bundle detection failed: ${e.message}`);
    }
    
    return { isBundle: false, uniqueBuyers: 0, timeWindow: 30, buyersAddresses: [] };
}

// Bitquery API for accurate Pump.fun data
const BITQUERY_API_URL = 'https://streaming.bitquery.io/eap';
const BITQUERY_API_KEY = 'BQYd9X0bxlIyTQc5YdxnfUxkPpq2hPVS'; // Free tier key

/**
 * Fetch Pump.fun token data from Bitquery GraphQL API
 * Returns accurate bonding curve progress, market cap, and liquidity
 */
async function fetchPumpFunFromBitquery(tokenAddress) {
    try {
        const query = `
        query GetPumpFunTokenData {
            Solana {
                DEXPools(
                    limit: {count: 1}
                    orderBy: {descending: Block_Slot}
                    where: {
                        Pool: {
                            Market: {
                                BaseCurrency: {
                                    MintAddress: {is: "${tokenAddress}"}
                                }
                            },
                            Dex: {
                                ProgramAddress: {is: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"}
                            }
                        }
                    }
                ) {
                    BondingCurveProgress: calculate(expression: "100 - ((($Pool_Base_Balance - 206900000) * 100) / 793100000)")
                    Pool {
                        Market {
                            MarketAddress
                            BaseCurrency {
                                MintAddress
                                Symbol
                                Name
                            }
                            QuoteCurrency {
                                MintAddress
                                Symbol
                                Name
                            }
                        }
                        Dex {
                            ProtocolFamily
                            ProtocolName
                        }
                        Quote {
                            PostAmount
                            PriceInUSD
                            PostAmountInUSD
                        }
                        Base {
                            Balance: PostAmount
                        }
                    }
                }
            }
        }`;

        const response = await axios.post(BITQUERY_API_URL, 
            { query },
            {
                timeout: 8000,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${BITQUERY_API_KEY}`
                }
            }
        );

        const pools = response.data?.data?.Solana?.DEXPools;
        if (pools && pools.length > 0) {
            const pool = pools[0];
            const bondingProgress = parseFloat(pool.BondingCurveProgress) || 0;
            const priceUSD = parseFloat(pool.Pool?.Quote?.PriceInUSD) || 0;
            const liquidityUSD = parseFloat(pool.Pool?.Quote?.PostAmountInUSD) || 0;
            const quoteAmount = parseFloat(pool.Pool?.Quote?.PostAmount) || 0;
            
            // Calculate market cap: price * total supply (1 billion for pump.fun tokens)
            const totalSupply = 1000000000;
            const marketCap = priceUSD * totalSupply;
            
            return {
                success: true,
                name: pool.Pool?.Market?.BaseCurrency?.Name || 'Unknown',
                symbol: pool.Pool?.Market?.BaseCurrency?.Symbol || '???',
                mintAddress: pool.Pool?.Market?.BaseCurrency?.MintAddress,
                priceUSD: priceUSD,
                marketCap: marketCap,
                liquidity: liquidityUSD,
                liquiditySOL: quoteAmount,
                bondingCurveProgress: bondingProgress,
                graduated: bondingProgress >= 100,
                platform: 'pumpfun',
                dex: pool.Pool?.Dex?.ProtocolName || 'Pump.fun'
            };
        }
        
        return null;
    } catch (error) {
        console.log(`Bitquery API error: ${error.message}`);
        return null;
    }
}

/**
 * Fetch recent Pump.fun launches from Bitquery
 */
async function fetchRecentPumpFunLaunches(limit = 20) {
    try {
        const query = `
        query GetRecentPumpFunLaunches {
            Solana {
                DEXPools(
                    limit: {count: ${limit}}
                    orderBy: {descending: Block_Time}
                    where: {
                        Pool: {
                            Dex: {
                                ProgramAddress: {is: "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"}
                            }
                        }
                    }
                ) {
                    Block {
                        Time
                    }
                    BondingCurveProgress: calculate(expression: "100 - ((($Pool_Base_Balance - 206900000) * 100) / 793100000)")
                    Pool {
                        Market {
                            BaseCurrency {
                                MintAddress
                                Symbol
                                Name
                            }
                        }
                        Quote {
                            PriceInUSD
                            PostAmountInUSD
                        }
                    }
                }
            }
        }`;

        const response = await axios.post(BITQUERY_API_URL,
            { query },
            {
                timeout: 10000,
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${BITQUERY_API_KEY}`
                }
            }
        );

        const pools = response.data?.data?.Solana?.DEXPools;
        if (pools && pools.length > 0) {
            return pools.map(pool => {
                const priceUSD = parseFloat(pool.Pool?.Quote?.PriceInUSD) || 0;
                const totalSupply = 1000000000;
                const marketCap = priceUSD * totalSupply;
                
                return {
                    mint: pool.Pool?.Market?.BaseCurrency?.MintAddress,
                    name: pool.Pool?.Market?.BaseCurrency?.Name || 'Unknown',
                    symbol: pool.Pool?.Market?.BaseCurrency?.Symbol || '???',
                    priceUSD: priceUSD,
                    marketCap: marketCap,
                    liquidity: parseFloat(pool.Pool?.Quote?.PostAmountInUSD) || 0,
                    bondingCurveProgress: parseFloat(pool.BondingCurveProgress) || 0,
                    timestamp: new Date(pool.Block?.Time).getTime() || Date.now(),
                    platform: 'pumpfun'
                };
            });
        }
        
        return [];
    } catch (error) {
        console.log(`Bitquery recent launches error: ${error.message}`);
        return [];
    }
}

/**
 * Get token icon using DexScreener CDN - DIRECT IMAGE URL
 */
function getDexScreenerImageUrl(tokenAddress) {
    return `https://dd.dexscreener.com/ds-data/tokens/solana/${tokenAddress}.png`;
}

/**
 * Fetch token image using Helius DAS API (most reliable - direct blockchain data)
 * Uses Helius CDN for faster loading instead of raw IPFS
 * @param {string} tokenAddress - The token mint address
 * @returns {Promise<string|null>} - The image URL or null
 */
async function fetchImageFromHelius(tokenAddress) {
    try {
        const response = await axios.post(HELIUS_RPC_URL, {
            jsonrpc: '2.0',
            id: 'helius-image',
            method: 'getAsset',
            params: { id: tokenAddress }
        }, { timeout: 5000 });
        
        if (response.data?.result) {
            const asset = response.data.result;
            
            // PRIORITY 1: Helius CDN (fastest - cached images)
            if (asset.content?.files?.[0]?.cdn_uri) {
                return asset.content.files[0].cdn_uri;
            }
            
            // PRIORITY 2: Direct image link
            if (asset.content?.links?.image) {
                const img = asset.content.links.image;
                // Convert to Helius CDN if it's an IPFS URL
                if (img.includes('ipfs')) {
                    return `https://cdn.helius-rpc.com/cdn-cgi/image//${img}`;
                }
                return img;
            }
            
            // PRIORITY 3: First file URI
            if (asset.content?.files?.[0]?.uri) {
                const uri = asset.content.files[0].uri;
                return `https://cdn.helius-rpc.com/cdn-cgi/image//${uri}`;
            }
        }
    } catch (e) {
        console.log(`Helius API error: ${e.message}`);
    }
    return null;
}

/**
 * Fetch token icon from MULTIPLE APIs in PARALLEL
 * Sources: DexScreener CDN (fastest), Helius, DexScreener API, GMGN, Pump.fun, PumpPortal
 * @param {string} tokenAddress - The token mint address
 * @returns {Promise<string|null>} - The icon URL or null
 */
async function fetchTokenIcon(tokenAddress) {
    // Check cache first
    if (iconCache.has(tokenAddress)) {
        return iconCache.get(tokenAddress);
    }
    
    console.log(`[Icon] Fetching icon for ${tokenAddress.slice(0, 8)}...`);
    
    // PRIORITY 1: DexScreener CDN - Direct image URL (fastest, no API call)
    const dexCdnUrl = `https://dd.dexscreener.com/ds-data/tokens/solana/${tokenAddress}.png`;
    
    // Run ALL API calls in PARALLEL - first valid image wins!
    const imagePromises = [
        // API 1: DexScreener CDN direct (fastest - just returns URL to try)
        Promise.resolve(dexCdnUrl),
        
        // API 2: Helius (blockchain metadata - most reliable for new tokens)
        fetchImageFromHelius(tokenAddress).catch(() => null),
        
        // API 3: DexScreener API (for traded tokens with verified images)
        axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, { timeout: 3000 })
            .then(r => r.data?.pairs?.[0]?.info?.imageUrl || null)
            .catch(() => null),
        
        // API 4: GMGN.ai API (reliable public API for Solana tokens)
        axios.get(`https://gmgn.ai/defi/quotation/v1/tokens/sol/${tokenAddress}`, { 
            timeout: 3000,
            headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }
        })
            .then(r => r.data?.data?.token?.logo || r.data?.data?.token?.image || null)
            .catch(() => null),
        
        // API 5: Pump.fun API (for pump tokens)
        axios.get(`https://frontend-api.pump.fun/coins/${tokenAddress}`, { 
            timeout: 3000, 
            headers: { 'User-Agent': 'Mozilla/5.0' } 
        })
            .then(r => r.data?.image_uri ? convertIpfsUrl(r.data.image_uri) : null)
            .catch(() => null),
        
        // API 6: PumpPortal API
        axios.get(`https://pumpportal.fun/api/data/token-info?token=${tokenAddress}`, { timeout: 3000 })
            .then(r => r.data?.image || r.data?.imageUrl || null)
            .catch(() => null),
        
        // API 7: Jupiter Token List
        axios.get(`https://token.jup.ag/strict`, { timeout: 3000 })
            .then(r => {
                const token = r.data?.find(t => t.address === tokenAddress);
                return token?.logoURI || null;
            })
            .catch(() => null),
        
        // API 8: Solana FM
        axios.get(`https://api.solana.fm/v0/tokens/${tokenAddress}`, { timeout: 3000 })
            .then(r => r.data?.tokenList?.image || r.data?.tokenList?.logoURI || null)
            .catch(() => null)
    ];
    
    try {
        // Wait for all to complete, pick first valid
        const results = await Promise.all(imagePromises);
        
        for (const img of results) {
            if (img && typeof img === 'string' && img.length > 10) {
                console.log(`[Icon] Found image: ${img.substring(0, 50)}...`);
                iconCache.set(tokenAddress, img);
                return img;
            }
        }
    } catch (e) {
        console.log(`[Icon] Error: ${e.message}`);
    }
    
    // Final fallback: DexScreener CDN
    const fallbackUrl = getDexScreenerImageUrl(tokenAddress);
    console.log(`[Icon] Using DexScreener CDN fallback`);
    iconCache.set(tokenAddress, fallbackUrl);
    return fallbackUrl;
}

/**
 * Fast icon fetch using Promise.race - returns FIRST successful result
 */
async function fetchTokenIconFast(tokenAddress) {
    // Check cache first
    if (iconCache.has(tokenAddress)) {
        return iconCache.get(tokenAddress);
    }
    
    // Race all APIs - first one with valid image wins!
    const racePromises = [
        // Helius
        fetchImageFromHelius(tokenAddress),
        
        // DexScreener API
        axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`, { timeout: 3000 })
            .then(r => r.data?.pairs?.[0]?.info?.imageUrl || null),
        
        // DexScreener CDN (direct, always available)
        Promise.resolve(getDexScreenerImageUrl(tokenAddress)),
        
        // Pump.fun
        axios.get(`https://frontend-api.pump.fun/coins/${tokenAddress}`, { timeout: 3000, headers: { 'User-Agent': 'Mozilla/5.0' } })
            .then(r => r.data?.image_uri ? convertIpfsUrl(r.data.image_uri) : null)
    ].map(p => p.catch(() => null));
    
    try {
        const results = await Promise.all(racePromises);
        const validImage = results.find(img => img && typeof img === 'string' && img.length > 10);
        
        if (validImage) {
            iconCache.set(tokenAddress, validImage);
            return validImage;
        }
    } catch (e) {}
    
    // Fallback
    return getDexScreenerImageUrl(tokenAddress);
}

/**
 * Analyze token to determine if it's bullish, bearish, or neutral
 * Now includes advanced safety checks!
 */
function analyzeToken(tokenData) {
    let score = 50; // Start at neutral
    const signals = [];
    const warnings = [];
    
    // Market cap analysis
    const mcap = tokenData.marketCap || 0;
    if (mcap >= 50000) {
        score += 15;
        signals.push('High mcap');
    } else if (mcap >= 9000) {
        score += 8;
        signals.push('Good mcap');
    } else if (mcap < 3000) {
        score -= 10;
        signals.push('Low mcap');
    }
    
    // Liquidity analysis (if available)
    const liq = tokenData.liquidity || 0;
    if (liq >= 20000) {
        score += 15;
        signals.push('High liquidity');
    } else if (liq >= 5000) {
        score += 8;
        signals.push('Good liquidity');
    } else if (liq > 0 && liq < 2000) {
        score -= 10;
        signals.push('Low liquidity');
    }
    
    // ADVANCED: Holder count analysis
    const holderCount = tokenData.holderCount || 0;
    if (holderCount >= 100) {
        score += 15;
        signals.push(`${holderCount}+ holders`);
    } else if (holderCount >= 50) {
        score += 8;
        signals.push(`${holderCount} holders`);
    } else if (holderCount > 0 && holderCount < 50) {
        score -= 15;
        warnings.push(`Only ${holderCount} holders`);
    }
    
    // ADVANCED: Dev wallet percentage check
    const devPercent = tokenData.devWalletPercent || 0;
    if (devPercent > 20) {
        score -= 25;
        warnings.push(`Dev holds ${devPercent.toFixed(1)}%`);
    } else if (devPercent > 10) {
        score -= 15;
        warnings.push(`Dev holds ${devPercent.toFixed(1)}%`);
    } else if (devPercent > 0 && devPercent <= 5) {
        score += 10;
        signals.push(`Low dev: ${devPercent.toFixed(1)}%`);
    }
    
    // ADVANCED: Volume spike detection
    if (tokenData.volumeSpike) {
        score += 15;
        signals.push('🔥 Volume spike!');
    }
    
    // ADVANCED: Buy pressure (more buys than sells)
    const buyPressure = tokenData.buyPressure || 50;
    if (buyPressure >= 70) {
        score += 15;
        signals.push(`High buy pressure: ${buyPressure.toFixed(0)}%`);
    } else if (buyPressure >= 55) {
        score += 5;
        signals.push(`Buy pressure: ${buyPressure.toFixed(0)}%`);
    } else if (buyPressure < 40) {
        score -= 10;
        warnings.push(`Sell pressure: ${(100 - buyPressure).toFixed(0)}%`);
    }
    
    // ADVANCED: Whale activity
    if (tokenData.whaleActivity) {
        score += 10;
        signals.push('🐋 Whale interest');
    }
    
    // Name/Symbol analysis (avoid rugs with suspicious names)
    const name = (tokenData.name || '').toLowerCase();
    const symbol = (tokenData.symbol || '').toLowerCase();
    
    const bullishKeywords = ['ai', 'pepe', 'doge', 'meme', 'moon', 'gold', 'gem', 'elon', 'trump', 'sol'];
    const bearishKeywords = ['rug', 'scam', 'test', 'fake', 'copy', 'clone'];
    
    for (const kw of bullishKeywords) {
        if (name.includes(kw) || symbol.includes(kw)) {
            score += 5;
            signals.push(`Trending: ${kw}`);
            break;
        }
    }
    
    for (const kw of bearishKeywords) {
        if (name.includes(kw) || symbol.includes(kw)) {
            score -= 20;
            warnings.push(`Warning: ${kw}`);
            break;
        }
    }
    
    // Platform bonus
    if (tokenData.platform === 'pumpfun') {
        score += 5; // Pump.fun generally more active
    }
    
    // Determine signal
    let signal = 'neutral';
    if (score >= 65) {
        signal = 'bullish';
    } else if (score <= 35) {
        signal = 'bearish';
    }
    
    return {
        signal,
        score: Math.min(100, Math.max(0, score)),
        signals,
        warnings,
        details: {
            holderCount,
            devWalletPercent: devPercent,
            volumeSpike: tokenData.volumeSpike || false,
            buyPressure,
            whaleActivity: tokenData.whaleActivity || false
        }
    };
}

/**
 * Enhanced token analysis with async safety checks
 * Fetches holder count, dev wallet %, volume data, whale activity
 */
async function analyzeTokenAdvanced(tokenAddress, basicData = {}) {
    try {
        // Fetch all data in parallel for speed
        const [holderData, volumeData, whaleData] = await Promise.allSettled([
            getTokenHolders(tokenAddress),
            getVolumeData(tokenAddress),
            checkWhaleActivity(tokenAddress)
        ]);
        
        // Merge all data
        const enrichedData = {
            ...basicData,
            holderCount: holderData.status === 'fulfilled' ? holderData.value.holderCount : 0,
            devWalletPercent: holderData.status === 'fulfilled' ? holderData.value.devWalletPercent : 0,
            topHolders: holderData.status === 'fulfilled' ? holderData.value.topHolders : [],
            volumeSpike: volumeData.status === 'fulfilled' ? volumeData.value.volumeSpike : false,
            buyPressure: volumeData.status === 'fulfilled' ? volumeData.value.buyPressure : 50,
            volume24h: volumeData.status === 'fulfilled' ? volumeData.value.volume24h : 0,
            buys: volumeData.status === 'fulfilled' ? volumeData.value.buys : 0,
            sells: volumeData.status === 'fulfilled' ? volumeData.value.sells : 0,
            whaleActivity: whaleData.status === 'fulfilled' ? whaleData.value.whaleActivity : false
        };
        
        // Run analysis with enriched data
        return analyzeToken(enrichedData);
    } catch (e) {
        console.log(`Advanced analysis failed: ${e.message}`);
        return analyzeToken(basicData);
    }
}

/**
 * Start live feed WebSocket connection
 */
function startLiveFeed(platform, minMcap, callback) {
    liveFeedPlatform = platform || 'both';
    liveFeedMinMcap = minMcap || 1000;
    liveFeedCallback = callback;
    
    // Close existing connection
    if (liveFeedWs) {
        try { liveFeedWs.close(); } catch(e) {}
    }
    
    // Connect to PumpPortal WebSocket
    liveFeedWs = new WebSocket('wss://pumpportal.fun/api/data');
    
    liveFeedWs.on('open', () => {
        log('📡 Live feed connected!', 'success');
        
        // Subscribe to new token creations
        // PumpPortal sends BOTH pump.fun and letsbonk.fun tokens
        // We filter by platform in the message handler
        liveFeedWs.send(JSON.stringify({ method: "subscribeNewToken" }));
        
        const platformText = liveFeedPlatform === 'both' ? 'Pump.fun & LetsBonk' : 
                            liveFeedPlatform === 'pumpfun' ? 'Pump.fun' : 'LetsBonk';
        log(`📡 Listening for ${platformText} tokens...`, 'info');
        
        if (callback) {
            callback({ type: 'status', connected: true });
        }
    });
    
    liveFeedWs.on('message', async (data) => {
        try {
            const msg = JSON.parse(data.toString());
            
            log(`📡 Feed message received: ${msg.mint ? msg.mint.slice(0, 8) + '...' : 'unknown type'}`, 'info');
            
            // New token creation
            if (msg.mint && msg.signature) {
                // Detect platform based on token address
                // Pump.fun tokens end with "pump", LetsBonk tokens don't
                const isPumpFun = msg.mint.toLowerCase().endsWith('pump');
                const detectedPlatform = isPumpFun ? 'pumpfun' : 'letsbonk';
                
                const tokenData = {
                    mint: msg.mint,
                    name: msg.name || 'Unknown',
                    symbol: msg.symbol || '???',
                    uri: msg.uri || '',
                    platform: detectedPlatform,
                    timestamp: Date.now(),
                    marketCap: msg.marketCapSol ? msg.marketCapSol * 200 : 5000, // Estimate USD
                    liquidity: msg.vSolInBondingCurve ? msg.vSolInBondingCurve * 200 : 0,
                    image: null,
                    socials: {
                        twitter: null,
                        telegram: null,
                        website: null,
                        discord: null
                    }
                };
                
                // Skip if below min market cap
                if (tokenData.marketCap < liveFeedMinMcap) {
                    log(`📡 Skipping token - below min mcap: $${tokenData.marketCap} < $${liveFeedMinMcap}`, 'info');
                    return;
                }
                
                // Skip if wrong platform filter
                if (liveFeedPlatform !== 'both' && liveFeedPlatform !== detectedPlatform) {
                    log(`📡 Skipping token - wrong platform: ${detectedPlatform} != ${liveFeedPlatform}`, 'info');
                    return;
                }
                
                // Analyze the token
                const analysis = analyzeToken(tokenData);
                tokenData.analysis = analysis;
                
                log(`📡 New token: ${tokenData.name} (${tokenData.symbol}) - ${detectedPlatform}`, 'success');
                
                // Try to get image AND socials from metadata URI (best source for new tokens)
                if (tokenData.uri) {
                    try {
                        const metadataUrl = convertIpfsUrl(tokenData.uri);
                        const metaResp = await axios.get(metadataUrl, { 
                            timeout: 3000,
                            headers: { 'User-Agent': 'Mozilla/5.0' }
                        });
                        
                        if (metaResp.data) {
                            const meta = metaResp.data;
                            
                            // Get image
                            if (meta.image) {
                                tokenData.image = convertIpfsUrl(meta.image);
                                log(`📷 Got image from metadata`, 'success');
                            }
                            
                            // Get socials from metadata (pump.fun tokens include these)
                            if (meta.twitter && meta.twitter.length > 15) {
                                // Validate Twitter URL (must have a username, not just x.com)
                                const twitterUrl = meta.twitter.startsWith('http') ? meta.twitter : `https://twitter.com/${meta.twitter.replace('@', '')}`;
                                if (twitterUrl.includes('/') && twitterUrl.split('/').pop().length > 0) {
                                    tokenData.socials.twitter = twitterUrl;
                                    log(`🔗 Found Twitter`, 'info');
                                }
                            }
                            if (meta.telegram && meta.telegram.length > 5) {
                                tokenData.socials.telegram = meta.telegram.startsWith('http') ? meta.telegram : `https://t.me/${meta.telegram.replace('@', '')}`;
                                log(`🔗 Found Telegram`, 'info');
                            }
                            if (meta.website && meta.website.length > 10 && !meta.website.includes('pump.fun')) {
                                tokenData.socials.website = meta.website;
                                log(`🔗 Found Website`, 'info');
                            }
                            
                            // Some tokens use 'external_url' for website
                            if (!tokenData.socials.website && meta.external_url && meta.external_url.length > 10) {
                                tokenData.socials.website = meta.external_url;
                            }
                        }
                    } catch (e) {
                        log(`📷 Metadata fetch failed: ${e.message}`, 'warning');
                    }
                }
                
                // If no image yet, use multiple fallback sources
                if (!tokenData.image) {
                    // Try DexScreener CDN first (fast, reliable)
                    tokenData.image = `https://dd.dexscreener.com/ds-data/tokens/solana/${tokenData.mint}.png`;
                    
                    // Backup: Extract IPFS hash from URI and use ipfs.io
                    if (tokenData.uri) {
                        const uriParts = tokenData.uri.split('/');
                        const ipfsHash = uriParts[uriParts.length - 1];
                        if (ipfsHash && (ipfsHash.startsWith('Qm') || ipfsHash.startsWith('bafy'))) {
                            tokenData.image = `https://ipfs.io/ipfs/${ipfsHash}`;
                        }
                    }
                }
                
                // Send to callback
                if (liveFeedCallback) {
                    liveFeedCallback({ type: 'token', data: tokenData });
                }
                
                // Fetch additional data asynchronously (for fallbacks)
                (async () => {
                    try {
                        let updatedImage = null;
                        let socialsUpdated = false;
                        
                        // Check if we need to fetch more data
                        const needsImage = !tokenData.image || tokenData.image.includes('cf-ipfs') || tokenData.image.includes('mypinata');
                        const needsSocials = !tokenData.socials.twitter && !tokenData.socials.telegram && !tokenData.socials.website;
                        
                        // If we already have socials from metadata, send update to UI
                        if (!needsSocials) {
                            socialsUpdated = true;
                            liveFeedCallback({ type: 'socials_update', mint: tokenData.mint, socials: tokenData.socials });
                        }
                        
                        // Try multiple APIs for better image
                        if (needsImage) {
                            // Try Helius first
                            try {
                                const heliusImage = await fetchImageFromHelius(tokenData.mint);
                                if (heliusImage && !heliusImage.includes('cf-ipfs')) {
                                    updatedImage = heliusImage;
                                    log(`📷 Got image from Helius`, 'success');
                                }
                            } catch (e) {}
                            
                            // Try GMGN.ai if Helius didn't work
                            if (!updatedImage) {
                                try {
                                    const gmgnResp = await axios.get(`https://gmgn.ai/defi/quotation/v1/tokens/sol/${tokenData.mint}`, {
                                        timeout: 3000,
                                        headers: { 'User-Agent': 'Mozilla/5.0' }
                                    });
                                    const gmgnImg = gmgnResp.data?.data?.token?.logo || gmgnResp.data?.data?.token?.image;
                                    if (gmgnImg) {
                                        updatedImage = gmgnImg;
                                        log(`📷 Got image from GMGN`, 'success');
                                    }
                                } catch (e) {}
                            }
                        }
                        
                        // Send icon update if we found a better image
                        if (updatedImage && liveFeedCallback) {
                            liveFeedCallback({ type: 'icon_update', mint: tokenData.mint, image: updatedImage });
                        }
                        
                        // If no socials yet, try DexScreener (works for tokens with some trading activity)
                        if (needsSocials) {
                            try {
                                const dexResp = await axios.get(`https://api.dexscreener.com/latest/dex/tokens/${tokenData.mint}`, { timeout: 5000 });
                                if (dexResp.data?.pairs?.[0]?.info) {
                                    const info = dexResp.data.pairs[0].info;
                                    
                                    if (info.websites && info.websites.length > 0) {
                                        tokenData.socials.website = info.websites[0].url;
                                        socialsUpdated = true;
                                    }
                                    if (info.socials) {
                                        for (const social of info.socials) {
                                            if (social.type === 'twitter') {
                                                tokenData.socials.twitter = social.url;
                                                socialsUpdated = true;
                                            } else if (social.type === 'telegram') {
                                                tokenData.socials.telegram = social.url;
                                                socialsUpdated = true;
                                            } else if (social.type === 'discord') {
                                                tokenData.socials.discord = social.url;
                                                socialsUpdated = true;
                                            }
                                        }
                                    }
                                    
                                    // Also get image from DexScreener if needed
                                    if (!updatedImage && info.imageUrl) {
                                        liveFeedCallback({ type: 'icon_update', mint: tokenData.mint, image: info.imageUrl });
                                    }
                                }
                            } catch (e) {}
                        }
                        
                        // Send socials update to UI if we found any
                        if (socialsUpdated && liveFeedCallback) {
                            liveFeedCallback({ type: 'socials_update', mint: tokenData.mint, socials: tokenData.socials });
                        }
                    } catch (e) {
                        // Ignore async errors
                    }
                })();
            }
        } catch (e) {
            log(`📡 Feed parse error: ${e.message}`, 'error');
        }
    });
    
    liveFeedWs.on('error', (err) => {
        log(`❌ Live feed error: ${err.message}`, 'error');
    });
    
    liveFeedWs.on('close', () => {
        log('📡 Live feed disconnected', 'warning');
        if (liveFeedCallback) {
            liveFeedCallback({ type: 'status', connected: false });
            
            // Auto-reconnect after 3 seconds
            setTimeout(() => {
                if (liveFeedCallback) {
                    log('📡 Attempting to reconnect...', 'info');
                    startLiveFeed(liveFeedPlatform, liveFeedMinMcap, liveFeedCallback);
                }
            }, 3000);
        }
    });
    
    return { success: true };
}

/**
 * Stop live feed
 */
function stopLiveFeed() {
    if (liveFeedWs) {
        try {
            liveFeedWs.close();
        } catch(e) {}
        liveFeedWs = null;
    }
    liveFeedCallback = null;
    return { success: true };
}

/**
 * Check if live feed is connected
 */
function isLiveFeedConnected() {
    return liveFeedWs && liveFeedWs.readyState === WebSocket.OPEN;
}

// ═══════════════════════════════════════════════════════════════════════════════
// SIMPLE LAUNCH - Create token on Pump.fun
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Simple Launch - One-click token creation on Pump.fun via PumpPortal API
 * Features:
 * - Launch in seconds
 * - Built-in bonding curve
 * - Auto-graduation to DEX (Raydium) at ~$69K
 * 
 * @param {object} launchData - Token launch parameters
 * @param {string} launchData.name - Token name
 * @param {string} launchData.symbol - Token symbol (2-10 chars)
 * @param {string} launchData.description - Token description
 * @param {string} [launchData.image] - Optional image URL or base64
 * @param {string} [launchData.imageBase64] - Optional image as base64 (from file upload)
 * @param {number} [launchData.initialBuy] - Initial buy amount in SOL (optional)
 * @param {object} userConfig - User configuration with wallet info
 */
async function simpleLaunchToken(launchData, userConfig) {
    const platform = launchData.platform || 'pumpfun';
    const platformName = platform === 'pumpfun' ? 'Pump.fun' : 'LetsBonk';
    console.log(`[Simple Launch] Starting token creation on ${platformName}...`);
    console.log('[Simple Launch] Data:', JSON.stringify({ ...launchData, imageBase64: launchData.imageBase64 ? '[BASE64 DATA]' : null }, null, 2));
    
    try {
        // Validate inputs
        if (!launchData.name || launchData.name.length < 2) {
            return { success: false, error: 'Token name must be at least 2 characters' };
        }
        if (!launchData.symbol || launchData.symbol.length < 2 || launchData.symbol.length > 10) {
            return { success: false, error: 'Symbol must be 2-10 characters' };
        }
        if (!launchData.description || launchData.description.length < 10) {
            return { success: false, error: 'Description must be at least 10 characters' };
        }
        
        // Check if wallet is configured - use passed userConfig
        if (!userConfig || !userConfig.privateKey) {
            return { 
                success: false, 
                error: 'Wallet not configured. Please add your private key in Settings first.',
                instructions: 'Go to Settings → Wallet Configuration → Enter your private key'
            };
        }
        
        console.log('[Simple Launch] Wallet configured ✓');
        
        // Import required modules
        const { Keypair, Connection, VersionedTransaction } = require('@solana/web3.js');
        const bs58 = require('bs58');
        const axios = require('axios');
        const FormData = require('form-data');
        
        // Create wallet from private key
        let wallet;
        try {
            const privateKeyBytes = bs58.decode(userConfig.privateKey);
            wallet = Keypair.fromSecretKey(privateKeyBytes);
            console.log('[Simple Launch] Wallet loaded:', wallet.publicKey.toString());
        } catch (e) {
            return { success: false, error: `Invalid private key: ${e.message}` };
        }
        
        // Connect to Solana
        const rpcUrl = userConfig.rpcUrl || 'https://api.mainnet-beta.solana.com';
        const connection = new Connection(rpcUrl, 'confirmed');
        
        // Generate a new keypair for the token mint
        const mintKeypair = Keypair.generate();
        console.log('[Simple Launch] Generated mint address:', mintKeypair.publicKey.toString());
        
        // Prepare metadata for IPFS upload via PumpPortal
        console.log('[Simple Launch] Preparing token metadata...');
        
        // Create form data for the API
        const formData = new FormData();
        formData.append('name', launchData.name);
        formData.append('symbol', launchData.symbol);
        formData.append('description', launchData.description);
        
        // Handle image - either from file (base64) or URL
        if (launchData.imageBase64) {
            // Convert base64 to buffer for upload
            const base64Data = launchData.imageBase64.replace(/^data:image\/\w+;base64,/, '');
            const imageBuffer = Buffer.from(base64Data, 'base64');
            formData.append('file', imageBuffer, { filename: 'token_image.png', contentType: 'image/png' });
            console.log('[Simple Launch] Image attached from file upload');
        } else if (launchData.image) {
            // If URL provided, try to fetch and attach
            try {
                const imageResponse = await axios.get(launchData.image, { responseType: 'arraybuffer', timeout: 10000 });
                formData.append('file', Buffer.from(imageResponse.data), { filename: 'token_image.png', contentType: 'image/png' });
                console.log('[Simple Launch] Image fetched from URL');
            } catch (e) {
                console.log('[Simple Launch] Could not fetch image from URL, continuing without image');
            }
        }
        
        // Add social links if provided
        if (launchData.twitter) formData.append('twitter', launchData.twitter);
        if (launchData.telegram) formData.append('telegram', launchData.telegram);
        if (launchData.website) formData.append('website', launchData.website);
        
        // Add showName flag
        formData.append('showName', 'true');
        
        console.log(`[Simple Launch] Uploading metadata to IPFS for ${platformName}...`);
        
        // Step 1: Upload metadata to IPFS
        // Both platforms use similar IPFS endpoints
        const ipfsEndpoint = platform === 'letsbonk' 
            ? 'https://letsbonk.fun/api/ipfs'  // LetsBonk IPFS endpoint
            : 'https://pump.fun/api/ipfs';       // Pump.fun IPFS endpoint
        
        let metadataUri;
        try {
            const ipfsResponse = await axios.post(ipfsEndpoint, formData, {
                headers: formData.getHeaders(),
                timeout: 30000
            });
            metadataUri = ipfsResponse.data.metadataUri;
            console.log('[Simple Launch] Metadata uploaded:', metadataUri);
        } catch (e) {
            console.log('[Simple Launch] IPFS upload failed, trying alternative...');
            // Try the other platform's IPFS if first fails
            try {
                const fallbackEndpoint = platform === 'letsbonk' 
                    ? 'https://pump.fun/api/ipfs' 
                    : 'https://letsbonk.fun/api/ipfs';
                const fallbackResponse = await axios.post(fallbackEndpoint, formData, {
                    headers: formData.getHeaders(),
                    timeout: 30000
                });
                metadataUri = fallbackResponse.data.metadataUri;
                console.log('[Simple Launch] Metadata uploaded via fallback:', metadataUri);
            } catch (e2) {
                console.log('[Simple Launch] Both IPFS uploads failed');
                metadataUri = null;
            }
        }
        
        // Step 2: Create the token via API
        console.log(`[Simple Launch] Creating token on ${platformName}...`);
        
        // Set pool based on platform
        const poolType = platform === 'letsbonk' ? 'bonk' : 'pump';
        const tokenUriBase = platform === 'letsbonk' 
            ? `https://letsbonk.fun/api/token/${mintKeypair.publicKey.toString()}`
            : `https://pump.fun/api/token/${mintKeypair.publicKey.toString()}`;
        
        const createPayload = {
            publicKey: wallet.publicKey.toString(),
            action: 'create',
            tokenMetadata: {
                name: launchData.name,
                symbol: launchData.symbol,
                uri: metadataUri || tokenUriBase
            },
            mint: mintKeypair.publicKey.toString(),
            denominatedInSol: 'true',
            amount: launchData.initialBuy || 0,
            slippage: 15,
            priorityFee: userConfig.priorityFee || 0.005,
            pool: poolType
        };
        
        console.log(`[Simple Launch] Sending create request (pool: ${poolType})...`);
        
        // PumpPortal API handles both pump.fun and letsbonk through the 'pool' parameter
        const response = await axios.post(
            'https://pumpportal.fun/api/trade-local',
            createPayload,
            {
                timeout: 30000,
                headers: { 'Content-Type': 'application/json' },
                responseType: 'arraybuffer'
            }
        );
        
        if (!response.data || response.data.length === 0) {
            throw new Error('Empty response from PumpPortal API');
        }
        
        console.log('[Simple Launch] Got transaction from PumpPortal!');
        
        // Deserialize and sign the transaction
        const txBuffer = Buffer.from(response.data);
        const transaction = VersionedTransaction.deserialize(txBuffer);
        
        // Sign with both the wallet and the mint keypair
        transaction.sign([wallet, mintKeypair]);
        
        console.log('[Simple Launch] Transaction signed, sending to blockchain...');
        
        // Send transaction
        const signature = await connection.sendRawTransaction(
            transaction.serialize(),
            { skipPreflight: true, maxRetries: 3 }
        );
        
        console.log('[Simple Launch] TX sent:', signature);
        
        // Confirm transaction
        console.log('[Simple Launch] Confirming transaction...');
        const confirmation = await connection.confirmTransaction(signature, 'confirmed');
        
        if (confirmation.value.err) {
            throw new Error('Transaction failed on chain: ' + JSON.stringify(confirmation.value.err));
        }
        
        // SUCCESS!
        const mintAddress = mintKeypair.publicKey.toString();
        console.log('[Simple Launch] ✅ TOKEN CREATED SUCCESSFULLY!');
        console.log('[Simple Launch] Mint Address:', mintAddress);
        console.log('[Simple Launch] TX Signature:', signature);
        
        return {
            success: true,
            mint: mintAddress,
            signature: signature,
            name: launchData.name,
            symbol: launchData.symbol,
            platform: platform,
            platformName: platformName,
            message: `Token "${launchData.name}" (${launchData.symbol}) created on ${platformName}!`,
            links: {
                platform: platform === 'letsbonk' 
                    ? `https://letsbonk.fun/${mintAddress}`
                    : `https://pump.fun/${mintAddress}`,
                pumpfun: `https://pump.fun/${mintAddress}`,
                letsbonk: `https://letsbonk.fun/${mintAddress}`,
                dexscreener: `https://dexscreener.com/solana/${mintAddress}`,
                solscan: `https://solscan.io/token/${mintAddress}`,
                tx: `https://solscan.io/tx/${signature}`
            }
        };
        
    } catch (error) {
        console.error('[Simple Launch] Error:', error);
        
        // Provide helpful error messages
        let errorMessage = error.message || 'Unknown error';
        
        if (errorMessage.includes('insufficient funds') || errorMessage.includes('0x1')) {
            errorMessage = 'Insufficient SOL balance. You need at least 0.02 SOL + initial buy amount.';
        } else if (errorMessage.includes('timeout')) {
            errorMessage = 'Request timed out. Please check your internet connection and try again.';
        } else if (errorMessage.includes('429') || errorMessage.includes('rate limit')) {
            errorMessage = 'Too many requests. Please wait a moment and try again.';
        }
        
        return { success: false, error: errorMessage };
    }
}

// Export module
module.exports = {
    start,
    stop,
    getBalance,
    quickBuy,
    quickSell,
    lookupToken,
    getPositions,
    getWalletHoldings,
    generateWallets,
    getBundleWalletBalances,
    fundBundleWallets,
    collectBundleFunds,
    bundleBuy,
    bundleSell,
    startLiveFeed,
    stopLiveFeed,
    isLiveFeedConnected,
    analyzeToken,
    // Bitquery functions for accurate data
    fetchPumpFunFromBitquery,
    fetchRecentPumpFunLaunches,
    // ADVANCED SAFETY CHECKS
    analyzeTokenAdvanced,
    getTokenHolders,
    checkTokenSafety,
    getVolumeData,
    checkWhaleActivity,
    detectBundleBuying,
    // Simple Launch
    simpleLaunchToken
};


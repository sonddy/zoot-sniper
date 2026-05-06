/**
 * Telegram alerts for the Zoot Sniper Bot.
 *
 * Opt-in: stays silent until both `telegramEnabled` is true AND
 * `telegramBotToken` + `telegramChatId` are set. The module exposes a tiny
 * surface — `init`, `sendMessage`, plus typed convenience helpers used by
 * the trade engine — so callers don't worry about HTTP plumbing.
 *
 * Design notes
 * - Never throw out to the bot. A failed alert should never break a trade.
 * - Coalesce repeated identical alerts within 30s to avoid Telegram rate
 *   limits when something fires in a tight loop (e.g. WS reconnect storms).
 * - Use `parse_mode: HTML` and escape user-supplied strings so a token name
 *   like `<script>` doesn't blow up Telegram's parser.
 */

const https = require('https');

let cfg = {};
let lastSentByKey = new Map();
const COALESCE_MS = 30 * 1000;

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function isReady() {
    return !!(cfg.telegramEnabled && cfg.telegramBotToken && cfg.telegramChatId);
}

function init(config) {
    cfg = config || {};
    lastSentByKey = new Map();
}

function postTelegram(text) {
    return new Promise((resolve) => {
        try {
            const body = JSON.stringify({
                chat_id: cfg.telegramChatId,
                text,
                parse_mode: 'HTML',
                disable_web_page_preview: true
            });
            const req = https.request({
                hostname: 'api.telegram.org',
                path: `/bot${cfg.telegramBotToken}/sendMessage`,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body)
                },
                timeout: 5000
            }, (res) => {
                // Drain so the socket can be reused, but don't error out on
                // non-200 — Telegram returns helpful JSON we can ignore.
                res.on('data', () => {});
                res.on('end', () => resolve(res.statusCode === 200));
            });
            req.on('error', () => resolve(false));
            req.on('timeout', () => { req.destroy(); resolve(false); });
            req.write(body);
            req.end();
        } catch (e) {
            resolve(false);
        }
    });
}

/**
 * Send a Telegram message. `coalesceKey` is optional; when provided, the same
 * key won't be re-sent within COALESCE_MS. Use it for events that can fire in
 * tight loops (e.g. circuit breaker checks).
 */
async function sendMessage(text, coalesceKey) {
    if (!isReady() || !text) return false;
    if (coalesceKey) {
        const last = lastSentByKey.get(coalesceKey) || 0;
        if (Date.now() - last < COALESCE_MS) return false;
        lastSentByKey.set(coalesceKey, Date.now());
    }
    return postTelegram(text);
}

// ── typed helpers ─────────────────────────────────────────────────────────
async function alertBuy({ tokenName, tokenAddress, amountSOL, source, sourceWallet, paper }) {
    if (!cfg.telegramAlertOnBuy) return;
    const lines = [
        `🟢 <b>BUY</b>${paper ? ' <i>(paper)</i>' : ''}`,
        `<b>${escapeHtml(tokenName || 'Token')}</b>`,
        `<code>${escapeHtml(tokenAddress)}</code>`,
        `Size: <b>${amountSOL} SOL</b>`
    ];
    if (source === 'copytrade') {
        lines.push(`👥 Copy-trade from <code>${escapeHtml((sourceWallet || '').slice(0, 8))}…</code>`);
    }
    lines.push(`<a href="https://pump.fun/${encodeURIComponent(tokenAddress)}">pump.fun</a> · <a href="https://dexscreener.com/solana/${encodeURIComponent(tokenAddress)}">DexScreener</a>`);
    return sendMessage(lines.join('\n'));
}

async function alertSell({ tokenName, tokenAddress, profitSOL, multiplier, sellPercent, paper }) {
    if (!cfg.telegramAlertOnSell) return;
    const sign = profitSOL >= 0 ? '+' : '';
    const emoji = profitSOL >= 0 ? '💰' : '🩸';
    const lines = [
        `${emoji} <b>SELL ${sellPercent}%</b>${paper ? ' <i>(paper)</i>' : ''}`,
        `<b>${escapeHtml(tokenName || 'Token')}</b>`,
        `<code>${escapeHtml(tokenAddress)}</code>`,
        `P&amp;L: <b>${sign}${profitSOL.toFixed(4)} SOL</b>`,
        `Multiplier: <b>${multiplier?.toFixed?.(2) ?? multiplier}x</b>`
    ];
    return sendMessage(lines.join('\n'));
}

async function alertError(message, coalesceKey) {
    if (!cfg.telegramAlertOnError) return;
    return sendMessage(`⚠️ <b>Error</b>\n<code>${escapeHtml(message)}</code>`, coalesceKey);
}

async function alertCircuitBreaker(reason) {
    if (!cfg.telegramAlertOnCircuitBreaker) return;
    return sendMessage(`🛑 <b>Circuit breaker</b>\n${escapeHtml(reason)}`, `cb:${reason}`);
}

async function dailySummary({ trades, wins, losses, netSOL, durationMs }) {
    if (!cfg.telegramDailySummary) return;
    const winRate = trades > 0 ? (wins / trades * 100).toFixed(1) : '0.0';
    const hours = Math.max(1, Math.floor((durationMs || 0) / 3600_000));
    const sign = netSOL >= 0 ? '+' : '';
    return sendMessage([
        `📊 <b>Session summary</b>`,
        `Duration: ~${hours}h`,
        `Trades: <b>${trades}</b> (W ${wins} / L ${losses}, ${winRate}%)`,
        `Net P&amp;L: <b>${sign}${netSOL.toFixed(4)} SOL</b>`
    ].join('\n'));
}

module.exports = {
    init,
    isReady,
    sendMessage,
    alertBuy,
    alertSell,
    alertError,
    alertCircuitBreaker,
    dailySummary
};

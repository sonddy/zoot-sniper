/**
 * Trade journal — append-only JSONL log of every closed trade.
 *
 * Stored in `userData/trades.jsonl` (one JSON object per line). Append-only
 * is robust against crashes — a partial last line is just ignored on read.
 *
 * Schema (per closed leg of a trade):
 *   {
 *     ts,            // unix ms when the leg closed
 *     mint,          // token address
 *     name, symbol,  // best-effort labels
 *     platform,      // 'pumpfun' | 'letsbonk' | 'raydium' | ...
 *     buySOL,        // SOL spent on the buy this position is derived from
 *     profitSOL,     // realized profit/loss for THIS leg only
 *     multiplier,    // current price / initial price at the moment of sell
 *     sellPercent,   // 100 = full close, 66 = partial sell at TP1, etc.
 *     durationMs,    // time held since the buy
 *     paper,         // true if this was a paper-trade
 *     source         // 'detect' | 'copytrade' | 'quick' | 'paper'
 *   }
 *
 * No external deps; readers tolerate broken trailing lines and missing files.
 */

const fs = require('fs');
const path = require('path');

let journalPath = null;

function init(userDataPath) {
    journalPath = path.join(userDataPath, 'trades.jsonl');
    try {
        // Touch file so first read doesn't have to handle ENOENT.
        if (!fs.existsSync(journalPath)) fs.writeFileSync(journalPath, '', 'utf-8');
    } catch (e) {
        // Best-effort. The bot keeps running even if the journal is unwritable.
    }
}

function record(entry) {
    if (!journalPath) return false;
    try {
        const safe = {
            ts: entry.ts || Date.now(),
            mint: entry.mint || '',
            name: entry.name || '',
            symbol: entry.symbol || '',
            platform: entry.platform || '',
            buySOL: Number(entry.buySOL || 0),
            profitSOL: Number(entry.profitSOL || 0),
            multiplier: Number(entry.multiplier || 0),
            sellPercent: Number(entry.sellPercent || 100),
            durationMs: Number(entry.durationMs || 0),
            paper: !!entry.paper,
            source: entry.source || 'detect'
        };
        fs.appendFileSync(journalPath, JSON.stringify(safe) + '\n', 'utf-8');
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Return the last `limit` rows (most recent first). Tolerates partial last
 * lines and silently skips rows that fail to parse.
 */
function readAll(limit) {
    if (!journalPath || !fs.existsSync(journalPath)) return [];
    try {
        const raw = fs.readFileSync(journalPath, 'utf-8');
        const lines = raw.split('\n');
        const rows = [];
        for (const line of lines) {
            if (!line) continue;
            try { rows.push(JSON.parse(line)); } catch (e) { /* skip */ }
        }
        rows.reverse();
        return typeof limit === 'number' ? rows.slice(0, limit) : rows;
    } catch (e) {
        return [];
    }
}

/**
 * Aggregate stats across ALL closed legs in the journal. We treat every
 * recorded line as one observation; partial sells at TP1 are counted just
 * like full closes since they materialize realized P&L.
 *
 * Returns a fixed shape so the UI doesn't have to deal with missing fields.
 */
function stats() {
    const rows = readAll();
    const out = {
        totalTrades: rows.length,
        wins: 0,
        losses: 0,
        winRate: 0,
        netSOL: 0,
        bestTradeSOL: 0,
        worstTradeSOL: 0,
        avgMultiplier: 0,
        last24hNetSOL: 0,
        last24hTrades: 0,
        equityCurve: [],          // [{ts, cumulativeSOL}]
        topTokens: []             // [{symbol, mint, profitSOL, count}]
    };
    if (rows.length === 0) return out;

    const dayAgo = Date.now() - 24 * 3600_000;
    let cumulative = 0;
    let mxSum = 0, mxN = 0;
    const byToken = new Map();

    // rows is newest-first; flip to chronological for the equity curve.
    const chrono = rows.slice().reverse();
    for (const r of chrono) {
        cumulative += r.profitSOL;
        out.equityCurve.push({ ts: r.ts, cumulativeSOL: Number(cumulative.toFixed(6)) });
        if (r.profitSOL >= 0) out.wins++; else out.losses++;
        out.netSOL += r.profitSOL;
        if (r.profitSOL > out.bestTradeSOL) out.bestTradeSOL = r.profitSOL;
        if (r.profitSOL < out.worstTradeSOL) out.worstTradeSOL = r.profitSOL;
        if (r.multiplier && isFinite(r.multiplier)) { mxSum += r.multiplier; mxN++; }
        if (r.ts >= dayAgo) {
            out.last24hNetSOL += r.profitSOL;
            out.last24hTrades++;
        }
        const k = r.mint || r.symbol || 'unknown';
        const ex = byToken.get(k) || { symbol: r.symbol || '?', mint: r.mint || '', profitSOL: 0, count: 0 };
        ex.profitSOL += r.profitSOL;
        ex.count++;
        byToken.set(k, ex);
    }

    out.winRate = out.totalTrades > 0 ? (out.wins / out.totalTrades * 100) : 0;
    out.avgMultiplier = mxN > 0 ? mxSum / mxN : 0;
    out.netSOL = Number(out.netSOL.toFixed(6));
    out.bestTradeSOL = Number(out.bestTradeSOL.toFixed(6));
    out.worstTradeSOL = Number(out.worstTradeSOL.toFixed(6));
    out.last24hNetSOL = Number(out.last24hNetSOL.toFixed(6));

    out.topTokens = Array.from(byToken.values())
        .sort((a, b) => b.profitSOL - a.profitSOL)
        .slice(0, 10);

    // Cap the equity curve to ~500 points so we don't ship a 10k-point array
    // to the renderer for an SVG sparkline.
    if (out.equityCurve.length > 500) {
        const step = Math.ceil(out.equityCurve.length / 500);
        out.equityCurve = out.equityCurve.filter((_, i) => i % step === 0 || i === out.equityCurve.length - 1);
    }

    return out;
}

module.exports = { init, record, readAll, stats };

/**
 * Zoot Licensing API — Express + SQLite reference implementation.
 *
 * Endpoints:
 *   POST /v1/validate           public, called by the client on every launch
 *   POST /admin/issue           gated by ADMIN_TOKEN
 *   POST /admin/revoke          gated by ADMIN_TOKEN
 *   GET  /admin/list            gated by ADMIN_TOKEN
 *
 * Storage:
 *   licenses.sqlite (file in the working directory; configurable via DB_PATH)
 *
 * Env:
 *   PORT          default 8787
 *   ADMIN_TOKEN   required for /admin/* routes
 *   DB_PATH       default ./licenses.sqlite
 */

const express = require('express');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

const PORT = parseInt(process.env.PORT || '8787', 10);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || '';
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'licenses.sqlite');

const db = new Database(DB_PATH);
db.exec(`
    CREATE TABLE IF NOT EXISTS licenses (
        key TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        expiresAt TEXT,
        boundMachineId TEXT,
        revoked INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        lastSeenAt TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_licenses_machine ON licenses(boundMachineId);
`);

const app = express();
app.use(express.json({ limit: '8kb' }));

function requireAdmin(req, res, next) {
    if (!ADMIN_TOKEN) return res.status(500).json({ error: 'ADMIN_TOKEN not configured' });
    const tok = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (tok !== ADMIN_TOKEN) return res.status(401).json({ error: 'unauthorized' });
    next();
}

function genKey(type) {
    const block = () => crypto.randomBytes(2).toString('hex').toUpperCase();
    const yymmdd = new Date().toISOString().slice(2, 10).replace(/-/g, '');
    return `ZOOT-${block()}-${block()}-${block()}-${type}-${yymmdd}`;
}

app.post('/v1/validate', (req, res) => {
    try {
        const { licenseKey, machineId, product } = req.body || {};
        if (!licenseKey || !machineId) {
            return res.json({ valid: false, error: 'Missing licenseKey or machineId' });
        }
        const row = db.prepare('SELECT * FROM licenses WHERE key = ?').get(licenseKey);
        if (!row) return res.json({ valid: false, error: 'Unknown license key' });
        if (row.revoked) return res.json({ valid: false, error: 'License revoked' });
        if (row.expiresAt && new Date(row.expiresAt).getTime() <= Date.now()) {
            return res.json({ valid: false, error: 'License expired', type: row.type });
        }

        // Bind on first activation; reject mismatched machine afterwards.
        if (!row.boundMachineId) {
            db.prepare('UPDATE licenses SET boundMachineId = ?, lastSeenAt = ? WHERE key = ?')
              .run(machineId, new Date().toISOString(), licenseKey);
        } else if (row.boundMachineId !== machineId) {
            return res.json({ valid: false, error: 'License is bound to another machine' });
        } else {
            db.prepare('UPDATE licenses SET lastSeenAt = ? WHERE key = ?')
              .run(new Date().toISOString(), licenseKey);
        }

        res.json({
            valid: true,
            type: row.type,
            expires: row.expiresAt,
            product: product || null
        });
    } catch (e) {
        res.status(500).json({ valid: false, error: e.message });
    }
});

app.post('/admin/issue', requireAdmin, (req, res) => {
    const { type = 'Pro', ttlDays } = req.body || {};
    if (!['Standard', 'Pro', 'Lifetime'].includes(type)) {
        return res.status(400).json({ error: 'type must be Standard | Pro | Lifetime' });
    }
    const key = genKey(type === 'Lifetime' ? 'LT' : type === 'Pro' ? 'PRO' : 'STD');
    const expiresAt = (type === 'Lifetime' || !ttlDays)
        ? null
        : new Date(Date.now() + ttlDays * 86400_000).toISOString();
    db.prepare('INSERT INTO licenses (key, type, expiresAt, revoked, createdAt) VALUES (?, ?, ?, 0, ?)')
      .run(key, type, expiresAt, new Date().toISOString());
    res.json({ key, type, expiresAt });
});

app.post('/admin/revoke', requireAdmin, (req, res) => {
    const { key } = req.body || {};
    if (!key) return res.status(400).json({ error: 'key required' });
    const r = db.prepare('UPDATE licenses SET revoked = 1 WHERE key = ?').run(key);
    res.json({ revoked: r.changes === 1 });
});

app.get('/admin/list', requireAdmin, (req, res) => {
    const rows = db.prepare('SELECT key, type, expiresAt, boundMachineId, revoked, createdAt, lastSeenAt FROM licenses ORDER BY createdAt DESC LIMIT 500').all();
    res.json({ licenses: rows });
});

app.listen(PORT, () => {
    console.log(`Zoot licensing API listening on :${PORT} (db=${DB_PATH})`);
});

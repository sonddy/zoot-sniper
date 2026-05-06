/**
 * Zoot Licensing API — Cloudflare Worker variant.
 *
 * Bind a Workers KV namespace named ZOOT_LICENSES (see wrangler.toml) and an
 * environment secret ADMIN_TOKEN. Same JSON contract as server.js.
 *
 * KV layout:
 *   key:<licenseKey>  -> JSON record
 *   index:all         -> JSON array of license keys (for /admin/list)
 */

export default {
    async fetch(request, env) {
        const url = new URL(request.url);
        try {
            if (request.method === 'POST' && url.pathname === '/v1/validate') {
                return validate(request, env);
            }
            if (url.pathname.startsWith('/admin/')) {
                if (!env.ADMIN_TOKEN) return json(500, { error: 'ADMIN_TOKEN not configured' });
                const tok = (request.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
                if (tok !== env.ADMIN_TOKEN) return json(401, { error: 'unauthorized' });
                if (request.method === 'POST' && url.pathname === '/admin/issue')   return issue(request, env);
                if (request.method === 'POST' && url.pathname === '/admin/revoke')  return revoke(request, env);
                if (request.method === 'GET'  && url.pathname === '/admin/list')    return list(env);
            }
            return json(404, { error: 'not found' });
        } catch (e) {
            return json(500, { error: e.message });
        }
    }
};

async function validate(request, env) {
    const { licenseKey, machineId, product } = await request.json();
    if (!licenseKey || !machineId) return json(200, { valid: false, error: 'Missing licenseKey or machineId' });

    const raw = await env.ZOOT_LICENSES.get(`key:${licenseKey}`);
    if (!raw) return json(200, { valid: false, error: 'Unknown license key' });

    const rec = JSON.parse(raw);
    if (rec.revoked) return json(200, { valid: false, error: 'License revoked' });
    if (rec.expiresAt && new Date(rec.expiresAt).getTime() <= Date.now()) {
        return json(200, { valid: false, error: 'License expired', type: rec.type });
    }

    if (!rec.boundMachineId) {
        rec.boundMachineId = machineId;
    } else if (rec.boundMachineId !== machineId) {
        return json(200, { valid: false, error: 'License is bound to another machine' });
    }
    rec.lastSeenAt = new Date().toISOString();
    await env.ZOOT_LICENSES.put(`key:${licenseKey}`, JSON.stringify(rec));

    return json(200, {
        valid: true,
        type: rec.type,
        expires: rec.expiresAt,
        product: product || null
    });
}

async function issue(request, env) {
    const { type = 'Pro', ttlDays } = await request.json();
    if (!['Standard', 'Pro', 'Lifetime'].includes(type)) {
        return json(400, { error: 'type must be Standard | Pro | Lifetime' });
    }
    const block = () => Array.from(crypto.getRandomValues(new Uint8Array(2)))
        .map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    const yymmdd = new Date().toISOString().slice(2, 10).replace(/-/g, '');
    const typeCode = type === 'Lifetime' ? 'LT' : type === 'Pro' ? 'PRO' : 'STD';
    const key = `ZOOT-${block()}-${block()}-${block()}-${typeCode}-${yymmdd}`;
    const expiresAt = (type === 'Lifetime' || !ttlDays)
        ? null
        : new Date(Date.now() + ttlDays * 86400_000).toISOString();
    const rec = {
        key, type, expiresAt,
        boundMachineId: null,
        revoked: false,
        createdAt: new Date().toISOString()
    };
    await env.ZOOT_LICENSES.put(`key:${key}`, JSON.stringify(rec));

    const idxRaw = await env.ZOOT_LICENSES.get('index:all');
    const idx = idxRaw ? JSON.parse(idxRaw) : [];
    idx.unshift(key);
    await env.ZOOT_LICENSES.put('index:all', JSON.stringify(idx.slice(0, 5000)));

    return json(200, { key, type, expiresAt });
}

async function revoke(request, env) {
    const { key } = await request.json();
    if (!key) return json(400, { error: 'key required' });
    const raw = await env.ZOOT_LICENSES.get(`key:${key}`);
    if (!raw) return json(404, { revoked: false, error: 'unknown key' });
    const rec = JSON.parse(raw);
    rec.revoked = true;
    await env.ZOOT_LICENSES.put(`key:${key}`, JSON.stringify(rec));
    return json(200, { revoked: true });
}

async function list(env) {
    const idxRaw = await env.ZOOT_LICENSES.get('index:all');
    const idx = idxRaw ? JSON.parse(idxRaw) : [];
    const records = [];
    for (const k of idx.slice(0, 200)) {
        const raw = await env.ZOOT_LICENSES.get(`key:${k}`);
        if (raw) records.push(JSON.parse(raw));
    }
    return json(200, { licenses: records });
}

function json(status, body) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' }
    });
}

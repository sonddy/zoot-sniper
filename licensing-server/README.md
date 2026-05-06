# Zoot Licensing API

Reference licensing server for the v2 client. The client calls
`POST {LICENSE_API_URL}/validate` with `{ licenseKey, machineId, product, appVersion }`
and expects a JSON response of the form:

```json
{
  "valid": true,
  "type": "Pro",
  "expires": "2026-12-31T00:00:00Z"
}
```

or, on rejection:

```json
{ "valid": false, "error": "License revoked" }
```

The client transparently tolerates a 5 s timeout and 72 h offline grace period.

## Why

The v1 client shipped a `LICENSE_SECRET` and a hardcoded list of `MASTER_KEYS`
inside the asar. Anyone with `npx asar extract` could read them and bypass
licensing entirely. v2 strips both: the only secrets live here, server-side.

## Implementations

This folder ships two reference implementations. Pick whichever fits your stack —
both speak the same JSON.

### 1. Cloudflare Worker (`worker.js`)

Cheap (free tier covers thousands of activations per day), globally fast, no
infra to babysit. Stores license records in Workers KV.

```bash
cd licensing-server
npm i -g wrangler
wrangler kv:namespace create ZOOT_LICENSES
# Paste the namespace id into wrangler.toml
wrangler deploy
```

Set the client's API URL when packaging, e.g.

```bash
ZOOT_LICENSE_API_URL=https://license.zoot.bot/v1 npm run build:asar
```

### 2. Express server (`server.js`)

For self-hosting on a VPS. Stores licenses in a SQLite file via `better-sqlite3`.

```bash
cd licensing-server
npm install
npm start            # listens on :8787
```

## License record shape

```json
{
  "key": "ZOOT-AAAA-BBBB-CCCC-PRO-260101",
  "type": "Pro",
  "expiresAt": "2026-12-31T00:00:00Z",
  "boundMachineId": "ABCDEF0123456789",  // null = first activation will bind
  "revoked": false,
  "createdAt": "2026-01-15T12:34:56Z"
}
```

Activation rule: a key with `boundMachineId === null` is bound to the first
machine that validates it. Subsequent calls from a different machine fail with
`"License is bound to another machine"`. Keys with `revoked: true` always fail.

## Issuing keys

`POST /admin/issue` (gated by `ADMIN_TOKEN`):

```json
{ "type": "Pro", "ttlDays": 90 }
```

returns

```json
{ "key": "ZOOT-...-PRO-260801", "expiresAt": "..." }
```

`POST /admin/revoke` with `{ "key": "..." }` flips the revoked flag.

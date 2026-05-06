# Changelog

## v2.0.0 — security, safety, profitability overhaul

### Security
- **Encrypted private keys at rest.** Configs are now sealed with Electron
  `safeStorage` (DPAPI on Windows, Keychain on macOS, libsecret on Linux).
  The on-disk format stores only the encrypted blob; we never write a
  plaintext key back. Existing v1 plaintext configs are auto-migrated on
  first launch.
- **Master license keys removed from the shipped JS.** v1 had
  `MASTER_KEYS = ['ZOOT-MASTER-OWNER-2024', 'ZOOT-ADMIN-FOREVER-KEY',
  'ZOOT-SONDDY-UNLIMITED']` and a shared `LICENSE_SECRET` baked into the asar.
  Both are gone. The client now defers to a server (`./licensing-server`)
  with a 72 h offline grace window.

### Safety / risk controls
- **Real anti-rug.** Wires the `antiRug` toggle to (a) a tick-driven detector
  for sudden 60%+ price collapses, (b) a 15 s freeze-authority watcher that
  emergency-sells if a token's freeze authority is added back. Trial tokens
  with the freeze authority already revoked at launch are left alone, as
  expected.
- **Daily loss circuit breaker.** `dailyLossCapSOL` blocks new buys for the
  rest of the trading day after net P&L crosses the threshold.
- **Max concurrent positions** cap.
- **Losing-streak cooldown** (`cooldownAfterLosses`, `cooldownSeconds`)
  pauses new buys after N consecutive losers.

### Speed / profitability
- **Tick-driven exits.** Replaces the 10 s `setInterval` price poll with
  per-position PumpPortal `subscribeTokenTrade` subscriptions, so partial
  sells, trailing stops, and stop-loss fire on the very next on-chain trade.
  The poll loop remains as a safety net.
- **Jito bundle path.** `useJitoBundles` + `jitoTipSOL` route buys through
  the Jito Block Engine with a configurable tip; falls back transparently
  to the regular RPC send if no engine accepts the bundle.

### Trust
- **Paper trade / dry run mode.** When `paperTrade` is on, the bot runs the
  full detection + filter + exit logic but never calls
  `connection.sendRawTransaction`. Lets users validate settings before
  risking SOL.

### UX
- **Token icons rewritten.** The live feed now (a) keeps a placeholder until
  an image is verified, (b) routes every fetch through the main process
  (`fetch-image-base64`) to bypass renderer `webSecurity`, IPFS-gateway
  flakiness, and mixed-content failures, and (c) deduplicates concurrent
  fetches per mint. IPFS URLs are normalized through `cloudflare-ipfs.com`.
  No more broken broken-image icons.

### Repo
- v1 was a `.exe` only distribution; v2 is a real source repo with a
  `npm run build:asar` task that repackages `_extracted/` back into
  `resources/app.asar` so the existing Electron binary picks up changes.

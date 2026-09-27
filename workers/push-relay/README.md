# Personal Telar push relay

The Mac decides which paired phones receive alerts and Live Activity updates.
Cloudflare signs and forwards those requests to Apple's APNs service.
Conversations and approvals continue over the existing paired host connection.

This deployment uses the existing **Workers Free** plan and SQLite Durable
Objects. It does not enable billing or paid services. Free quotas can stop
notifications until the quota resets. This is a personal deployment, not a
public registration service.

## v2: self-service, no Mac provisioning

Everything is served under `/v2/`; there is no host registry and no Mac is
provisioned. v1 (hand-provisioned Mac bearers, `/v1/`) is retired and its
routes answer 404. v2 adds no secrets: it reads the App Attest team from
`TELAR_APNS_TEAM_ID`, and bundle ids are fixed in code. The App IDs must have
the App Attest capability enabled.

| Who | Request | Proof |
|---|---|---|
| Phone | `GET /v2/challenge` → `{challenge}` | none; per-IP limited, single use, 5 minutes |
| Phone | `POST /v2/devices` `{keyId, attestation, challenge, bundle, sandbox, token, pushToStartToken?, activities:[{id, token}]}` → `201 {handle}` | App Attest attestation over `SHA256(challenge)` |
| Phone | `PUT /v2/devices/:handle` (refresh tokens), `DELETE` (forget everything) | `x-telar-assertion` over `"<METHOD> <path>\n<body>"` |
| Phone | `POST /v2/devices/:handle/keys` `{pairing}` → `201 {keyId, sendKey}`; `DELETE …/keys/:keyId` | assertion as above |
| Mac | `POST /v2/devices/:handle/push` `{kind:"alert"\|"liveactivity"\|"background", start?, activity?, collapseId, payload}` → `{status, reason?}` | `x-telar-key`, `x-telar-timestamp` (ms), `x-telar-signature` = hex HMAC-SHA256(sendKey, `"<ts>\nPOST\n<path>\n<body>"`) |

- **Tokens stay in the relay.** The Mac names a kind and, for a Live
  Activity, the activity id the phone registered. The relay picks the token,
  the topic (`<bundle>` or `<bundle>.push-type.liveactivity`) and the APNs host
  (`sandbox` → `api.sandbox.push.apple.com`).
- **Bundles:** `io.github.novarix.telar` and `io.github.novarix.telar.dev`, plus the pre-#1042
  `com.telar.mobile` and `com.telar.mobile.dev` for phones not yet moved.
- **Keys:** there is one send key per pairing. Asking again for the same
  `pairing` rotates that key. Each handle holds at most 16 keys. A key unused
  for 60 days, or a handle the phone has not refreshed in 60 days, expires.
- **Signatures:** a signature is refused outside ±5 minutes or if seen before.
  Timestamps from one Mac must strictly increase.
- **Limits:**
  - per IP (IPv6 by /64): 30 challenges, 10 registrations, 240 phone requests
    and 3,000 sends an hour;
  - per handle: 120 sends a minute and 5,000 a day; `background` (silent
    read-sync, `aps` exactly `{"content-available":1}`, priority 5, the
    phone's own bundle as topic) may only spend the first 4,000, answering
    429 `background_budget` with no `Retry-After` past that;
  - across all of v2: 40,000 requests a day, answered with `503` and
    `Retry-After`.
- **Dead tokens:** a token Apple disowns is dropped. The handle and its keys
  stay, and the phone's next refresh restores delivery.

## Deploy

Run **Deploy personal push relay** in GitHub Actions. Deployment requires
variable `CLOUDFLARE_ACCOUNT_ID`, secret `CLOUDFLARE_API_TOKEN` scoped to
Workers Scripts Write, and secrets `TELAR_APNS_KEY_P8_BASE64`,
`TELAR_APNS_KEY_ID`, `TELAR_APNS_TEAM_ID`. The deployment's temporary secrets
file is permission-restricted and deleted.

The deployed address is `https://telar-push-relay.facundo-barbera.workers.dev`.
Apple's signing key stays in GitHub secrets and the deployed Worker secret.
A single internal signer (`RelaySigner`) reuses its APNs JWT across isolates
and restarts to avoid Apple's excessive token refresh limit. Payload logging is
disabled. The public `/health` endpoint exposes no configuration or token data.

## Validation

`node --test workers/push-relay/worker.test.mjs` covers attestation and
assertion checks, send-key signatures and replay, limits, dead-token handling,
persisted signer reuse, and that v1 routes are gone.

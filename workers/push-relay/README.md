# Personal Telar push relay

The Mac decides which paired devices receive alerts and Live Activity updates.
Cloudflare signs and forwards those requests to Apple's production APNs service.
Conversations and approvals continue over the existing paired host connection.

This deployment uses the existing **Workers Free** plan and SQLite Durable
Objects. It does not enable billing or paid services. Free quotas can stop
notifications until the quota resets. This is a personal deployment, not a
public registration service.

## v2: self-service, no Mac provisioning

v2 runs alongside v1 on the same Worker, under `/v2/`, and needs no host
registry. It adds no secrets: it reads the App Attest team from
`TELAR_APNS_TEAM_ID`, and bundle ids are fixed in code. The App IDs must have
the App Attest capability enabled.

| Who | Request | Proof |
|---|---|---|
| Phone | `GET /v2/challenge` → `{challenge}` | none; per-IP limited, single use, 5 minutes |
| Phone | `POST /v2/devices` `{keyId, attestation, challenge, bundle, sandbox, token, pushToStartToken?, activities:[{id, token}]}` → `201 {handle}` | App Attest attestation over `SHA256(challenge)` |
| Phone | `PUT /v2/devices/:handle` (refresh tokens), `DELETE` (forget everything) | `x-telar-assertion` over `"<METHOD> <path>\n<body>"` |
| Phone | `POST /v2/devices/:handle/keys` `{pairing}` → `201 {keyId, sendKey}`; `DELETE …/keys/:keyId` | assertion as above |
| Mac | `POST /v2/devices/:handle/push` `{kind:"alert"\|"liveactivity", start?, activity?, collapseId, payload}` → `{status, reason?}` | `x-telar-key`, `x-telar-timestamp` (ms), `x-telar-signature` = hex HMAC-SHA256(sendKey, `"<ts>\nPOST\n<path>\n<body>"`) |

- **Tokens stay in the relay.** The Mac names a kind and, for a Live
  Activity, the activity id the phone registered. The relay picks the token,
  the topic (`<bundle>` or `<bundle>.push-type.liveactivity`) and the APNs host
  (`sandbox` → `api.sandbox.push.apple.com`).
- **Bundles:** `com.telar.mobile` and `com.telar.mobile.dev`.
- **Keys:** there is one send key per pairing. Asking again for the same
  `pairing` rotates that key. Each handle holds at most 16 keys. A key unused
  for 60 days, or a handle the phone has not refreshed in 60 days, expires.
- **Signatures:** a signature is refused outside ±5 minutes or if seen before.
  Timestamps from one Mac must strictly increase.
- **Limits:**
  - per IP (IPv6 by /64): 30 challenges, 10 registrations, 240 phone requests
    and 3,000 sends an hour;
  - per handle: 120 sends a minute and 5,000 a day;
  - across all of v2: 40,000 requests a day, answered with `503` and
    `Retry-After`.
- **Dead tokens:** a token Apple disowns is dropped. The handle and its keys
  stay, and the phone's next refresh restores delivery.

## Provision and deploy (v1)

1. Run `swift workers/push-relay/provision-host.swift` on the Mac. It generates
   a random runtime credential in Keychain, or reuses its existing identity.
   Its output contains only the host ID and public SHA-256 credential hash.
2. Add that record to the JSON array in GitHub repository variable
   `TELAR_PUSH_HOSTS`, preserving other authorized hosts.
3. Run **Deploy personal push relay** in GitHub Actions. Deployment requires
   variable `CLOUDFLARE_ACCOUNT_ID`, secret `CLOUDFLARE_API_TOKEN` scoped to
   Workers Scripts Write, and secrets `TELAR_APNS_KEY_P8_BASE64`,
   `TELAR_APNS_KEY_ID`, `TELAR_APNS_TEAM_ID`.
4. Run a desktop build containing the mobile push worker. Cockpit startup
   reads the runtime identity from Keychain. Pair the production iPhone build
   and enable notifications in Settings.

The deployed address is `https://telar-push-relay.facundo-barbera.workers.dev`.
The Mac credential is never a release artifact or a GitHub deployment key.
Apple's signing key stays in GitHub secrets and the deployed Worker secret.
The deployment's temporary secrets file is permission-restricted and deleted.

## Boundaries and revocation

Each request verifies the host registry before selecting that host's durable
state. Hosts can only send to their own registered phone and activity tokens.
The API accepts production `com.telar.mobile` destinations only. Per host:
32 phones, 8 followed activity tokens per phone, 120 operations per minute.
Registrations expire after 24 hours and the trusted host refreshes before send.
APNs payloads are bounded to 4096 bytes. Payload logging is disabled.

Removing a host's record from `TELAR_PUSH_HOSTS` and redeploying revokes all
its requests. Device revocation on the Mac removes its local and relay
registration on the next poll. A single internal signer reuses its APNs JWT
across isolates and restarts to avoid Apple's excessive token refresh limit.
The public `/health` endpoint exposes no configuration or token data.

## Validation

`node --test workers/push-relay/worker.test.mjs` covers host authentication,
revocation, destination restrictions, rate/device caps, expired activity token
handling and persisted signer reuse. Web tests cover paired-device role gates
and the host-to-relay adapter. A dummy-device response from Apple establishes
transport and signing only; actual notification and Live Activity delivery
requires the signed iPhone build.

Automatic cards use a separately registered ActivityKit push-to-start token.
That token can start a card but cannot update one; per-card tokens can update
or end it but cannot start another. Starts and ends use immediate APNs priority.

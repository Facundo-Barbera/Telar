# Personal Telar push relay

The Mac decides which paired devices receive alerts and Live Activity updates.
Cloudflare signs and forwards those requests to Apple's production APNs service.
Conversations and approvals continue over the existing paired host connection.

This deployment uses the existing **Workers Free** plan and SQLite Durable
Objects. It does not enable billing or paid services. Free quotas can stop
notifications until the quota resets. This is a personal deployment, not a
public registration service.

## Provision and deploy

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

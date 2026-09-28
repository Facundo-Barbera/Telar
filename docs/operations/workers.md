# Cloudflare Workers

There are two Workers. Neither is a Bun workspace member, and neither has dependencies.

| Worker | Directory | Config | Purpose |
| --- | --- | --- | --- |
| `telar-push-relay` | `workers/push-relay` | `wrangler.json` | signs and forwards alerts, Live Activity and background pushes to APNs for paired phones |
| `telar-updates-proxy` | `workers/updates-proxy` | `wrangler.toml` | gates read access to the private R2 bucket that serves desktop updates |

## Tests

```sh
bun run test:workers
```

This runs `node --test workers/push-relay/worker.test.mjs workers/updates-proxy/worker.test.mjs`, so it needs `node` on PATH. CI runs the same command in the `Test workers` job of `verify.yml`. To run one Worker's tests:

```sh
node --test workers/push-relay/worker.test.mjs
node --test workers/updates-proxy/worker.test.mjs
```

## Push relay

The routes, the App Attest registration, send-key signatures and rate limits are described in `workers/push-relay/README.md`. The public health check is `GET /health`, which returns `{"service":"telar-push","version":2}`.

### Deploying with the workflow

Deploys run from `deploy-push-relay.yml` ("Deploy personal push relay"). It runs the relay tests, then `node workers/push-relay/deploy.mjs`.

It triggers on a push to `main` that touches `workers/push-relay/**` or the workflow file, so merging a relay change deploys it. To redeploy without a change, dispatch it:

```sh
gh workflow run deploy-push-relay.yml --ref main
gh run watch
```

A dispatch deploys whatever ref you give it, and it reaches the production relay.

### Deploying by hand

`deploy.mjs` needs these environment variables. It exits before deploying if any is missing:

- `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN` (Workers Scripts Write)
- `TELAR_APNS_KEY_P8_BASE64`, `TELAR_APNS_KEY_ID`, `TELAR_APNS_TEAM_ID`

Export them in your shell, for example from a password manager. Don't type them inline, then run from the repo root:

```sh
node workers/push-relay/deploy.mjs
```

It writes the three APNs values to a temporary `0600` secrets file and runs `npx --yes wrangler@4.129.1 deploy --config workers/push-relay/wrangler.json --secrets-file <file>`. The file is deleted afterwards. Each deploy therefore sets the Worker secrets too.

### Secrets and settings

| Where | Name | Notes |
| --- | --- | --- |
| GitHub variable | `CLOUDFLARE_ACCOUNT_ID` | a repository variable (`vars.`), not a secret |
| GitHub secret | `CLOUDFLARE_API_TOKEN` | |
| GitHub secret | `TELAR_APNS_KEY_P8_BASE64`, `TELAR_APNS_KEY_ID`, `TELAR_APNS_TEAM_ID` | mapped to the Worker secrets below |
| Worker secret | `APNS_KEY_BASE64`, `APNS_KEY_ID`, `APNS_TEAM_ID` | set by `deploy.mjs` on every deploy |
| Worker var (optional) | `APPATTEST_TEAM_ID` | App Attest team; falls back to `APNS_TEAM_ID` |
| Worker var (optional) | `APPATTEST_ROOT`, `GLOBAL_DAILY_BUDGET`, `HANDLE_BACKGROUND_CEILING` | test overrides; production uses the code defaults |

Until all three APNs secrets and the three Durable Object bindings are present, every known `/v2/` route returns 503.

### Durable Objects

`wrangler.json` binds `SIGNER` (`RelaySigner`), `GATE` (`RelayGate`) and `DEVICE_STATE` (`RelayDevice`). Its `migrations` list has three tags, `v1` to `v3`. To add, rename or delete a class, append a new tag rather than editing an existing one.

## Updates proxy

The proxy accepts only `GET` and `HEAD`, and only with an `X-Telar-Update-Key` header equal to the `UPDATE_KEY` secret. Any other method gets 405, and a missing or wrong key gets 403. The request path is the R2 object key in the `TELAR_UPDATES` binding (bucket `telar-updates`). The proxy serves single-range and multi-range requests, so electron-updater's differential downloads work.

It is read-only. CI writes to the bucket directly with R2 API credentials (see [release-desktop.md](release-desktop.md)).

### Deploying

No workflow deploys the proxy. Deploy it by hand with wrangler, logged in to the account that owns the bucket:

```sh
bunx wrangler@4.129.1 deploy --config workers/updates-proxy/wrangler.toml
```

Set or rotate the key with:

```sh
bunx wrangler@4.129.1 secret put UPDATE_KEY --config workers/updates-proxy/wrangler.toml
```

wrangler prompts for the value, so it stays out of your shell history.

### Secrets

| Where | Name | Must match |
| --- | --- | --- |
| Worker secret | `UPDATE_KEY` | GitHub secret `UPDATE_PROXY_KEY` |
| GitHub secret | `UPDATE_PROXY_URL` | the deployed proxy's URL |
| GitHub secret | `R2_BUCKET` | `bucket_name` in `wrangler.toml` (`telar-updates`) |

Every packaged app has the key baked in at build time. Rotating `UPDATE_KEY` makes installed apps get 403 on every update check, and they can't recover by themselves: a new key only reaches them through an update. Don't rotate the key unless you also plan to reinstall every app by hand.

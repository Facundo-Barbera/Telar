# Disposable APNs transport probe

This test establishes whether a standard Cloudflare Worker on the existing Free
plan can reach APNs and sign requests with the GitHub-managed APNs credential.
It is not a production relay or proof of notification delivery to an iPhone.

Run local checks with `node --test workers/apns-probe/worker.test.mjs`.
The `APNs free Worker probe` workflow supplies credentials from GitHub secrets,
creates a uniquely named Worker, invokes its authenticated probe, and deletes
it and its secret bindings in `finally`. Its endpoint expires after ten minutes
as a backstop; if a CI runner is forcibly terminated, manually delete only that
run's `telar-apns-probe-<run id>-<attempt>` Worker. No database, queue, container,
subscription, or existing update Worker is modified.

The probe uses a fixed all-zero device token and a fixed payload. It accepts no
user-provided destinations or notification contents. It cannot test delivery to
a real device. Provider credentials and JWTs never appear in its response.

## Verified on September 7, 2026

[Successful GitHub Actions run](https://github.com/Facundo-Barbera/Telar/actions/runs/34152998182)
from commit `212d79604ab9d6d20be33ae61f3b8174d959f505`:

- Unauthenticated callers: rejected with 401.
- Direct Node HTTP/2 control: APNs 400 `BadDeviceToken`.
- Unsigned Worker request: APNs 403 `MissingProviderToken`.
- Signed Worker request: APNs 400 `BadDeviceToken`.
- Cleanup: temporary Worker and secret bindings deleted successfully.
- Cloudflare dashboard confirmed the account's current plan was Free.

Earlier attempts failed because the probe used Fetch's `redirect: "error"`,
which Workers rejects. `redirect: "manual"` works and prevents credential
forwarding. Node's `http2` module is not needed by the Worker implementation.

This is evidence for transport and signing feasibility within the free runtime,
not a forecast of production capacity or proof of real-device delivery. A
production relay still needs per-host authentication, destination registration,
revocation, rate limits, retries, and signed-device acceptance. Keep the $0
additional hosting constraint: do not enable a paid plan as part of deployment.

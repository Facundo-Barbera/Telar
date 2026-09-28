# Releasing the iOS app

The iOS app ships only through TestFlight. A maintainer cuts a nightly by pushing a tag. CI archives, signs, uploads, and offers the build to the internal and external testers.

## Bundle ids

| Bundle id | What uses it |
| --- | --- |
| `io.github.novarix.telar` | The TestFlight app ("Telar" on the home screen). It is the project default for `TELAR_APP_BUNDLE_ID`, so every Release archive and every App Store Connect call uses it. |
| `io.github.novarix.telar.activity` | The `TelarActivity` widget extension, which draws the Live Activity. It is always `$(TELAR_APP_BUNDLE_ID).activity`. |
| `io.github.novarix.telar.dev` | "Telar Dev": a Debug build with the amber icon, installed by cable through `apps/ios/phone.sh`. iOS treats it as a separate app from the TestFlight build, and each keeps its own pairing. |
| `io.github.novarix.telar.dev.activity` | The extension inside "Telar Dev". |

The push relay (`workers/push-relay/v2.mjs`) and the cockpit's push topics (`apps/web/src/lib/mobile/push.ts`) accept the app and `.dev` ids.

To change the id, override `TELAR_APP_BUNDLE_ID`. Never override `PRODUCT_BUNDLE_IDENTIFIER`, because the app and the extension would then share one id. The only entitlement is `aps-environment`: `development` in Debug and `production` in Release (`Config/TelarMobile.entitlements`). There are no app groups. The team is `MM74W7WGAM`.

## Cutting a nightly

Tags are pushed by hand. There is no schedule. The workflow accepts any `ios-nightly-*` tag, and the convention is `ios-nightly-YYYYMMDD-HHMM` in local time:

```sh
git fetch origin main
TAG="ios-nightly-$(date +%Y%m%d-%H%M)"
git tag "$TAG" origin/main
git push origin "$TAG"
```

The tag must point at a commit on `main`, or the workflow refuses to build it. The build number comes from the runner's clock (`YYYYMMDDHHMM`, UTC), not from the tag. A re-run therefore always gets a fresh number.

To re-run without a new tag, dispatch the workflow on `main`. On any other ref the job is skipped:

```sh
gh workflow run nightly-ios.yml --ref main
```

## What `nightly-ios.yml` does

The workflow runs on `macos-latest` with `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`, and has a timeout of 80 minutes. It runs one build at a time.

1. It refuses a tag that is not an ancestor of `origin/main`.
2. It refuses a beta Xcode, because App Store Connect rejects uploads built with one.
3. It decodes the App Store Connect API key into `$RUNNER_TEMP`.
4. It imports the Apple Distribution `.p12` into a temporary keychain.
5. It runs `apps/ios/nightly.sh`, which does the following:
   - archives the Release build unsigned, then ad hoc signs the app with its entitlements. The export only keeps entitlements the archive already has.
   - fails unless the archived app has `aps-environment=production`.
   - exports with `ExportOptions.plist` (`app-store-connect`, `destination: export`, `signingCertificate: Apple Distribution`), which re-signs the app for distribution. The export runs with `/usr/bin` first on `PATH`.
   - fails unless the exported IPA still has `aps-environment=production`.
   - runs `testflight-app.sh`, which makes sure the App Store Connect app record is ready (see below).
   - uploads with `xcrun altool`. It judges the result from the output (`UPLOAD SUCCEEDED`, no `ERROR`), because altool can exit 0 after a rejection.
   - runs `testflight-external.sh <build-number>` to offer the build to the external group.
6. It restores the keychain search list and deletes the key and the keychain.

## TestFlight

The App Store Connect app is found by bundle id. `testflight-app.sh` runs before every upload and is idempotent:

- It finds the app, and fails if there is no single app for the bundle id.
- It makes sure an internal group named `Internal` exists with `hasAccessToAllBuilds`, and that the account holder is a tester in it.
- It copies the beta app description, feedback email, privacy URL and Beta App Review contact from the template app (`TELAR_ASC_TEMPLATE_APP_ID`, default `6807300090`) wherever the new app has none. It never copies demo-account credentials.
- It creates an empty external group named `Nightly`. Inviting external testers is done by hand in App Store Connect.

Only a missing app record fails the script. The other steps print `::warning::` and continue.

How a build reaches testers:

- **Internal**: automatic once Apple finishes processing, usually minutes after the upload. There is no review. Builds expire after 90 days, and testers update through the TestFlight app.
- **External (`Nightly`)**: `testflight-external.sh` handles this. It polls until the build is `VALID` (up to 30 minutes), sets the en-US "What to Test" text, adds the build to the external group, and submits it for Beta App Review. The first build of a new marketing version can wait in review for hours. Later builds of the same version clear in minutes.

The marketing version is `MARKETING_VERSION` in `apps/ios/TelarMobile.xcodeproj/project.pbxproj`. It is set separately on the app, the extension and the unit-test targets, so bump them together.

## Signing and secrets

Signing uses two credentials, and both are repository secrets:

| Secret | Use |
| --- | --- |
| `APPLE_API_KEY_P8_BASE64` | App Store Connect API key (`.p8`, base64). Used for `-allowProvisioningUpdates`, the altool upload and the App Store Connect API calls. The desktop release shares it for notarization. |
| `APPLE_API_KEY_ID` | That key's id. The scripts receive it as `TELAR_ASC_KEY_ID`. |
| `APPLE_API_ISSUER` | That key's issuer id. The scripts receive it as `TELAR_ASC_ISSUER_ID`. |
| `IOS_DIST_CERT_P12_BASE64` | Apple Distribution certificate and private key (`.p12`, base64). |
| `IOS_DIST_CERT_PASSWORD` | The `.p12` password. |

- **API key role**: Admin. `testflight-app.sh` lists users, which needs Admin.
- **Certificate**: it must be a real Apple Distribution certificate. Apple's validator rejects cloud-managed signatures with error 90035.
- **Provisioning profiles**: not stored anywhere. `-allowProvisioningUpdates` with the API key creates or refreshes them on each run. The team uses automatic signing throughout.

### Rotating the distribution certificate

`scripts/create-apple-cert.mjs` requests only `DEVELOPER_ID_APPLICATION` certificates, which the desktop app uses. It cannot produce the iOS certificate.

To rotate the iOS certificate:

1. Create an Apple Distribution certificate in Xcode (Settings → Accounts → Manage Certificates) or in the developer portal.
2. Export it together with its private key as a `.p12`.
3. Update the secrets. The `.p12` and its password stay out of the shell history:

```sh
base64 -i dist.p12 | gh secret set IOS_DIST_CERT_P12_BASE64
gh secret set IOS_DIST_CERT_PASSWORD
```

4. Delete the local `.p12`.
5. Run the export probe to confirm the new certificate works before cutting a tag.

## Export probe

`ios-export-probe.yml` runs the production `nightly.sh --export-only` with the same secrets. It archives and exports, then asserts that the IPA is signed `Apple Distribution` and stops. It never uploads, so it is safe to run at any time.

- **By hand**: Actions → "iOS export probe" → Run workflow, on any ref.
- **By push**: push to a branch named `telar/*-probe-*` that touches `ios-export-probe.yml`, `apps/ios/nightly.sh` or `apps/ios/ExportOptions.plist`.

```sh
gh workflow run ios-export-probe.yml --ref <branch>
```

If the export fails, the probe prints the filtered error lines from the export's `.xcdistributionlogs`. Use it for any change to the export, signing or `ExportOptions.plist`.

## Running the pipeline by hand

`nightly.sh` accepts three modes and rejects anything else:

```sh
apps/ios/nightly.sh --no-upload     # archive only; needs no credentials
apps/ios/nightly.sh --export-only   # archive and export; needs TELAR_ASC_*
apps/ios/nightly.sh                 # archive, export, upload, offer to Nightly
```

The credential variables are `TELAR_ASC_KEY_ID`, `TELAR_ASC_ISSUER_ID` and `TELAR_ASC_KEY_PATH` (the path to the `.p8`). `TELAR_BUNDLE_ID` overrides the target app. Output goes to `apps/ios/DerivedData-nightly/`.

To offer an existing upload to the external group again, for example after the processing wait timed out, pass the build number the log printed as `uploaded build N`:

```sh
apps/ios/testflight-external.sh 202609270517
```

`testflight-external.sh` accepts these optional overrides: `TELAR_ASC_APP_ID`, `TELAR_TESTFLIGHT_EXTERNAL_GROUP`, `TELAR_ASC_POLL_SECONDS`, `TELAR_ASC_POLL_TIMEOUT_SECONDS` and `TELAR_TESTFLIGHT_WHATS_NEW`. Both TestFlight scripts share `apps/ios/asc.sh`, which mints a fresh ES256 JWT for each call and never prints it. Their tests are in `apps/desktop/testflight-external.test.js`, with `curl` stubbed:

```sh
cd apps/desktop && bun test testflight-external.test.js
```

## Pull request gate

`verify.yml`'s `ios` job runs on a Mac only when `ios-paths.sh` matches a changed path: `apps/ios/**`, `verify.yml` or `ios-paths.sh`. Changes to `nightly-ios.yml` and `ios-export-probe.yml` do not trigger it. The job:

1. Archives Release unsigned and asserts that both the app and the extension are Mach-O binaries.
2. Reports the Swift expressions over the 500 ms type-check floor. This step never fails on slow expressions.
3. Runs `-only-testing:TelarMobileTests` on `iPhone 17` in the simulator, with a minimum count of passed tests.

A green pull request does not prove that signing or export works. Only the probe or a nightly does.

## Common failures

| Symptom | Cause and fix |
| --- | --- |
| `... is not an ancestor of origin/main` | The tag was cut from a branch. Delete it and tag a commit on `origin/main`. |
| Job skipped on dispatch | It was dispatched on a ref other than `main`. |
| `is a beta Xcode` | The runner image's default Xcode is a beta. Wait for the image to update, or pin `DEVELOPER_DIR` to a release Xcode. |
| Archive fails with "unable to type-check this expression in reasonable time" | Hosted runners are slower than a desktop Mac. Split the expression. Raising the solver limits does not help. |
| `archived app has aps-environment='<missing>'` | The ad hoc signing step or the entitlements file broke. Check `Config/TelarMobile.entitlements` and `APS_ENVIRONMENT`. |
| `exported IPA has aps-environment=...` | The distribution profile does not grant Push Notifications. Enable the capability on the `io.github.novarix.telar` App ID and re-run; the profile regenerates. |
| `exportArchive Copy failed`, exit 70 | A non-system `rsync` answered the export's staging copy. `nightly.sh` pins `/usr/bin` first on `PATH`, so check that the pin is still in place and run the probe. |
| 90035 at upload, or the probe says the IPA is not Apple Distribution signed | The certificate secret is missing, expired or not a distribution certificate. Rotate it (see above). |
| `upload FAILED` | Read altool's `ERROR` lines above the failure. Re-running mints a new build number. |
| `no single app with bundle id` | Create the app record in App Store Connect for `io.github.novarix.telar`. |
| `was still not processed after 1800s` (warning) | The upload succeeded and internal testers get the build, but external testers do not. Re-run `testflight-external.sh <build>`. |
| `no EXTERNAL beta group named 'Nightly'` | Create the group in App Store Connect → TestFlight, or check the `testflight-app.sh` warnings in the same log. |
| Beta App Review submission refused | The error line carries Apple's `detail` (for example, missing export compliance or review contact). Fix it in App Store Connect, then re-run `testflight-external.sh <build>`. |

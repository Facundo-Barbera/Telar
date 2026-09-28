# Releasing the desktop app

Desktop builds are signed, notarized and uploaded to a private R2 bucket. Installed apps read that bucket through the `updates-proxy` Worker (see [workers.md](workers.md)). There are two channels, and each has its own workflow:

| Channel | Workflow | Tag | GitHub Release |
| --- | --- | --- | --- |
| `nightly` | `nightly-desktop.yml` | `v0.1.0-nightly.YYYYMMDD.N` | none |
| `beta` | `release-desktop.yml` | `v0.1.0-beta.N` | prerelease with zip and dmg |

Both workflows build only commits on `origin/main`. A tag that is not an ancestor of `origin/main` fails the first step, and a manual dispatch runs only when dispatched from `main`.

## Versions and tags

`scripts/set-desktop-version.mjs` computes the version. It keeps the `x.y.z` base from `apps/desktop/package.json` (currently `0.1.0`) and adds:

- nightly: `-nightly.<UTC date YYYYMMDD>.<N>`, where `N` is one more than the highest existing `v<base>-nightly.<date>.*` tag, or `1` if none exists yet;
- beta: `-beta.<N>`, where `N` is one more than the highest existing `v<base>-beta.*` tag.

When the run is triggered by a tag, the tag is the version: `--version` passes it through, and the script only checks that it contains `-<channel>.`. electron-builder takes the update channel from the prerelease tag, so the version and `--channel` must agree.

To bump the base (for example to `0.2.0`), change `version` in `apps/desktop/package.json` on main.

## Cutting a build

There are two ways to cut a build, and both are equivalent.

Push a tag on a main commit. The tag triggers the workflow and names the version:

```sh
git fetch origin main --tags
git tag v0.1.0-nightly.20260927.5 origin/main
git push origin v0.1.0-nightly.20260927.5
```

```sh
git tag v0.1.0-beta.7 origin/main
git push origin v0.1.0-beta.7
```

Or dispatch from main. There are no inputs. The nightly builds the tip of `origin/main`, the beta builds the commit `main` pointed at when dispatched, and both derive the version themselves:

```sh
gh workflow run nightly-desktop.yml --ref main
gh workflow run release-desktop.yml --ref main
```

After a dispatched nightly publishes, the workflow pushes the `v<version>` tag, which later runs count. A dispatched beta gets its tag from `gh release create --target`, on the commit it built.

Pick tag numbers that sort above the version currently on the channel. Clients compare semver, and numeric prerelease parts compare as numbers.

## What a run does

1. Checks out with full history and tags, and refuses a tag that is not on main.
2. Imports the Developer ID certificate into a temporary per-run keychain, and restricts the keychain search list to it. The last step restores the search list and deletes the keychain.
3. Writes the App Store Connect API key, and installs the `aws` CLI if it is missing.
4. Runs `scripts/build-desktop.sh`:
   - takes a clean `git worktree` snapshot of the ref, so local changes never ship;
   - runs a frozen install and builds the pinned computer-use helper (`apps/desktop/computer-use-helper.json`);
   - builds the standalone web server and stamps `build-info.json` (sha, ref, channel);
   - sets the version, then runs `electron-builder --mac`. The app is signed from the keychain and notarized when `APPLE_API_KEY*` are set;
   - verifies the signature, checks that the helper has Telar's team ID, and runs `spctl --assess`;
   - runs `Telar.app --smoke`, which must print `SMOKE_OK` and `ENGINE_WORKER_OK`;
   - uploads zip/dmg/blockmap to R2 first, and `<channel>-mac.yml` last, under `--feed-prefix`.
5. Nightly: pushes the tag (dispatch only). Beta: creates the GitHub prerelease.

Targets: nightly builds `zip` only, beta builds `zip,dmg`. Both run on `macos-latest`. Nightlies share the `nightly-publish` concurrency group and betas the `Release desktop app` group. A run in progress is never cancelled; a new run queues behind it, and GitHub keeps only the newest queued run.

### Secrets used

All are GitHub repository secrets. Set them, never print them:

- Signing: `MACOS_CERT_P12_BASE64`, `MACOS_CERT_PASSWORD`, `MACOS_KEYCHAIN_PASSWORD`
- Notarization: `APPLE_API_KEY_P8_BASE64`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`
- Upload: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`
- Feed: `UPDATE_PROXY_URL` (becomes `publish.url`), `UPDATE_PROXY_KEY` (baked into the packaged `package.json` as `updateProxyKey`)

`UPDATE_PROXY_KEY` must equal the Worker's `UPDATE_KEY`. If they differ, every installed app gets 403 on update checks.

## Bucket layout and update channels

```
<bucket>/
  beta-mac.yml, nightly-mac.yml, *.zip ...     com.telar.desktop installs; frozen
  io.github.novarix.telar/
    beta-mac.yml, nightly-mac.yml              feeds for the current app id
    *.zip, *.blockmap, *.dmg
    handoff-beta-mac.json, handoff-nightly-mac.json
```

- The app id is `io.github.novarix.telar` (`apps/desktop/package.json` `build.appId`). `scripts/feed-prefix.sh` refuses to publish any id other than `com.telar.desktop` to the bucket root, so builds pass `--feed-prefix io.github.novarix.telar`.
- The proxy treats the request path as the object key, so a prefix needs no Worker change.
- The app reads its channel from `update-prefs.json` in its user-data directory. The channel is `beta` or `nightly` and defaults to `beta`. The app checks on launch and every 6 hours, downloads automatically, and logs to `update.log` in the same directory.
- Setting a channel makes electron-updater allow downgrades. A client follows whatever version the channel's feed names, even an older one.
- Dev builds (`bun run desktop:package:dev`) and builds without `updateProxyKey` never check for updates.

## The bundle-id hand-off

Squirrel installs only updates that carry the running app's bundle id, so `com.telar.desktop` installs cannot follow a feed to the new id. The last old-id release (H) instead:

1. looks for `<proxy>/io.github.novarix.telar/handoff-<channel>-mac.json`;
2. downloads the zip it names and checks size, sha512, bundle id, team and Gatekeeper;
3. swaps the new app in with a detached helper, which restores the old app if the new one doesn't confirm a boot within 180 seconds.

The logic is in `apps/desktop/desktop-handoff-core.js` and `desktop-handoff.js`. Nothing happens until the manifest exists.

Publish a manifest one channel at a time, after that channel's new-id build has been installed and tried. Do nightly first, then beta:

```sh
gh workflow run publish-handoff.yml --ref main -f channel=nightly
```

The job downloads `io.github.novarix.telar/<channel>-mac.yml` from R2 and runs `scripts/handoff-manifest.mjs` (team `MM74W7WGAM`). It checks that the named zip exists in the bucket, then uploads `handoff-<channel>-mac.json`. The manifest is printed in the job log.

To produce a manifest locally from a downloaded feed:

```sh
bun scripts/handoff-manifest.mjs --feed nightly-mac.yml --channel nightly --team MM74W7WGAM
```

Every new build replaces the channel feed, but the manifest stays as it was. After later builds, re-run the workflow if old installs should land on the newest build instead of the one the manifest names.

## Verifying a release

- The run's `Build, sign, notarize, and publish to R2` log ends with `BUILD OK`, the version and `published to r2://...`.
- For a beta, check the release: `gh release view v0.1.0-beta.N`.
- Read the feed through the proxy with the key from your environment, not pasted into the command line:

  ```sh
  curl -fsS -H "X-Telar-Update-Key: $UPDATE_PROXY_KEY" "$UPDATE_PROXY_URL/io.github.novarix.telar/nightly-mac.yml"
  ```

  `version` and the zip name should match the run.
- On an installed app on that channel, check for updates and read `update.log`. `/api/about` reports the build's sha and channel from `build-info.json`.

## Rolling back

No workflow rolls back. The practical move is to roll forward: tag a known-good main commit with a version above the bad one. The ancestry check accepts older main commits.

```sh
git tag v0.1.0-nightly.20260927.6 <good-main-sha>
git push origin v0.1.0-nightly.20260927.6
```

Clients allow downgrades, so re-uploading an older `<channel>-mac.yml` under the prefix also works, but only if you kept a copy. Builds overwrite the feed, and CI keeps no copy.

To stop the hand-off offering a build, delete `io.github.novarix.telar/handoff-<channel>-mac.json` from the bucket. Installs that already swapped stay on the new id.

## Building locally

- `bash scripts/build-desktop.sh --help` lists the flags. With no flags it builds an unsigned `Telar.app` from `origin/main` into `apps/desktop/release/from-origin/`.
- `bun run desktop:package` builds the working tree, unsigned, without publishing. `bun run desktop:package:dev` builds the separate "Telar Dev" app.

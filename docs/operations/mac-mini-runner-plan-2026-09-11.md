# One Mac, every release — the runner plan

Date: 2026-09-11. Machine: Mac mini, Apple M2, 24 GB RAM, 228 GB disk,
32 GB free at the time of writing. macOS 26.6.2.

## The problem

GitHub-hosted runners have refused every job since Sept 7 ("recent account
payments have failed or your spending limit needs to be increased"). So:
Verify is red on every push, the iOS nightly cannot build, and the desktop
release workflow (`macos-14`) would fail the moment it is tagged. The desktop
nightly is the only green workflow, because it already runs on this Mac.

The Mac has one Xcode, the 27.0 **beta 6**, and App Store Connect refuses
uploads built by a beta. That is Apple's rule and the only thing standing
between this machine and TestFlight.

## The shape

**One Xcode, no simulators, no VM.** Bare self-hosted runner, as the desktop
nightly already proves works. `tart`-style macOS VMs would give a pristine
guest per job but cost ~60 GB and a day; on a disk this size they are the
wrong trade. Docker is Linux-only on macOS and cannot touch anything Apple
signs, so it is used for nothing here.

Every workflow moves to the one runner:

| workflow | today | after | why it works here |
|---|---|---|---|
| nightly-desktop | self-hosted | unchanged | already green |
| nightly-ios | `macos-15` | self-hosted | release Xcode + the same temp-keychain dance the desktop job does |
| release-desktop | `macos-14` | self-hosted | same steps as nightly-desktop plus notarize; `notarytool` ships with Xcode |
| verify | `ubuntu-latest` | self-hosted | bun/node are installed; nothing in it is Linux-specific |
| deploy-push-relay, apns-free-probe | `ubuntu-latest` | self-hosted | plain node scripts calling Cloudflare |

The runner takes one job at a time, so a Verify run queues behind a build.
Acceptable at this volume; a second registration on the same machine is a
five-minute change later if it ever isn't.

**iOS tests move off the simulator — decided, not deferred.** The unit and
UI suites run on the phone (`-destination "platform=iOS,id=$TELAR_IPHONE_UDID"`,
the same id `phone.sh` installs to); the README carries the commands. The
nightly never needed a simulator: it archives for `generic/platform=iOS`.
External storage is on order; until it lands, nothing else grows on this disk.

## Disk: what leaves, what arrives

Reclaim, in the order it is safe:

| item | size | note |
|---|---|---|
| iOS 26.5 simulator runtime | 16 GB | `xcrun simctl runtime delete`; the beta's runtime, useless after the swap |
| simulator devices | 5 GB | `simctl delete all` |
| Xcode 27 beta 6 | 3.6 GB | after the RC builds and ships once |
| `~/Downloads/Xcode_27_beta_6.xip` | 1.8 GB | the beta's installer, already installed |
| Docker images and volumes (12 images, 0 in use) | 4.6 GB | `docker system prune -a --volumes`; nothing in Telar uses them |
| `~/.cache/uv`, `~/.cache/codex-runtimes` | 4.8 GB | package caches, regenerate on demand |
| `~/Library/Caches/{Homebrew,ms-playwright,Google,Firefox,aws}` | 4.9 GB | caches |
| `apps/web/.next` | 1.5 GB | dev build output |
| Telar engine worktrees (6 ozom-gv checkouts) | 2.4 GB | **not touched**: two of their sessions are working |
| **total reclaimable** | **~42 GB** | |

Arrives: Xcode 27 RC 1 (27A266a), ~3.6 GB xip, ~12 GB installed. It
bundles the iOS 27 SDK; no separate platform download, and no simulator
runtime unless one is asked for.

Net: roughly **+60 GB free** at the end, one Xcode, no simulators.

## Execution, in order

Steps marked **(you)** need your Apple ID or a decision; everything else I do.

1. **Reclaim the safe caches now.** Docker prune, uv/codex caches,
   Homebrew/playwright/browser caches, `.next`. ~16 GB. No Apple involvement.
2. **(you) Download Xcode 27 RC 1.** Either `xcodes install "27.0 Release
   Candidate"` on the mini and answer the 2FA prompt, or save the xip from
   developer.apple.com into `~/Downloads`. Only the download needs you.
3. **Install the RC.** Unpack to `/Applications/Xcode.app` (the unsuffixed
   name, so it is *the* Xcode), accept the license, run
   `xcodebuild -runFirstLaunch`. Confirm `altool`, `notarytool`, the iOS SDK.
4. **Prove it builds Telar.** `nightly.sh --no-upload` archives the iOS app
   under the RC; the desktop build runs its unit tier. Both on the bare host,
   as the runner will.
5. **Retarget the four workflows** to `[self-hosted, macOS, ARM64,
   telar-nightly]`. Replace `sudo xcode-select` with `DEVELOPER_DIR=
   /Applications/Xcode.app/Contents/Developer` (the runner user has no
   passwordless sudo, and `nightly.sh` already honours the variable). Drop
   `setup-bun`/`setup-node`/cache actions where the host already has the
   tool. Keep the "refuse a tag not on main" guards. One PR.
6. **Cut the iOS nightly.** Tag `ios-nightly-<stamp>` on main. Watch the run
   on the mini; confirm the build appears in TestFlight on the phone.
7. **Delete the beta and the simulators.** Runtime, devices, `Xcode-beta.app`,
   the beta xip. ~26 GB. Update `phone.sh`, `nightly.sh`, the iOS README and
   `CLAUDE.md`-adjacent notes that name `Xcode-beta.app` to name `Xcode.app`.
8. **Verify on the mini.** Push a branch, confirm Verify goes green on the
   self-hosted runner. Then the two Cloudflare workflows, dispatch-only check.
9. **When Xcode 27 GM ships** (days to two weeks): `xcodes install 27.0`,
   swap, delete the RC. Same shape, one Xcode.

## What stays hosted

Nothing. If the billing is fixed later, `release-desktop` is the one job
worth putting back on GitHub's runners: it is rare, and a pristine image is
worth more for a signed public release than for a nightly.

## Risks, named

- **The RC refuses a build the beta accepted.** Unlikely (same major, same
  SDK), but step 4 is where it would show, before anything is deleted.
- **A simulator is wanted later** for the UI suite. Install a runtime then;
  it is one command and 16 GB, and it can be deleted again.
- **Runner PATH.** The service's default PATH is `/usr/bin:/bin:/usr/sbin:/sbin`;
  the desktop job survives because `setup-bun` adds bun and `brew install`
  adds aws. The workflow changes must set PATH explicitly or keep those
  steps. Step 5 handles it; step 8 proves it.
- **iOS unit tests in CI.** Without a simulator they need a phone on USB.
  The nightly does not run them; Verify never did. They are a local matter,
  run against the connected phone, by decision.

  **Reversed 2026-09-19** (#675). `.github/workflows/nightly-ios-tests.yml`
  runs `TelarMobileTests` on that phone, on a daily schedule rather than as a
  PR gate — a required check cannot depend on a cable. The phone-on-USB
  premise is unchanged and so is the no-simulator decision; what changed is
  that "a local matter" meant the suite was verified only as often as someone
  remembered, which is not a property a test suite can be said to have.

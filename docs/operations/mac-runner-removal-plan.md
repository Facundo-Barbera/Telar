# Removing the `telar-nightly` runner from the Mac

**Status: PLAN ONLY. Nothing here has been run.** Written to be read before it
is executed, because one of these steps destroys state that cannot be recreated
without a new token from GitHub, and a half-removal is worse than either end
state.

**Do not start until every workflow is green on hosted runners.** A
deregistered runner plus a workflow still asking for `[self-hosted, macOS,
ARM64, telar-nightly]` is a job that queues for ever against a runner that no
longer exists. Order matters more than speed here.

---

## There are TWO runners on this machine. One is not ours.

```
94670  actions.runner.Facundo-Barbera-Telar.facundo-mac-telar-nightly     ← ours
94883  actions.runner.Facundo-Barbera-lintel.facundo-mac-lintel-nightly   ← NOT ours
```

`/Users/facundo/actions-runners/lintel-nightly/` belongs to another project and
has its own `Runner.Listener` process. **Nothing in this plan touches it.**

The names differ by four characters in the middle of a long string. Every
command below names the full path or the full service label — **do not
substitute a wildcard or a `grep`**, because the cost of matching the wrong one
is deregistering a runner nobody here owns.

---

## What is on disk

```
/Users/facundo/actions-runners/telar-nightly/
  .credentials, .credentials_rsaparams, .runner   ← registration identity
  .service                                        ← names the LaunchAgent
  _work/                                          ← 1.9 GB of checkouts
  runner.tar.gz                                   ← 128 MB installer
  svc.sh, config.sh, run.sh, bin/, externals/
```

Service definition:
`/Users/facundo/Library/LaunchAgents/actions.runner.Facundo-Barbera-Telar.facundo-mac-telar-nightly.plist`

---

## Preconditions

1. **Every workflow repointed off the runner.** ✅ Done — PR #754 (`verify.yml`)
   and PR #756 (the other five). No workflow targets `telar-nightly` any more.
   **Both must be MERGED, not merely green**, or `main` still asks for a runner
   that is about to disappear.

2. **`nightly-ios-tests.yml` has an answer.** ✅ Done — parked, see #755
   following #675. Disabled rather than deleted; it is the one job that cannot
   move, because it needs a Mac with a phone attached.

3. **The three build-and-sign workflows proven green on `macos-latest`.**
   ❌ **NOT DONE — this is the blocking one.** `nightly-desktop`,
   `release-desktop` and `nightly-ios` have been repointed but never run there.
   Their signing is already portable (certificates come from repository secrets
   into a temporary per-run keychain), which is good evidence and is not proof.
   Proving it is awkward on purpose: these build, sign, notarise and publish, so
   a test run uploads a real nightly to R2 or a build to TestFlight. Either
   accept a deliberate real run, or probe checkout → build → sign and stop
   before publishing. **Do not deregister the runner on the strength of the
   secrets being portable.** If they fail on hosted and the runner is already
   gone, there is nothing to fall back to.

4. **No job in flight.** `_work/_temp` was modified minutes before this was
   written, so check rather than assume.

---

## The steps, and what each destroys

### 1. Confirm nothing is running

```sh
launchctl list | grep -F 'actions.runner.Facundo-Barbera-Telar.facundo-mac-telar-nightly'
```

Destroys nothing. Read-only.

### 2. Get a removal token

GitHub → repository **Settings → Actions → Runners** → the
`facundo-mac-telar-nightly` runner → **Remove**. GitHub shows a `config.sh
remove --token …` command containing a short-lived token.

Destroys nothing yet. **This token expires in about an hour** — get it
immediately before step 4, not in advance.

### 3. Stop and uninstall the service

```sh
cd /Users/facundo/actions-runners/telar-nightly
./svc.sh stop
./svc.sh uninstall
```

**Destroys:** the LaunchAgent plist, so the runner no longer starts at login.
**Reversible** — `./svc.sh install && ./svc.sh start` puts it back, as long as
step 4 has not run.

This is the safe stopping point. If anything looks wrong, stop here: the
registration is still intact and the runner can be restarted.

### 4. Deregister from GitHub

```sh
cd /Users/facundo/actions-runners/telar-nightly
./config.sh remove --token <TOKEN-FROM-STEP-2>
```

**Destroys the registration, and this is the irreversible one.** It removes
`.credentials`, `.credentials_rsaparams` and `.runner`, and deletes the runner
from the repository. Re-registering later needs a **new** token and creates a
**new** runner identity — the old one cannot be restored.

After this the repository has no self-hosted runner. Any workflow still
targeting `telar-nightly` will queue indefinitely rather than fail, which is
why the preconditions are not optional.

### 5. Do NOT delete the directory — decided

```sh
# rm -rf /Users/facundo/actions-runners/telar-nightly   ← deliberately not run
```

**Stop at deregistration.** The directory holds 1.9 GB of `_work` checkouts and
`_diag`, and `_diag` is the only record of what ever ran on that machine. "Leave
it clean" was about the Mac no longer being a runner, not about destroying that
record — so the directory stays.

It is inert once step 4 has run: no service, no credentials, nothing listening.
The disk is the owner's to reclaim whenever he wants, and it costs nothing to
keep it now. If he does want the space later, this is the command, and the only
thing lost is the history.

### 6. Confirm the other runner is untouched

```sh
launchctl list | grep -F 'actions.runner.Facundo-Barbera-lintel.facundo-mac-lintel-nightly'
ls /Users/facundo/actions-runners/
```

The first must still print a PID; the second must still list `lintel-nightly`.
**If either is missing, something went wrong and that project's runner needs
re-registering** — say so immediately rather than quietly.

---

## If it needs undoing

- **Before step 4:** `./svc.sh install && ./svc.sh start`. Full recovery.
- **After step 4:** register a new runner from scratch — download, `config.sh`
  with a fresh registration token, label it `telar-nightly`, `svc.sh install`,
  `svc.sh start`. The workflows' `runs-on` does not change, since it matches on
  the label rather than the identity. Budget half an hour and expect the 128 MB
  download again.

---

## What this does not cover

Removing the runner does not remove the **secrets** the Mac-bound workflows
used. `MACOS_CERT_P12_BASE64`, `TELAR_APNS_KEY_P8_BASE64`, the R2 keys and the
rest live in repository secrets and are still needed by the release and nightly
workflows wherever those end up running. Nothing here touches them, and nothing
here should.

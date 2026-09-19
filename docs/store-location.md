# Where Telar's store lives — design for #630

Design only. Nothing here is built yet. The migration is the part that wants
sign-off before code, because it is the one step that can lose something a
person cannot get back.

## What the disk actually says

Measured on the machine that runs Telar, read-only:

| | |
|---|---|
| `<userData>/engine` | 14 GB |
| `<userData>/engine/worktrees` | 12 GB (86% of it) |
| `<userData>/engine/sessions` | 368 MB |
| free on `/` | 12 GiB |
| mounted volumes | `/Volumes/Focaltec HD` |

That table decides most of this document. **Worktrees are the problem — the rest
of the store is a rounding error.** And worktrees are the one part of the store
that is *reproducible*: they are git checkouts cut from a project at a recorded
base sha, and the engine already re-cuts them
(`state.ts`'s `restoreWorktreesForProject`, around `state.ts:4738`). Journals,
`threads.sqlite`, `projects.json` and attachments are not reproducible by
anything.

So the risk the issue is most afraid of — a half-migration that destroys
irreplaceable history — attaches to 2 GB of the 14, and the 12 GB that would
actually fix the disk carries almost none of it.

## Decision 1 — which meaning of "dynamically": **restart required**

Not hot-swap, and the argument is not effort, it is that there is nothing to
swap *to* without a restart:

- `telarHome()` (`apps/desktop/main.js:386`) is read once and handed to both
  children in `childEnv` (`main.js:596`). Changing it later changes nothing
  that is already running.
- `engineRootFromEnv` (`apps/engine/src/state.ts:749`) resolves the root once at
  construction; `this.paths` is captured for the daemon's life.
- The daemon holds `engine.lock` (`state.ts:843`) and open sqlite handles for
  its whole life. A live switch means closing both under in-flight turns and
  daemon leases, and there is no honest way to do that without failing the turns
  — which is the thing a restart does anyway, only loudly and at a moment the
  person chose.

So: persist the choice, apply it at next launch, and **say so** — match
`PATCH /api/remote`'s `restartRequired: true`
(`apps/web/app/api/remote/route.ts:102,126`) rather than implying the change
took. Migration is offered as a separate, explicit action, not a side effect of
saving a setting.

## Decision 2 — two settings, and the recommended one is the worktrees root

`worktreesRoot()` is a single function taking the engine root
(`apps/engine/src/worktree.ts:313`), with three call sites, all in that file.
Pointing it at a volume is a small, contained change that frees 12 of the 14 GB.

Build both settings. Recommend moving the worktrees root and leaving the store
root alone, because the two choices have very different failure costs:

| drive absent | worktrees root on it | whole store on it |
|---|---|---|
| Telar starts | yes | no |
| session list, history, search | intact | gone |
| pairing (`<TELAR_HOME>/remote/remote.json`) | intact | gone |
| sqlite on removable media | no | yes |
| what breaks | worktree sessions' checkouts — files absent, `git` fails, nothing corrupt | everything |
| recoverable by | plugging in, or re-cutting the worktree | plugging in, only |

And the absent-drive behaviour of the worktrees half is *already reasoned*:
`worktree.ts`'s header works through a worktree whose `.git` is on an absent
disk and concludes "nothing was broken, something was absent". This is the same
shape with the two sides swapped, which is the direction the codebase already
thinks in. Putting the store itself on the drive is the inversion nothing in the
codebase has considered, and it buys 2 GB.

## Decision 3 — where the choice is persisted

`<userData>/storage.json` — Electron's own userData, which is on the internal
disk and is never the thing being chosen. It joins the files already kept there
for exactly this reason: `server-port.json`, `update-prefs.json`,
`ui-prefs.json`, `keybindings.json`. Deliberately **not** under `TELAR_HOME`,
because `TELAR_HOME` is what it decides.

```jsonc
{
  "version": 1,
  // absent means "the default" — <userData>/engine, today's behaviour
  "storeRoot":     { "path": "/Volumes/…/Telar", "volume": { "mount": "/Volumes/…", "uuid": "…" } },
  "worktreesRoot": { "path": "/Volumes/…/Telar-worktrees", "volume": { "mount": "…", "uuid": "…" } }
}
```

`volume` is recorded the same way and for the same reason `Project.volume` is
(`volumes.ts:38`): the mount path is a hint that goes stale, the uuid is
identity, and `findVolumeMount` is what turns a remount at `<name> 1` into a
rename instead of a loss.

### The #628 rule applies here, and it points the other way

`remote.json` falls **open** on an unrecognised version (`RESET`,
`apps/web/lib/remote/store.ts:199`) because the worse failure there was locking
a working install out of itself.

Here the worse failure is the opposite one. Falling back to the default path on
an unrecognised `storage.json` is precisely "Telar starts, finds nothing, and
cheerfully initialises a fresh empty store over the top of someone's absent
history". So:

> **An unrecognised `storage.json` refuses to start and says why. It never
> guesses a store path.**

Precedent in the same file: the profile registry is read from userData and
"a bad file is a startup error, not a silent fallback" (`main.js:931`).

## Decision 4 — what happens when the volume is absent

`engineRootFromEnv` already throws on unset and on relative. "Set, absolute, and
not mounted" is the fourth throw, and it is decided in the shell *before* the
children spawn, because the shell is the only process that can show a window
about it.

1. **Configured, uuid recorded, nothing mounted** → do not spawn the engine.
   Show a blocking window naming the drive, with **Retry**, **Wait** (the
   `/Volumes` watcher in `apps/desktop/volume-watch.js` already turns a plug-in
   into an event within one burst — no new machinery), and **Use the default
   store**, which is an explicit, typed confirmation and never a default button.
   Never initialise at the configured path.
2. **Mounted somewhere else** (`/Volumes/Focaltec HD 1`) → resolve by uuid with
   `findVolumeMount` before deciding anything, then rewrite the recorded
   `mount`. This is `recoverRemountedProject`'s move (`state.ts:4630`) applied
   to the store itself.
3. **A leftover empty `/Volumes/<name>` folder** → `isMountPoint` must pass
   before the path is believed (`volumes.ts:118`). This is the catastrophic
   case: an empty directory where the drive used to be is exactly where a fresh
   store would get written, and it disappears on the next remount.

**Mid-session unplug is not made safe, and I am saying so rather than implying
otherwise.** If the store is on the drive and the drive is pulled, sqlite
returns I/O errors, journal appends fail, and in-flight turns fail. Refusing to
*start* is the cheap 90%; surviving a yank is not tractable without a write-ahead
design the engine does not have. This is the sharpest argument for keeping the
store on the internal disk and moving only the worktrees: then an unplug costs
running sessions their checkouts — recoverable — and costs history nothing.

## Decision 5 — the migration, in order

The rule is one sentence: **the source is never touched by the same operation
that creates the copy.**

Engine stopped first — this runs in the shell before children spawn, or as a
one-shot with the daemon down.

1. **Preflight.** Target is a real mount (`isMountPoint`), writable, not inside
   the source, not the source; free space ≥ source size × 1.05; read and record
   the uuid.
2. **Copy to `<target>/engine.incoming-<stamp>`.** Never straight onto the final
   name, so an interrupted copy can never be mistaken for a store by the next
   launch.
3. **Verify, before anything is switched.** Manifest of relative paths identical;
   total bytes identical; every `*.sqlite` opens and passes
   `PRAGMA integrity_check`; `projects.json` and every `sessions/*/…` metadata
   document parses. Any failure: leave `engine.incoming-*` for inspection,
   change no setting, report what failed.
4. **Rename** `engine.incoming-<stamp>` → `engine`. Same filesystem, atomic.
5. **Write `storage.json`.** Only now does anything point at the new root.
6. **Rename the source to `engine.migrated-<stamp>` and stop.** Deleting it is a
   *separate action the person takes afterwards*, with the size shown. That
   second click is where the disk is actually reclaimed, and making it separate
   is the entire safety property: at no point does one operation both create the
   copy and destroy the original.

### The worktrees-only variant is smaller and safer

Steps 2–4 become, per worktree, `git worktree move` — git rewrites both sides
(the `.git` file in the worktree and `.git/worktrees/<name>/gitdir` in the
repository), which is the part a hand-rolled copy gets wrong. Then:

- **Skip any project whose availability is not `available`** — the same rule,
  for the same reason, as the prune refusal in `worktree.ts`'s header. A skipped
  worktree stays where it is and is reported; nothing is guessed.
- Rewrite each session's `workspace.path` with the loop shape already at
  `state.ts:4680–4696`.
- No `PRAGMA integrity_check`, no `engine.migrated-*` to delete afterwards:
  `git worktree move` leaves nothing behind, and a worktree that fails to move
  is re-cuttable from its project.

## The picker half is already unblocked — measured, not assumed

- Electron's `showOpenDialog` (`main.js:1681`) has no filter and reaches
  `/Volumes` today.
- `browseRoots()` returns `["/Users/facundo", "/Volumes"]` on this machine, and
  `listDirectories({ path: "/Volumes" })` lists `Focaltec HD`. Both run, now,
  against `apps/web/lib/fs-dirs.ts`.
- `registerProject` already records the volume identity for a root on a drive
  (`state.ts:4785`).

The one real gap is an **affordance, not a validation**: the browser opens at
home, and home's `parent` is `null` (`fs-dirs.ts:257`), so `/Volumes` is
reachable only by typing it into the path field. The fix is to show the mounted
volumes as roots in the browser's chrome — `browseRoots()` already sanctions
exactly those paths, so nothing new is being permitted.

## Not being built

- Hot-swapping the store with sessions running.
- Surviving a mid-turn unplug.
- Any automatic deletion of a migration source.

## Correction to the brief

`apps/engine/src/run/mount.ts` and `run/store-capability.ts` are the **Run
surface's** mount point — where run routes are attached to the daemon — and have
nothing to do with disk volumes. The prior art that matters is
`apps/engine/src/volumes.ts`, `state.ts` (`4416`, `4602`, `4748`),
`worktree.ts`'s header, and `apps/desktop/volume-watch.js`.

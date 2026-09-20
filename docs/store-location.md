# Where Telar's store lives — design for #630

Design only; nothing here is built. The store may be moved to any location the
person chooses, including a removable volume, and changed again later without
reinstalling.

The hard part is not the setting. It is that **a store that is absent and a
store that never existed look identical from the filesystem**, and getting that
distinction wrong initialises a fresh empty store over the top of somebody's
history. Everything below is arranged around that one problem.

## 1. The marker — the whole mechanism

A missing directory cannot tell first run from absent volume, so the answer
cannot be a directory check. It is a pair of records that have to agree.

### The marker, on the internal disk

`<userData>/store-location.json` — Electron's own userData, the one place that
is present whatever is mounted. It joins the files already kept there for this
exact reason (`server-port.json`, `update-prefs.json`, `keybindings.json`).
Deliberately **not** under `TELAR_HOME`, because `TELAR_HOME` is what it
decides.

```jsonc
{
  "version": 1,
  // The store Telar opens. Written only once a store there has been PROVEN —
  // successfully stamped on a first run, or successfully migrated and reopened.
  "active": {
    "path": "<absolute>",
    "storeId": "<uuid>",
    // Absent when the store is on non-removable storage.
    "volume": { "mount": "<absolute>", "uuid": "<volume uuid>", "label": "<name at adoption>" },
    "adoptedAt": 0,
    "lastOpenedAt": 0
  },
  // A move the person asked for that has not completed. Cleared on success or
  // on abandonment. Never consulted when deciding where to open.
  "pending": { "path": "<absolute>", "requestedAt": 0 }
}
```

**`active` is a fact, `pending` is an intent, and they are separate fields
because conflating them is a trap**: if saving the setting wrote `active`, a
mistyped path or a failed migration would leave Telar permanently refusing to
start against a store that was never there.

**The presence of `active` is what means "a store exists".** Its absence, and
only its absence, means first run.

### The stamp, inside the store

`<storeRoot>/store.json`:

```jsonc
{ "version": 1, "storeId": "<uuid>", "createdAt": 0 }
```

Minted once, when a store is first initialised, and carried by a migration
rather than regenerated. Nothing like it exists today — `engine.json` is
per-boot discovery, not identity.

The stamp is what makes "the volume is mounted and the path exists" insufficient
grounds to write anything. A drive can be reformatted, a different drive can
mount at the same name, and macOS leaves an empty folder behind at an old mount
point. In all three the path resolves and the directory is absent or foreign;
only a matching `storeId` says *this is your store*.

**The stamp is primary identity; the volume uuid is an accelerator.** The uuid
is what lets a remount under a different name be recognised as a rename rather
than a loss, and it is what names the missing drive in the waiting window — but
it is macOS-only and absent for network shares (`volumes.ts:138`), so nothing
load-bearing may depend on having one. The stamp works everywhere.

## 2. Start-up: every state, and what each does

Decided in the shell, before either child spawns — the shell is the only process
that outlives the engine and can put a window on screen. `engineRootFromEnv`
already throws on unset and on relative (`state.ts:749`); this is the same
discipline extended to the states a path can be in.

| marker | on disk | what happens |
|---|---|---|
| absent | — | **First run.** Initialise at the default, mint the stamp, write `active`. |
| `active`, no volume | stamp matches | Normal start. |
| `active`, no volume | directory or stamp missing | **Refuse.** Named error. Never initialise. |
| `active` + volume | not mounted | **Wait** — see below. |
| `active` + volume | mounted elsewhere | Resolve by uuid (`findVolumeMount`), verify the stamp, rewrite `mount`, start. |
| `active` + volume | mounted, no stamp | **Refuse.** Empty mount point, or a reformatted or foreign drive. |
| `active` + volume | mounted, `storeId` differs | **Refuse**, naming both ids. |
| unrecognised `version`, or unparseable | — | **Refuse**, and say why. Never guess a path. |

Two of those deserve their reasons written down.

**Unrecognised shape refuses.** `remote.json` falls *open* on an unknown version
(`RESET`, `apps/web/lib/remote/store.ts:199`) because there the worse failure
was locking a working install out of itself. Here the worse failure is the
opposite one: falling back to the default path is exactly the fresh-store-over-
absent-history bug. So the same lesson points the other way. Precedent in the
shell already: a bad profile registry is "a startup error, not a silent
fallback" (`main.js:931`).

**A mounted path is never trusted without the stamp.** `isMountPoint`
(`volumes.ts:118`) is the guard against a leftover empty directory at a mount
point, and the stamp is the guard against everything else. Both, because
initialising at either is unrecoverable.

### Waiting, when the volume is absent

This is a designed-for state, not an error path. The volume is *intended* to be
present, so its absence is a condition to sit in and recover from — not an
exception to throw.

- The engine is not spawned. Nothing opens, nothing initialises, nothing is
  written at the configured path.
- A window says which volume is missing — by the **label recorded in the marker
  at adoption time**, since the disk is not here to ask — that Telar is waiting,
  and that no data has been touched.
- Recovery is automatic. `apps/desktop/volume-watch.js` already turns a mount
  into a coalesced event within one burst, it is a pure module taking an
  `onChanged` callback, and it needs no engine — so it is reusable verbatim here
  rather than polling. Its `powerMonitor` half covers the drive that was
  unplugged while the machine slept.
- Manual **Retry** as well, because a watcher is a hint and the person may know
  something it does not.
- **Open a different store** and **Start a new store here** are available but are
  explicit, typed confirmations, never default buttons — and "start a new store"
  *archives* the existing `active` under a timestamped key rather than
  overwriting it, so choosing it by accident is still reversible.

### Falling back to a second store on the internal disk: considered, rejected

The peer asked for this to be settled out loud, so: **no, and not as an option.**

Two stores that both accumulate history and later diverge cannot be reconciled.
There is no merge for journals, for sqlite rows, and for a project registry that
has minted different ids for the same checkout, and the person would have no
reliable way to tell which store a given window was showing. Refusing to run is
reversible by plugging in a cable; a silent fork is reversible by nothing.

"Start a new store here" survives as a *deliberate act with a different name* —
for the drive that is genuinely gone for good. It is never automatic, never a
default, and it never happens because something was missing.

## 3. Mid-session removal: what is guaranteed, and what merely usually works

The brief asked for durability claims that have been established rather than
assumed. Here is what the code actually does.

**Established, by reading the code:**

- `atomicWriteText` (`apps/engine/src/atomic.ts:32`) writes a temporary file and
  renames over the target. **There is no `fsync` anywhere in the engine or the
  shell** — `fsyncSync`/`fdatasync` do not appear in either tree.
- So every JSON document write is atomic against a *process* crash — rename
  either happens or does not, and a reader never sees a torn document — and is
  **not durable** against the device going away. A write acknowledged to the
  engine may still be only in the page cache.
- `acquireDaemonLock` (`state.ts:12719`) reclaims a lock whose recorded pid is
  not alive. It records `hostname` and **never compares it**. That is harmless
  while the store is on the machine's own disk and becomes a real hazard the
  moment the store is portable: a drive carried to a second Mac can have a live
  daemon's lock broken by an unrelated pid. **This is a new bug that this feature
  creates, and it must be fixed as part of it** — compare `hostname`, and treat a
  lock from another host as held, not stale.

**What can honestly be claimed about a yank:**

- *Usually works*: sqlite's journal/WAL recovery restores the last committed
  transaction. This is the same guarantee as pulling the power, and it rests on
  the enclosure honouring flushes — which external enclosures are widely known
  to lie about. It is not a guarantee this project can make on the device's
  behalf.
- *Not claimed*: that the most recent writes survive. Without `fsync` they may
  be in a cache the device never wrote back. Losing the newest appended events
  is possible.
- *Structurally safe*: a reader never sees a half-written document, because
  rename is atomic within the filesystem and APFS journals metadata. The failure
  mode is a *missing* recent write, not a corrupt one.
- *Will fail, loudly*: any turn in flight at the moment of removal. Its writes
  return I/O errors and it is reported as failed.

**What the engine does about it.** `volume-watch.js` fires on entries
disappearing as well as appearing, so the store's volume going away is a signal
the engine already has a delivery path for. On it:

- Enter a `store-unavailable` state; refuse to start new turns, and say which
  volume is missing rather than failing each turn with an I/O error.
- Quiesce: close sqlite, stop journal appends, so the window in which a write
  can be in flight is as short as it can be made.
- **This is best-effort and is stated as such**: the unmount is learned about
  *after* it happened, so anything in flight at that instant is already past
  saving. Narrowing the window is not closing it.
- On remount, re-verify the stamp before resuming. A different `storeId` is a
  different store and must not be resumed into.

## 4. Moving the store: order of operations

One rule: **the source is never touched by the operation that creates the copy.**

The engine must be stopped. The move runs in the shell as a one-shot before
children spawn — the shell is what outlives the engine and can show progress.

1. **Preflight.** Target absolute; not equal to and not inside the source; its
   volume is a real mount (`isMountPoint`) when it has one; writable, proven by
   writing and re-reading a probe file rather than by a permission bit; free
   space at the target at least the source's size plus a margin. Read the
   source's stamp. Record the target volume's uuid and label if it has them.
2. **Copy into `<target>/.telar-incoming-<timestamp>/`** — never onto a name the
   next launch would read, so an interrupted copy is inert rather than mistaken
   for a store. Staging goes *inside* the target and not beside it: the final
   step is a rename, a rename is atomic only within a filesystem, and a sibling
   of a target at a volume root would land on `/Volumes` — a different
   filesystem, an unwritable one, and a cross-device rename that fails at the
   very end after the whole copy has been paid for. Modes are preserved, so a
   moved store does not arrive world-readable. Progress reported by bytes.

   What is copied is the subtrees the store owns — `engine/` and `remote/` — not
   the directory. At the default location the store root *is* Electron's
   userData, shared with `Cache/`, `Local Storage/` and this install's
   preferences, so "move the store" can never mean "move the directory". It is
   also why a migration onto a drive does not drag a Chromium cache with it.
3. **Hash the copy by reading it back**, not by digesting the bytes on their way
   out. Hashing what the writer held proves the writer held it and says nothing
   about what reached the disk, so each file is re-read from the target and
   compared against a digest taken from the source. That is two reads and a
   write rather than one read and a write — the price of the check actually
   being a check, paid once.
4. **Verify before switching anything.** Relative-path manifest identical in
   both directions — nothing missing, nothing extra — and every per-file digest
   matched. Any failure leaves the staging directory in place for inspection,
   changes no marker, and names the file and the reason.

   `PRAGMA integrity_check` runs too, and it is worth being exact about what it
   establishes: once the copy is byte-identical to the source, a check on the
   copy is a check on the **source**. It is kept because learning that the store
   was already damaged is worth having *before* the original is retired — but
   it is not what verifies the copy. The hashes are.
5. **Fsync the copied tree, directories included.** Without it, "verified" means
   "verified in page cache" — and this is the one moment the whole store's
   durability is worth paying for explicitly, whatever the engine does at
   steady state.
6. **Rename each subtree out of staging into place**, then write the stamp. Each
   rename is atomic within the filesystem. The stamp goes last on purpose: until
   it exists the target is not a store, so a crash between the renames leaves
   something that nothing will open, with the marker still naming the source.
6a. **Repair every worktree's registration** — see §4a. Before the source is
   retired, so both paths still exist and `git worktree repair` cannot be
   confused about which is which.
7. **Write the marker.** `active` updated, `pending` cleared. This single write
   *is* the switch: before it Telar opens the old store, after it the new one,
   and there is no state in between.
8. **Rename the source's subtrees aside** to `engine.migrated-<timestamp>` and
   `remote.migrated-<timestamp>`. Subtree-wise for the same reason the copy was:
   renaming userData itself would take the whole app with it. Do not delete.
9. **Deleting the source is a separate, later action**, with its size shown, and
   **gated on `active.lastOpenedAt` post-dating the migration** — the old store
   cannot be removed until Telar has actually opened the new one and run from
   it. "Verified copy" is thereby made to mean "a store that has been opened",
   not "bytes that matched".

Rollback at every point: before step 7, abandoning costs only the staging
directory. Between 7 and 8, the source is untouched at its original path and
recovery is rewriting the marker. After 8, recovery is renaming it back.

**An interrupted move refuses to resume.** A target that already holds a store,
or the leftovers of a previous attempt, is a refusal with a sentence — not a
resume. Nothing has been lost at that point, which means a resume that guessed
wrong would be the only remaining way to lose something.

## 4a. Git worktrees do not move by being copied

`engine/worktrees/` is inside the store, so the migration carries it — and
carrying it is not the same as moving it. The two pointers are asymmetric:

```
<worktree>/.git                      ->  <repo>/.git/worktrees/<name>
<repo>/.git/worktrees/<name>/gitdir  ->  <worktree>/.git
```

A copy rewrites neither. The first still resolves, because the repository did
not move. The second names the path the migration is about to rename aside — so
git concludes the worktree was **deleted**, and the next `git worktree prune`
anywhere removes the registration. The work is still on disk; git's record of
whose it is, is not. `git worktree repair`, run from the repository with the new
path, rewrites it. No project registry is needed: each worktree's own `.git`
names its repository, which is what keeps this in the shell where the migration
happens.

### And a worktree on a removable volume must be locked

This is a live defect independent of the migration, and it is the sharper half.
`removeSessionWorktreeAsync` guards on the **project's** availability and then
runs `git worktree prune`. Once the store is on a drive, those two facts come
apart:

- the project is on the internal disk and perfectly available,
- the worktrees are on a volume that is out,
- the guard passes, `prune` runs,
- and **every** worktree registration on the absent drive is deleted — not just
  the one being removed.

Removing a single session while the drive is unplugged would take out all of
them. Git's own documentation asks for `git worktree lock` on exactly this —
a worktree on a portable device or a network share — and a locked worktree is
ignored by `prune` however long its directory has been missing, whatever
`expire` says. So:

1. **Lock on creation** when the worktree lands on a removable volume.
2. **Unlock in teardown**, unconditionally and before `worktree remove`. A lock
   outlives its reason: a worktree locked onto a drive that was later
   reformatted refuses to be removed. Locking without an unlock path trades a
   data-loss bug for a leak-forever bug.
3. **Guard `prune` on the worktrees root being present**, not only on the
   project being available. The lock protects worktrees that already exist; the
   guard stops us asking git the question at all.

### A relocated store cannot share `node_modules` with the bun cache

A store on another volume cannot deduplicate `node_modules` against a bun cache
left in `~/.bun` on the internal disk. Neither hard links nor APFS clones cross
a filesystem boundary, so each worktree there holds a full copy. This is a
property of the layout, not a fault to go looking for: the only fix is to move
the cache onto the same volume as the worktrees, which buys a second cache and
installs that require the volume mounted. The cost has been measured and the
work deferred — see #633, which carries the numbers and the measurement trap
that an earlier reading of this fell into.

Telar uses no git alternates and no `--local` clones, so git objects are not
implicated at all — they live once, in the project repository, which does not
move.

## 5. Registering a project from a volume — already unblocked

Verified by running the code, not by reading it:

- Electron's `showOpenDialog` (`main.js:1681`) has no filter and reaches mount
  points today.
- `browseRoots()` already returns the home directory *and* this platform's mount
  roots, and `listDirectories` lists a mounted volume's contents
  (`apps/web/lib/fs-dirs.ts:151`).
- `registerProject` already records volume identity for a root on a drive
  (`state.ts:4785`).

The only gap is an **affordance, not a validation**: the browser opens at home,
home's `parent` is `null` (`fs-dirs.ts:257`), and so a mount root is reachable
only by typing its path. The fix is to offer the mounted volumes as roots in the
browser's chrome. `browseRoots()` already sanctions exactly those paths, so
nothing new is being permitted — it is being made visible.

## 6. Not being built

- Hot-swapping the store while sessions run. The root is read once and handed to
  both children (`main.js:596`); `engineRootFromEnv` resolves once at
  construction; the daemon holds `engine.lock` and open sqlite handles for its
  whole life. A live switch fails the in-flight turns that a restart fails
  anyway, at a moment nobody chose. The setting applies at next launch and the
  UI says so, matching `PATCH /api/remote`'s `restartRequired`
  (`apps/web/app/api/remote/route.ts:102`).
- Surviving a mid-turn removal. See §3 for what is claimed instead.
- Any automatic deletion of a migration source.
- Reconciling two divergent stores. See §2.

## Correction to the brief

`apps/engine/src/run/mount.ts` and `run/store-capability.ts` are the **Run
surface's** mount point — where run routes attach to the daemon — and have
nothing to do with disk volumes. The prior art that matters is
`apps/engine/src/volumes.ts`, `state.ts` (`4416`, `4602`, `4748`, `12719`),
`worktree.ts`'s header, `apps/engine/src/atomic.ts`, and
`apps/desktop/volume-watch.js`.

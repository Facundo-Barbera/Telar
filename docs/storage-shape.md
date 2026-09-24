# Telar's storage shape — which tier a thing goes in, and who owns it

**This page is normative.** It is the answer to "where does this new kind of
data go", and it exists because that question had no written answer: #630, #642,
#646 and #658 are each well argued and each had to decide it again, locally, and
each decided it reasonably and differently. A patch series that shuffled files
would have moved bytes without adding the sentence, and the fifth increment
would have landed beside the shape exactly like the first four.

Written for #665. The companion pages are [`store-location.md`](store-location.md)
— how a store is moved, in detail — and [`worktrees-indexing.md`](worktrees-indexing.md).

---

## The rule, in one table

Four tiers, decided by one question each: **does it move with the store?**

| # | Tier | Where | The rule |
|---|---|---|---|
| 1 | **The store** | `<TELAR_HOME>/engine`, `<TELAR_HOME>/remote`, `<TELAR_HOME>/store.json` | *If losing it costs a person something they cannot reconstruct, it is here.* Moves. Identified by the stamp. |
| 2 | **This installation** | Electron `userData` | *If it is meaningless on another machine, it is here.* Deliberately does not move. |
| 3 | **Reproducible** | `engine/worktrees`, `engine/python`, `engine/tools`, package caches | *If the engine can re-make it from a recorded sha or a re-install, it is here* — and it may live anywhere. |
| 4 | **Not ours** | `~/.claude`, `~/.codex`, `~/.bun`, the Keychain, the person's own repositories | Read, sometimes written, **never moved**, and named in the UI so a person knows Telar's answer is "we do not carry this". |

`apps/desktop/store-location.js` already states tier 1 operationally:

```js
const STORE_SUBTREES = ["engine", "remote"];
```

That list plus `store.json` is what a move carries, what the stamp identifies,
and what a person gets back when they plug the drive into another Mac.
Everything else is one of the other three tiers, and the rest of this page is
which.

---

## Tier 1 — the store

### One SQLite database

`engine/execution.sqlite` plus its `-wal` and `-shm`. Holds the `events`
journal, the `documents` table, the `items` rows (#658), `sessions`,
`turn_summaries`, `session_search` and `receipts`. Measured at 1005.6 MiB before
#646's compaction and 695.1 MiB after (`execution-store.ts`).

Four kinds of row in it are worth naming because they are **not files however
much their keys look like paths**: `sessions/<id>/session.json`, `queue.json`,
`requests.json`, `tasks.json` and the two `.index.json` offset indexes are rows
in `documents`; a session's items are rows in `items` once it has migrated.
`ExecutionStore.owns()` is the whole boundary, and it is a regex over seven key
shapes. Everything else under `sessions/<id>/` — `notifications.json`,
`attachments.json`, `attachments/<id>.<ext>`, `ds/kernel.json`,
`events.ndjson` — is a real file on disk.

> **The sharpest instance of "no shape" in this repository.** Inside one session
> directory some names are rows and some are files, and nothing in the path tells
> you which: `writeDocument` takes a path and routes it to sqlite or to
> `atomicWrite` based on a regex, and the caller cannot tell. It is also why
> #658's `items.json` problem was invisible from the filesystem — you cannot
> `ls` your way to a 17 MiB blob being rewritten per item.
>
> **The rule for new data:** if it is per-session state the cockpit reads back,
> it belongs in the database, and `owns()` must be taught about it in the same
> change. If it is a blob nothing queries — an attachment, a kernel spec — it is
> a file.

### The loose JSON documents at the store root

**`statePaths()` in `apps/engine/src/state.ts` is the only sanctioned way to
name one.** Before #665 there were two — `statePaths` and a hand-written
`path.join(root, "…")` in nine other places — and only one of them was a list,
which made "what is sanctioned" unanswerable and the invariant test below
impossible to write. All nine have been moved in.

A new root-level file is added to `EngineStatePaths` and to `statePaths()`, with
a comment saying why it is at the root rather than in the database, **in the
same change that first writes it.** A file composed by hand is a file the store
shape does not know about.

### The directories inside the store

`sessions/`, `worktrees/` (tier 3 by rule, relocatable — see below), `python/`,
`browser-profiles/`, `notes/`, `dictation/`, `run/`, `diagnostics/`,
`orientation/`, `appearance/`, `adopted/`, `tools/tectonic/<version>/`,
`execution-json-backup/`, `retired/`.

`retired/` is where a decommissioned feature's data is set aside rather than
deleted. The built-in Agent's `agent/` directory is moved there whole, once, as
`retired/agent-<stamp>/` on the first start of a build without the Agent (#908,
`retireAgentStore` in `decommission-sweep.ts`); the `decommissioned-agent`
marker at the root records that it ran.

**Two of these have same-named twins in tier 2, and they are different things:**

| name | in the store (tier 1, moves) | in `userData` (tier 2, stays) |
|---|---|---|
| `browser-profiles` | Chromium user-data-dirs for the **headless** runtime (`daemon.ts`) — what the Storage pane's "browser-profiles" row measures | `browser-profiles.json`, plus `Partitions/<name>/`: the Electron partitions for **the browser a human clicks**, including its cookies and logins |
| `diagnostics` | per-worker JSONL (`worker-diagnostics.ts`) | heap snapshots (`main.js`) |

So the Storage pane row labelled *"Chromium partitions for Telar's own browser"*
does not measure the browser the person uses, and moving the store does not take
their logins with it. That is a real gap and it is listed as open below.

### Secrets

Two places carry secrets at 0600 in files of their own:
`dictation/credentials.json`, and the trio `provider-secrets.json` /
`usage-limit-secrets.json` / `mcp-oauth.json`. A home that ran the built-in
Agent also keeps its pasted key at `retired/agent-<stamp>/credentials.json`,
still 0600 — moved there by #908, not deleted, and read by nothing.

Splitting a secret out of the record it belongs to is deliberate and
well-argued: `listProviderInstances` hands its answer to a settings page over
HTTP, and a secret on the record would echo every API key the person ever typed
back to the browser on every open. **It also means a person cannot tell by
looking which files in their store are dangerous to share** — which is a
consequence to write down rather than to fix by re-merging them.

### At `TELAR_HOME` itself

`store.json` — the stamp (`storeId`, `createdAt`), minted once, carried by a
migration, never regenerated. `remote/remote.json`, `remote/hosts.json`, and
`remote/mobile-push.json`.

> **`remote/remote/mobile-push.json` was a real path until #665.** `remoteHome()`
> already returns `<TELAR_HOME>/remote` and `pushFile()` joined `"remote"` onto it
> again, so every install with a phone registered grew a `remote/remote/`
> directory nobody intended. Fixed with a read-both-write-new migration:
> `readPushRecords()` reads the new path and falls back to the doubled one, and
> the first write after upgrade lands on the new path. **The old file is not
> deleted on the read path** — a delete performed while reading is how a
> downgrade becomes data loss. It is a few hundred bytes of litter that a later
> pass may sweep once no shipped build reads it.

---

## Tier 2 — this installation

Electron's `userData`. At the default location `userData` **is** `TELAR_HOME`,
which makes this whole tier invisible: everything looks like it is in one place.
The moment the store moves to a drive, this tier stays behind on the internal
disk.

| what | why it is here |
|---|---|
| `store-location.json` | the marker. Deliberately does not move — it is how "where is the store" survives the store being absent. Correct. |
| `server-port.json` | this process's listening port. |
| `update-prefs.json` | which channel this copy follows. |
| `ui-prefs.json` | this window's geometry and chrome. |
| `update.log`, `shell.log`, `diagnostics/` | this install's logs and heap snapshots. |
| `keybindings.json` | **fails the tier-2 test — see below.** |
| `browser-profiles.json`, `browser-site-permissions.json`, `browser-tabs.json` | **the first two fail the test — see below.** |
| `Partitions/<name>/` | the integrated browser's cookies and logins. **Fails the test.** |
| `extensions/` | the 1Password extension payload. Re-downloadable; correctly here. |
| `Cache/`, `Local Storage/`, … | Chromium's own. Note that the cockpit's **appearance Look actually lives in `localStorage`** — `appearance.json` in the store is a *republication* for paired clients, not the record. |

### OPEN — four things in tier 2 that fail the tier-2 test

The rule for tier 2 is *"meaningless on another machine"*. These four are not:

- **`keybindings.json`** — a person's customisation, and the one they would
  notice. Their shortcuts do not travel with their store.
- **`browser-profiles.json`** and **`browser-site-permissions.json`** — named
  profiles and per-site grants.
- **`Partitions/<name>/`** — the integrated browser's cookies and logins.
- **the Look in `localStorage`** — with `appearance.json` beside it in the store
  already, as a republication.

Each promotion is a small migration: read from `userData` if present, write to
the store thereafter.

**They are deliberately NOT promoted here, and this is the owner's call, not a
builder's.** There is a defensible "no": a drive that travels is a drive that
can be lost, and a person may not want their browser logins following their
store onto it. Promoting them is a decision about what a store *is*, which is
exactly the kind of decision this page exists to make explicit rather than
settle in passing.

---

## Tier 3 — reproducible

`engine/worktrees/` (relocatable since #642 part 2), `engine/python/`,
`engine/tools/`, and the package managers' caches.

The rule earns its own tier because of one asymmetry the Storage pane already
states in a person's words: **a checkout is re-cut from a recorded base sha, so
losing one costs a re-clone; a transcript is the only copy there has ever
been.** That is the whole argument for relocating worktrees and not history.

### Package caches and the filesystem boundary (#633)

Deduplication — hardlinks, and APFS `clonefile`, which is bun's default backend
on macOS — is **same-filesystem only**. When the worktrees and the package
cache land on different devices, every install into a worktree pays a real full
copy.

`apps/engine/src/package-caches.ts` detects this by comparing `st_dev`. Note the
deliberate contradiction with `volumes.ts`, whose header **rejects** a
device-number test: that rejection is correct for *its* question ("is this an
external drive"), because APFS firmlinks put `/Users` on a different device from
`/`. Deduplication is literally a same-filesystem property, so comparing two
arbitrary paths' devices *is* the question here, and the comparison against `/`
is never made.

**Three instruments lie about this and none of them may be used as evidence:**

| instrument | why it lies |
|---|---|
| `du` | cannot see block sharing, so a free clone and a paid copy read identically |
| `stat.blocks` — and therefore Telar's own Storage pane, which is `blocks * 512` | the same |
| hardlink count | `clonefile` shares blocks **without** raising it; it reads 1 whether dedup works or not |

Only a `df` delta across a real install distinguishes them, and it must be run
twice — same-device and cross-device — because one number alone proves nothing.
The Storage pane's copy now says its figure is **apparent** size rather than
physical, because it is a shipped instrument that reads "fine" when the thing is
broken and "broken" when it is fine.

---

## Tier 4 — not ours

- **`~/.claude/projects/<cwd-slug>/<sessionId>.jsonl`** — the Claude driver's
  transcripts. Telar reads them and **renames files there** (`claude-fork.ts`).
  For Claude-driver sessions a meaningful part of the conversation record is in
  a third-party CLI's home, on the internal disk, uncounted and unmoved. The
  rename is the one tier-4 *write* that should be re-examined on its merits.
- `~/.claude`, `~/.codex`, `~/.config/opencode` — skills and auth.
- `~/.local/bin` — created by the engine for CLI installs.
- `~/.bun` install cache, `~/.conda`, `~/miniforge3`.
- `os.tmpdir()` — textgen scratch, installer scripts.
- **The person's own repositories** — `ensureTelarGitignore` appends to
  `<projectRoot>/.gitignore`, deliberately non-atomically.
- **The macOS Keychain** — the APNs signing key. No migration carries it and no
  copy of the store contains it.

---

## So what would a person have to back up or move?

Four separate operations, and only the first is built:

1. **Settings ▸ Storage ▸ Move…** carries `engine/`, `remote/` and the stamp.
2. **Nothing carries tier 2.** Keybindings, browser logins, open tabs, site
   grants and the cockpit's Look stay on the old machine. *The person is not
   told.*
3. **Nothing carries `~/.claude/projects/`.** Claude-driver transcripts stay
   behind.
4. **Nothing carries the Keychain item.**

### A supported safe copy

`ExecutionStore.copyTo()` (#665) is the sanctioned way to get a store somebody —
or an agent — can open without risk: `VACUUM INTO` for the database, a file copy
for the non-sqlite subtrees, into a destination that must not already exist.

It exists because **a store shape is not finished until there is a supported way
to get a safe copy of one.** Before it, the only read paths were a size walk and
a hand-run `sqlite3 -readonly` snippet, so every question of the form "what is
actually in there" became either a manual query against the one irreplaceable
artifact or an estimate — which is what happened in #646 and #658, and why
#646's own numbers had to be corrected twice.

---

## Where the settings live, and which one is the index

Storage decisions are spread across seven panes, and each belongs where it is.
What was missing is that **one of them is the index and the others link to it**:
Settings ▸ Storage is that one.

| pane | what it decides |
|---|---|
| **Storage** | the figures, the retention window, where the store is, where checkouts go, which checkouts can go |
| General ▸ Workspace | worktree-vs-local, which is a storage decision |
| Projects | per-project roots |
| Browser | profiles → `Partitions/` |
| Plugins ▸ Data science | a Python interpreter path |
| Plugins ▸ LaTeX | a tectonic path and a managed install inside the store |
| Remote access | `remote.json` |

---

## `@telar/env` — a second root convention, not shipped

`packages/env/src/paths.ts`:

```ts
export function telarHome(): string {
  return process.env.TELAR_HOME ?? join(homedir(), ".telar");
}
```

It writes `<TELAR_HOME>/env/state.json`, `<TELAR_HOME>/projects/<id>/env.yaml`
and `<TELAR_HOME>/config.yaml` — **directly at `TELAR_HOME`, not under
`engine/`** — and its fallback is `~/.telar`, which is exactly the path
`engineRootFromEnv` refuses as legacy state.

**Nothing in the shipped product imports or runs it.** It is not a dependency of
`apps/engine`, `apps/web` or `apps/desktop`; the only repository-level
references are CI's own `typecheck` and `test:env` scripts. Its README describes
it as standalone and Telar-optional.

It is therefore **a separate, unshipped convention**, documented here rather
than deleted, and it must not be adopted into the product without first adopting
`<TELAR_HOME>/engine`'s convention — otherwise it drops three paths into
`userData` beside `engine/` and `remote/`, which is the exact "two owners of one
directory" that `LEGACY_ROOT_NAME` exists to prevent. Tracked in **#861**, which
lays out the three ways out and the one of them that is worth doing whichever is
chosen.

---

## How the invariant test sees every writer

`apps/engine/test/store-shape.test.ts` asserts that a representative workload
creates nothing outside the sanctioned set. The trap it is written against is
real and worse here than the generic version, because **most of Telar's writers
are not in this process**: `apps/engine/src` alone has ~114 synchronous `fs`
write callsites *and 162 subprocess spawn sites* (git, bun, uv, conda, tectonic,
and the agent CLIs), plus native sqlite, plus Chromium inside Electron.

A test that monkey-patches `node:fs` sees perhaps half the fs writes and **none**
of the sqlite, subprocess or Chromium writes — and passes, cleanly, while the
store grows directories it did not sanction. So:

1. **It observes the filesystem, not the process.** Snapshot the tree, drive a
   workload, snapshot again, diff. A filesystem diff cannot be evaded by a
   subprocess, by native sqlite or by Chromium, because it does not care who
   wrote.
2. **Sanctioned is a list the product owns**, not one the test keeps —
   `statePaths` plus the named directories, which is why "`statePaths` is the
   only way to name a root file" is a precondition and not tidying.
3. **The workload IS the coverage argument.** The test proves nothing about a
   writer it never provoked, so the covered list is written in the file and
   anything absent from it is explicitly out of reach.
4. **A canary per writer class proves the harness can see.** One in-process
   `fs` write, one from a *spawned subprocess*, one through sqlite — each must
   be reported. If a canary is invisible the harness is blind, and the blindness
   fails CI rather than being discovered a year later.
5. **`$HOME` is inside the sandbox.** Tier 4 means the run must touch nothing
   under the real home, and that only holds if `HOME`, `CLAUDE_CONFIG_DIR`,
   `CODEX_HOME`, `BUN_INSTALL_CACHE_DIR` and `XDG_CONFIG_HOME` are all
   redirected. Any of them unset is a hole, and `claude-fork.ts` writing into
   `~/.claude/projects` is the writer that would find it.

---

## Open, and deliberately not decided here

- **The four tier-2 promotions** (keybindings, browser profiles, site
  permissions, the Look). The owner's call; see above.
- **The two same-named directory pairs.** `browser-profiles` and `diagnostics`
  each mean two different things at two levels. Renaming one of each would end
  it; nothing here does.
- **Telar renaming files inside `~/.claude/projects`** — the one tier-4 write.
- **`@telar/env`'s second root**, above.
- **Windows and Linux.** `volumeSupportOn()` now reports what each platform can
  actually answer, and both consumers surface it as a named state rather than
  as a confident wrong one. What is not known is whether Windows is a target at
  all; the desktop app is macOS arm64 only today.
- **The two mount-list copies in `apps/desktop`.** The list itself now lives
  once, in `@telar/engine-client`'s `mounts`, which the engine and the cockpit
  both import. The shell cannot: it is plain CommonJS packaged by
  electron-builder from an explicit allowlist inside its own directory, with no
  workspace dependency on that package, and adding one to share four strings
  would pull zod and the whole protocol into the app bundle.
  `apps/desktop/mount-roots.test.js` holds those two copies to the original,
  platform by platform, which is the part that was missing — before #665 there
  were five copies agreeing by convention and the win32 hole was in all five.
  Collapsing the last two needs a packaging decision, not a refactor.

# The Living Map — Storage and Collision Protocol

Companion to `SPEC.md` (CAP-3, CAP-21, CAP-22).

## Two artifact classes, different physics

1. **Loom-run artifacts** — decision graph, flow DAGs, evidence, per-loom deltas. Single-owner, engine state:
   `TELAR_HOME/projects/<id>/looms/<loom-id>/{decision-graph.json, flow/*.json, evidence/}`. No collisions by construction.
   **This project-scoped tree is the canonical per-loom root for *all* loom state** — engine state and service
   leases included (conciliation ruling, 2026-07-24). New looms create everything here; the legacy flat
   `~/.telar/looms/<id>/` tree stays read-only for pre-redesign looms until drained.
2. **Project knowledge** — the living map: PRD/objective, architecture decisions, context, verification recipe. Shared and durable → **in-repo by default**, as fine-grained markdown region files (`objective.md`, `architecture.md`, `surfaces.md`, `verification.md`, …), **never a monolith**.

Both sit behind a **MapStore adapter**: one read/write interface, two backends (in-repo dir | `TELAR_HOME` dir). Location is a per-project config dial set once (prep may ask at the first loom) and reversible via a migration command. Default: personal repos → in-repo; work repos (non-personal remote) → home.

**Only human-meaningful markdown ever lands in-repo.** Machine artifacts (DAG JSON, evidence, HTML) always stay in `TELAR_HOME`, referenced by loom id — they are unmergeable and not human-reviewable.

## Collision protocol (lockless)

No file locks anywhere. Looms run for hours; locks would starve the fleet.

1. **Pin** — at prep, each loom pins the map's content hash as read.
2. **Propose** — looms never write shared docs directly mid-run; they emit proposal deltas to a ledger.
3. **Land serially** — at accept, deltas land one at a time. Serial landing is the moat.
4. **Rebase-adapt** — if map head moved since the pin, a mandatory rebase-adapt agent pass re-applies the delta onto the current doc (the doc equivalent of rebase-and-reverify).
5. **Surface contradictions** — if the rebase reveals a *semantic* contradiction rather than a textual merge, both deltas show side-by-side on the accept card. The human rules.
6. **Staleness check** — the lazy intake diff runs again at land time; large drift triggers the existing bounded recompile instead of blind landing.

Intake always diffs against the map at **main/default-branch head**, never against a worktree's local copy — worktrees may carry divergent copies freely because landing is serial.

### Read semantics

- **The pin does not move for the loom's lifetime.** Threads read the pinned map as stable background reference. A loom's own prep decisions do not rewrite that view — they travel through the contract frozen at the gate and through each node's context manifest. This is what makes the map background truth rather than a mutable scratchpad, and it makes the rebase base at land time unambiguous.
- **Graph-generated artifacts are not shared at all.** The decision graph, flow DAGs, node conversations and evidence are single-owner engine state under `TELAR_HOME/projects/<id>/looms/<loom-id>/` — collisions impossible by construction. Only the map is shared, and it is never written mid-run. There are therefore no contested *files* between looms, only contested *proposals*, resolved serially at accept.
- **Other looms' open proposals are reachable, never handed over.** A preparation agent may query the ledger for unlanded proposals touching a region it is working on; nothing is injected into its context by default. A loom plans against accepted reality, may look at what is coming, and never builds on it — if that loom is boomeranged, nothing was built on a fiction.

### Three collision classes, three owners

| Class | Trigger | Owner |
|---|---|---|
| Textual | two deltas touch the same region file | fine-grained region files + rebase-adapt agent |
| Semantic | deltas textually merge but contradict in meaning | human, via the accept card |
| Staleness | loom planned against an outdated map | drift-diff at land + bounded recompile |

## Load-bearing rules

- One file per map region — shrinks the textual collision surface and prevents monolith sediment.
- The **ledger holds full history**, so region files can be adapted **in place** (rewritten, not appended to) and stay lean. This is the fix for the epic-sediment failure mode: documentation **adapts, never accumulates**.
- The map is a **regenerable projection** — a reconciliation loom can rebuild it from repo + ledger. That is what lowers the stakes of the location question in the first place: only unregenerable things (human decisions, accepted deltas) need a durable versioned home.
- **Hand-edits by the user are allowed and treated as GOOD.** Human writes are never silent; the lazy intake diff absorbs them as drift, exactly like code drift.
- This instantiates the fractal: **declare (delta) → validate (schema) → execute deterministically (serial land) → reconcile lazily (rebuild view)**. Storage falls out of the pattern rather than being a new decision.
- It respects wall #4 — nobody writes the map silently — which is precisely what makes locks unnecessary: proposals are the only write path, landing the only commit path.

## Map write-back paths

Only three, and none of them is automatic:

- **(A) Drift ledger** declared on accept.
- **(C) Lazy intake diff**, always on, at prep and at land.
- **(B) Threshold-triggered reconciliation loom** as escalation, when drift exceeds what (A) and (C) absorb.

## Rejected options

Recorded so they are not re-litigated.

- **A — all in-repo**: repo pollution, unmergeable generated JSON/HTML, unusable on work repos where planning docs can't be committed.
- **B — all in `TELAR_HOME`**: map drifts from branch reality, invisible to in-repo tooling, lost on a `.telar` wipe, doesn't travel with a clone.
- *(B sub-option) in-repo but gitignored*: same loss of versioning and portability as B — "B wearing an in-repo costume."
- **D — git-native sidecar** (`refs/telar/*`, git-notes style): versioned and pollution-free, but exotic — invisible in a normal checkout, agents can't just read files, nobody can debug it at 1am.
- **E — sidecar repo** (`~/.telar/maps/<project>`, own git history): clean separation, but two repos to keep correlated and map-to-code version pinning becomes its own problem. Most machinery for least gain at single-user scale.

## Region set

**Regions are declared by the project's loaded methodology, not by the engine** (CAP-7). There is no universal taxonomy to discover — the deferred research question ("what should a living project model hold?") is moot as posed, because the answer belongs to whichever method the project follows.

v1 ships one built-in methodology, BMAD-derived, declaring:

| Region | Holds |
|---|---|
| `objective.md` | what we are building and why — BMad's PRD role |
| `architecture.md` | structural decisions |
| `form.md` | how it should feel — the region the vision critic judges against |
| `surfaces.md` | what the system exposes |
| `verification.md` | the recipe region (compiles to `servers.yaml` + prepare/carry/verify) |
| `conventions.md` | house rules — telar's existing `project-context.md` folded in, so hand-edits to it are absorbed as drift like any other region |

**Epics and stories are deliberately not a region.** They are work breakdown — what is being done right now — not durable truth about the project, and that role is already played by the decision graph and compiled flow DAGs, which live as run artifacts under `TELAR_HOME`. Making them a durable region would import the epic-sediment failure the artifact-storage session set out to fix.

A region declaration says what the region **holds** — not how its staleness is proven. Noticing drift is the intake session's judgment over intent, the map and the actual repo; it may read the repo, stand the lab up, or ask, and it chooses. Some regions happen to be mechanically checkable (does the recipe still boot, do the described routes still exist) and others only judgeable (objective, form), but that is an observation the session can exploit, not a schema field it must obey. The readiness gate is what makes the looseness safe: the human rules on the resulting graph before any build spend.

Two rules keep a declared catalog from becoming ceremony:

- A methodology declares what regions *may* exist; **drift alone decides which nodes run**.
- A methodology never declares *how* anything is written — the propose → serial land protocol sits below it and is unreachable from it, so wall #4 survives a user-modified methodology.

Changing a project's methodology is a reconciliation-loom rebuild of a regenerable projection, never a schema migration.

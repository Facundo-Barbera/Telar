# Intent: Loom Artifact Storage & Collision Handling

Source: brainstorm-loom-artifact-storage-2026-07-24 (.memlog.md). For bmad-spec intake.

## Decision

Two artifact classes, different physics:

1. **Loom-run artifacts** (decision graph, flow DAGs, evidence, per-loom deltas) — single-owner, engine state → `TELAR_HOME/projects/<id>/looms/<loom-id>/{decision-graph.json, flow/*.json, evidence/}`. No collisions by construction.
2. **Project knowledge** ("living map": PRD, architecture decisions, context, verification recipe) — shared, durable → **in-repo by default**, as fine-grained markdown region files (one file per region: `objective.md`, `architecture.md`, `surfaces.md`, `verification.md`, etc.), never a monolith.

Both classes sit behind a **MapStore adapter**: one read/write interface, two backends (in-repo dir | TELAR_HOME dir). Location is a per-project config dial, set once (prep can ask at first loom), reversible via a migration command. Default: personal repos → in-repo; work repos (non-personal remote) → home.

Only human-meaningful markdown ever lands in-repo. Machine artifacts (DAG JSON, evidence, HTML) always stay in TELAR_HOME, referenced by loom id — they're unmergeable and not human-reviewable.

## Collision Protocol (lockless)

No file locks anywhere — looms run for hours; locks would starve the fleet. Sequence:

1. **Pin** — at prep, each loom pins the map's content-hash as read.
2. **Propose** — looms never write shared docs directly mid-run; they emit proposal deltas to a ledger.
3. **Land serially** — at accept, deltas land one at a time (serial landing = the moat).
4. **Rebase-adapt** — if map head moved since pin, run a mandatory rebase-adapt agent pass: re-apply the delta onto the current doc (doc equivalent of rebase-and-reverify).
5. **Surface contradictions** — if the rebase reveals a semantic contradiction (not just a textual merge), show both deltas side-by-side on the accept card; human rules.
6. **Staleness check** — the lazy intake diff (already run at prep) is also run at land time; large drift triggers the existing bounded recompile instead of blind landing.

### Three collision classes → three owners

| Class | Trigger | Owner |
|---|---|---|
| Textual | two deltas touch the same region file | fine-grained region files + rebase-adapt agent |
| Semantic | deltas textually merge but contradict in meaning | human, via accept card |
| Staleness | loom planned against an outdated map | drift-diff at land + bounded recompile |

Intake always diffs against the map at main/default-branch head, never against a worktree's local copy — worktrees may carry divergent copies freely since landing is serial.

## Rejected / Parked Options

- **A — all in-repo**: repo pollution, unmergeable generated JSON/HTML, unusable on work repos you can't commit planning docs to.
- **B — all in TELAR_HOME**: map drifts from branch reality, invisible to in-repo tooling, lost on `.telar` wipe, doesn't travel with a clone.
- *(B sub-option) in-repo but gitignored*: same loss of versioning/portability as B — "B wearing an in-repo costume."
- **D — git-native sidecar** (`refs/telar/*`, git-notes style): versioned and pollution-free, but exotic — invisible in a normal checkout, agents can't just read files, nobody can debug it at 1am.
- **E — sidecar repo** (`~/.telar/maps/<project>`, own git history): clean separation, but two repos to keep correlated and map-to-code version pinning becomes its own problem — most machinery for least gain at single-user scale.

## Load-Bearing Rules to Preserve

- Only human-meaningful markdown lands in-repo; machine JSON/HTML stays in TELAR_HOME.
- One file per map region — shrinks textual collision surface and prevents monolith sediment.
- The ledger holds full history so region files can be adapted-in-place (rewritten, not appended-to) and stay lean — this is the fix for the bmad epic-sediment failure mode.
- The map is a regenerable projection (a reconciliation loom can rebuild it from repo + ledger) — this is what lowers the stakes of the location question in the first place; only unregenerable things (human decisions, accepted deltas) need a durable, versioned home.
- Hand-edits to in-repo map files by the user are allowed and treated as GOOD (human writes are never silent) — the lazy intake diff absorbs them as drift, same as code drift.
- This all instantiates the existing fractal pattern: **declare (delta) → validate (schema) → execute deterministically (serial land) → reconcile lazily (rebuild view)**. Storage falls out of the pattern rather than being a new decision.
- Respects wall #4 — nobody writes the map silently — which is what makes locks unnecessary: proposals are the only write path, landing is the only commit path.

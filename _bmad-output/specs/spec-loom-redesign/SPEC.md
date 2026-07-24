---
id: SPEC-loom-redesign
companions:
  - lifecycle.md
  - verification.md
  - recipe-schema.md
  - map-and-storage.md
  - ux-surfaces.md
  - brownfield.md
  - ../../brainstorming/brainstorm-loom-verification-2026-07-18/recipe.schema.yaml
  - ../../brainstorming/brainstorm-loom-ux-ui-2026-07-23/conversation-component.md
  - ../../project-context.md
sources:
  - ../../brainstorming/brainstorm-loom-system-2026-07-18/brainstorm-intent.md
  - ../../brainstorming/brainstorm-loom-verification-2026-07-18/brainstorm-intent.md
  - ../../brainstorming/brainstorm-loom-verification-2026-07-18/schema-grid.md
  - ../../brainstorming/brainstorm-loom-ux-ui-2026-07-23/brainstorm-intent.md
  - ../../brainstorming/brainstorm-loom-artifact-storage-2026-07-24/brainstorm-intent.md
  - ../../brainstorming/brainstorm-organization-workspace-2026-07-23/brainstorm-intent.md
---

> **Canonical contract.** This SPEC and the files in `companions:` are the complete, preservation-validated contract for what to build, test, and validate. Source documents listed in frontmatter are for traceability only — consult them only if you need narrative rationale or prose color this contract intentionally omits.

# Loom Redesign — Intent to Proven Delivery

## Why

A vision to realize, with a diagnosed failure in the way. A loom's axiom is **get it done**: carry intent all the way to proven-working delivery, on judgment rather than steering, so the human stays in the planner seat — planning the next batch while fleets deliver. Telar's looms already run in production, but the root failure is **preparation**: a single agent drafts charter and spec, infers too much, and the human is asked to steer at the wrong moments. Downstream of that, verification never reliably closed the loop (threads that never reach approval), evidence was not trustworthy enough to judge in seconds, and the surfaces were built for one loom at a time when 7+ concurrent is the norm. This spec is the converged output of four brainstorming sessions — the loom's form (2026-07-18), the verification system (2026-07-22), the UX/UI rebuild (2026-07-23), and artifact storage (2026-07-24) — restructuring the loom into three acts (prepare, execute, judge) around four structural walls. The loom's true deliverable is **evidence**; code is the side effect.

## Capabilities

### Act 1 — Prepare

- **CAP-1** Loom birth and detach
  - **intent:** A user turns an ask into a loom from a session: the session hands over premise plus optional context and nothing more, then the loom detaches and lives on its own pages. The same handover fires from the workspace queue's batch weave and from a ripened work packet.
  - **success:** A loom's premise is a list of N≥1 intents, so a multi-task loom is expressible everywhere it is visible: the gate renders one contract group per intent, Judge lights those groups up per intent, and the delivery card's claim reads as N deliveries under one verdict. Accept stays a single moment — that is what sizes the loom. Spinning off leaves exactly two things in the originating chat — a detach marker and a one-line mono receipt (`premise + context · detached`) — with no graph preview, no progress narration, and no loom door in the session. Below the simple-task boundary the agent does the work inline instead and no loom exists. The batch-weave and packet paths produce the identical receipt; a ripened packet stays behind as an origin receipt. Tasks a loom has picked up stay in the workspace list and stay editable: an edit posts to that loom's always-open steering channel and the entry marks that it was sent, so the orchestrator decides what to do with it while the loom's copy of the brief stays frozen. Nothing locks — a parked loom would otherwise hold the user's own notes for days. Entries leave the list only once the loom is both accepted and landed, per `SPEC-organization-workspace` CAP-11. Batch weave hands the selected work packets over as the **preparation graph's seed**: the graph initializes from that task set rather than from an opening intake conversation, and grows from there. Both workspace paths take a typed handover — premise list plus context references — never a read of the workspace's store, consistent with that module's rule that cross-surface access goes through its MCP server and never raw file tools.

- **CAP-2** Decision graph
  - **intent:** Preparation runs as a branching DAG of real sessions that converges into the gate: an intake conversation opens it, the intake diffs intent against the living map, and planning nodes spawn only where drift exists.
  - **success:** The graph's opening is either an intake conversation or, when the loom was woven from a batch of work packets, that task set seeding the graph directly — the packets replace the opening conversation rather than being narrated into one. Every node in a completed graph is a session that actually ran or was explicitly skipped — never a decorative step. Nodes bloom and branches converge; a fresh map region skips its node rather than re-planning it; the user can steer at any point. Node shape is agent-chosen, never hard-coded.

- **CAP-3** Living map and lazy intake diff
  - **intent:** Every project carries an adaptive model of itself in fine-grained region files that intake diffs against, so preparation preserves prior progress instead of re-deriving it. Which regions exist is declared by the project's loaded methodology (CAP-7), not fixed by the engine.
  - **success:** Intake diffs against the map at main/default-branch head — never a worktree copy — and reports per-region drift; a region with no drift spawns no node. How drift is noticed is the intake session's judgment over intent, the map and the actual repo — not a per-region rule table: the session may read the repo, stand the lab up, or simply ask, and chooses. The readiness gate is what makes that freedom safe, since the human rules on the resulting graph before any build spend, so an unnecessary node costs a glance rather than money. Regions are rewritten in place, never appended to, so the map does not accumulate sediment. A loom's pin does not move for its lifetime: threads read the pinned map as stable background reference, while the loom's own decisions reach them through the gate-frozen contract and their per-node context manifests, never by mutating the loom's view of the map. See `map-and-storage.md`.

- **CAP-4** Verification-readiness node and recipe
  - **intent:** Before any build spend, a preparation node proves the lab can actually stand up for this project and emits a reusable verification recipe stored as a map region.
  - **success:** The node boots the declared services, probes readiness, and either produces a recipe every future loom on that project inherits, or fails closed with the reason — no lab, no experiment. Degraded modes (missing secret → synthetic data, feature off) are declared in the recipe and surfaced before the gate. Recipe shape in `recipe-schema.md`.

- **CAP-5** Readiness gate
  - **intent:** The human rules on the prepared plan at one entrance moat, with the option to change it in place rather than accept-or-restart.
  - **success:** The gate offers Accept, Modify on the go, and Deny → straight to development. Unprovables are shown first and the degraded-mode acknowledgement gates Accept. Modify wakes a dormant node and grows a new edge into flow compile as an audited recompile. Deny skips preparation and goes straight to build.

- **CAP-6** Approval-gated advance
  - **intent:** An agent moves the graph forward only by proposing, never by acting: `advance_node`, `weave_batch`, and the ack-gated Accept are one protocol.
  - **success:** Every advance renders as the same approval card (mono header, the proposal, Approve/Hold) and no node changes state without an explicit human approval. No code path advances a node on the agent's own authority.

- **CAP-7** Methodology as data
  - **intent:** The seats that staff graph nodes, the artifacts they produce, and the map regions those artifacts land in are **declared data, not engine code** — so a project can follow a different development methodology without changing the loom.
  - **success:** Each node in a run names the seat that staffed it, and adding a seat or an artifact requires no change to the graph engine. v1 ships exactly one built-in methodology, BMAD-derived, expressed through that mechanism rather than hardcoded — the flexibility is structural even before a second methodology exists. User overrides ride the `customize.toml` + `_bmad/custom/<name>.toml` pattern already proven in this repo (scalars override, arrays append) rather than a new format.

### Act 2 — Execute

- **CAP-8** Orchestrator ownership and the role wall
  - **intent:** After the gate the orchestrator takes sole responsibility for carrying the loom from created to delivered, and conductors never touch code.
  - **success:** Orchestrators and sub-orchestrators hold no write or edit tools and carry a distinct role in the UI (the conductor "holds no pen"); no human steering is required between gate and delivery except escalations that pass the dire razor.

- **CAP-9** Flow compile
  - **intent:** A thread's main agent authors its own execution plan — a DAG of parallel lanes with dependency edges and a per-node context manifest — which is then executed deterministically instead of improvised.
  - **success:** The authored flow validates against a schema before any child spawns; execution follows it deterministically; every node's agent receives exactly its manifest (neither context-bombed nor starved). Parallelism is a planning output, not a constant: interference analysis over shared files and surfaces shapes how wide the decomposition goes. Re-planning is an explicit, bounded, audited recompile event, and a low-confidence or simple task falls back to the pre-written step template.

- **CAP-10** Branch and worktree isolation
  - **intent:** Concurrent looms on one project never collide, because each materializes its own checkout and branch.
  - **success:** Every loom gets its own branch and its own worktree; the user's primary checkout is never touched by a loom; threads default to their own worktrees and a single serial thread may share the loom's. A thread worktree is reaped as soon as its work lands into the loom branch, so peak disk tracks threads running *now* rather than threads ever run; the loom's own worktree survives until accept and landing complete, because boomerang and park both resume from it. Thread worktrees receive dependencies by APFS copy-on-write clone of the loom worktree's install rather than a fresh install each, falling back to `prepare.install` where clonefile is unavailable — N thread checkouts must not cost N installs. A loom stacked on another loom's branch declares the relationship explicitly, verifies against A+delta, and lands after A.

- **CAP-11** Declared services and supervisor-owned labs
  - **intent:** Agents declare the services they need instead of spawning them; telar's supervisor spawns, owns, probes, restarts on death, and tears down everything under a per-owner lease.
  - **success:** `ensure_service(name)` reuses a live lease instead of spawning a duplicate; one owner token enumerates and tears down everything that run created and nothing else; orphaned processes are impossible by construction. The same primitive serves in-chat session processes and loom labs, differing only in owner and lifetime, and the UI lists both from the registry.

- **CAP-12** Borrowed heavy infra
  - **intent:** A fleet shares expensive infrastructure by time and refcount rather than each loom standing up its own stack.
  - **success:** Each service declares scope `project | loom | ephemeral`; project-scope stacks are shared under a refcounted lease and released on last use; a fleet-wide semaphore caps concurrent heavy stacks and queues the rest; labs are leased just-in-time per verify round, not for the loom's lifetime. Data isolation is tenant-db (stamped from a migration-hash-keyed template) where the backend allows and mutex-plus-reset where it does not. See `verification.md`.

- **CAP-13** Two-altitude verification
  - **intent:** Two different questions get two different answers: "does the code hold?" runs constantly and cheaply per thread; "is this what you asked?" runs as a full lab experiment at the loom altitude.
  - **success:** Thread-altitude verification is serviceless, streaming and parallel, runs on every thread, and its rungs double as the progress heartbeat. Loom-altitude verification stands up the lab, runs live Playwright against a real checkout with capability-walled agents, and emits evidence — gated so that only one loom verification per repo runs at a time.

- **CAP-14** Pause, park and resume
  - **intent:** A loom survives interruption: it parks on usage or credit exhaustion or on user command, and picks back up later.
  - **success:** Execution state is durable enough that a parked loom resumes without re-running completed work, including under a different account or provider; the UI shows park state and why.

- **CAP-15** Progress liveness and dire-razor escalation
  - **intent:** The human is told when a loom has genuinely stopped, and is not told anything else.
  - **success:** Two liveness layers run: the supervisor watches process liveness (restart on death, crash-loop breaker) and the orchestrator watches progress liveness — a heartbeat of evidence rungs, landings and verify rounds. A flatline for N minutes escalates as dire even when every process is green. Push fires only when the loom has no viable path to advance without the human; a failed test entering repair or a flaky boot being retried never pushes. Mid-run escalations ask the orchestrator first and reach the user only if mediation fails.

### Act 3 — Judge

- **CAP-16** Evidence subsystem
  - **intent:** One evidence system serves three consumers — proof on the accept card, proof-of-life for stall detection, and forensics for disputes.
  - **success:** Artifacts are harness-captured and provenance-stamped in a ledger; the synthesized narrative cites artifacts and any uncited claim renders as unverified; every verify attempt stays on the history with flaky boots and tests flagged; each run records its lab grade (dev or release) and its reality manifest (which mode the lab actually ran in — real or synthetic data, which services degraded).

- **CAP-17** Delivery card
  - **intent:** A human judges a finished loom in seconds at fleet scale, and can go as deep as taste and then evidence when a delivery earns it.
  - **success:** The shelf row carries claim, proof strip, risk flags, release grade and the verdict in place — skimmable across 7+ looms. Opening a card leads with the live product on its frozen final-verify lane (filmstrip flipping to ledger screenshots), with the courtroom below the glass: reality manifest, cited narrative, contract with per-assert citations, evidence ledger, attempt history, advisory critic verdict. One `VerdictBar` per delivery, shared between shelf row and open card.

- **CAP-18** Accept-then-land with a landing queue
  - **intent:** The human judges branch evidence first; landing is mechanical work that happens afterward, serially, without stalling on human latency.
  - **success:** Accept queues the landing; the queue rebases each accepted branch onto moved main and re-verifies the same contract at release grade before merging, one at a time. A clean rebase with a contract pass lands silently; a landing whose repair modified code surfaces a delta note on the done card; a contract failure re-opens repair and knocks only when repair is exhausted.

- **CAP-19** Boomerang
  - **intent:** Rejecting a delivery sends the loom back to finish what it started, rather than discarding it.
  - **success:** Boomerang opens a composer; sending resumes the same loom with its branch, worktree and recipe intact, so the second attempt is cheap. No rejected loom is destroyed by the rejection.

- **CAP-20** Vision critic
  - **intent:** An advisory seat judges a delivery against the map's objective and form regions — the "why", where verifiers only check contracts.
  - **success:** The critic's verdict renders in the card's courtroom section and never gates or bypasses Accept.

- **CAP-21** Map write-back
  - **intent:** The map changes only through human-accepted proposals, so parallel looms never corrupt shared project knowledge.
  - **success:** A loom pins the map's content hash at prep and emits proposal deltas to a ledger instead of writing shared docs mid-run; the drift ledger is declared on accept; deltas land one at a time; a moved head triggers a mandatory rebase-adapt pass that re-applies the delta onto current content; a semantic contradiction that survives textual merge is shown side-by-side on the accept card for the human to rule on; large drift at land time triggers the bounded recompile instead of blind landing. Another loom's open, unlanded proposals are **reachable but never handed over**: a preparation agent can query the ledger for proposals touching a region it is working on, and nothing is injected into its context by default. A loom plans against accepted reality; it may look at what is coming, and never builds on it. Protocol detail in `map-and-storage.md`.

- **CAP-22** MapStore and the artifact split
  - **intent:** Two artifact classes with different physics get one storage interface: single-owner run artifacts and shared, durable project knowledge.
  - **success:** Loom-run artifacts (decision graph, flow DAGs, evidence, deltas) always live under `TELAR_HOME/projects/<id>/looms/<loom-id>/`; project knowledge lives in-repo by default as per-region markdown. Both go through one MapStore read/write interface with two backends; location is a per-project dial set once, defaulting in-repo for personal repos and home for work repos, and reversible by a migration command.

### Surfaces

- **CAP-23** Home / fleet triage
  - **intent:** From one screen the user sees what needs them, what is running, and where the map has drifted — across the whole fleet.
  - **success:** Needs-you sits top-left and splits into a compressed delivery shelf (claim, proof tally, risk flag, Accept/Boomerang) and parked questions shown verbatim, where answering resumes the loom. Running rows carry an act chip (prepare/build/verify/repair/parked) and evidence age. The right column keeps recent sessions and adds a done-today receipt and hot projects carrying map drift, plus a landing-queue strip — queued count, what is currently landing, landed today — so an accepted-but-unlanded loom is never invisible. It grafts onto the existing dashboard's KPI hero, two-column deck and panel grammar rather than replacing it.

- **CAP-24** Loom cockpit
  - **intent:** A running loom is walkable: the user can enter any act, follow the work down to an individual agent, and reach the live product and the lab from the same page.
  - **success:** Persistent Prepare/Execute/Judge act tabs with park and kill in the header. Prepare renders the sealed preparation DAG as a frozen receipt. Execute pins the conductor over dense thread rows, always rendered inside groups — a single-lane flow renders exactly one group, and group identity comes from the compiled flow's declared lanes rather than a free-text label, so a group always denotes real interference structure. Drilling a thread shows the compiled flow, per-node context manifests, builder lanes, thread-altitude rungs, and per-agent transcripts streaming in a right drawer. Judge shows the contract lighting up as work completes. The header carries WINDOW (live merged-so-far URL, borrowed on demand at scale), LAB (service registry with scope, lease token, trust wall) and CHATS (steering always open, intake reopenable). Full surface contract in `ux-surfaces.md`.

## Constraints

- **The four structural walls are the constitution and never bend:** verifiers cannot write, conductors cannot code, agents cannot accept, and nobody writes the map silently. The existing human-accept moat is unchanged — there is no agent-callable accept tool, and none is ever added.
- **ONE design for looms at any size.** No small/medium/large UI split. Below the simple-task boundary work stays a plain session with no loom and no graph; the moment something becomes a loom it takes the full shape — detach, graph, gate, cockpit, delivery. Ceremony scales; the branch, evidence and human-accept walls hold at every weight, so even a one-stitch loom gets a worktree and a screenshot.
- **The decision graph always exists** and is never rendered inside the originating session's UI — it belongs entirely to the loom's own pages.
- **No file locks anywhere on the map.** Looms run for hours; locks would starve the fleet. Proposals are the only write path and serial landing the only commit path — that is what makes locks unnecessary.
- **Only human-meaningful markdown lands in-repo**, one file per map region. Machine artifacts (DAG JSON, evidence, HTML) always stay in `TELAR_HOME`, referenced by loom id — they are unmergeable and not human-reviewable.
- **A methodology declares the catalog, never the graph.** It states what artifacts and regions *may* exist and who staffs them; drift alone decides which nodes actually run. A methodology that could force its full artifact set to run every time would rebuild the epic-sediment failure inside the loom.
- **Methodologies never declare how anything is written.** They name artifacts, seats and regions; the propose → serial land protocol sits below the methodology layer and is not reachable from it, so wall #4 survives a user-modified methodology.
- **The region set is per-project.** Changing a project's methodology is a reconciliation-loom rebuild of a regenerable projection, never a schema migration.
- **Hand-edits to in-repo map files are allowed and treated as good.** Human writes are never silent; the lazy intake diff absorbs them as drift, same as code drift.
- **One loom verification per repo at a time** (per-repo verification mutex). Heavy infra is never duplicated for concurrent verifies of the same repo.
- **Trust wall:** sessions may adopt a user-hand-started foreign stack; looms never may. Adoption is allowed for working, forbidden for proving — evidence comes only from telar-owned labs.
- **Data class `production` means refuse surface-verify, fail closed.** This is a real hazard, not hypothetical: a surveyed project's documented dev path pointed at live production Supabase.
- **Carried files have lab-checkout lifetime.** `carry` plants them at checkout at mode `0600`, scrubs them at teardown, and never copies them into evidence, the map, or an agent transcript. Worktree removal stays best-effort as it is today, with one exception: a worktree that held carry files and cannot be removed raises a dire escalation naming the path, rather than swallowing the failure and leaving secrets on disk.
- **Evidence inherits its recipe's data class.** `disposable` retains freely; `shared-dev` is flagged on the reality manifest as possibly carrying real data and never lands in-repo; `production` is already refused. Evidence is reaped with its loom.
- **Degradation is a prep-time concern.** The readiness node surfaces it before the gate so the user decides with full knowledge before any spend; it never surfaces mid-run.
- **Children escalate to mediation, never straight to humans.** Mid-run escalation asks the orchestrator first and the user only if unresolved. Pushes are awareness-only — telar is a local, no-auth desktop cockpit and nothing can be resolved from the phone; the knock exists to kill false confidence, not to enable remote action.
- **One window per loom, never per thread.** One running server per line of development, mirroring how the user works locally: the loom's warm lane is the single live URL, updated as threads land, and thread progress is read through it. Heavy infra is one stack at a time, never N. For heavy projects the window is **borrowed on demand** — opening it stands the lane while you look and releases after; infra-free projects keep always-warm windows. The `ephemeral` scope exists for frozen final verifies and preview lanes as infrastructure, not as a per-thread preview surface.
- **How many windows may be live at once on one project is set by the recipe's `isolation` parameter, not by a fixed number.** `mutex` (Supabase-gateway, reset-on-acquire) permits exactly one live window per project, and a window cannot coexist with a loom verification there, since the verify's acquire resets the database under whoever is looking. `tenant-db` and `schema` permit one window per loom, because each loom holds its own data. A project with no database keeps always-warm windows. A request beyond what isolation permits **queues and names its holder** — it never displaces a live window or a running verify.
- **The lane owns the server.** Project-owned e2e suites reuse it via `PORT` + `reuseExistingServer` rather than launching a nested `webServer`.
- **The recipe is a map region** that compiles to `servers.yaml` plus prepare/carry/verify sections — the region is source of truth, the compiled files are what the lane consumes.
- **v1 serializes fleet access to stock or colliding ports** rather than rewriting committed port config.
- **Evidence must cite artifacts;** uncited claims render as unverified. Every verify attempt stays on the card's history and flaky boots and tests are flagged, never silently retried into invisibility.
- **Landings verify at dev grade** for speed; the accept-gating ALL-verify and the post-accept landing re-verify run at **release grade**.
- **Tone law:** no suggestion-text or doctrine captions anywhere in the UI. Surfaces show state and data only.
- **New conversational surfaces are born on the extracted `Conversation` shell.** The carve-out of `session-view.tsx` cuts at the render seam only; the shell owns no data fetching and no session semantics. Plan in `conversation-component.md`.
- **One fractal pattern runs everywhere:** declare → validate → execute deterministically → reconcile lazily. Flow compile, storage and map write-back all fall out of it rather than each being a fresh decision.
- Project-wide rules in `project-context.md` bind: client-bundle rule, atomic writes, `TELAR_HOME` as the state root, the single status vocabulary, hand-rolled SSE, bun-only.

## Non-goals

- **A graduated-autonomy dial**, or any autonomy setting that silently bypasses the accept moat.
- **Remote accept.** A relay-only companion website for answering blocked questions is a flagged future; remote accept is not, and the moat deserves its own design pass first.
- **A productized preview-deploy verify tier** — shareable preview URLs, or verifying against an actually-deployed preview. v1 ships the `ephemeral` service scope only.
- **Tenant-DB optimization beyond v1's template-stamp-per-migration-hash** (incremental stamping, warm pooling).
- **Port remapping** — rewriting or overriding committed port config per project.
- **The organization-workspace module** — master chat, Desk, queue mechanics, packet ripening, ephemeral expert agents, bed mode. Only the loom-birth seam (batch weave, packet handover, detach receipt) is in scope here; the module gets its own spec.
- **A methodology authoring UI, and a second shipped methodology.** v1 makes methodology *data*; authoring it, and proving the seam by varying it, come later.
- **A universal map-region taxonomy.** The taxonomy research is moot as posed — regions are whatever the loaded methodology declares, so there is nothing universal to discover.
- **A fleet-level map surface or landing-queue visualization** — deferred by design during the UX fit audit.
- **Telar's own Ultra workflows** — a separate workstream, contracted in `SPEC-ultra-workflows`.
- Rebuilding the existing capability-walled verifier/critic/panel stack, the supervisor, or the runner-lease machinery. This redesign generalizes and rewires them; see `brownfield.md`.

## Success signal

One real loom runs end to end on a real project, and the human touches it exactly three times. It is born from a session with a premise and detaches behind a one-line receipt; its decision graph converges into a gate the human accepts after acknowledging one declared degraded mode; the orchestrator compiles flows and runs threads on the loom's own branch in its own worktree while a borrowed lab produces cited evidence; the human reads the delivery card in under a minute and accepts; the landing queue rebases, re-verifies at release grade and lands silently. Between gate and card, the human is knocked once — and only because the loom genuinely could not advance. The recursive proof is the same run executed on telar itself under a sandboxed `TELAR_HOME`: the system verifies its own next version.

## Assumptions

- The three acts replace and absorb the existing production loom lifecycle (`queued → scoping → charter-review → preparing → running → verifying → ready → done`) rather than running beside it; the dead `preparing`-phase `runSetup` hook is the natural slot for the readiness node.
- Demo-gallery entries under `apps/web/lib/demo-gallery/**` are design source of truth, not production code — production still runs the current dashboard and `session-view.tsx`.
- `recipe.schema.yaml` in the verification brainstorm folder is the machine-readable draft the recipe map region compiles from; adopted as-is rather than re-derived here.
- The vision critic (CAP-20) is in-contract because UX 3's final card renders it. The July-18 MoSCoW listed it as Could, so its promotion is inferred from chronology, not a direct call.
- Three other July-18 "Could" items were likewise promoted by later sessions: fleet lanes + landing queue (verification made serial landing constitutional), streaming-evidence early-kill (park/kill landed in the cockpit header), and adaptive ceremony templates (superseded by "ONE design at any size" plus the ceremony dial).


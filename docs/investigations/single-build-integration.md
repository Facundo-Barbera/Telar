# Single-branch integration experiment

User objective: complete the remaining authorized Telar work with Opus agents,
one local branch, no new worktrees, and one verified build for user testing.

Branch: `telar/single-build-integration`. Base: `9666d777`.
Only working checkout: `/Users/facundo/Projects/personal/Telar`.
Root owns Git transitions, dependency installation, combined gates and packaging.
Agents own disjoint edits; shared-file ownership must transfer explicitly.
No installed application is replaced during development.

## Preservation

All eleven dirty checkouts were preserved with temporary indexes (original
indexes and worktree files unchanged), committed and published as GitHub tags
under `archive/single-build-20260910/`. Four unique local histories were also
published under that prefix. Each remote SHA was independently verified.
The primary checkout's original state is commit `c8dc2b7c`.

External backup: `/Users/facundo/telar-preservation-2026-09-09/git-checkpoints/`.
It contains the checkpoint manifest, published refs, a verified all-refs bundle,
original indexes, merge metadata, staged and working patches. The earlier
snapshot includes untracked files and checksums. These are preservation artifacts,
not feature acceptance evidence. Root has not deleted any worktree.

## First implementation wave

| Owner session | Scope | Shared-file boundary |
| --- | --- | --- |
| `e25a7f…` (Opus) | #191 plugin engine, LaTeX/DS migration, all-provider socket integration | All engine-client protocol and client verbs (including Run), daemon, drivers, worker, store; plugin settings only after naming files |
| `e36dd3…` (Opus, fresh local session) | #198 Run configurations/process tracking, #193 Files removal | Run engine modules/tests, Run web, right-panel; excludes daemon, protocol, run-mount test |
| `bb5059…` (Opus) | #206 failed counts, #214 adaptive streaming | Transcript/reveal/message rendering and tests; excludes right-panel and cockpit |

Read-only checkpoints used for ports: plugin `b73e5f71`, Run `50580435`.
UI commits: `1b757779` (#193), `d61f6365` (#206).

## Remaining scope ledger

The issue labels and previous test reports do not establish acceptance. Each
entry must be reconciled against the combined source and relevant behavior.

- #191, #198: first-wave implementation, then integrated acceptance.
- #193, #206: saved UI fixes must be ported and verified.
- #214: continuity is in PR217; adaptive paced reveal remains to implement.
- #199: milestone 1 independent session relationships, assignments, following,
  message presentation/sidebar coherence, and verified provenance. The issue
  explicitly defers optional coordinator tool restrictions to milestone 2;
  those restrictions are not part of this first implementation.
- #184: finish the saved Dev updater work without replacing the installed app.
- #192, #195, #196, #197, #204: read full issue requirements, reconcile checkpoints,
  implement missing behavior and verify; do not silently exclude them.
- #49, #71, #82, #87, #94, #120: reconcile the older open issues against current
  behavior and original scope, then implement remaining work.
- #185–190, #194, #201, #205, #208, #209: already-shipped work requires combined
  review/verification; do not reintroduce superseded implementations.

## Acceptance and delivery

Record each requirement, its implementation, and meaningful verification.
Run focused checks during development with isolated fixture homes. Serialize
the full repository gate, production web build, and final desktop packaging.
Review provider isolation, SQLite compatibility, Stop semantics, message identity,
stream continuity, and cross-feature settings/Run/plugin integration.
Report exact build commit, artifact path, checksums and test limitations.
Publication and local-deletion readiness remain separate from build acceptance.

## Review findings during the first wave

- Shared dependencies synchronized once with `bun install --frozen-lockfile`;
  two packages installed and `bun.lock` unchanged.
- Plugin policy: daemon module state does not reach a separate worker process.
  The owner changed the default to fail closed and transmits/derives ratified
  reads during registration. Combined verification remains pending.
- Run dispatch must inspect its route before consuming the request body;
  otherwise unrelated session routes receive an empty body. Owner corrected it.
- Codex read-tool classification parity changes previous Codex approval behavior;
  it must be described and tested explicitly, not called an unchanged authority.
- The first adaptive reveal draft still emptied five-character bursts in one
  or two frames. Its test excluded fully drained frames, hiding the reported
  stutter. Root reproduced the visible output timeline and requested actual
  hook tests, arrival timestamps and deadlines that later chunks cannot reset.
- Run requests need pinned host/session identity, stale-response suppression and
  inactive-surface polling control. These were sent to the Run owner for tests.

Worker-reported focused counts are checkpoints, not final build acceptance.

## Integration checkpoints — September 10

- `b0f61ba1`: adaptive streaming and neutral failed-step totals.
- `451c822b`: plugin migration, provider routing, Run configuration surfaces and
  Files-tab removal. Published; remote SHA independently verified.
- `a4dbeb69`: explicit Dev updater and product-named helper resolution. Pushed
  to the same integration branch. Real packaging and update-swap acceptance
  remain pending.
- Root checks: engine-client 88/88; focused plugin/Run integration 55/55;
  desktop unit suite 208 pass, 3 skipped. Socket fixtures needed execution
  outside the filesystem/network sandbox; initial bind failures were not
  accepted as product failures.
- #199 implementation is active. Review requires authoritative assignment
  derivation across paged history, rather than treating a missing carrier as
  active. Creation provenance and Following presentation are separate concerns.
- #204 source investigation found the sidebar local client followed remote
  pathname routing. Owner applied a pinned local fetcher; production-path
  regression and rendered acceptance are still underway.
- #195 is active, reusing LoginGrantStore. Metadata-only module exists;
  trusted-window confirmation and full integration remain unfinished.
- Latest web typecheck is not green: host fixture effect cleanup returns a
  boolean, and generated `.next-desktop/types` references a removed recovery
  fixture page. Neither diagnostic has been waived.

### Follow-up review

- Data Science routes and lifecycle are now implemented in the plugin module;
  the owner reports 150 focused passes. Provider socket wiring remains active.
- Plugin drain review found that recursive polling renews its own deadline,
  and pending drains need cancellation when a project re-enables a plugin.
  Owner has the disable/re-enable regression requirement; not yet accepted.
- Streaming now separates advancing existing text from ingesting a new chunk,
  and only flushes the expired chunk's prefix. A mounted browser fixture is
  assigned for hook effects, reduced motion, replacement and completion.
- Root reproduced the six coordination JSX failures under inherited production
  mode. The existing test script sets NODE_ENV=test; the same eight tests pass
  with that environment, without source changes. Use the repository test script
  for acceptance rather than a bare bun test from the installed app environment.

### Integration verification, 2026-09-10 (supersedes earlier pending checks)

Primary remains `telar/single-build-integration`; no new worktree or install.

- Root full web run: 1,674 pass, zero failures (`NODE_ENV=test`). The first
  sandboxed run failed two local socket binds; the unrestricted run passed.
- Root engine-client: 102 pass, zero failures.
- Root engine state + assignment HTTP + machine-plugin tests: 177 pass, zero
  failures, using isolated homes and real local HTTP.
- After Follow corrections, root reran Following, task-message and related-work:
  37 pass, zero failures. This includes deferred creation/read orderings and
  static rendered message boundaries; it is not packaged-app acceptance.
- Startup owner measured engine readiness on a copied 114-session store:
  21,011 ms before, 1,226 ms after batching terminal-run recovery by session.
  These exclude Electron startup and are not a packaged cold-launch result.
- Root visually inspected the footer fixture: graph and gear left, updater
  right. Dev mode still invoked the feed action in that fixture; the UI owner
  is investigating the discrepancy. Do not accept Dev updater behavior yet.
- UI footer worker and Settings-navigation worker are confirmed running.
  Final combined typechecks/gates, publication of current uncommitted changes,
  and a fresh packaged Dev build with rendered acceptance remain outstanding.

Historical partial checkpoints above describe earlier states, not current
acceptance. The installed nightly has not been replaced by a local build.

### Footer fixture follow-up

Root reloaded the updated footer fixture and switched to Dev via its remount
control. The actual component now shows the hammer icon and the accessible
label `Update from local checkout…`; screenshot inspected. The earlier
discrepancy was the fixture switching its scripted build without remounting.
This verifies the rendered Dev affordance, not a real application update swap.

### Full engine gate correction

Root full engine run completed with 2,083 pass, 3 skipped, 7 failures and one
error. Plugin owner reproduced the failures standalone: worker-side generic
plugin transport/capability leasing is missing, despite earlier driver-side
completion reports. This is an implementation gap, not test contamination.
The owner is assigned to complete actual worker-to-provider wiring, preserve
lease lifecycle and approvals, and rerun the failing suites before a new full
gate. Earlier plugin completion statements do not establish end-to-end delivery.

### Worker transport repair under verification

The owner implemented worker leases, refreshed per-turn capability bindings
when reusing a lease, and included enabled plugins in Claude's fingerprint.
Focused dispatch/rebind tests are reported green; root inspected the mutable
capability box and started a fresh full engine gate. Root's latest full web
run passed 1,696 tests with zero failures. Publication and packaging still
require completion of the full engine gate and final artifact acceptance.

### Delivery gate, 2026-09-10

The previous full engine run finished with 2,091 passes, three skips and one
Stop continuity failure. The worker now marks running after setup; a deterministic
test stops during the blocked profile-binding await and proves no provider starts.
The continuity test waits for the provider ID to be recorded before stopping.
There is no promise of a cursor before the provider has identified itself.

Root reran the full web suite with socket access: 1,696 pass, zero failures.
Desktop: 272 pass, three skips, zero failures. Engine-client: 102 pass.
Repository typecheck passes its existing core-test ceiling (264/264); lint has
zero errors and 15 warnings. The final engine run and compact-wake corrections
are still in progress at this checkpoint. This is not packaged-app acceptance.

Seven finished worker sessions were settled, retaining their resumable history.
The notification and Stop workers remain available for final verification.

### Final engine gate result

The full engine gate completed: 2,100 pass, three live-provider skips, zero
failures (117 files). The subsequent ping-only read refinements are checked
separately in sessions-tools, sessions-wiring and state tests. Subscription
notices now omit answers and request fields; run-scoped reads preserve answer
whitespace and carry both event and answer cursors for bounded continuation.

Packaging and visual verification of the resulting Dev artifact remain pending.

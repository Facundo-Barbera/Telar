# Onboarding a project — the agent procedure

You are onboarding a project onto the Telar environment contract (v1). Your
deliverable is a **sidecar** contract that passes `telar-env conform`. You
never commit anything Telar-shaped into the project's own repository.

## Procedure

1. **Scaffold.** From inside the project: `telar-env init --write`. Note the
   sidecar path it prints (`~/.telar/projects/<id>/env.yaml`).
2. **Read the repo's own run story.** README, `package.json` scripts,
   Makefile, compose files, `scripts/`. The verbs should *name* what the repo
   already has (`up: bun run up`), not reinvent it.
3. **Pick the cost class honestly.** Containers or databases → `heavy`.
   A dev server or two → `light`. Library with self-contained tests → `none`.
4. **Fill the verbs.** Rules that conformance will enforce:
   - `up` idempotent; second call on a running slot is a no-op.
   - `up` must return — background an attached dev command
     (`nohup ... & echo $! > pidfile`) in a glue script under the sidecar's
     `scripts/` dir, keyed per worktree.
   - `ready` exits 0 only when the environment is actually usable.
   - `down` safe on an already-down slot; never touches other slots.
   - Respect the repo's own port/slot convention if it has one; otherwise
     derive ports from `$TELAR_PORT_BASE` (range of 20).
5. **Prove it.** `telar-env conform` — iterate until every step passes. Do not
   hand-wave a failing step; the failing verb's output is in the report.
6. **Leave the machine clean.** Conformance ends with `down`; verify nothing
   you started is still listening.

## Hard rules

- Sidecar only. If you think the repo itself needs a change, stop and report
  it — a committed change must be tool-neutral and is the human's call.
- If the contract itself cannot express the project, do NOT work around it in
  glue; report the gap. The contract gets amended deliberately (v2), never
  special-cased.
- There is no `accept` here and you do not decide the onboarding is "good
  enough" — a passing conformance report is the only green.

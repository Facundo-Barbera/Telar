# Telar Greenfield-Next E2E Harness

A one-command, fully isolated, repeatable end-to-end test. A single run:

1. creates a fresh isolated tmp project (its own `TELAR_HOME`, unique name + port),
2. launches an **orchestrated** loom whose objective is to scaffold a **minimal
   Next.js (Bun) App Router app from an EMPTY directory**,
3. has Telar weave → build → **verify against a real Verification Contract**
   (deterministic gates + a live critic panel) → reach `ready`,
4. then **tears the whole thing down surgically**.

Empty dir → orchestrated weave → contract/panel verify → `ready` → clean teardown.

## Run it

From the repo root:

```bash
bun run scripts/e2e/greenfield-next/orchestrate.ts
```

Runs **headless** by default: the loom is hosted and monitored in-process (state
transitions stream to the console) — no browser UI, so it never collides with a
dev server you already have running.

- Add `--ui` to also start a throwaway Telar cockpit (its own `TELAR_HOME`, unique
  port) to watch the run in a browser. **Caveat:** Next 16 refuses a second
  `next dev` for `apps/web` while another is running, so `--ui` only works when your
  main cockpit (`:3131`) is stopped.
- Add `--keep` to leave the run up (the loom — and the `--ui` server, if any — stay
  alive; Ctrl-C tears down):
  ```bash
  bun run scripts/e2e/greenfield-next/orchestrate.ts --keep
  ```
- Tear down a kept/crashed run later (newest run if `--run` omitted):
  ```bash
  bun run scripts/e2e/greenfield-next/teardown.ts --run <runDir>
  ```

`orchestrate.ts` is the canonical path: `startLoomFromBundle` runs the executor
fire-and-forget **in the calling process**, so one long-lived process must host
it to completion. `setup.ts` / `run.ts` / `teardown.ts` are runnable standalone
for debugging (`run.ts` self-hosts via `watch` so the executor isn't abandoned).

## Static check only (no live loom)

```bash
bun run scripts/e2e/greenfield-next/sanity.ts     # prints: SANITY OK
bunx tsc --noEmit -p scripts/e2e/greenfield-next/tsconfig.json
```

`sanity.ts` imports only the **pure** validators (`validateContract`,
`validateCharter`, `isWoven`, `partitionAssertions`) + `spec.ts`. It never starts
a server, registers a project, or dispatches a loom.

## The two invariants (and how they're forced)

1. **Orchestration ALWAYS runs.** `run.ts` injects a woven `planWeaveFn` into
   `DispatcherDeps`. `startLoomFromBundle` assigns the returned (always-woven)
   Charter and routes to `runWeaveWiring` — the degenerate no-weaver path is
   never taken. The Charter decomposes into two threads (`s1` scaffold, `s2` ui).
2. **Spec is FORCED (contract/panel path, not bare acceptanceCriteria).** The
   loom is a **bundle** loom created via `createDraftLoom` + `writeContract` +
   `startLoomFromBundle`. Its CONTRACT GATE stamps `contractRequired: true` on
   the root and both children, so verification takes the panel/contract path.
   The `s2` slice carries a `live-critic` assertion → the critic panel runs; the
   manifest sets `devCommand` and omits `urls` so the panel **auto-spins** a dev
   server on a free port and tears it down after each attempt.

## Isolation + safety guarantees

- **Per-run `TELAR_HOME`** under `os.tmpdir()/telar-e2e-greenfield-next/<runId>`.
  Setting `TELAR_HOME` relocates the *entire* Telar state root (registry + all
  loom dirs + accounts) into the run's tmp dir — so isolation is total.
- **Teardown is one scoped `fs.rm`** of the run dir (guarded by
  `assertScopedRunDir`, which refuses anything not a `wt_*` dir under the scratch
  root) **plus one port-scoped kill** of the run's own server/port.
- **NEVER touched:** the shared `~/.telar` tree (its `projects.json`, existing
  `looms/`, `accounts.json`, `credentials.json`, `sessions/`, `policy.json`);
  any other project (`ozom-gv`, `telar-web-playground`, `playground`, `telar`);
  **port 3131** (the shared dev server); the telar repo working tree. There is
  no `unregisterProject`, no raw `rm`, and no `git add` outside `<runDir>/project`.

## Repeatability + idempotency

`runId = wt_<base36 epoch>_<3-byte hex>` drives four unique axes per run:
project name, run dir, `TELAR_HOME`, and web-server port (`findFreePort()`). Two
runs share no registry, loom dir, accounts, or port. A leftover run dir is
irrelevant to a new run (different path/home/port) and is removable via
`teardown.ts --run <oldDir>` (or the newest-run fallback). `fs.rm({force})` +
`process.kill` in `try/catch` make teardown itself idempotent.

## Env knobs

| Var | Default | Effect |
|---|---|---|
| `TELAR_E2E_ACCOUNT` | `personal` | account for model calls (auto-seeded on a fresh `TELAR_HOME`) |
| `TELAR_E2E_MAX_TURNS` | `400` | lifts the per-build turn ceiling for a from-empty scaffold+install+ui |
| `TELAR_E2E_TIMEOUT_MS` | `1800000` | watch timeout (30 min) |
| `TELAR_E2E_SELF_SERVE` | off | reserved — the executor's panel auto-spin is the tested path; harness-owned dev server is not needed |

## Requirements

- Network access for `bun install` (pulls `next` / `react` / `react-dom`).
- A working `personal` (ambient Claude) account for the live model calls. A fresh
  `TELAR_HOME` auto-seeds the `personal` account; its auth comes from the ambient
  Claude install, not from `TELAR_HOME`, so no shared `credentials.json` is needed.

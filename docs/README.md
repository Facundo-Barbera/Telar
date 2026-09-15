# docs

**Current direction (2026-08):** [`vision-2026-08.md`](vision-2026-08.md) — docs as
the interface, looms as workers, verification as the gate, and environment leasing
as the scarce-resource manager. Normative companion: [`env-contract-v1.md`](env-contract-v1.md)
(implemented by `packages/env`). A visual summary lives in [`artifacts/`](artifacts/).

Fresh documentation is being written here. What is already in this directory is
not part of that effort — it is the set of pages that **live source code cites as
its own rationale**, kept when the generated 2026-07-17 doc set was cleared:

| File | Cited by |
| --- | --- |
| `engine-contract-v2.md` | `packages/engine-client/src/protocol/index.ts` |
| `command-keys-web-port.md` | `apps/web/lib/command-keys.ts` |

Those modules deliberately hold point-of-use notes only and defer the long
reasoning to these pages, so deleting one silently strips the explanation for
code that is still shipping. Supersede them by rewriting rather than by dropping
the file — and when you do, update the citing comment in the same change.

**Five rows left this table in #501 step 3.** `session-profile-port.md`,
`weave-contracts.md`, `workspace-item-schema-design.md`, `integration-architecture.md`
and `deferred-work.md` were kept because `packages/core` cited them —
`src/session-profile.ts`, `src/weave-contracts.ts`, `src/workspace/schema.ts`,
`test/invariants.test.ts` (INV-1, the accept-tool moat) and `src/ultra/wake.ts`.
That package was deleted with the Loom engine, so no live source cites those five
any more and the rule above no longer holds them here. They are still on disk;
#501 step 5 is the doc sweep that decides each one (the issue names
`workspace-item-schema-design.md` as reviewed, not dropped blindly).

Note that source comments also cite pages that are **already** gone (chiefly
`docs/loom-model.md` and `docs/loom-orchestrator.md`). Those predate this
cleanup; they were archived long before it, and nothing here restored them.

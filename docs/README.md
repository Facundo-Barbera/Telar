# docs

**Current direction (2026-08):** [`vision-2026-08.md`](vision-2026-08.md) — docs as
the interface, verification as the gate, and environment leasing as the
scarce-resource manager. Normative companion: [`env-contract-v1.md`](env-contract-v1.md)
(implemented by `packages/env`). A visual summary lives in [`artifacts/`](artifacts/).

Fresh documentation is being written here. What is already in this directory is
not part of that effort — it is the set of pages that **live source code cites as
its own rationale**, kept when the generated 2026-07-17 doc set was cleared:

| File | Cited by |
| --- | --- |
| `engine-contract-v2.md` | `packages/engine-client/src/protocol/index.ts` |
| `command-keys-web-port.md` | `apps/web/lib/command-keys.ts` |
| `page-api.md` | `apps/web/lib/page-api.ts` |

Those modules deliberately hold point-of-use notes only and defer the long
reasoning to these pages, so deleting one silently strips the explanation for
code that is still shipping. Supersede them by rewriting rather than by dropping
the file — and when you do, update the citing comment in the same change.

**Five rows left this table in #501 step 3**, when `packages/core` — the only
source that cited them — was deleted with the Loom engine. Step 5 ruled on each:

- **Deleted**, because their cited module went too: `weave-contracts.md`
  (`src/weave-contracts.ts`) and `session-profile-port.md`
  (`src/session-profile.ts`, `workspace/store.ts`).
- **Kept, uncited**: `workspace-item-schema-design.md` (the issue asked for it
  to be reviewed, not dropped blindly), `integration-architecture.md` and
  `deferred-work.md`. The last two are dated records rather than live
  rationale, which is why the rule above no longer has to hold them here.

The Spool's and the Loom's own pages (`spool-definition.md`, `spool-loops.md`,
`spool-port.md`, `loom-model-v1.md`) were deleted with those two surfaces.
Everything removed is in git history if the reasoning is ever wanted; nothing
here cites any of it.

// The turn-1 loom SEED gate (docs/loom-model.md §5) — which wire `loomId` a
// brand-new chat is allowed to bind itself to.
//
// WHY IT IS A MODULE AND NOT FOUR CONJUNCTS IN route.ts. This predicate is the
// whole of the door story 5.5's weave (SPEC-organization-workspace CAP-11) walks
// through: the workspace fills a DRAFT loom's bundle with a packet's premise and
// then stops at the detach boundary, deliberately writing no Verification
// Contract — and `start_loom`'s CONTRACT GATE refuses a bundle without one. The
// only way that draft ever reaches a human and a start button is a planning
// session that ADOPTS it (/looms/plan/<project>?loom=<id>), and that adoption is
// this function saying yes. A gate that load-bearing, living as an inline `if`
// in a 3000-line route, is a gate no test can hold still.
//
// IT ONLY EVER NARROWS. Everything here is a refusal; the caller's `undefined`
// result means "behave exactly as if no loomId had been sent", which is a fresh
// planning session that mints its own draft on first use — never an error. That
// is deliberate and is the same reasoning the route applies to its other seeded
// roles: a gate whose failure depends on whether a client resent a query param
// would be a non-deterministic 400, which is worse than no gate at all.
//
// THE LOOM IS READ THROUGH AN INJECTED READER, not imported. This module reaches
// no state root and no store (INV-7's "injected" mechanism), and the route hands
// it `getLoom` — so the read still happens once, in the same place, and only
// when the first three checks have already passed.

// The only two fields the decision reads. Deliberately structural rather than
// `Loom`: this module imports nothing, which is what keeps it testable without a
// state root and without a mock of @telar/core.
export type SeedableLoom = { project?: string; draft?: boolean } | null | undefined;

export type LoomSeedInput = {
  // True for a RESUMED chat. A resumed chat's own persisted link always wins, so
  // the wire value is not consulted at all — otherwise a client that kept a
  // stale `?loom=` in its URL could re-point a conversation mid-life.
  hasExistingChat: boolean;
  // The session role as it arrived on the wire.
  role: string | undefined;
  // Untyped on purpose: this is request-body data, and validating it is the
  // job rather than the precondition.
  rawLoomId: unknown;
  // The anchoring project — the loom must belong to it. A project-less session
  // (5.6's master) can never adopt: `master` is not a seedable role, and the
  // string check below is the second lock on the same door.
  project: string | undefined;
};

// The three roles that may arrive already bound. `steerer` (the loom's Chat tab)
// and `escalation` (a blocked loom's "Discuss with the orchestrator") are the
// long-standing pair; `planner` joined them for the adopted-draft case above.
const SEEDABLE_ROLES = new Set(["steerer", "escalation", "planner"]);

export function seedLoomIdForTurnOne(
  { hasExistingChat, role, rawLoomId, project }: LoomSeedInput,
  readLoom: (id: string) => SeedableLoom,
): string | undefined {
  if (hasExistingChat) return undefined;
  if (typeof role !== "string" || !SEEDABLE_ROLES.has(role)) return undefined;
  if (typeof rawLoomId !== "string" || !rawLoomId) return undefined;
  if (typeof project !== "string" || !project) return undefined;

  // A malformed or traversal-shaped id makes getLoom return null rather than
  // throw (AD-8's weak-reference law), so a bad id lands on the same refusal as
  // a foreign one.
  const loom = readLoom(rawLoomId);
  if (!loom) return undefined;
  // NEVER SOMEONE ELSE'S LOOM. The session is already scoped to `project`, so
  // this widens nothing: it only ever lets the session bind to a loom it could
  // already see.
  if (loom.project !== project) return undefined;
  // THE LOAD-BEARING HALF, and the one that is easiest to lose in a refactor: a
  // PLANNER may adopt a DRAFT and nothing else. A planning session may write
  // bundle files and a Verification Contract into whatever it is bound to, so
  // binding it to a running, blocked or landed loom would let a fresh planning
  // conversation edit the spec of work already under way — which is the
  // steerer's job, through the steerer's own gated verbs, and is exactly what
  // draft_bundle_file's remint rule refuses on the other side. Steerer and
  // escalation are unaffected: they exist to talk ABOUT a live loom.
  if (role === "planner" && loom.draft !== true) return undefined;

  return rawLoomId;
}

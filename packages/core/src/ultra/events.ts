// Ultra's declared event catalogue — the FIRST production `declareEvents` call
// in this repo (AD-14 / AD-21, story 4.1 / AC4).
//
// WHY IT IS ITS OWN FILE. AD-21 makes a module's published event names as
// binding as its tool signatures, so the catalogue is a port surface and it gets
// a port surface's treatment: one file, one call, all names in it, and INV-9 in
// packages/core/test/invariants.test.ts pinning the set and the delivery class
// so a later story cannot re-class or extend it by accident. AD-21 assigns the
// catalogue to the owning module's epic, and Ultra is epic 4 — which is why
// declaring it here is the design rather than an escape from story 1.2's
// deliberate "declare no concrete events".
//
// ⚠️ A STALE SENTENCE THIS FILE CREATES AND DOES NOT FIX. `event-bus.ts`'s header
// STILL ENDS, verbatim and unedited: "This module declares NO concrete events…
// The only event names in this repo today are fixtures in event-bus.test.ts."
// The first clause is still true of that module. The SECOND IS NOW FALSE — this
// file is a production declaration. It is left alone deliberately: `event-bus.ts`
// is outside story 4.1's write set (the story's §0 fences it explicitly — "you
// are its first production caller. You call declareEvents; you do not change
// it"), so the finding is RECORDED in docs/deferred-work.md rather than crossed.
// Whoever next opens that file owns the one-line correction.
//
// THE DELIVERY CLASS IS THE POINT, not a field to fill in. `run-completed` is
// `agent-facing` because a subscriber MAY synthesize an assistant turn from it —
// that is literally the feature (FR-UW-1: a detached run finishing wakes the
// session's agent). It is the case the class exists to distinguish from the
// workspace's "never initiates contact", and `subscribeAgentFacing` refusing a
// human-facing name is the structural half of that guarantee.
//
// ── WHY THE ACCESSOR, AND WHY IT CHECKS THE REGISTRY ───────────────────────────
// `declareEvents` THROWS on re-declaration — deliberately, not idempotently (its
// own comment explains that two zod schemas cannot be compared for equivalence,
// so "same declaration is fine" is not a check anyone can make honestly). Three
// things in this repo re-evaluate or reset:
//   · Next dev re-evaluates route modules on edit, so a module-scope call dies on
//     the second evaluation;
//   · `bun test` runs every file in ONE process, so one suite's declaration is
//     still registered when the next file loads;
//   · `resetBus()` clears declarations GLOBALLY, and any module-level cached port
//     would keep pointing at names the registry no longer knows — the next
//     `publish` then throws `not declared` from inside a `.then()` where nothing
//     catches it.
//
// A cached-port-plus-a-boolean-flag survives the first two and BREAKS on the
// third: the flag says "declared" while the registry says otherwise. So the
// accessor below checks the REGISTRY, never a flag. One function, correct under
// all three. The next module to declare a catalogue will copy whatever this file
// does, so it is written to be copied.
import { z } from "zod";
import { declareEvents, eventDeclaration, type EventPort } from "../event-bus";

// The terminal states a completed run can be in. Mirrors executor.ts's
// `Exclude<UltraState, "running">` — spelled as a zod enum here rather than
// imported, because a PAYLOAD SHAPE is a published contract (AD-21) and must not
// silently widen when an internal type does.
export const UltraRunCompletedState = z.enum(["done", "failed", "stopped"]);
export type UltraRunCompletedState = z.infer<typeof UltraRunCompletedState>;

// The payload. Everything a subscriber needs to state the outcome WITHOUT a
// disk read — AD-8's "carry enough denormalized label to render without a
// lookup", so a dangling reference is a tombstone and never a throw.
export const UltraRunCompletedPayload = z.object({
  runId: z.string(),
  // The owning chat session, and the owning chat TURN. Both may be "": a run
  // launched outside a chat has neither. Weak references (AD-8) — nothing here
  // resolves them, and a consumer that cannot find them renders the run alone.
  sessionId: z.string(),
  messageId: z.string(),
  state: UltraRunCompletedState,
  // A human label for the run — see `ultraRunLabel` below for where it comes
  // from and why it needs a fallback at all.
  name: z.string(),
  // The manifest's `spend` at the terminal write — itself a fold over
  // usage.ndjson (AD-18), never a counter.
  spendUsd: z.number(),
  terminalAt: z.number(),
  // Only on `done`; only on `failed`/`stopped`. Not enforced as a discriminated
  // union: a payload shape that refuses a run whose executor recorded both
  // would turn a bookkeeping oddity into a thrown publish, and the publish is
  // best-effort by design.
  result: z.unknown().optional(),
  error: z.string().optional(),
});
export type UltraRunCompletedPayload = z.infer<typeof UltraRunCompletedPayload>;

// The catalogue. ONE `declareEvents` per module, all names in one call — it is
// all-or-nothing, so a malformed entry registers none of them and the retry
// after the fix cannot collide with its own leftovers.
//
// The full name is composed INSIDE `declareEvents` as `ultra:run-completed`;
// this file never hands in a pre-composed string, which is what makes "a module
// cannot declare into another module's namespace" true by construction.
const ULTRA_EVENT_DECLS = {
  "run-completed": {
    deliveryClass: "agent-facing",
    payload: UltraRunCompletedPayload,
  },
} as const satisfies Parameters<typeof declareEvents>[1];

export type UltraEventPort = EventPort<typeof ULTRA_EVENT_DECLS>;

// The one full event name, exported so a caller (and INV-9) can ask the registry
// about it without re-composing the string. This is the name AD-21 makes
// contract: renaming it is a deliberate contract change, and INV-9a is what
// makes that true rather than aspirational.
export const ULTRA_RUN_COMPLETED = "ultra:run-completed";

// A run's human label, DERIVED and never assumed. Measured, because the obvious
// implementation throws on a script somebody wrote slightly differently:
// `UltraManifest` has NO `name` field. Its only descriptive field is
// `meta: ScriptMeta`, and `packages/core/src/ultra/sandbox.ts` declares
// `export type ScriptMeta = Record<string, unknown>` — a free-form bag.
// `compileScript` checks only that `export const meta = {…}` is a pure object
// literal; NOTHING validates that `name` exists or is a string. The convention
// comes from `apps/web/lib/ultra-mcp.ts`'s ULTRA_TOOL_DESCRIPTION, which teaches
// the authoring agent `export const meta = { name, description, phases }` —
// prose to a model, not an enforced shape.
//
// So: the name when it is a non-empty string, the runId otherwise. A wake whose
// label is a runId is ugly and correct; a wake that throws on a script whose
// author omitted `name` is neither.
export function ultraRunLabel(meta: unknown, runId: string): string {
  const name = (meta as { name?: unknown } | null | undefined)?.name;
  return typeof name === "string" && name.trim() ? name : runId;
}

let cached: UltraEventPort | null = null;

// THE SELF-HEALING ACCESSOR. Returns the cached port only while the registry
// still knows the name; otherwise re-declares and re-caches. Call it from a
// deliberate path (a publish, a subscribe, a test) — never at module scope, per
// the instruction above `declareEvents`.
export function ultraEvents(): UltraEventPort {
  if (cached && eventDeclaration(ULTRA_RUN_COMPLETED)) return cached;
  cached = declareEvents("ultra", ULTRA_EVENT_DECLS);
  return cached;
}

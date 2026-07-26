// THE ITEM-KIND REGISTRY — AD-13 ("kind ids carry their owning module and
// cannot collide") made executable, and AD-12's purity rule made legible.
//
// WHY THE MODULE VOCABULARY IS CLOSED. `MODULE_NAMESPACES` is a fixed const, not
// a free string, because a typo'd `looms:gate-card` would otherwise register a
// second, near-identical namespace beside `loom:` and nothing would ever say so.
// Downstream tracks extend the vocabulary by editing THAT ONE CONST, which makes
// it a deliberate contract change (AD-21's discipline applied to kind ids)
// rather than a silent widening. Adding a namespace is a decision; typing one by
// accident is a bug, and only a closed list can tell them apart.
//
// WHY A RENDERER IS A PLAIN FUNCTION AND NOT A ComponentType. A component
// invites props, and props invite context. `(payload, view) => ReactNode` makes
// the contract legible at the call site: THESE TWO VALUES ARE EVERYTHING YOU
// GET. That matters because the architecture's own adversarial review (finding
// A3) found the failure this rule prevents — a kind that reads live state from a
// React context its adapter provides can only render inside that adapter, so a
// transcript holding two such kinds can render neither. Owner data reaches a
// renderer INSIDE THE PAYLOAD; a read-only surface simply builds payloads whose
// callbacks are absent and the renderer degrades to non-interactive.
//
// The type cannot enforce purity — a plain function called during render CAN
// legally call a hook — so the enforcement is a static scan, INV-8b in
// packages/core/test/invariants.test.ts. The type says the shape; the invariant
// says it is true.
//
// WHY THE REGISTRY IS A PROP AND NOT A MODULE SINGLETON. project-context.md
// forbids a global client store, and a mutable module-level registry is exactly
// that — plus it would make two surfaces on one page share a registration list,
// which is the collision AD-13 exists to prevent. The owner adapter composes its
// own registry (built-ins + whatever it registers) and passes it in.
//
// NO "use client" HERE, ON PURPOSE — this module is types and one closure over a
// Map. See items.ts's header for why that matters to INV-4.

import type { ReactNode } from "react";
import type { TranscriptItem } from "./items";

/** The closed module vocabulary. Adding an entry is a contract change (AD-21). */
export const MODULE_NAMESPACES = [
  "conversation",
  "ultra",
  "loom",
  "workspace",
  "session",
] as const;

export type ModuleNamespace = (typeof MODULE_NAMESPACES)[number];

/** `<module>:<name>`. The TYPE is deliberately loose (a template literal cannot
 *  forbid a second colon); `createItemKindRegistry` is where the rule is real. */
export type ItemKindId = `${string}:${string}`;

export type ItemViewState = {
  /** This item is the live tail of a streaming turn. */
  live: boolean;
  /** Opaque per-item disclosure state. The shell holds the map; the renderer
   *  names the key, and the shell scopes it to that item. NO DOMAIN VOCABULARY
   *  LIVES HERE — no `groupOpen`, no `thinkingOpen` — because that is how a
   *  shell acquires session semantics one field at a time.
   *
   *  `fallback` is what to answer when the human has expressed NO preference for
   *  this key. It is load-bearing rather than a convenience: the donor's rule is
   *  "a manual toggle always beats the automatic default", and a default that
   *  itself varies (a streaming turn's trailing tool group defaults OPEN) cannot
   *  be expressed by a bare boolean without losing the difference between
   *  "closed" and "never touched". */
  isOpen: (key: string, fallback?: boolean) => boolean;
  setOpen: (key: string, next: boolean) => void;
  /**
   * Render a nested item through the SAME registry, optionally overriding view
   * state for that child. COMPOSITE kinds use this; leaf kinds ignore it. It is
   * supplied BY THE SHELL — it is shell-provided view state, not ambient
   * context, so AD-12's purity rule holds. Without it, a kind containing other
   * items would have to get the registry from "somewhere", and "somewhere" is
   * exactly the ambient context AC4 forbids.
   */
  render: (item: TranscriptItem, override?: { live?: boolean }) => ReactNode;
};

export type ItemRenderer<P = unknown> = (payload: P, view: ItemViewState) => ReactNode;

export type ItemKind<P = unknown> = { id: ItemKindId; render: ItemRenderer<P> };

export type ItemKindRegistry = {
  /** The renderer for a kind, or undefined — NEVER a throw. AD-8: a dangling
   *  cross-module reference renders as a tombstone. A transcript containing one
   *  unknown kind must still render every other item. */
  get: (kind: string) => ItemRenderer<never> | undefined;
  /** Every registered id, for tests and for the gallery. */
  ids: () => readonly ItemKindId[];
};

// The `never` in the exported signatures is the standard erasure trick for a
// heterogeneous registry: each ItemKind<P> is constructed with its own concrete
// P and widened on entry, and the renderer casts once at its own boundary.
// (Story 3.1 permitted `any` here with a WHY comment if `never` fought back; it
// did not, so this is `never` — the stricter of the two.)
type AnyItemKind = ItemKind<never>;

const RULE_HINT =
  "Ids are `<module>:<name>` with exactly one colon and both halves non-empty, " +
  `and <module> must be one of: ${MODULE_NAMESPACES.join(", ")}.`;

/**
 * Build a registry from a list of kinds. THROWS at construction on a malformed
 * or colliding id — construction happens at module scope in an owner adapter, so
 * a collision is a build-time-ish error the author sees immediately rather than
 * a runtime surprise a user meets.
 *
 * Every message names the offending id, the rule it broke, the consequence and
 * the next step: the reader will be a Track D/E/F author who has never seen this
 * file.
 */
export function createItemKindRegistry(entries: readonly AnyItemKind[]): ItemKindRegistry {
  const byId = new Map<string, ItemRenderer<never>>();
  const order: ItemKindId[] = [];

  for (const entry of entries) {
    const id = entry.id;
    const segments = id.split(":");

    if (segments.length === 1) {
      throw new Error(
        `createItemKindRegistry: kind id "${id}" carries no module namespace. ${RULE_HINT} ` +
          `CONSEQUENCE: an unnamespaced id is exactly the collision AD-13 exists to prevent — ` +
          `two modules both registering a bare "text" would silently overwrite each other, and ` +
          `the transcript would render whichever loaded last. NEXT STEP: prefix it with your ` +
          `module, e.g. "loom:${id}".`,
      );
    }
    if (segments.length > 2) {
      throw new Error(
        `createItemKindRegistry: kind id "${id}" has ${segments.length - 1} colons; exactly one ` +
          `is allowed. ${RULE_HINT} CONSEQUENCE: the module segment stops being unambiguous, so ` +
          `"who owns this kind" can no longer be answered by reading the id — which is the whole ` +
          `property AD-13 buys. NEXT STEP: use a hyphen inside the name segment instead, e.g. ` +
          `"${segments[0]}:${segments.slice(1).join("-")}".`,
      );
    }

    const [moduleSegment, nameSegment] = segments as [string, string];
    if (moduleSegment.length === 0 || nameSegment.length === 0) {
      throw new Error(
        `createItemKindRegistry: kind id "${id}" has an empty ${moduleSegment.length === 0 ? "module" : "name"} ` +
          `segment. ${RULE_HINT} CONSEQUENCE: an empty half is indistinguishable from a typo and ` +
          `defeats the namespace check below it. NEXT STEP: give both halves a real name.`,
      );
    }
    if (!(MODULE_NAMESPACES as readonly string[]).includes(moduleSegment)) {
      throw new Error(
        `createItemKindRegistry: kind id "${id}" names module "${moduleSegment}", which is not in ` +
          `the declared vocabulary. ${RULE_HINT} CONSEQUENCE: an undeclared module is almost ` +
          `always a typo of a declared one, and registering it would create a second, ` +
          `near-identical namespace that nothing would ever flag. NEXT STEP: fix the spelling, ` +
          `or — if this genuinely is a new module — add it to MODULE_NAMESPACES in ` +
          `components/conversation/registry.ts and say so in your story's completion notes, ` +
          `because four tracks depend on that vocabulary being stable.`,
      );
    }
    if (byId.has(id)) {
      throw new Error(
        `createItemKindRegistry: kind id "${id}" is registered twice. CONSEQUENCE: the second ` +
          `registration would silently win and the first module's items would render through the ` +
          `wrong renderer — the exact failure namespacing was meant to make impossible, arriving ` +
          `instead from one module registering its own id twice. NEXT STEP: remove the duplicate ` +
          `entry, or rename one of them.`,
      );
    }

    byId.set(id, entry.render);
    order.push(id);
  }

  return {
    get: (kind: string) => byId.get(kind),
    ids: () => order,
  };
}

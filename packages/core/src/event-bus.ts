// The one typed, in-process event bus (AD-14 / AD-21, CAP-3).
//
// WHY IT EXISTS. Three feature epics all need "something finished". Without one
// bus they each build their own, and we get three delivery semantics that drift
// — which is how a `human-facing` fact ends up pushed at a user, or an
// `agent-facing` one ends up silently dropped on a surface nobody visits. So
// the DELIVERY CLASS is a required field of the declaration type, not a
// convention: an event that does not say how it may reach a person does not
// typecheck.
//
// THE TWO CLASSES, and what each one licenses:
//   agent-facing — a subscriber MAY synthesize an assistant turn from it. This
//                  is the only class that may push. It is reachable through the
//                  separate wake channel below, which is class-gated, so
//                  "human-facing pushes nothing" is structural rather than
//                  documented.
//   human-facing — renders only on a surface the user arrives at. It never
//                  reaches a wake handler, on either side of the gate:
//                  registration is refused AND publish does not route it.
//
// AD-21: a module's published event names and payload shapes are as binding as
// its tool signatures. So a name must be DECLARED before anyone may subscribe
// to it or publish it, and the name is COMPOSED here from the declaring
// module's own namespace — never handed in pre-composed. That is what makes "a
// module cannot declare into another module's namespace" true by construction
// instead of by a validation rule someone can forget. Undeclared events are
// internal: nobody outside may reach them, and a typo cannot mint a silent,
// unsubscribable event because publish refuses an undeclared name too.
//
// AD-20: subscriptions and declarations are this service's own state. They
// belong to no module's subtree and are written only through these functions.
//
// SCOPE, deliberately small. IN-PROCESS ONLY. The bus persists NOTHING and
// watches nothing — no file writes, no fs.watch. Deriving events by watching
// the state tree is the tempting design and it is forbidden twice over: a
// watcher reads every module's subtree by path, inverting AD-5/AD-20, and
// fs-watch semantics differ between the Next dev server and the packaged
// Electron app. Every durable trace in this system is already a module-owned
// NDJSON stream; this is the live wire between modules, not a second record.
//
// This module declares NO concrete events. Which events a module publishes is
// owned by that module's own epic — AD-21 is precisely what makes deferring the
// catalogue safe. The only event names in this repo today are fixtures in
// event-bus.test.ts.
import { z } from "zod";

// Exactly these two literals (AD-14, SPEC CAP-3).
export type DeliveryClass = "agent-facing" | "human-facing";

// One rule, one place: only an agent-facing event may PUSH. Both sides of the
// gate call this — subscribeAgentFacing refuses a registration it rejects, and
// publish refuses to route to the wake channel when it rejects. Exported so the
// rule itself is directly testable, not only its two consequences.
export const canWake = (deliveryClass: DeliveryClass): boolean =>
  deliveryClass === "agent-facing";

export type EventDeclaration<P extends z.ZodType = z.ZodType> = {
  // REQUIRED, and that is the whole point of AC1: a declaration that does not
  // state how the event may reach a person is unrepresentable, so the omission
  // is a compile error rather than a runtime surprise. Do NOT make this
  // optional, and do not give it a default — a default would silently pick a
  // delivery posture on the author's behalf, which is the failure this field
  // exists to prevent.
  deliveryClass: DeliveryClass;
  // AD-21: the payload SHAPE is part of the published contract, so it is
  // declared alongside the class and enforced on every publish.
  payload: P;
};

// `<module>:<past-tense-fact>` — e.g. "ultra:run-completed", "loom:node-blocked".
// A NEW convention for bus events only. The older NDJSON `type` literals
// ("committed", "accept-aborted", "spend-record-failed") are a different,
// unrelated stream convention and are NOT being retrofitted.
const SEGMENT = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const eventName = (module: string, fact: string): string => `${module}:${fact}`;

export type PublishResult = {
  name: string;
  deliveryClass: DeliveryClass;
  // Ordinary subscribers that received it.
  delivered: number;
  // Wake-channel subscribers that received it. Structurally always 0 for a
  // human-facing event — that is AC2's "provably pushes nothing", made
  // observable rather than merely asserted about internals.
  wakeDelivered: number;
  // Handlers that threw. Delivery is a fan-out, not a transaction (see below),
  // so this is how a publisher learns a subscriber failed without a side channel.
  failed: number;
};

type Subscription = { handler: (payload: unknown) => void; wake: boolean };

// --- the bus's own state (AD-20) -------------------------------------------

const declarations = new Map<string, EventDeclaration>();
const subscriptions = new Map<string, Set<Subscription>>();

const declarationOf = (name: string, verb: string): EventDeclaration => {
  const decl = declarations.get(name);
  if (!decl) {
    throw new Error(
      `event-bus: cannot ${verb} "${name}" — no module declared it. Published event names are ` +
        `part of a module's port contract (AD-21); undeclared events are internal and nobody ` +
        `may subscribe to or publish them. Declare it with declareEvents("<module>", {...}) first.`,
    );
  }
  return decl;
};

// A typed handle over one module's catalogue. Callers go through this rather
// than hand-writing names: `names` is the only place a full event name is
// minted, and publish/subscribe take the bare FACT, so the module's namespace
// is not something a call site can get wrong.
export type EventPort<D extends Record<string, EventDeclaration>> = {
  readonly module: string;
  readonly names: { readonly [K in keyof D]: string };
  publish<K extends keyof D & string>(fact: K, payload: z.input<D[K]["payload"]>): PublishResult;
  subscribe<K extends keyof D & string>(
    fact: K,
    handler: (payload: z.output<D[K]["payload"]>) => void,
  ): () => void;
  subscribeAgentFacing<K extends keyof D & string>(
    fact: K,
    handler: (payload: z.output<D[K]["payload"]>) => void,
  ): () => void;
};

// A module declares its whole catalogue at once, keyed by the bare fact. The
// full name is composed HERE, so a module structurally cannot declare into
// another module's namespace.
//
// RE-DECLARATION IS AN ERROR, not an idempotent no-op. This one was genuinely a
// call, so: an event name is a published contract, and a second declaration is
// either two modules colliding on a namespace or one module's payload shape
// drifting — both of which must surface at wiring time, loudly, rather than at
// the first publish that fails validation. "Same declaration is fine" is not a
// check that can be made honestly (two zod schemas cannot be compared for
// equivalence), so it is not offered. A module should therefore declare once
// from a deliberate init path rather than at module scope, and `resetBus()` is
// the seam for tests and for a reloading dev server.
export function declareEvents<D extends Record<string, EventDeclaration>>(
  module: string,
  decls: D,
): EventPort<D> {
  if (typeof module !== "string" || !SEGMENT.test(module)) {
    throw new Error(
      `event-bus: invalid module namespace ${JSON.stringify(module)} — expected a ` +
        `lower-kebab segment, e.g. "ultra" or "loom".`,
    );
  }
  // ALL-OR-NOTHING. Validate the whole catalogue before committing any of it:
  // a module whose third event is malformed must not leave its first two
  // registered, or the retry after the fix collides with its own leftovers.
  const names = {} as { [K in keyof D]: string };
  const staged: Array<[string, EventDeclaration]> = [];
  for (const fact of Object.keys(decls) as Array<keyof D & string>) {
    const decl = decls[fact]!;
    if (!SEGMENT.test(fact)) {
      throw new Error(
        `event-bus: invalid event fact ${JSON.stringify(fact)} in module "${module}" — expected ` +
          `a lower-kebab past-tense fact, e.g. "run-completed". The full name is composed as ` +
          `"<module>:<fact>"; a fact may not carry its own namespace.`,
      );
    }
    // The entry itself, before either of its fields is read — the same bypass
    // that omits a field can omit the whole declaration, and reading
    // `.deliveryClass` off undefined would raise an internal TypeError instead
    // of naming the event that is malformed.
    if (decl == null || typeof decl !== "object") {
      throw new Error(
        `event-bus: "${eventName(module, fact)}" is not a declaration (got ` +
          `${decl === null ? "null" : typeof decl}). Every entry is an EventDeclaration carrying a ` +
          `delivery class and a payload schema (AD-14/AD-21).`,
      );
    }
    // Belt-and-suspenders for callers that bypass the type system (`as any`, a
    // JS caller, a payload off the wire). It does NOT satisfy AC1 on its own —
    // "the type system demands it" is discharged by EventDeclaration above.
    if (decl.deliveryClass !== "agent-facing" && decl.deliveryClass !== "human-facing") {
      throw new Error(
        `event-bus: "${eventName(module, fact)}" has no delivery class. Every event must declare ` +
          `"agent-facing" or "human-facing" (AD-14) — it is a required field of EventDeclaration, ` +
          `so this can only be reached by bypassing the type system.`,
      );
    }
    // The payload SHAPE is the other half of the same contract (AD-21), and the
    // same bypass reaches it. Unguarded, a declaration with the payload omitted
    // REGISTERED FINE and then blew up at the first publish, as
    // `TypeError: undefined is not an object (evaluating 'decl.payload.safeParse')`
    // from inside publish — an internal stack trace, surfacing in whichever
    // module published rather than in the one that mis-declared, instead of this
    // module's descriptive error at the moment the contract was broken.
    if (typeof (decl as { payload?: { safeParse?: unknown } }).payload?.safeParse !== "function") {
      throw new Error(
        `event-bus: "${eventName(module, fact)}" has no payload schema. A module's payload shapes ` +
          `are as binding as its tool signatures (AD-21), so every declaration carries a zod ` +
          `schema that publish validates against — it is a required field of EventDeclaration, so ` +
          `this can only be reached by bypassing the type system.`,
      );
    }
    const name = eventName(module, fact);
    if (declarations.has(name)) {
      throw new Error(
        `event-bus: "${name}" is already declared. An event name is a published contract ` +
          `(AD-21) — re-declaring is either a namespace collision or a payload shape drifting. ` +
          `Use resetBus() if you are re-initializing.`,
      );
    }
    staged.push([name, decl]);
    names[fact] = name;
  }
  for (const [name, decl] of staged) declarations.set(name, decl);
  return {
    module,
    names,
    publish: (fact, payload) => publish(eventName(module, fact), payload),
    subscribe: (fact, handler) =>
      subscribe(eventName(module, fact), handler as (payload: unknown) => void),
    subscribeAgentFacing: (fact, handler) =>
      subscribeAgentFacing(eventName(module, fact), handler as (payload: unknown) => void),
  };
}

// Ordinary subscription. Throws on an undeclared name; returns an unsubscribe.
export function subscribe(name: string, handler: (payload: unknown) => void): () => void {
  declarationOf(name, "subscribe to");
  return attach(name, { handler, wake: false });
}

// THE WAKE CHANNEL — the capability to synthesize an assistant turn from an
// event. Class-gated: registering a human-facing name here is REFUSED, so the
// "human-facing pushes nothing" guarantee does not depend on every publisher
// remembering it.
export function subscribeAgentFacing(
  name: string,
  handler: (payload: unknown) => void,
): () => void {
  const decl = declarationOf(name, "subscribe to");
  if (!canWake(decl.deliveryClass)) {
    throw new Error(
      `event-bus: "${name}" is ${decl.deliveryClass} and cannot be subscribed on the wake ` +
        `channel. Only an agent-facing event may synthesize an assistant turn (AD-14); a ` +
        `human-facing event renders only on a surface the user arrives at, and never pushes.`,
    );
  }
  return attach(name, { handler, wake: true });
}

function attach(name: string, sub: Subscription): () => void {
  const set = subscriptions.get(name) ?? new Set<Subscription>();
  set.add(sub);
  subscriptions.set(name, set);
  // The handle is minted AT the moment of the subscription — never derived from
  // a position, an index or a count, so unsubscribing is exact even after the
  // set has churned.
  return () => {
    subscriptions.get(name)?.delete(sub);
  };
}

// Synchronous fan-out. Throws on an undeclared name, and on a payload that does
// not match the declared shape — a publisher shipping the wrong shape is a
// contract breach (AD-21) and must be loud at the source, not decoded into
// nonsense by every subscriber.
//
// DELIVERY IS A FAN-OUT, NOT A TRANSACTION. Each handler is wrapped, so one
// subscriber throwing can neither break `publish` for its caller nor starve its
// siblings; the count comes back in `failed` so the swallow is observable. The
// list is COPIED before iteration — a handler that unsubscribes (or subscribes)
// during delivery must not shift the collection being walked.
export function publish(name: string, payload: unknown): PublishResult {
  const decl = declarationOf(name, "publish");
  const parsed = decl.payload.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `event-bus: payload for "${name}" does not match its declared shape (AD-21): ` +
        z.prettifyError(parsed.error),
    );
  }
  const value = parsed.data;
  const wakeAllowed = canWake(decl.deliveryClass);
  const result: PublishResult = {
    name,
    deliveryClass: decl.deliveryClass,
    delivered: 0,
    wakeDelivered: 0,
    failed: 0,
  };
  for (const sub of [...(subscriptions.get(name) ?? [])]) {
    // The publish-side half of the class gate, reading the SAME rule as the
    // registration side. It is UNREACHABLE BY CONSTRUCTION today — a wake
    // subscription on a human-facing name cannot exist, because
    // subscribeAgentFacing refuses it and a name's class cannot change under a
    // live subscription (re-declaration throws; resetBus clears both maps
    // together). Measured, not assumed: deleting canWake's rule fails the
    // registration test, not this branch. Kept anyway — it is what keeps
    // "human-facing pushes nothing" true if those invariants ever loosen, and
    // it costs one comparison per subscriber.
    if (sub.wake && !wakeAllowed) continue;
    try {
      sub.handler(value);
      if (sub.wake) result.wakeDelivered++;
      else result.delivered++;
    } catch {
      result.failed++;
    }
  }
  return result;
}

// Read-only view of a declaration, for a caller that needs to know an event's
// class without holding the port. Returns null for an undeclared name rather
// than throwing — this is a question, not an operation on the event.
export function eventDeclaration(name: string): { deliveryClass: DeliveryClass } | null {
  const decl = declarations.get(name);
  return decl ? { deliveryClass: decl.deliveryClass } : null;
}

export const declaredEvents = (): string[] => [...declarations.keys()].sort();

// Test seam — the same one-process reason as admission.ts's resetAdmission:
// `bun test` runs every file in ONE process, so a suite that declares fixtures
// and does not clear them makes the next suite's declaration collide.
export function resetBus(): void {
  declarations.clear();
  subscriptions.clear();
}

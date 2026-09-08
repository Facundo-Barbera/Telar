/**
 * ONE REQUEST AT A TIME, ABOUT ONE THING, AND ONLY ITS OWN ANSWER LANDS.
 *
 * WHY THIS IS NOT JUST A `busy` FLAG. A flag stops a second click. It does not
 * stop the FIRST answer arriving after the screen has moved on to a different
 * project, or a different Mac — and an action that removes a project must not
 * be able to report success against a record it is no longer about, or steer
 * the router away from a page somebody is now reading. Three separate things
 * have to be true for a response to be honoured: nothing else was started, the
 * subject has not changed underneath it, and the caller still exists.
 *
 * A PLAIN OBJECT, NOT A HOOK, because this is where the interleavings live and
 * they are worth testing directly — this app has no DOM test setup, so logic
 * that stays inside a component is logic no test can reach. Same reason
 * `publishableEnv` sits beside its card rather than inside it.
 */

export type RequestGate = {
  /**
   * Take the gate for a request about `identity`. Returns a token to settle
   * with, or `undefined` when one is already in flight — which IS the explicit
   * double-submit guard, rather than a re-render's stale `busy` value.
   */
  begin(identity: string): number | undefined;
  /** True when this response still owns the gate, and releases it. False means
   *  it is stale and must change nothing. */
  settle(token: number): boolean;
  /** The subject changed. Anything in flight was about the old one, so it is
   *  disowned — its `settle` will say so — and the gate reopens. */
  retarget(identity: string): void;
  /** Whether a request is outstanding. For rendering, never for deciding. */
  inFlight(): boolean;
};

export function createRequestGate(): RequestGate {
  let issued = 0;
  let active: { token: number; identity: string } | undefined;
  return {
    begin(identity) {
      if (active) return undefined;
      issued += 1;
      active = { token: issued, identity };
      return issued;
    },
    settle(token) {
      if (!active || active.token !== token) return false;
      active = undefined;
      return true;
    },
    retarget(identity) {
      if (active && active.identity !== identity) active = undefined;
    },
    inFlight() {
      return active !== undefined;
    },
  };
}

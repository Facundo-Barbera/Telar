/**
 * WHO THE AGENT IS, in the one place both the store and the tool wall can
 * import without either importing the other (#531).
 *
 * A MODULE FOR ONE CONSTANT, and the alternative is why: `state.ts` needs it to
 * recognise a subscriber that is not a session, and `agent/tools.ts` needs it
 * to set `self` on the capability. Putting it in either would make the other
 * import a module it has no other business with — and `state.ts` importing the
 * tool wall would be a cycle waiting for its first edit.
 */

/**
 * THE RESERVED SUBSCRIBER AND SENDER ID.
 *
 * `agent` rather than `agent_<something>`: there is exactly one per machine and
 * never a second, so a suffix would be a number that never changes. It passes
 * the engine's `ID` shape (letters only), which is what lets a subscription row
 * carrying it round-trip through `subscriptions.json` with no schema change.
 *
 * NOTHING CREATES A SESSION BY THIS NAME, and nothing should: the Agent's
 * conversation is a LangGraph thread, not a session document. `getSession`
 * refuses it, which is correct and is why the subscription verbs check for it
 * by name rather than looking it up.
 */
export const AGENT_SELF_ID = "agent";

/** Is this subscriber the built-in Agent rather than a session? */
export function isAgentSelf(id: string): boolean {
  return id === AGENT_SELF_ID;
}

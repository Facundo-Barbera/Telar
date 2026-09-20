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
import { AGENT_SELF_ID } from "@telar/engine-client";

/**
 * THE RESERVED SUBSCRIBER, SENDER AND — SINCE #784 — TARGET ID.
 *
 * `agent` rather than `agent_<something>`: there is exactly one per machine and
 * never a second, so a suffix would be a number that never changes. It passes
 * the engine's `ID` shape (letters only), which is what lets a subscription row
 * carrying it round-trip through `subscriptions.json` with no schema change.
 *
 * NOTHING CREATES A SESSION BY THIS NAME, and nothing should: the Agent's
 * conversation is a LangGraph thread, not a session document. `requireSession`
 * refuses it in words (`AGENT_IS_NOT_A_SESSION` below), which is correct and is
 * why the subscription verbs check for it by name rather than looking it up.
 *
 * THE VALUE MOVED TO THE CONTRACT, and only the value. `packages/engine-client`
 * holds it now because two things that cannot import this file have to
 * recognise it — the wire shapes, and `protocol/assignments.ts`, which must
 * never fold a row naming it into an assignment. Re-exported here so every
 * engine-side reader keeps the one import it already had.
 */
export { AGENT_SELF_ID };

/** Is this subscriber the built-in Agent rather than a session? */
export function isAgentSelf(id: string): boolean {
  return id === AGENT_SELF_ID;
}

/**
 * THE ONE SENTENCE EVERY DOOR REFUSES WITH — issue #784.
 *
 * SPELLED ONCE, HERE, for the reason the constant above is: `state.ts` throws
 * it from `requireSession` and the tool wall quotes it back, and a refusal each
 * side worded for itself is two descriptions of one thing waiting to disagree
 * about what the Agent even is.
 *
 * IT NAMES WHAT DOES WORK. A refusal that only says "no" leaves a model to
 * guess, and the guess it makes is to try the same call again with a different
 * id. There is exactly one verb this address takes, so the sentence says it.
 */
export const AGENT_IS_NOT_A_SESSION =
  `"${AGENT_SELF_ID}" is the built-in Agent — the person's own conversation — and it is not a session: ` +
  "it has no transcript to read, no turns to stop, no checkout to diff and nothing to subscribe to. " +
  "sessions_send is the only call that takes it, and it leaves one row in the Agent's inbox for the person to see when they next speak.";

/**
 * WHO IS SENDING A `sessions_send`, PROVEN — and the two ways there are to
 * prove it, which are different in kind rather than in detail (#539).
 *
 * A SESSION proves itself with the CLAIM of the turn doing the sending: a
 * session id, a run id and the token the engine minted for that claim. The
 * engine looks it up and stamps the sender from what it finds, so a model
 * cannot name a session it is not.
 *
 * THE AGENT PROVES ITSELF BY BEING UNABLE TO. It is a LangGraph thread, not a
 * session — no queue, no run, no token — so its proof is the reserved id alone.
 * That is safe precisely because the shape is unreachable from outside: the
 * wire schema (`AgentTurnInput`) requires the run id and the token, so no HTTP
 * body can be a claimless proof, and `submitAgentTurn` refuses a CLAIMED proof
 * that names `agent`. Only the in-process capability the daemon builds with a
 * `self` can produce this arm.
 */
export type AgentSenderProof =
  | { sessionId: string; runId: string; claimToken: string }
  | { sessionId: typeof AGENT_SELF_ID; runId?: undefined; claimToken?: undefined };

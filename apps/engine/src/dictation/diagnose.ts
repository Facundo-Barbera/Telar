/**
 * WHY A DICTATION FAILED, ASKED ONCE FOR EVERY SURFACE (#711).
 *
 * ── THE DEFECT THIS EXISTS FOR ──────────────────────────────────────────────
 * A `400 Bad Request — Keyterm limit exceeded` reached the owner as "The
 * connection to the transcription service failed", and he replaced his Deepgram
 * key trying to fix it — which could not possibly have worked. Every refusal of
 * the listen socket arrives at every client as that one sentence, and the
 * sentence is honest: a browser's `WebSocket` error event carries no reason BY
 * DESIGN, because surfacing the status of a failed cross-origin handshake would
 * be an oracle. iOS's `URLSessionWebSocketTask` lands on its own version of the
 * same nothing, and the headset on a third.
 *
 * THE GRANT HALF WAS ALREADY FINE, and saying so is half the value of this file:
 * `grantDictationToken` quotes Deepgram's own words, so a wrong key or an empty
 * balance already reaches a person as a sentence naming the fault. What is lost
 * is everything that refuses the LISTEN socket while the grant succeeds — the
 * keyterm budget, a project without access to the model, a token that expired
 * between the mint and the press, the edge's own refusal of an oversized query.
 *
 * ── WHY THE ENGINE, AND WHY AFTER THE FAILURE ───────────────────────────────
 * The engine holds the long-lived key and already makes a round trip per press
 * to mint a token, so it is the one place that can ask. It asks AFTER a socket
 * has failed rather than before every press, and that is the choice this file
 * records:
 *
 *   A PROBE ON EVERY PRESS bills a handshake against somebody who is about to
 *   speak, and answers about the engine's own network and the engine's own
 *   query — which is not where the failure necessarily was. The phone is on a
 *   different network; the browser is behind whatever proxy it is behind.
 *
 *   A PROXY gets the reason for free and is ruled out for the reason `token.ts`
 *   already gives: relaying every frame would put a Mac on the hot path of a
 *   real-time stream that has no reason to touch it.
 *
 *   ASKING ON FAILURE costs nothing on the hot path — it is paid only by
 *   somebody whose dictation has already stopped — and it diagnoses the state
 *   the socket actually met rather than the state a pre-flight guessed at.
 *
 * ── AND AN ACCEPTED HANDSHAKE IS AN ANSWER TOO, NOT A SHRUG ─────────────────
 * The case a pre-flight probe cannot produce at all: if this Mac opens the
 * socket with the same settings a moment after the client's attempt failed,
 * then Deepgram is reachable and the key is good, and the fault is between the
 * device that was dictating and Deepgram. That is a real, actionable fact — it
 * sends somebody to the network rather than to the vendor's console — and there
 * is no other way to obtain it.
 *
 * ── NOTHING HERE MAY CARRY A CREDENTIAL ─────────────────────────────────────
 * This is all error text, and error text is read by people and written to logs.
 * The key is spent in one header inside `askListen` and appears nowhere else;
 * every sentence built here is scrubbed of it on the way out anyway, the same
 * backstop `grantDictationToken` keeps. The sentences name the FAULT, never the
 * credential that met it.
 */
import { DEEPGRAM_LISTEN_URL, askListen, type ListenAnswer } from "./listen";
import { DictationError, NO_KEY_CONFIGURED } from "./token";

/**
 * How long a diagnosis may take. Longer than the fit's budget and for the
 * opposite reason: nobody is holding a microphone open waiting for this, the
 * dictation has already stopped, and an answer that arrives is worth more than
 * one that gives up early. Still bounded, because a client is waiting on a
 * route.
 */
export const DIAGNOSE_DEADLINE_MS = 6_000;

/**
 * WHAT WENT WRONG, AS A FACT AND AS A SENTENCE.
 *
 * `fault` IS FOR A CLIENT THAT WANTS TO BEHAVE DIFFERENTLY — a pane that offers
 * "paste a key" for `refused` and nothing for `elsewhere`. `reason` is for the
 * person, and every surface shows that and nothing else.
 */
export type DictationDiagnosis = {
  /**
   * `refused`    Deepgram turned the connection down, and `reason` carries its
   *              own words. The fault is this Mac's settings or the account.
   * `unreachable` This Mac could not reach Deepgram at all.
   * `elsewhere`  Deepgram accepted a connection from this Mac just now, so the
   *              fault is between the device that was dictating and Deepgram.
   * `unconfigured` There is no key here to ask with.
   */
  fault: "refused" | "unreachable" | "elsewhere" | "unconfigured";
  /** One sentence for a person, naming the fault and what to do about it. */
  reason: string;
};

/** Deepgram's own sentence, when its error body carries one. Two spellings
 *  because both have been seen on this endpoint: `err_msg` on a JSON refusal,
 *  `message` on some of them. */
function said(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body) as { err_msg?: unknown; message?: unknown };
    if (typeof parsed.err_msg === "string" && parsed.err_msg.trim()) return parsed.err_msg.trim();
    if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message.trim();
  } catch {
    // Not JSON — see `EDGE_HTML` below for the one case where that is expected.
  }
  return undefined;
}

/** THE EDGE'S OWN REFUSAL, which is a `400` with no `err_msg` in it at all:
 *  measured at a 38,696-byte request line (#712), answered as plain HTML before
 *  Deepgram reads the credential. Quoting that HTML at a person would be worse
 *  than useless, so this branch names the fault instead. */
const EDGE_HTML = /<html/i;

/**
 * Ask Deepgram why, and turn the answer into a sentence.
 *
 * NEVER THROWS EXCEPT FOR "NO KEY", which is a `DictationError` so the route
 * answers 409 for it exactly as the mint does — a Mac with no key configured is
 * a different fact from a diagnosis, and inventing a sentence for it here would
 * be a second copy of `NO_KEY_CONFIGURED` to keep in step.
 *
 * EVERY INPUT IS INJECTABLE, so every branch is tested without an account.
 */
export async function diagnoseDictation(input: {
  key: string | undefined;
  /** Deepgram's own code, as the mint would send it. */
  language: string;
  /** The glossary this Mac would hand out right now. The point is to ask the
   *  question the client's socket asked, and the keyterms are the part of it
   *  that can be refused. */
  keyterms: readonly string[];
  fetchImpl?: typeof fetch;
  url?: string;
  signal?: AbortSignal;
}): Promise<DictationDiagnosis> {
  const key = input.key?.trim();
  if (!key) throw new DictationError("unconfigured", NO_KEY_CONFIGURED);

  const answer = await askListen({
    key,
    language: input.language,
    keyterms: input.keyterms,
    fetchImpl: input.fetchImpl ?? fetch,
    url: input.url ?? DEEPGRAM_LISTEN_URL,
    signal: input.signal ?? AbortSignal.timeout(DIAGNOSE_DEADLINE_MS),
  });

  const read = diagnosis(answer);
  return { ...read, reason: scrub(read.reason, key) };
}

function diagnosis(answer: ListenAnswer): DictationDiagnosis {
  // THE ONE ANSWER A PRE-FLIGHT PROBE COULD NEVER GIVE — see the header. This
  // Mac just opened the socket the client could not, so the fault is on the
  // path between that device and Deepgram, and naming it sends somebody
  // somewhere useful instead of back to the vendor's console.
  if (answer.accepted) {
    return {
      fault: "elsewhere",
      reason:
        "Deepgram accepted a connection from this Mac just now, with the same settings — so the service is reachable and this Mac's key is good. The dictation failed somewhere between the device that was listening and Deepgram: a network on the way, or something in front of it that does not pass WebSocket connections.",
    };
  }

  if (answer.status === 0) {
    return {
      fault: "unreachable",
      reason: `This Mac could not reach Deepgram at all${answer.unreachable ? `: ${answer.unreachable}` : "."} Check that it is online, then try again.`,
    };
  }

  // DEEPGRAM'S OWN WORDS, WHICH IS THE WHOLE POINT OF ASKING. "400" alone
  // cannot tell a person the glossary is over budget; "Keyterm limit exceeded"
  // can, and it is what `use-dictation.ts` has never been able to see.
  const words = said(answer.body);
  if (words) return { fault: "refused", reason: `Deepgram refused the transcription connection: HTTP ${answer.status} — ${words}` };

  // THE EDGE, WHICH ANSWERS BEFORE IT READS THE CREDENTIAL. Its body is a page
  // of HTML naming nothing; the fault is the size of the query, and saying that
  // is more use than quoting it.
  if (EDGE_HTML.test(answer.body)) {
    return {
      fault: "refused",
      reason: `Deepgram's edge refused the request before reading the credential (HTTP ${answer.status}) — the query was too long. That is the glossary: it is bounded on this Mac, so this is worth reporting.`,
    };
  }

  return { fault: "refused", reason: `Deepgram refused the transcription connection with HTTP ${answer.status} and said nothing about why.` };
}

/** A backstop, not the design — the key is spent in one header and is not in
 *  any of these sentences. See `grantDictationToken`, which keeps the same one
 *  for the same reason: this is the seam where a remote string becomes
 *  something a person reads. */
function scrub(text: string, key: string): string {
  return text.split(key).join("[redacted]");
}

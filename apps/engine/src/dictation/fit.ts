/**
 * THE LARGEST GLOSSARY DEEPGRAM WILL ACTUALLY TAKE, ASKED RATHER THAN GUESSED
 * (#712).
 *
 * ── WHY THERE IS A SECOND BOUND AT ALL ──────────────────────────────────────
 * `keyterms.ts` builds a list under a BYTE budget, because bytes are the one
 * unit that cannot be wrong in the direction that refuses a socket. That makes
 * the bound safe and makes it conservative by exactly the amount real text is
 * more than one byte per token — which was measured, and is between 1.70 and
 * 2.83 depending on the words (see the probe). A byte bound has to survive the
 * worst of those, so on the best of them it leaves most of the budget unspent.
 *
 * This is where the rest is recovered: ASK. Deepgram refuses an over-budget
 * glossary with a specific, machine-readable sentence —
 *
 *   400 Bad Request — Keyterm limit exceeded. The maximum number of tokens
 *   across all keyterms is 500.
 *
 * — so the engine sends the list it built, and if that is the answer, drops the
 * tail and asks again. The person gets the largest glossary that actually fits
 * rather than the largest one we can prove fits.
 *
 * ── AND WHY IT IS THE ENGINE THAT ASKS, NOT THE CLIENT (#711, #712) ─────────
 * The client CANNOT read that body. A browser's `WebSocket` error event carries
 * no reason by design — it would be a cross-origin oracle — so `use-dictation.ts`
 * sees a bare `onerror` and can honestly say nothing. That is not a gap to
 * engineer around in a tab; it is the specification.
 *
 * The engine is in the opposite position: it holds the long-lived key, it is
 * where the list is built, and it already makes one round trip per press of the
 * mic button to mint a token. So it asks, once, for every surface — instead of
 * a browser, a phone and a headset each rediscovering that they cannot. This
 * does NOT depend on #711 shipping: that issue is about REPORTING a reason to a
 * person, and this is about ACTING on one, which the engine can do today.
 *
 * ── IT IS A `fetch`, WHICH WAS NOT OBVIOUS AND WAS MEASURED ────────────────
 * A plain GET to `/v1/listen` is refused before keyterms are looked at —
 * `400 Connection header did not include 'upgrade'` — so the naive version of
 * this file would have measured nothing. Carrying the upgrade headers on an
 * ordinary `fetch` gets the real answer: `400 … Keyterm limit exceeded` for an
 * over-budget list, `101` for one that fits. That keeps this in the same shape
 * `grantDictationToken` already has — an injectable `fetch`, faked in tests,
 * with no raw TLS anywhere in the engine.
 *
 * ── THE RULE IS THE MESSAGE, NEVER THE STATUS ───────────────────────────────
 * There is a second `400` on this endpoint and retrying it would be a loop that
 * can never succeed: Deepgram's edge answers a plain-HTML `400 Bad request` for
 * an oversized request line, before it reads the credential. Measured, not
 * assumed — a 38,696-byte request line answers
 * `<html><body><h1>400 Bad request</h1>…` with no `err_msg` at all. So the
 * retry matches Deepgram's SENTENCE, and a `400` that says anything else is
 * treated as "cannot tell" and falls to the floor below.
 *
 * ── THE FLOOR IS WHAT MAKES ANY OF THIS SAFE ────────────────────────────────
 * Every path that is not "Deepgram accepted this list" ends at the PROVABLE
 * prefix — the first `DEEPGRAM_KEYTERM_PROVABLE_BYTES` of the list, which
 * cannot be refused for this limit under any input, because a subword token
 * never covers fewer than one byte. A network error, an edge refusal, a
 * timeout, a 401, retries exhausted: all of them degrade to a shorter glossary
 * and none of them can cost dictation.
 *
 * That is the property this file exists for, and it holds BY CONSTRUCTION
 * rather than by the byte bound being right: being wrong about the bound costs
 * a round trip and some terms, never the feature.
 *
 * ── TWO ASKS, NOT A LOOP ────────────────────────────────────────────────────
 * A person pressing the mic button is already waiting on a token mint and a
 * permission prompt. So: the built list, then one shrink, then the floor
 * unasked — the floor needs no confirmation, which is the whole point of it
 * being provable. At most two requests, and a deadline over the pair of them so
 * a slow answer cannot hold up a press.
 *
 * ── AND MOST PRESSES ASK NOTHING ────────────────────────────────────────────
 * A list already inside the provable floor is returned untouched without a
 * request, and an accepted answer is remembered for the exact list that earned
 * it. The glossary changes when the rail changes — which is rarely, next to how
 * often somebody dictates — so the steady state is zero extra round trips. The
 * caller runs what remains IN PARALLEL with the grant (see `provider.ts`), so
 * even a miss costs no wall clock.
 */
import { DEEPGRAM_KEYTERM_PROVABLE_BYTES } from "./keyterms";

/** The socket every client opens, as an `https:` URL because this asks with
 *  `fetch` rather than opening it. The clients spell it `wss:` — same endpoint,
 *  and the scheme is the only difference an upgrade request has. */
export const DEEPGRAM_LISTEN_URL = "https://api.deepgram.com/v1/listen";

/**
 * THE MODEL THE CLIENTS ASK FOR, and the one field here that could make this
 * check answer about a different request than the one that will be made.
 *
 * A tokenizer belongs to a model, so a glossary confirmed against `nova-3` is
 * confirmed for a socket opened with `nova-3` and nothing else. Its twin lives
 * in `apps/web/lib/dictation/deepgram.ts` (and iOS's `Dictation.swift`), which
 * this engine cannot import — so a client that moves off `nova-3` without
 * moving this is the one drift that would make the answer stale. Nothing else
 * on the query can change it: `interim_results`, `smart_format` and
 * `endpointing` are not counted against the keyterm budget, and are left off so
 * this file is not a second, silently diverging copy of the client's URL.
 */
const LISTEN_MODEL = "nova-3";

/** Deepgram's own sentence for this refusal, and the ONLY thing that earns a
 *  retry — see the header for the `400` that must not. */
const KEYTERM_LIMIT = /keyterm limit exceeded/i;

/** How long the whole fit may take, across both asks. A press is a person
 *  waiting to speak; a slow answer degrades to the floor rather than holding
 *  the microphone. */
const FIT_DEADLINE_MS = 2_500;

/** How many remembered answers to keep. The glossary has one shape at a time
 *  and changes with the rail, so this is a handful of recent ones rather than a
 *  cache with a policy — and it is bounded because an engine runs for weeks. */
const REMEMBERED = 8;

const encoder = new TextEncoder();

/** What the list weighs in the unit the budget is charged in. */
export function keytermBytes(terms: readonly string[]): number {
  let total = 0;
  for (const term of terms) total += encoder.encode(term).length;
  return total;
}

/** The longest prefix weighing no more than `budgetBytes`. A PREFIX, because
 *  the order in `keyterms.ts` is the priority and dropping from the tail is
 *  what it is for — the branches go before the person's own words do. */
export function keytermPrefix(terms: readonly string[], budgetBytes: number): string[] {
  const kept: string[] = [];
  let spent = 0;
  for (const term of terms) {
    const cost = encoder.encode(term).length;
    if (spent + cost > budgetBytes) break;
    kept.push(term);
    spent += cost;
  }
  return kept;
}

/**
 * WHAT THE LAST FIT DID, so a person can be told (#712).
 *
 * Silently handing somebody a smaller glossary is how this becomes invisible
 * again, which is the thing the issue asks not to repeat. `built` is what the
 * engine assembled and `sent` is what Deepgram actually took; equal means
 * nothing was dropped, and that is the ordinary case.
 */
export type KeytermFit = {
  /** Terms the builder produced for this press. */
  built: number;
  /** Terms handed to the client — never more than `built`. */
  sent: number;
  /** Why it is smaller, when it is. `refused` means Deepgram said the list was
   *  over budget; `unconfirmed` means the check could not be completed and the
   *  provable floor was used instead. Absent when nothing was dropped. */
  reason?: "refused" | "unconfirmed";
};

/** The last fit, for the settings pane — see `KeytermFit`. Module state rather
 *  than a stored document on purpose: it describes the CURRENT glossary against
 *  the CURRENT engine, and a value that outlived a restart would be a claim
 *  about a list nobody has checked. */
let last: KeytermFit | undefined;

export function lastKeytermFit(): KeytermFit | undefined {
  return last;
}

/** Remembered accepted answers, keyed by the exact question. */
const remembered = new Map<string, string[]>();

/** For tests, which must not inherit another test's remembered answer. */
export function forgetKeytermFits(): void {
  remembered.clear();
  last = undefined;
}

/** NEWLINE-JOINED, and that is not arbitrary: `deepgramKeyterms` collapses all
 *  whitespace inside a term, so a newline cannot occur in one and cannot make
 *  two different lists share a key. A space could. */
function rememberedKey(language: string, terms: readonly string[]): string {
  return [language, ...terms].join("\n");
}

function record(built: number, sent: number, reason: KeytermFit["reason"]): KeytermFit {
  last = { built, sent, ...(sent < built && reason ? { reason } : {}) };
  return last;
}

/** What one ask answered. `unknown` is everything that is not a clear yes or
 *  this specific no, and it never earns a retry — see the header. */
type Answer = "accepted" | "over-budget" | "unknown";

async function ask(input: {
  key: string;
  language: string;
  keyterms: readonly string[];
  fetchImpl: typeof fetch;
  url: string;
  signal: AbortSignal;
}): Promise<Answer> {
  const url = new URL(input.url);
  url.searchParams.set("model", LISTEN_MODEL);
  url.searchParams.set("language", input.language);
  // APPENDED, ONE PER TERM: `keyterm` is a repeated parameter, and a
  // comma-joined string would be one long term nobody says.
  for (const term of input.keyterms) url.searchParams.append("keyterm", term);

  let response: Response;
  try {
    response = await input.fetchImpl(url, {
      headers: {
        Authorization: `Token ${input.key}`,
        // THE UPGRADE HEADERS ARE NOT DECORATION. Without them Deepgram
        // answers `400 Connection header did not include 'upgrade'` before it
        // looks at a single keyterm, and this check would confirm every list
        // ever handed to it — measured, which is why they are here.
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Key": btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))),
        "Sec-WebSocket-Version": "13",
      },
      signal: input.signal,
    });
  } catch {
    // OFFLINE, ABORTED, DNS. Deepgram has said nothing, so there is nothing to
    // act on and the floor is the answer. NO CAUSE IS KEPT: this module holds a
    // key, and a thrown message is the wrong place to start trusting.
    return "unknown";
  }

  // AN ACCEPTED LIST OPENS A REAL SOCKET, and the body is that socket. It is
  // released immediately: this asked a question, it is not going to speak, and
  // a stream left unread is a connection left open on both ends.
  const body = await release(response);

  // 101 IS THE YES. Anything 2xx would be too, though this endpoint only ever
  // upgrades — the test is deliberately "not a refusal" rather than "== 101".
  if (response.status === 101 || response.ok) return "accepted";
  // THE MESSAGE, NOT THE STATUS — the edge's oversized-request-line `400` is
  // the case this must never retry, and it says nothing about keyterms.
  if (response.status === 400 && KEYTERM_LIMIT.test(body)) return "over-budget";
  return "unknown";
}

/** The body, read if it is short enough to be a refusal and dropped otherwise.
 *  A 101's body is a live socket and would never end. */
async function release(response: Response): Promise<string> {
  if (response.status === 101 || response.ok) {
    try {
      await response.body?.cancel();
    } catch {
      // Already gone.
    }
    return "";
  }
  try {
    return await response.text();
  } catch {
    return "";
  }
}

/**
 * The glossary to hand a client, confirmed against Deepgram where that is
 * possible and safely short where it is not.
 *
 * NEVER THROWS AND NEVER RETURNS MORE THAN IT WAS GIVEN. Every failure is a
 * shorter list — see the header. The caller does not need an `if` around this,
 * which is the point: a `catch` that fell back to the unchecked list would undo
 * the whole guarantee.
 */
export async function fitDeepgramKeyterms(input: {
  key: string | undefined;
  language: string;
  keyterms: readonly string[];
  fetchImpl?: typeof fetch;
  url?: string;
}): Promise<string[]> {
  const built = input.keyterms.length;
  const floor = (): string[] => keytermPrefix(input.keyterms, DEEPGRAM_KEYTERM_PROVABLE_BYTES);

  // NOTHING TO ASK ABOUT. A list already inside the provable floor cannot be
  // refused for this limit, so the common small glossary costs no round trip
  // and no key is spent confirming what arithmetic already settled.
  if (built === 0 || keytermBytes(input.keyterms) <= DEEPGRAM_KEYTERM_PROVABLE_BYTES) {
    record(built, built, undefined);
    return [...input.keyterms];
  }

  const key = input.key?.trim();
  // NO KEY IS NOT THIS FILE'S REFUSAL TO MAKE. `grantDictationToken` answers
  // that with a sentence a person can act on; this just cannot ask, so it
  // hands back the short list and lets the mint fail properly.
  if (!key) {
    record(built, floor().length, "unconfirmed");
    return floor();
  }

  const url = input.url ?? DEEPGRAM_LISTEN_URL;
  const fetchImpl = input.fetchImpl ?? fetch;
  const cached = remembered.get(rememberedKey(input.language, input.keyterms));
  if (cached) {
    record(built, cached.length, cached.length < built ? "refused" : undefined);
    return [...cached];
  }

  // ONE DEADLINE ACROSS BOTH ASKS, so the worst case this adds to a press is
  // bounded by a number in this file rather than by Deepgram's slowest minute.
  const deadline = AbortSignal.timeout(FIT_DEADLINE_MS);

  // THE LADDER: what was built, then one shrink halfway down to the floor, and
  // the floor itself is not asked about at all — it is provable, and a request
  // to confirm arithmetic is a request for nothing. At most two asks, which is
  // the "one or two, not a loop" the issue calls for.
  //
  // A RUNG THAT IS NOT SHORTER THAN THE ONE ABOVE IT IS DROPPED, so a glossary
  // whose halfway point lands on the same terms costs one request rather than
  // two identical ones.
  const ladder: string[][] = [[...input.keyterms]];
  const shrunk = keytermPrefix(input.keyterms, Math.floor((keytermBytes(input.keyterms) + DEEPGRAM_KEYTERM_PROVABLE_BYTES) / 2));
  if (shrunk.length > 0 && shrunk.length < built) ladder.push(shrunk);

  for (const candidate of ladder) {
    const answer = await ask({ key, language: input.language, keyterms: candidate, fetchImpl, url, signal: deadline });
    if (answer === "accepted") {
      if (remembered.size >= REMEMBERED) remembered.delete(remembered.keys().next().value as string);
      remembered.set(rememberedKey(input.language, input.keyterms), candidate);
      record(built, candidate.length, "refused");
      return candidate;
    }
    // ANYTHING THAT IS NOT THIS EXACT REFUSAL STOPS THE LADDER. Retrying an
    // edge `400`, a `401` or a dropped connection with a shorter list is a
    // second request that will fail the same way.
    if (answer === "unknown") break;
  }

  record(built, floor().length, "unconfirmed");
  return floor();
}

/**
 * ONE WAY TO ASK DEEPGRAM'S LISTEN ENDPOINT A QUESTION (#711, #712).
 *
 * ── WHY THIS IS A FILE AND NOT TWO COPIES ───────────────────────────────────
 * Two things in this engine open `/v1/listen` without meaning to speak: `fit.ts`
 * asks whether a glossary is accepted, and `diagnose.ts` asks why a client's
 * socket was refused. They want different answers out of the same request, and
 * the request itself is the part that was MEASURED rather than reasoned — so it
 * lives once, here, and the two callers differ only in what they make of it.
 *
 * ── THE UPGRADE HEADERS ARE NOT DECORATION ──────────────────────────────────
 * A plain GET to `/v1/listen` is refused with `400 Connection header did not
 * include 'upgrade'` BEFORE Deepgram looks at the query at all — so the naive
 * version of this would confirm every list ever handed to it and diagnose every
 * failure as the same one. Carrying the headers gets the real answer: `101` for
 * a request that would have opened, and the genuine refusal for one that would
 * not. Measured against the real endpoint (#712), not assumed.
 *
 * ── IT IS A `fetch`, WHICH IS THE POINT ─────────────────────────────────────
 * Reading a refused upgrade took a hand-rolled TLS handshake the first time
 * (`scripts/probe-deepgram-listen.ts`, #708). It does not have to: an ordinary
 * `fetch` carrying the same headers reads the same response. That keeps this in
 * the shape `grantDictationToken` already has — an injectable `fetch`, faked in
 * tests, no raw sockets anywhere in the engine.
 */

/** The socket every client opens, as an `https:` URL because this asks with
 *  `fetch` rather than opening it. The clients spell it `wss:` — same endpoint,
 *  and the scheme is the only difference an upgrade request has. */
export const DEEPGRAM_LISTEN_URL = "https://api.deepgram.com/v1/listen";

/**
 * THE MODEL THE CLIENTS ASK FOR, and the one field here that could make an
 * answer be about a different request than the one that will be made.
 *
 * A tokenizer belongs to a model, so a glossary confirmed against `nova-3` is
 * confirmed for a socket opened with `nova-3` and nothing else — and a refusal
 * read against `nova-3` is a refusal of the model the clients actually use. Its
 * twin lives in `apps/web/lib/dictation/deepgram.ts` (and iOS's
 * `Dictation.swift`), which this engine cannot import — so a client that moves
 * off `nova-3` without moving this is the one drift that would make an answer
 * here stale. Nothing else on the query can change it: `interim_results`,
 * `smart_format` and `endpointing` are not counted against the keyterm budget
 * and do not gate the handshake, and are left off so this file is not a second,
 * silently diverging copy of the client's URL.
 */
export const LISTEN_MODEL = "nova-3";

/**
 * What one ask came back with. `status` is 0 when nothing came back at all —
 * offline, DNS, aborted — which is a different fact from any refusal and is why
 * this does not throw: both callers have something to say about it.
 *
 * `body` IS EMPTY FOR AN ACCEPTED UPGRADE, and deliberately: a `101`'s body is
 * a live socket that would never end.
 */
export type ListenAnswer = {
  /** Deepgram's status, or 0 when the request never got one. */
  status: number;
  /** The refusal body, bounded. Empty on acceptance and on a request that
   *  never arrived. */
  body: string;
  /** Whether this would have opened a socket. `101` is the real answer; any
   *  2xx counts, because the test that matters is "not a refusal". */
  accepted: boolean;
  /** Why nothing came back, when nothing did. NEVER a cause object and never
   *  logged: a thrown message is a remote string and this file holds a key. */
  unreachable?: string;
};

/** A remote body is not a length this engine controls, and a page of HTML in a
 *  toast helps nobody. */
const MAX_BODY = 600;

/**
 * Ask the listen endpoint whether this exact query opens.
 *
 * NEVER THROWS. Every way this can go wrong is a `ListenAnswer` — see the type.
 * A caller that had to `catch` would be a caller that could forget to.
 */
export async function askListen(input: {
  /** The long-lived key. Spent in one header and never anywhere else. */
  key: string;
  language: string;
  keyterms: readonly string[];
  fetchImpl: typeof fetch;
  url: string;
  signal: AbortSignal;
}): Promise<ListenAnswer> {
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
        // See the header — without these Deepgram answers before it reads the
        // query, and every answer would be the same one.
        Upgrade: "websocket",
        Connection: "Upgrade",
        "Sec-WebSocket-Key": btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16)))),
        "Sec-WebSocket-Version": "13",
      },
      signal: input.signal,
    });
  } catch (cause) {
    // OFFLINE, ABORTED, DNS. Deepgram has said nothing, so there is nothing of
    // theirs to quote — and the cause is kept only as a short string, scrubbed
    // by whoever turns it into a sentence.
    return { status: 0, body: "", accepted: false, unreachable: cause instanceof Error ? cause.message : String(cause) };
  }

  const accepted = response.status === 101 || response.ok;
  return { status: response.status, body: await release(response, accepted), accepted };
}

/** The body, read if it is a refusal and dropped otherwise. An accepted upgrade
 *  IS a socket, and it is released immediately: this asked a question, it is
 *  not going to speak, and a stream left unread is a connection left open on
 *  both ends. */
async function release(response: Response, accepted: boolean): Promise<string> {
  if (accepted) {
    try {
      await response.body?.cancel();
    } catch {
      // Already gone.
    }
    return "";
  }
  try {
    return (await response.text()).slice(0, MAX_BODY);
  } catch {
    return "";
  }
}

/**
 * ASKING DEEPGRAM WHAT IT WILL ACTUALLY TAKE, AND SURVIVING EVERY ANSWER
 * (#712).
 *
 * #707 bounded the glossary in UTF-8 bytes, which is provable and therefore
 * conservative: a byte bound has to survive the worst-tokenizing content, so on
 * ordinary content it leaves most of the budget unspent. #712 recovers that by
 * ASKING — the engine sends the list it built, and shortens it if Deepgram says
 * it is over budget.
 *
 * THE ONLY PROPERTY THAT REALLY MATTERS IS THE LAST ONE HERE: under every
 * answer this endpoint can give — accepted, refused for this reason, refused
 * for another, HTML from the edge, a dropped connection, a timeout, a 401 — the
 * list handed to a client is a PREFIX of what was built and is never longer
 * than it. "Fewer terms" is a degradation; "no dictation" was #707's outage,
 * and nothing in here may reintroduce it.
 *
 * DEEPGRAM IS NEVER CALLED. Every answer is injected, including the two 400s,
 * because the whole point of the retry rule is that it tells them apart — and a
 * rule about a body nobody can produce on demand is a rule nobody can test.
 * The live shapes those fakes stand in for were measured on the wire by
 * `scripts/probe-deepgram-keyterm-bound.ts` and are quoted where they are used.
 */
import { afterEach, expect, test } from "bun:test";
import { fitDeepgramKeyterms, forgetKeytermFits, keytermBytes, lastKeytermFit } from "../src/dictation/fit";
import { DEEPGRAM_KEYTERM_BYTE_BUDGET, DEEPGRAM_KEYTERM_PROVABLE_BYTES } from "../src/dictation/keyterms";

afterEach(() => forgetKeytermFits());

/** A glossary that is over the provable floor, so the fit actually asks. Terms
 *  are distinct and equal-length, which makes "how many survived" readable. */
const glossary = (count = 40): string[] => Array.from({ length: count }, (_, index) => `term-${String(index).padStart(3, "0")}-abcdefghij`);

/** WHAT DEEPGRAM SAYS WHEN THE LIST IS TOO BIG — measured, #707 and #712. */
const OVER_BUDGET = "Bad Request: Keyterm limit exceeded. The maximum number of tokens across all keyterms is 500.";

/** AND WHAT ITS EDGE SAYS FOR AN OVERSIZED REQUEST LINE, which is a `400` that
 *  must never be retried: plain HTML, no `err_msg`, nothing about keyterms.
 *  Measured at a 38,696-byte request line. */
const EDGE_HTML = "<html><body><h1>400 Bad request</h1> Your browser sent an invalid request. </body></html>";

type Ask = { url: URL; headers: Record<string, string> };

/** A fake Deepgram that answers each ask in turn. `accepted` is a 200 rather
 *  than the 101 a real upgrade returns, because `new Response` refuses to
 *  construct a 101 — the code under test treats both as acceptance for exactly
 *  this reason, and the real 101 is what the probe observed. */
function deepgram(answers: (Response | "throw")[]): { fetchImpl: typeof fetch; asks: Ask[] } {
  const asks: Ask[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    asks.push({ url: new URL(String(input)), headers: (init?.headers ?? {}) as Record<string, string> });
    const answer = answers[asks.length - 1] ?? new Response(null, { status: 200 });
    if (answer === "throw") throw new Error("the socket went away");
    return answer;
  };
  return { fetchImpl, asks };
}

const accepted = (): Response => new Response(null, { status: 200 });
const refused = (): Response => new Response(OVER_BUDGET, { status: 400 });

const fit = (input: { keyterms: readonly string[]; fetchImpl?: typeof fetch; key?: string | undefined }): Promise<string[]> =>
  fitDeepgramKeyterms({
    key: "key" in input ? input.key : "dg-secret-key",
    language: "multi",
    keyterms: input.keyterms,
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
  });

test("a list inside the provable floor is handed back without asking anything", async () => {
  // THE COMMON CASE COSTS NOTHING. A short glossary cannot be refused for this
  // limit — a token never covers fewer than one byte — so confirming it would
  // be a round trip to check arithmetic, on the press of a mic button.
  const { fetchImpl, asks } = deepgram([]);
  const small = ["Telar", "worktree", "cockpit"];
  expect(await fit({ keyterms: small, fetchImpl })).toEqual(small);
  expect(asks).toHaveLength(0);
});

test("an over-budget-sized list Deepgram accepts is handed over whole, in one ask", async () => {
  const { fetchImpl, asks } = deepgram([accepted()]);
  const terms = glossary();
  expect(keytermBytes(terms)).toBeGreaterThan(DEEPGRAM_KEYTERM_PROVABLE_BYTES);
  expect(await fit({ keyterms: terms, fetchImpl })).toEqual(terms);
  expect(asks).toHaveLength(1);
  expect(lastKeytermFit()).toEqual({ built: terms.length, sent: terms.length });
});

test("the ask carries the upgrade headers, without which it would confirm anything", async () => {
  // MEASURED, AND THE REASON THIS TEST EXISTS: a plain GET to `/v1/listen` is
  // refused with `Connection header did not include 'upgrade'` BEFORE keyterms
  // are looked at. A check that dropped these headers would see that 400,
  // read it as "cannot tell", and quietly fall to the floor on every press.
  const { fetchImpl, asks } = deepgram([accepted()]);
  await fit({ keyterms: glossary(), fetchImpl });
  const ask = asks[0]!;
  expect(ask.headers.Upgrade).toBe("websocket");
  expect(ask.headers.Connection).toBe("Upgrade");
  expect(ask.headers["Sec-WebSocket-Version"]).toBe("13");
  expect(ask.headers["Sec-WebSocket-Key"]).toBeTruthy();
  expect(ask.headers.Authorization).toBe("Token dg-secret-key");
  // THE SAME QUESTION THE CLIENT WILL ASK: a tokenizer belongs to a model, so a
  // list confirmed against another one is confirmed for nothing.
  expect(ask.url.searchParams.get("model")).toBe("nova-3");
  expect(ask.url.searchParams.get("language")).toBe("multi");
  expect(ask.url.searchParams.getAll("keyterm")).toHaveLength(glossary().length);
});

test("when Deepgram says the list is over budget it shrinks and asks once more", async () => {
  const { fetchImpl, asks } = deepgram([refused(), accepted()]);
  const terms = glossary();
  const sent = await fit({ keyterms: terms, fetchImpl });
  expect(asks).toHaveLength(2);
  // SHORTER, AND A PREFIX — the order in `keyterms.ts` is the priority, so what
  // goes is the tail rather than whatever happened to be long.
  expect(sent.length).toBeLessThan(terms.length);
  expect(sent).toEqual(terms.slice(0, sent.length));
  expect(asks[1]!.url.searchParams.getAll("keyterm")).toEqual(sent);
  expect(lastKeytermFit()).toEqual({ built: terms.length, sent: sent.length, reason: "refused" });
});

test("two refusals end at the provable floor rather than at a third ask", async () => {
  // BOUNDED, NOT A LOOP. A person pressing the mic button is already waiting on
  // a token mint and a permission prompt; the floor needs no confirming, so the
  // ladder stops at two.
  const { fetchImpl, asks } = deepgram([refused(), refused()]);
  const terms = glossary();
  const sent = await fit({ keyterms: terms, fetchImpl });
  expect(asks).toHaveLength(2);
  expect(keytermBytes(sent)).toBeLessThanOrEqual(DEEPGRAM_KEYTERM_PROVABLE_BYTES);
  expect(sent).toEqual(terms.slice(0, sent.length));
  expect(lastKeytermFit()?.reason).toBe("unconfirmed");
});

test("a 400 that is NOT the keyterm limit is never retried", async () => {
  // THE CASE THE ISSUE NAMES. Deepgram's edge answers plain HTML for an
  // oversized request line, and a rule that matched on the STATUS would retry
  // it with a shorter list — a second request that fails exactly the same way.
  // Matching on the sentence is what makes the retry safe rather than hopeful.
  const { fetchImpl, asks } = deepgram([new Response(EDGE_HTML, { status: 400 })]);
  const terms = glossary();
  const sent = await fit({ keyterms: terms, fetchImpl });
  expect(asks).toHaveLength(1);
  expect(keytermBytes(sent)).toBeLessThanOrEqual(DEEPGRAM_KEYTERM_PROVABLE_BYTES);
  expect(sent).toEqual(terms.slice(0, sent.length));
});

test("a refused credential is not a keyterm problem and is not retried either", async () => {
  const { fetchImpl, asks } = deepgram([new Response(JSON.stringify({ err_msg: "Invalid credentials." }), { status: 401 })]);
  const sent = await fit({ keyterms: glossary(), fetchImpl });
  expect(asks).toHaveLength(1);
  expect(keytermBytes(sent)).toBeLessThanOrEqual(DEEPGRAM_KEYTERM_PROVABLE_BYTES);
});

test("a connection that never answers costs the terms, not the dictation", async () => {
  const { fetchImpl, asks } = deepgram(["throw"]);
  const terms = glossary();
  const sent = await fit({ keyterms: terms, fetchImpl });
  expect(asks).toHaveLength(1);
  expect(sent.length).toBeGreaterThan(0);
  expect(sent).toEqual(terms.slice(0, sent.length));
  expect(keytermBytes(sent)).toBeLessThanOrEqual(DEEPGRAM_KEYTERM_PROVABLE_BYTES);
});

test("with no key there is nothing to ask with, and the answer is still a glossary", async () => {
  // The mint refuses this properly, with a sentence a person can act on — see
  // `NO_KEY_CONFIGURED`. This only has to not make it worse.
  const { fetchImpl, asks } = deepgram([]);
  const terms = glossary();
  const sent = await fit({ keyterms: terms, fetchImpl, key: undefined });
  expect(asks).toHaveLength(0);
  expect(sent).toEqual(terms.slice(0, sent.length));
  expect(keytermBytes(sent)).toBeLessThanOrEqual(DEEPGRAM_KEYTERM_PROVABLE_BYTES);
});

test("an accepted answer is remembered, so the next press asks nothing", async () => {
  // THE GLOSSARY CHANGES WHEN THE RAIL DOES, which is rarely next to how often
  // somebody dictates. Rediscovering the same answer on every press would be a
  // round trip per press for a question already settled.
  const { fetchImpl, asks } = deepgram([refused(), accepted()]);
  const terms = glossary();
  const first = await fit({ keyterms: terms, fetchImpl });
  expect(asks).toHaveLength(2);
  const second = await fit({ keyterms: terms, fetchImpl });
  expect(asks).toHaveLength(2);
  expect(second).toEqual(first);
});

test("a different glossary is a different question and is asked again", async () => {
  const { fetchImpl, asks } = deepgram([accepted(), accepted()]);
  await fit({ keyterms: glossary(40), fetchImpl });
  await fit({ keyterms: glossary(41), fetchImpl });
  expect(asks).toHaveLength(2);
});

test("under every answer this endpoint can give, the list is a prefix and never grows", async () => {
  // THE PROPERTY THE WHOLE FILE IS FOR. #707 was an outage because an
  // over-budget list refused the socket outright; every branch here has to end
  // in FEWER TERMS, never in none and never in more than were built.
  const terms = glossary();
  const answers: (Response | "throw")[][] = [
    [accepted()],
    [refused(), accepted()],
    [refused(), refused()],
    [new Response(EDGE_HTML, { status: 400 })],
    [new Response("", { status: 500 })],
    [new Response(OVER_BUDGET, { status: 400 }), "throw"],
    ["throw"],
    [new Response(JSON.stringify({ err_msg: "Invalid credentials." }), { status: 401 })],
  ];
  for (const answer of answers) {
    forgetKeytermFits();
    const { fetchImpl, asks } = deepgram(answer);
    const sent = await fit({ keyterms: terms, fetchImpl });
    expect(sent).toEqual(terms.slice(0, sent.length));
    expect(sent.length).toBeLessThanOrEqual(terms.length);
    expect(sent.length).toBeGreaterThan(0);
    // AND THE BUDGET IS NEVER A LOOP: at most the built list and one shrink.
    expect(asks.length).toBeLessThanOrEqual(2);
  }
});

test("a glossary built to the bound is inside it, and the bound is above the floor", async () => {
  // The two constants have to stay in this relationship or the ladder has no
  // rungs: what is built must be able to exceed what is provable, or asking is
  // pointless, and the floor must be reachable by shrinking.
  expect(DEEPGRAM_KEYTERM_BYTE_BUDGET).toBeGreaterThan(DEEPGRAM_KEYTERM_PROVABLE_BYTES);
});

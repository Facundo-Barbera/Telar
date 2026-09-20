/**
 * TELLING THE FAULTS APART, WHICH IS THE WHOLE OF #711.
 *
 * The bar the issue sets is not "a sentence exists". It is that a person can
 * tell a bad API key from an exceeded keyterm budget from a plain network fault
 * — three things that all arrived as "The connection to the transcription
 * service failed" and sent the owner to replace a key that was fine. So the
 * tests here are mostly one shape: give the diagnosis a real refusal, and
 * assert the sentence says which one it was.
 *
 * DEEPGRAM IS NEVER CALLED. Every body below was measured on the wire against
 * the real endpoint (#707, #712) and is quoted where it is used; the fetch is
 * injected. A test that needed an account would be a test nobody runs.
 *
 * AND THE KEY IS IN EVERY CALL ON PURPOSE. This module exists to build error
 * text, error text is read by people and written to logs, and the one thing it
 * must never contain is the credential — so that is asserted rather than
 * assumed, including for the case that would actually produce it: a remote
 * string that echoes it back.
 */
import { expect, test } from "bun:test";
import { DIAGNOSE_DEADLINE_MS, diagnoseDictation, type DictationDiagnosis } from "../src/dictation/diagnose";
import { DictationError } from "../src/dictation/token";

const KEY = "dg-secret-key-do-not-print";

/** What Deepgram actually answers, measured (#707). */
const KEYTERM_LIMIT = JSON.stringify({
  err_code: "Bad Request",
  err_msg: "Bad Request: Keyterm limit exceeded. The maximum number of tokens across all keyterms is 500.",
});
const NO_MODEL = JSON.stringify({ err_code: "INSUFFICIENT_PERMISSIONS", err_msg: "Project does not have access to the requested model." });
const BAD_TOKEN = JSON.stringify({ err_code: "INVALID_AUTH", err_msg: "Token is invalid." });

/** AND WHAT ITS EDGE ANSWERS for an oversized request line — a `400` with no
 *  `err_msg` anywhere in it, from before the credential is read. */
const EDGE_HTML = "<html><body><h1>400 Bad request</h1>\nYour browser sent an invalid request.\n</body></html>";

type Ask = { url: URL; headers: Record<string, string> };

function deepgram(answer: Response | "throw"): { fetchImpl: typeof fetch; asks: Ask[] } {
  const asks: Ask[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    asks.push({ url: new URL(String(input)), headers: (init?.headers ?? {}) as Record<string, string> });
    if (answer === "throw") throw new Error("getaddrinfo ENOTFOUND api.deepgram.com");
    return answer;
  };
  return { fetchImpl, asks };
}

const ask = (answer: Response | "throw", over?: { key?: string | undefined; keyterms?: string[] }): Promise<DictationDiagnosis> & { asks: Ask[] } => {
  const { fetchImpl, asks } = deepgram(answer);
  const run = diagnoseDictation({
    key: over && "key" in over ? over.key : KEY,
    language: "multi",
    keyterms: over?.keyterms ?? ["Telar", "worktree"],
    fetchImpl,
  });
  return Object.assign(run, { asks });
};

test("an over-budget glossary is named as one, in Deepgram's own words", async () => {
  // THE BUG THAT STARTED THIS. The owner saw "the connection failed" and
  // replaced his key; what he needed was this sentence.
  const said = await ask(new Response(KEYTERM_LIMIT, { status: 400 }));
  expect(said.fault).toBe("refused");
  expect(said.reason).toContain("Keyterm limit exceeded");
  expect(said.reason).toContain("400");
});

test("a project without access to the model says so, and is not the same sentence", async () => {
  const said = await ask(new Response(NO_MODEL, { status: 403 }));
  expect(said.fault).toBe("refused");
  expect(said.reason).toContain("does not have access to the requested model");
  // THE POINT IS THE DIFFERENCE. Two refusals that read alike would leave a
  // person exactly where the one sentence did.
  const other = await ask(new Response(KEYTERM_LIMIT, { status: 400 }));
  expect(said.reason).not.toBe(other.reason);
});

test("a token Deepgram will not take reads as a credential fault, not a network one", async () => {
  const said = await ask(new Response(BAD_TOKEN, { status: 401 }));
  expect(said.fault).toBe("refused");
  expect(said.reason).toContain("Token is invalid");
});

test("the edge's HTML 400 is named as a too-long query rather than quoted at anybody", async () => {
  // A PAGE OF HTML IN A TOAST HELPS NOBODY, and this `400` carries no `err_msg`
  // at all — it is answered before the credential is read. The fault is the
  // size of the query, so that is what the sentence says.
  const said = await ask(new Response(EDGE_HTML, { status: 400 }));
  expect(said.fault).toBe("refused");
  expect(said.reason).toContain("too long");
  expect(said.reason).not.toContain("<html");
});

test("a Mac that cannot reach Deepgram at all says that, and does not blame a key", async () => {
  const said = await ask("throw");
  expect(said.fault).toBe("unreachable");
  expect(said.reason).toContain("could not reach Deepgram");
  expect(said.reason).toContain("ENOTFOUND");
});

test("an accepted handshake is an answer: the fault is between the device and Deepgram", async () => {
  // THE ONE A PRE-FLIGHT PROBE COULD NOT PRODUCE. The client's socket failed
  // and this Mac's opens with the same settings, so the key and the account
  // are fine and the network in between is not — which sends somebody
  // somewhere useful rather than back to the vendor's console.
  //
  // A 200 stands in for the 101 a real upgrade returns, because `new Response`
  // refuses to construct a 101; `askListen` treats both as acceptance for
  // exactly this reason.
  const said = await ask(new Response(null, { status: 200 }));
  expect(said.fault).toBe("elsewhere");
  expect(said.reason).toContain("accepted a connection from this Mac");
});

test("a refusal with no words in it still says what it does know", async () => {
  const said = await ask(new Response("", { status: 502 }));
  expect(said.fault).toBe("refused");
  expect(said.reason).toContain("502");
});

test("no key on this Mac is the mint's own refusal, not a diagnosis", async () => {
  // A 409 AND NOT A 502, which is what the route reads off `kind` — and the
  // sentence is `NO_KEY_CONFIGURED`'s rather than a second copy of it here.
  const failed = ask(new Response(null, { status: 200 }), { key: undefined });
  await expect(failed).rejects.toThrow(DictationError);
  await failed.catch((error: DictationError) => expect(error.kind).toBe("unconfigured"));
});

test("the key never reaches the sentence, even when Deepgram echoes it back", async () => {
  // THE CASE THAT WOULD ACTUALLY PRODUCE IT. Deepgram does not echo the header,
  // but a body is a remote string and this is the seam where one becomes
  // something a person reads.
  const said = await ask(new Response(JSON.stringify({ err_msg: `Invalid credentials for ${KEY}` }), { status: 401 }));
  expect(said.reason).not.toContain(KEY);
  expect(said.reason).toContain("[redacted]");
});

test("it asks the question the client's socket asked — same model, same language, same glossary", async () => {
  // A DIAGNOSIS OF A DIFFERENT REQUEST IS NOT A DIAGNOSIS. The keyterms are the
  // part that can be refused, so they have to be on it, one parameter each.
  const run = ask(new Response(NO_MODEL, { status: 403 }), { keyterms: ["Telar", "worktree", "el despliegue"] });
  await run;
  const [asked] = run.asks;
  expect(asked?.url.searchParams.get("model")).toBe("nova-3");
  expect(asked?.url.searchParams.get("language")).toBe("multi");
  expect(asked?.url.searchParams.getAll("keyterm")).toEqual(["Telar", "worktree", "el despliegue"]);
  // AND WITH THE UPGRADE HEADERS, without which Deepgram answers before it
  // reads any of that and every diagnosis would be the same one.
  expect(asked?.headers.Upgrade).toBe("websocket");
});

test("one question, and a deadline on it, because a client is waiting on a route", async () => {
  const run = ask(new Response(NO_MODEL, { status: 403 }));
  await run;
  expect(run.asks).toHaveLength(1);
  expect(DIAGNOSE_DEADLINE_MS).toBeLessThanOrEqual(10_000);
});

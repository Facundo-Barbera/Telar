import { expect, test } from "bun:test";
import { DIAGNOSE_DEADLINE_MS, diagnoseDictation, type DictationDiagnosis } from "./diagnose";
import { DictationError } from "./token";

const KEY = "dg-secret-key-do-not-print";

const KEYTERM_LIMIT = JSON.stringify({
  err_code: "Bad Request",
  err_msg: "Bad Request: Keyterm limit exceeded. The maximum number of tokens across all keyterms is 500.",
});
const NO_MODEL = JSON.stringify({ err_code: "INSUFFICIENT_PERMISSIONS", err_msg: "Project does not have access to the requested model." });
const BAD_TOKEN = JSON.stringify({ err_code: "INVALID_AUTH", err_msg: "Token is invalid." });

const EDGE_HTML = "<html><body><h1>400 Bad request</h1>\nYour browser sent an invalid request.\n</body></html>";

type Ask = { url: URL; headers: Record<string, string> };

function deepgram(answer: Response | "throw"): { fetchImpl: typeof fetch; asks: Ask[] } {
  const asks: Ask[] = [];
  const fetchImpl = (async (input, init) => {
    asks.push({ url: new URL(String(input)), headers: (init?.headers ?? {}) as Record<string, string> });
    if (answer === "throw") throw new Error("getaddrinfo ENOTFOUND api.deepgram.com");
    return answer;
  }) as typeof fetch;
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
  const said = await ask(new Response(KEYTERM_LIMIT, { status: 400 }));
  expect(said.fault).toBe("refused");
  expect(said.reason).toContain("Keyterm limit exceeded");
  expect(said.reason).toContain("400");
});

test("a project without access to the model says so, and is not the same sentence", async () => {
  const said = await ask(new Response(NO_MODEL, { status: 403 }));
  expect(said.fault).toBe("refused");
  expect(said.reason).toContain("does not have access to the requested model");
  const other = await ask(new Response(KEYTERM_LIMIT, { status: 400 }));
  expect(said.reason).not.toBe(other.reason);
});

test("a token Deepgram will not take reads as a credential fault, not a network one", async () => {
  const said = await ask(new Response(BAD_TOKEN, { status: 401 }));
  expect(said.fault).toBe("refused");
  expect(said.reason).toContain("Token is invalid");
});

test("the edge's HTML 400 is named as a too-long query rather than quoted at anybody", async () => {
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
  const failed = ask(new Response(null, { status: 200 }), { key: undefined });
  await expect(failed).rejects.toThrow(DictationError);
  await failed.catch((error: DictationError) => expect(error.kind).toBe("unconfigured"));
});

test("the key never reaches the sentence, even when Deepgram echoes it back", async () => {
  const said = await ask(new Response(JSON.stringify({ err_msg: `Invalid credentials for ${KEY}` }), { status: 401 }));
  expect(said.reason).not.toContain(KEY);
  expect(said.reason).toContain("[redacted]");
});

test("it asks the question the client's socket asked — same model, same language, same glossary", async () => {
  const run = ask(new Response(NO_MODEL, { status: 403 }), { keyterms: ["Telar", "worktree", "el despliegue"] });
  await run;
  const [asked] = run.asks;
  expect(asked?.url.searchParams.get("model")).toBe("nova-3");
  expect(asked?.url.searchParams.get("language")).toBe("multi");
  expect(asked?.url.searchParams.getAll("keyterm")).toEqual(["Telar", "worktree", "el despliegue"]);
  expect(asked?.headers.Upgrade).toBe("websocket");
});

test("one question, and a deadline on it, because a client is waiting on a route", async () => {
  const run = ask(new Response(NO_MODEL, { status: 403 }));
  await run;
  expect(run.asks).toHaveLength(1);
  expect(DIAGNOSE_DEADLINE_MS).toBeLessThanOrEqual(10_000);
});

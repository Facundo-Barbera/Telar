import { afterEach, expect, test } from "bun:test";
import { fitDeepgramKeyterms, forgetKeytermFits, lastKeytermFit } from "./fit";
import { DEEPGRAM_KEYTERM_BYTE_BUDGET, DEEPGRAM_KEYTERM_PROVABLE_BYTES, keytermBytes } from "./keyterms";

afterEach(() => forgetKeytermFits());

const glossary = (count = 40): string[] => Array.from({ length: count }, (_, index) => `term-${String(index).padStart(3, "0")}-abcdefghij`);

const OVER_BUDGET = "Bad Request: Keyterm limit exceeded. The maximum number of tokens across all keyterms is 500.";

const EDGE_HTML = "<html><body><h1>400 Bad request</h1> Your browser sent an invalid request. </body></html>";

type Ask = { url: URL; headers: Record<string, string> };

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
  const { fetchImpl, asks } = deepgram([accepted()]);
  await fit({ keyterms: glossary(), fetchImpl });
  const ask = asks[0]!;
  expect(ask.headers.Upgrade).toBe("websocket");
  expect(ask.headers.Connection).toBe("Upgrade");
  expect(ask.headers["Sec-WebSocket-Version"]).toBe("13");
  expect(ask.headers["Sec-WebSocket-Key"]).toBeTruthy();
  expect(ask.headers.Authorization).toBe("Token dg-secret-key");
  expect(ask.url.searchParams.get("model")).toBe("nova-3");
  expect(ask.url.searchParams.get("language")).toBe("multi");
  expect(ask.url.searchParams.getAll("keyterm")).toHaveLength(glossary().length);
});

test("when Deepgram says the list is over budget it shrinks and asks once more", async () => {
  const { fetchImpl, asks } = deepgram([refused(), accepted()]);
  const terms = glossary();
  const sent = await fit({ keyterms: terms, fetchImpl });
  expect(asks).toHaveLength(2);
  expect(sent.length).toBeLessThan(terms.length);
  expect(sent).toEqual(terms.slice(0, sent.length));
  expect(asks[1]!.url.searchParams.getAll("keyterm")).toEqual(sent);
  expect(lastKeytermFit()).toEqual({ built: terms.length, sent: sent.length, reason: "refused" });
});

test("two refusals end at the provable floor rather than at a third ask", async () => {
  const { fetchImpl, asks } = deepgram([refused(), refused()]);
  const terms = glossary();
  const sent = await fit({ keyterms: terms, fetchImpl });
  expect(asks).toHaveLength(2);
  expect(keytermBytes(sent)).toBeLessThanOrEqual(DEEPGRAM_KEYTERM_PROVABLE_BYTES);
  expect(sent).toEqual(terms.slice(0, sent.length));
  expect(lastKeytermFit()?.reason).toBe("unconfirmed");
});

test("a 400 that is NOT the keyterm limit is never retried", async () => {
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
  const { fetchImpl, asks } = deepgram([]);
  const terms = glossary();
  const sent = await fit({ keyterms: terms, fetchImpl, key: undefined });
  expect(asks).toHaveLength(0);
  expect(sent).toEqual(terms.slice(0, sent.length));
  expect(keytermBytes(sent)).toBeLessThanOrEqual(DEEPGRAM_KEYTERM_PROVABLE_BYTES);
});

test("an accepted answer is remembered, so the next press asks nothing", async () => {
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
    expect(asks.length).toBeLessThanOrEqual(2);
  }
});

test("a glossary built to the bound is inside it, and the bound is above the floor", async () => {
  expect(DEEPGRAM_KEYTERM_BYTE_BUDGET).toBeGreaterThan(DEEPGRAM_KEYTERM_PROVABLE_BYTES);
});

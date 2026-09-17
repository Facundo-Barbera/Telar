/**
 * THE DICTATION TOKEN ROUTE, AGAINST A REAL DAEMON AND A FAKE DEEPGRAM (#544).
 *
 * What must not drift:
 *
 *   - OFF IS THE DEFAULT and an off Mac spends nothing — no key is read, no
 *     call is made, and the refusal is a sentence naming the pane;
 *   - the key never comes back out of any route, only `configured`;
 *   - the file it goes into is 0600 and is not the Agent's;
 *   - an unconfigured Mac is refused with a SENTENCE rather than a 500;
 *   - Deepgram refusing is a different fact from having no key, and its own
 *     words survive to the client;
 *   - what goes on the wire is `Authorization: Token <key>` and `ttl_seconds`,
 *     which is what the docs say and not what anybody remembered;
 *   - the answer is vendor-neutral: `provider` rides it.
 *
 * DEEPGRAM IS NEVER CALLED. `dictationFetch` is injected for `gh`'s reason: a
 * developer with a real key pasted into their own engine would otherwise have
 * this suite spending their account. The one live smoke is in
 * `dictation.live.test.ts`, off unless asked for.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient, EngineClientError } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../src/daemon";
import { stubModels } from "./stub-models";
import { DEEPGRAM_MAX_TTL_SECONDS, DICTATION_TTL_SECONDS, grantDictationToken } from "../src/dictation/token";
import { dictationKeyFile, readDictationKey, writeDictationKey } from "../src/dictation/credentials";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];

const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-dictation-"));
  roots.push(directory);
  fs.writeFileSync(path.join(directory, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  return directory;
};

/** Every call Deepgram was asked to serve, so a test can assert on the header
 *  and the body rather than only on what came back. */
type Call = { url: string; headers: Record<string, string>; body: unknown };

async function engine(deepgram?: (call: Call) => Response): Promise<{ daemon: EngineDaemon; client: EngineClient; calls: Call[] }> {
  const calls: Call[] = [];
  const dictationFetch: typeof fetch = async (input, init) => {
    const call: Call = {
      url: String(input),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return deepgram ? deepgram(call) : Response.json({ access_token: "jwt-from-deepgram", expires_in: 300 });
  };
  const daemon = await startEngine({ models: stubModels, engineRoot: root(), dictationFetch });
  daemons.push(daemon);
  return { daemon, client: new EngineClient(daemon.discovery), calls };
}

afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

/** A Mac somebody has actually switched dictation on for. Two fields because
 *  they are two decisions: choosing a provider and paying for it. */
async function switchedOn(client: EngineClient, key = "dg-secret-key"): Promise<void> {
  await client.setDictation({ provider: "deepgram", apiKey: key });
}

test("out of the box dictation is OFF, which is a choice and not a missing key", async () => {
  const { client } = await engine();
  // `off` rather than "deepgram with no key": macOS dictation and Wispr Flow
  // already work on the composer, so Telar does not claim the job uninvited.
  expect(await client.dictation()).toEqual({ dictation: { provider: "off", configured: false } });
});

test("an off Mac refuses a token with a sentence, and spends nothing finding out", async () => {
  const { client, calls } = await engine();
  await client.setDictation({ apiKey: "dg-secret-key" });
  const failure = await client.dictationToken().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(EngineClientError);
  expect((failure as EngineClientError).code).toBe("conflict");
  expect((failure as EngineClientError).message).toContain("switched off");
  expect((failure as EngineClientError).message).toContain("Settings");
  // A KEY IS PRESENT AND IS NOT SPENT. Off means off, not "off unless somebody
  // pasted something once".
  expect(calls).toHaveLength(0);
});

test("choosing a provider turns it on, and the key that was already there is still there", async () => {
  const { client } = await engine();
  await client.setDictation({ apiKey: "dg-secret-key" });
  expect(await client.setDictation({ provider: "deepgram" })).toEqual({ dictation: { provider: "deepgram", configured: true } });
  expect((await client.dictationToken()).token).toBe("jwt-from-deepgram");
});

test("switching back off keeps the key rather than throwing it away", async () => {
  const { client } = await engine();
  await switchedOn(client);
  // Turning dictation back on later has to be one click, not a trip to the
  // vendor's console.
  expect(await client.setDictation({ provider: "off" })).toEqual({ dictation: { provider: "off", configured: true } });
});

test("a provider this engine has never heard of is refused, and changes nothing", async () => {
  const { client } = await engine();
  await switchedOn(client);
  const failure = await client.setDictation({ provider: "wispr" as "deepgram" }).catch((error: unknown) => error);
  expect((failure as EngineClientError).code).toBe("invalid_request");
  expect((await client.dictation()).dictation.provider).toBe("deepgram");
});

test("a patch that names no provider leaves the chosen one alone", async () => {
  const { client } = await engine();
  await switchedOn(client);
  expect((await client.setDictation({ apiKey: "another-key" })).dictation.provider).toBe("deepgram");
});

test("a pasted key is reported as configured and NEVER echoed back", async () => {
  const { client } = await engine();
  const saved = await client.setDictation({ provider: "deepgram", apiKey: "dg-secret-key" });
  expect(saved).toEqual({ dictation: { provider: "deepgram", configured: true } });
  // The whole answer, serialised: the point is that the secret is in none of
  // it — not as a field, not redacted, not as a length.
  expect(JSON.stringify(await client.dictation())).not.toContain("dg-secret-key");
  expect(JSON.stringify(saved)).not.toContain("dg-secret-key");
});

test("the key lands 0600 in dictation/, which is not the Agent's file", async () => {
  const { daemon, client } = await engine();
  await client.setDictation({ apiKey: "dg-secret-key" });
  const file = dictationKeyFile(path.join(daemon.store.paths.root, "dictation"));
  expect(fs.existsSync(file)).toBe(true);
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  // The Agent's own credential is untouched — sharing one file would mean one
  // `{ key }` standing for two vendors.
  expect(fs.existsSync(path.join(daemon.store.paths.root, "agent", "credentials.json"))).toBe(false);
});

test("an empty string clears it, which is what emptying the field means", async () => {
  const { client } = await engine();
  await client.setDictation({ apiKey: "dg-secret-key" });
  expect((await client.setDictation({ apiKey: "" })).dictation.configured).toBe(false);
});

test("a patch that names no key leaves the stored one alone", async () => {
  const { client } = await engine();
  await client.setDictation({ apiKey: "dg-secret-key" });
  expect((await client.setDictation({})).dictation.configured).toBe(true);
});

test("with a provider and a key, the token route answers a token and the instant it dies", async () => {
  const { client, calls } = await engine();
  await switchedOn(client);
  const before = Date.now();
  const answer = await client.dictationToken();

  expect(answer.provider).toBe("deepgram");
  expect(answer.token).toBe("jwt-from-deepgram");
  // An INSTANT, not a duration — and Deepgram's own `expires_in` is what it is
  // derived from when they send one.
  expect(answer.expiresAt).toBeGreaterThanOrEqual(before + 300_000);
  expect(answer.expiresAt).toBeLessThanOrEqual(Date.now() + 300_000);

  // WHAT WENT ON THE WIRE, which is the half of this a fake response cannot
  // check: the docs say `Token`, not `Bearer`, and `ttl_seconds`, not `ttl`.
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe("https://api.deepgram.com/v1/auth/grant");
  expect(calls[0]!.headers.Authorization).toBe("Token dg-secret-key");
  expect(calls[0]!.body).toEqual({ ttl_seconds: DICTATION_TTL_SECONDS });
});

test("switched on with no key, the refusal is a conflict and a sentence naming where to fix it", async () => {
  const { client, calls } = await engine();
  await client.setDictation({ provider: "deepgram" });
  const failure = await client.dictationToken().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(EngineClientError);
  expect((failure as EngineClientError).code).toBe("conflict");
  expect((failure as EngineClientError).message).toContain("No Deepgram key is configured");
  expect((failure as EngineClientError).message).toContain("Settings");
  // Nothing was spent finding that out.
  expect(calls).toHaveLength(0);
});

test("Deepgram refusing is a different fact, and its own words reach the client", async () => {
  const { client } = await engine(() =>
    Response.json({ err_code: "INVALID_AUTH", err_msg: "Project does not have access to this feature" }, { status: 403 }),
  );
  await switchedOn(client);
  const failure = await client.dictationToken().catch((error: unknown) => error);
  expect((failure as EngineClientError).code).toBe("provider_unavailable");
  expect((failure as EngineClientError).message).toContain("403");
  expect((failure as EngineClientError).message).toContain("Project does not have access to this feature");
});

test("an unreachable Deepgram is reported as unreachable, not as a missing key", async () => {
  const { client } = await engine(() => {
    throw new Error("getaddrinfo ENOTFOUND api.deepgram.com");
  });
  await switchedOn(client);
  const failure = await client.dictationToken().catch((error: unknown) => error);
  expect((failure as EngineClientError).code).toBe("provider_unavailable");
  expect((failure as EngineClientError).message).toContain("could not be reached");
});

test("an answer with no token in it is a refusal rather than an empty credential", async () => {
  const { client } = await engine(() => Response.json({ expires_in: 300 }));
  await switchedOn(client);
  await expect(client.dictationToken()).rejects.toThrow("without a token in it");
});

/* ------------------------------------------------------------------ *
 * The grant helper on its own — the parts no route can reach.
 * ------------------------------------------------------------------ */

test("a key echoed back in an error body is scrubbed before it becomes a sentence", async () => {
  const failure = await grantDictationToken({
    key: "dg-secret-key",
    fetchImpl: async () => Response.json({ err_msg: "bad key: dg-secret-key" }, { status: 401 }),
  }).catch((error: unknown) => error);
  expect((failure as Error).message).not.toContain("dg-secret-key");
  expect((failure as Error).message).toContain("[redacted]");
});

test("the TTL is clamped to what Deepgram documents, at both ends", async () => {
  const asked: number[] = [];
  const grant: typeof fetch = async (_url, init) => {
    asked.push((JSON.parse(String(init?.body)) as { ttl_seconds: number }).ttl_seconds);
    return Response.json({ access_token: "jwt" });
  };
  await grantDictationToken({ key: "k", ttlSeconds: 0, fetchImpl: grant });
  await grantDictationToken({ key: "k", ttlSeconds: 99_999, fetchImpl: grant });
  expect(asked).toEqual([1, DEEPGRAM_MAX_TTL_SECONDS]);
});

test("without an expires_in, the TTL asked for is what the expiry is derived from", async () => {
  const answer = await grantDictationToken({
    key: "k",
    ttlSeconds: 60,
    now: () => 1_000_000,
    fetchImpl: async () => Response.json({ access_token: "jwt" }),
  });
  expect(answer.expiresAt).toBe(1_000_000 + 60_000);
});

test("a blank or whitespace key reads as no key at all", async () => {
  const directory = root();
  writeDictationKey(directory, "   ");
  expect(readDictationKey(directory)).toBeUndefined();
  await expect(grantDictationToken({ key: "   " })).rejects.toThrow("No Deepgram key is configured");
});

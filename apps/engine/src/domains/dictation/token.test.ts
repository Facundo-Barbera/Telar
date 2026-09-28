import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient, EngineClientError } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../../daemon";
import { stubModels } from "../../../test/stub-models";
import { DEEPGRAM_MAX_TTL_SECONDS, DICTATION_TTL_SECONDS, grantDictationToken } from "./token";
import { dictationKeyFile, readDictationKey, writeDictationKey } from "./credentials";
import { DEEPGRAM_KEYTERM_BYTE_BUDGET, TELAR_KEYTERMS } from "./keyterms";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];

const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-dictation-"));
  roots.push(directory);
  fs.writeFileSync(path.join(directory, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  return directory;
};

type Call = { url: string; headers: Record<string, string>; body: unknown };

async function engine(deepgram?: (call: Call) => Response): Promise<{ daemon: EngineDaemon; client: EngineClient; calls: Call[] }> {
  const calls: Call[] = [];
  const dictationFetch = (async (input, init) => {
    const call: Call = {
      url: String(input),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    return deepgram ? deepgram(call) : Response.json({ access_token: "jwt-from-deepgram", expires_in: 300 });
  }) as typeof fetch;
  const daemon = await startEngine({ models: stubModels, engineRoot: root(), dictationFetch });
  daemons.push(daemon);
  return { daemon, client: new EngineClient(daemon.discovery), calls };
}

afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

async function switchedOn(client: EngineClient, key = "dg-secret-key"): Promise<void> {
  await client.setDictation({ provider: "deepgram", apiKey: key });
}

test("out of the box dictation is OFF, which is a choice and not a missing key", async () => {
  const { client } = await engine();
  expect(await client.dictation()).toMatchObject({ dictation: { provider: "off", configured: false } });
});

test("an off Mac refuses a token with a sentence, and spends nothing finding out", async () => {
  const { client, calls } = await engine();
  await client.setDictation({ apiKey: "dg-secret-key" });
  const failure = await client.dictationToken().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(EngineClientError);
  expect((failure as EngineClientError).code).toBe("conflict");
  expect((failure as EngineClientError).message).toContain("switched off");
  expect((failure as EngineClientError).message).toContain("Settings");
  expect(calls).toHaveLength(0);
});

test("choosing a provider turns it on, and the key that was already there is still there", async () => {
  const { client } = await engine();
  await client.setDictation({ apiKey: "dg-secret-key" });
  expect(await client.setDictation({ provider: "deepgram" })).toMatchObject({ dictation: { provider: "deepgram", configured: true } });
  expect((await client.dictationToken()).token).toBe("jwt-from-deepgram");
});

test("switching back off keeps the key rather than throwing it away", async () => {
  const { client } = await engine();
  await switchedOn(client);
  expect(await client.setDictation({ provider: "off" })).toMatchObject({ dictation: { provider: "off", configured: true } });
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
  expect(saved).toMatchObject({ dictation: { provider: "deepgram", configured: true } });
  expect(JSON.stringify(await client.dictation())).not.toContain("dg-secret-key");
  expect(JSON.stringify(saved)).not.toContain("dg-secret-key");
});

test("the key lands 0600 in dictation/, which is not the Agent's file", async () => {
  const { daemon, client } = await engine();
  await client.setDictation({ apiKey: "dg-secret-key" });
  const file = dictationKeyFile(path.join(daemon.store.paths.root, "dictation"));
  expect(fs.existsSync(file)).toBe(true);
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
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
  expect(answer.expiresAt).toBeGreaterThanOrEqual(before + 300_000);
  expect(answer.expiresAt).toBeLessThanOrEqual(Date.now() + 300_000);

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

test("a key echoed back in an error body is scrubbed before it becomes a sentence", async () => {
  const failure = await grantDictationToken({
    key: "dg-secret-key",
    language: "multi",
    fetchImpl: (async () => Response.json({ err_msg: "bad key: dg-secret-key" }, { status: 401 })) as unknown as typeof fetch,
  }).catch((error: unknown) => error);
  expect((failure as Error).message).not.toContain("dg-secret-key");
  expect((failure as Error).message).toContain("[redacted]");
});

test("the TTL is clamped to what Deepgram documents, at both ends", async () => {
  const asked: number[] = [];
  const grant = (async (_url, init) => {
    asked.push((JSON.parse(String(init?.body)) as { ttl_seconds: number }).ttl_seconds);
    return Response.json({ access_token: "jwt" });
  }) as typeof fetch;
  await grantDictationToken({ key: "k", language: "multi", ttlSeconds: 0, fetchImpl: grant });
  await grantDictationToken({ key: "k", language: "multi", ttlSeconds: 99_999, fetchImpl: grant });
  expect(asked).toEqual([1, DEEPGRAM_MAX_TTL_SECONDS]);
});

test("without an expires_in, the TTL asked for is what the expiry is derived from", async () => {
  const answer = await grantDictationToken({
    key: "k",
    language: "multi",
    ttlSeconds: 60,
    now: () => 1_000_000,
    fetchImpl: (async () => Response.json({ access_token: "jwt" })) as unknown as typeof fetch,
  });
  expect(answer.expiresAt).toBe(1_000_000 + 60_000);
});

test("a blank or whitespace key reads as no key at all", async () => {
  const directory = root();
  writeDictationKey(directory, "   ");
  expect(readDictationKey(directory)).toBeUndefined();
  await expect(grantDictationToken({ key: "   ", language: "multi" })).rejects.toThrow("No Deepgram key is configured");
});

test("out of the box the language is `multi` — code-switching, not English", async () => {
  const { client } = await engine();
  expect((await client.dictation()).dictation.language).toBe("multi");
});

test("the language round-trips, and choosing one leaves the provider and the key alone", async () => {
  const { client } = await engine();
  await switchedOn(client);
  const saved = await client.setDictation({ language: "es-419" });
  expect(saved.dictation.language).toBe("es-419");
  expect(saved.dictation.provider).toBe("deepgram");
  expect(saved.dictation.configured).toBe(true);
  expect((await client.dictation()).dictation.language).toBe("es-419");
});

test("and switching provider afterwards leaves the language alone", async () => {
  const { client } = await engine();
  await client.setDictation({ language: "ja" });
  await client.setDictation({ provider: "deepgram" });
  expect((await client.dictation()).dictation.language).toBe("ja");
});

test("a language this engine cannot transcribe is refused with a sentence, and changes nothing", async () => {
  const { client } = await engine();
  await client.setDictation({ language: "fr" });
  const failure = await client.setDictation({ language: "elvish" }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(EngineClientError);
  expect((failure as EngineClientError).code).toBe("invalid_request");
  expect((failure as EngineClientError).message).toContain("transcribe");
  expect((await client.dictation()).dictation.language).toBe("fr");
});

test("the names to pick between ride the same answer as the choice", async () => {
  const { client } = await engine();
  const { languages } = (await client.dictation()).dictation;
  expect(languages[0]).toEqual({ code: "multi", label: "Automatic (any supported language)" });
  expect(languages).toContainEqual({ code: "es", label: "Spanish" });
  expect(languages).toContainEqual({ code: "pt-BR", label: "Portuguese (Brazil)" });
  expect(languages.map((language) => language.code)).not.toContain("en-ZZ");
  for (const { code } of languages) expect((await client.setDictation({ language: code })).dictation.language).toBe(code);
});

test("the token answer carries the language, so one round trip serves the whole press", async () => {
  const { client } = await engine();
  await switchedOn(client);
  await client.setDictation({ language: "de" });
  expect((await client.dictationToken()).language).toBe("de");
});

test("a Mac nobody has narrowed mints tokens that say `multi`", async () => {
  const { client } = await engine();
  await switchedOn(client);
  expect((await client.dictationToken()).language).toBe("multi");
});

test("out of the box the vocabulary is empty, and the keyterms are still not", async () => {
  const { client } = await engine();
  await switchedOn(client);
  expect((await client.dictation()).dictation.vocabulary).toEqual([]);
  expect((await client.dictationToken()).keyterms).toContain("Telar");
});

test("the vocabulary round-trips, and choosing one leaves the provider, the key and the language alone", async () => {
  const { client } = await engine();
  await switchedOn(client);
  await client.setDictation({ language: "es" });
  const saved = await client.setDictation({ vocabulary: ["Kubernetes", "Wispr Flow"] });
  expect(saved.dictation.vocabulary).toEqual(["Kubernetes", "Wispr Flow"]);
  expect(saved.dictation.provider).toBe("deepgram");
  expect(saved.dictation.configured).toBe(true);
  expect(saved.dictation.language).toBe("es");
  expect((await client.dictation()).dictation.vocabulary).toEqual(["Kubernetes", "Wispr Flow"]);
});

test("a patch that names no vocabulary leaves the stored one alone, and an empty list clears it", async () => {
  const { client } = await engine();
  await switchedOn(client);
  await client.setDictation({ vocabulary: ["Kubernetes"] });
  expect((await client.setDictation({ language: "ja" })).dictation.vocabulary).toEqual(["Kubernetes"]);
  expect((await client.setDictation({ vocabulary: [] })).dictation.vocabulary).toEqual([]);
});

test("blank lines and repeats are tidied away rather than refused", async () => {
  const { client } = await engine();
  await switchedOn(client);
  const saved = await client.setDictation({ vocabulary: ["  Kubernetes ", "", "   ", "kubernetes", "Wispr"] });
  expect(saved.dictation.vocabulary).toEqual(["Kubernetes", "Wispr"]);
});

test("the token answer carries the keyterms, with the person's own terms first", async () => {
  const { client } = await engine();
  await switchedOn(client);
  await client.setDictation({ vocabulary: ["Kubernetes", "Wispr Flow"] });
  const { keyterms } = await client.dictationToken();
  expect(keyterms!.slice(0, 2)).toEqual(["Kubernetes", "Wispr Flow"]);
  expect(keyterms).toContain("Telar");
});

test("an unsettled conversation and its project are words the recogniser is told about", async () => {
  const { daemon, client } = await engine();
  await switchedOn(client);
  daemon.store.projectRegistry.register({ id: "project_one", name: "Zarigüeya", root: "/tmp" });
  daemon.store.lifecycle.createSession({ id: "session_one", projectId: "project_one", title: "Nightly build triage" });
  const { keyterms } = await client.dictationToken();
  expect(keyterms).toContain("Nightly build triage");
  expect(keyterms).toContain("Zarigüeya");
});

test("the list stays bounded however many conversations are open", async () => {
  const { daemon, client } = await engine();
  await switchedOn(client);
  daemon.store.projectRegistry.register({ id: "project_one", name: "One", root: "/tmp" });
  for (let index = 0; index < 60; index += 1) {
    daemon.store.lifecycle.createSession({ id: `session_${index}`, projectId: "project_one", title: `Conversation number ${index}` });
  }
  const { keyterms } = await client.dictationToken();
  expect(new TextEncoder().encode(keyterms!.join("")).length).toBeLessThanOrEqual(DEEPGRAM_KEYTERM_BYTE_BUDGET);
  expect(keyterms!.length).toBeGreaterThan(TELAR_KEYTERMS.length);
  expect(keyterms!.length).toBeLessThan(60);
  expect(keyterms).toContain("Telar");
});

test("a settings file with a vocabulary this build cannot read still answers its provider", async () => {
  const { daemon, client } = await engine();
  await switchedOn(client);
  const file = path.join(daemon.store.paths.root, "dictation", "settings.json");
  fs.writeFileSync(file, JSON.stringify({ provider: "deepgram", language: "de", vocabulary: "not a list" }));
  const state = (await client.dictation()).dictation;
  expect(state.provider).toBe("deepgram");
  expect(state.language).toBe("de");
  expect(state.vocabulary).toEqual([]);
});

test("a settings file with a language this build cannot place still answers its provider", async () => {
  const { daemon, client } = await engine();
  await switchedOn(client);
  const file = path.join(daemon.store.paths.root, "dictation", "settings.json");
  fs.writeFileSync(file, JSON.stringify({ provider: "deepgram", language: "klingon" }));
  const state = (await client.dictation()).dictation;
  expect(state.provider).toBe("deepgram");
  expect(state.language).toBe("multi");
});

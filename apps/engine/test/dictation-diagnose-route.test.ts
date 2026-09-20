/**
 * THE DIAGNOSIS ROUTE, AGAINST A REAL DAEMON AND A FAKE DEEPGRAM (#711).
 *
 * `dictation-diagnose.test.ts` covers the sentences. This covers the route: that
 * it is reachable, that it refuses the way the mint beside it refuses, that it
 * asks the question the client's socket asked rather than a different one, and
 * that an off Mac spends nothing finding out.
 *
 * DEEPGRAM IS NEVER CALLED, for `dictation-token.test.ts`'s reason: a developer
 * with a real key pasted into their own engine would otherwise have this suite
 * spending their account.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient, EngineClientError } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../src/daemon";
import { stubModels } from "./stub-models";
import { forgetKeytermFits } from "../src/dictation/fit";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];

const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-diagnose-"));
  roots.push(directory);
  fs.writeFileSync(path.join(directory, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  return directory;
};

type Call = { url: string; headers: Record<string, string> };

async function engine(deepgram?: (call: Call) => Response): Promise<{ client: EngineClient; calls: Call[] }> {
  const calls: Call[] = [];
  const dictationFetch: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), headers: (init?.headers ?? {}) as Record<string, string> });
    if (deepgram) return deepgram(calls[calls.length - 1]!);
    return Response.json({ access_token: "jwt-from-deepgram", expires_in: 300 });
  };
  const daemon = await startEngine({ models: stubModels, engineRoot: root(), dictationFetch });
  daemons.push(daemon);
  return { client: new EngineClient(daemon.discovery), calls };
}

afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  // The fit remembers accepted answers across calls, and a remembered one from
  // another test would make this one ask a different question.
  forgetKeytermFits();
});

const listen = (call: Call): boolean => call.url.includes("/v1/listen");

test("an off Mac refuses the diagnosis with a sentence, and spends nothing finding out", async () => {
  const { client, calls } = await engine();
  await client.setDictation({ apiKey: "dg-secret-key" });
  const failure = await client.dictationDiagnosis().catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(EngineClientError);
  expect((failure as EngineClientError).code).toBe("conflict");
  expect((failure as EngineClientError).message).toContain("switched off");
  expect(calls).toHaveLength(0);
});

test("a Mac with no key is a conflict naming the pane, not a diagnosis", async () => {
  const { client, calls } = await engine();
  await client.setDictation({ provider: "deepgram" });
  const failure = await client.dictationDiagnosis().catch((error: unknown) => error);
  expect((failure as EngineClientError).code).toBe("conflict");
  expect((failure as EngineClientError).message).toContain("Settings");
  expect(calls).toHaveLength(0);
});

test("Deepgram's refusal comes back as Deepgram's own words", async () => {
  // THE WHOLE OF #711 IN ONE ASSERTION. This is the body that reached the owner
  // as "the connection to the transcription service failed".
  const { client } = await engine((call) =>
    listen(call)
      ? new Response(JSON.stringify({ err_msg: "Bad Request: Keyterm limit exceeded. The maximum number of tokens across all keyterms is 500." }), { status: 400 })
      : Response.json({ access_token: "jwt", expires_in: 300 }),
  );
  await client.setDictation({ provider: "deepgram", apiKey: "dg-secret-key" });
  const said = await client.dictationDiagnosis();
  expect(said.fault).toBe("refused");
  expect(said.reason).toContain("Keyterm limit exceeded");
});

test("an accepted handshake sends the reader to the network, not to the vendor's console", async () => {
  const { client } = await engine((call) => (listen(call) ? new Response(null, { status: 200 }) : Response.json({ access_token: "jwt", expires_in: 300 })));
  await client.setDictation({ provider: "deepgram", apiKey: "dg-secret-key" });
  const said = await client.dictationDiagnosis();
  expect(said.fault).toBe("elsewhere");
  expect(said.reason).toContain("accepted a connection from this Mac");
});

test("it asks with the model and language a client would have opened with", async () => {
  // A DIAGNOSIS OF A DIFFERENT REQUEST IS NOT A DIAGNOSIS — and `language` is
  // the field that made dictation transcribe Spanish as English when it went
  // missing once already (#560).
  const { client, calls } = await engine((call) =>
    listen(call) ? new Response(JSON.stringify({ err_msg: "Token is invalid." }), { status: 401 }) : Response.json({ access_token: "jwt", expires_in: 300 }),
  );
  await client.setDictation({ provider: "deepgram", apiKey: "dg-secret-key", language: "es" });
  await client.dictationDiagnosis();
  const asked = calls.filter(listen);
  expect(asked).toHaveLength(1);
  const url = new URL(asked[0]!.url);
  expect(url.searchParams.get("model")).toBe("nova-3");
  expect(url.searchParams.get("language")).toBe("es");
  // WITHOUT THE UPGRADE HEADERS Deepgram answers before it reads the query, and
  // every diagnosis would be the same one.
  expect(asked[0]!.headers.Upgrade).toBe("websocket");
});

test("the key is not in the answer, even when Deepgram puts it in the refusal", async () => {
  const key = "dg-secret-key";
  const { client } = await engine((call) =>
    listen(call) ? new Response(JSON.stringify({ err_msg: `Invalid credentials: ${key}` }), { status: 401 }) : Response.json({ access_token: "jwt", expires_in: 300 }),
  );
  await client.setDictation({ provider: "deepgram", apiKey: key });
  expect((await client.dictationDiagnosis()).reason).not.toContain(key);
});

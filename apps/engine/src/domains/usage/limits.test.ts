import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineStore } from "../../state";
import { EngineStateError } from "../../platform/kernel";
import {
  apiCall,
  claudeWindows,
  codexPlanLabel,
  codexUsage,
  driverOf,
  listAuthFiles,
  managementUrl,
  readHubAccounts,
  readUsageLimitSource,
  sourceLabel,
  UsageLimitSourceError,
} from "./limits";
import { stubModels } from "../../../test/stub-models";

const roots: string[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-usage-limits-"));
  roots.push(directory);
  return directory;
};

afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const store = (): EngineStore => new EngineStore(root(), () => 100);

const HUB = { url: "http://localhost:8317", managementKey: "sk-hub-secret" };

type Call = { url: string; init: RequestInit };

function stubHub(routes: Record<string, unknown | ((body: unknown) => unknown)>) {
  const calls: Call[] = [];
  const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });
    const suffix = url.slice(url.indexOf("/v0/management/") + "/v0/management/".length);
    const route = routes[suffix];
    if (route === undefined) return new Response("not found", { status: 404 });
    const parsedBody = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    const payload = typeof route === "function" ? (route as (body: unknown) => unknown)(parsedBody) : route;
    return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof globalThis.fetch;
  return { fetch: fetchStub, calls };
}

const claudeBody = JSON.stringify({
  five_hour: { utilization: 42, resets_at: "2026-09-13T18:00:00.000Z" },
  seven_day: { utilization: 7.5, resets_at: "2026-09-19T00:00:00.000Z" },
  limits: [
    { kind: "weekly_scoped", percent: 12, resets_at: "2026-09-19T00:00:00.000Z", scope: { model: { display_name: "Opus 5" } } },
    { kind: "five_hour", percent: 99 },
  ],
});

const codexBody = JSON.stringify({
  plan_type: "chatgpt_plus",
  rate_limit: {
    primary_window: { used_percent: 30, reset_at: 1_789_000_000, limit_window_seconds: 18_000 },
    secondary_window: { used_percent: 61.25, reset_at: null },
  },
});

const authFiles = {
  files: [
    { id: "claude-a", auth_index: "0", provider: "claude", email: "a@example.com" },
    { id: "codex-b", auth_index: "1", provider: "codex", id_token: { chatgpt_account_id: "acct-1", chatgpt_plan_type: "pro" } },
    { id: "claude-off", auth_index: "2", provider: "claude", disabled: true },
    { id: "gemini-c", auth_index: "3", provider: "gemini" },
    { id: "junk" },
  ],
};

test("management URLs resolve against the origin, and a bad or non-http URL is refused", () => {
  expect(managementUrl("http://localhost:8317", "auth-files")).toBe("http://localhost:8317/v0/management/auth-files");
  expect(managementUrl("http://localhost:8317/", "auth-files")).toBe("http://localhost:8317/v0/management/auth-files");
  expect(managementUrl("https://hub.example.com/ignored", "api-call")).toBe("https://hub.example.com/v0/management/api-call");
  expect(() => managementUrl("not a url", "auth-files")).toThrow(UsageLimitSourceError);
  expect(() => managementUrl("file:///etc/passwd", "auth-files")).toThrow("http or https");
});

test("the management key rides the Authorization header and appears nowhere else", async () => {
  const hub = stubHub({ "auth-files": authFiles, "api-call": { status_code: 200, body: claudeBody } });
  await readHubAccounts(HUB, { fetch: hub.fetch });
  expect(hub.calls.length).toBeGreaterThan(0);
  for (const call of hub.calls) {
    const headers = call.init.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer sk-hub-secret");
    expect(call.url).not.toContain("sk-hub-secret");
    expect(String(call.init.body ?? "")).not.toContain("sk-hub-secret");
  }
});

test("auth-files drops rows it cannot read rather than failing the whole list", async () => {
  const hub = stubHub({ "auth-files": authFiles });
  const files = await listAuthFiles(HUB, { fetch: hub.fetch });
  expect(files.map((file) => file.id)).toEqual(["claude-a", "codex-b", "claude-off", "gemini-c"]);
  expect(files[1]!.id_token?.chatgpt_account_id).toBe("acct-1");
});

test("a hub that refuses the key says so, and one that is down says that", async () => {
  const unauthorized = (async () => new Response("", { status: 401 })) as unknown as typeof globalThis.fetch;
  await expect(listAuthFiles(HUB, { fetch: unauthorized })).rejects.toThrow("refused the management key");
  const offline = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof globalThis.fetch;
  await expect(listAuthFiles(HUB, { fetch: offline })).rejects.toThrow("did not answer");
});

test("api-call sends the provider's own headers with the hub's $TOKEN$ placeholder", async () => {
  const hub = stubHub({ "api-call": { status_code: 200, body: "{}" } });
  await apiCall(HUB, { id: "codex-b", auth_index: "1", provider: "codex", id_token: { chatgpt_account_id: "acct-1" } }, "https://example.test/usage", {
    fetch: hub.fetch,
  });
  const sent = JSON.parse(String(hub.calls[0]!.init.body)) as { auth_index: string; method: string; url: string; header: Record<string, string> };
  expect(sent.auth_index).toBe("1");
  expect(sent.method).toBe("GET");
  expect(sent.url).toBe("https://example.test/usage");
  expect(sent.header["Authorization"]).toBe("Bearer $TOKEN$");
  expect(sent.header["OpenAI-Beta"]).toBe("codex-1");
  expect(sent.header["Originator"]).toBe("Codex Desktop");
  expect(sent.header["Chatgpt-Account-Id"]).toBe("acct-1");

  const claudeHub = stubHub({ "api-call": { status_code: 200, body: "{}" } });
  await apiCall(HUB, { id: "claude-a", auth_index: "0", provider: "claude" }, "https://example.test/usage", { fetch: claudeHub.fetch });
  const claudeSent = JSON.parse(String(claudeHub.calls[0]!.init.body)) as { header: Record<string, string> };
  expect(claudeSent.header["anthropic-beta"]).toBe("oauth-2025-04-20");
  expect(claudeSent.header["OpenAI-Beta"]).toBeUndefined();
});

test("a provider refusal inside a 200 hub answer is still a failure", async () => {
  const hub = stubHub({ "api-call": { status_code: 401, body: "revoked" } });
  await expect(
    apiCall(HUB, { id: "claude-a", auth_index: "0", provider: "claude" }, "https://example.test/usage", { fetch: hub.fetch }),
  ).rejects.toThrow("HTTP 401");
});

test("Claude's usage answer becomes the two standing windows plus model-scoped ones", () => {
  const windows = claudeWindows(claudeBody);
  expect(windows.map((entry) => entry.key)).toEqual(["five_hour", "seven_day", "model:Opus 5"]);
  expect(windows[0]).toEqual({ key: "five_hour", label: "5-hour", usedPercent: 42, resetsAt: Date.parse("2026-09-13T18:00:00.000Z") });
  expect(windows[2]!.label).toBe("Opus 5 weekly");
  expect(windows.filter((entry) => entry.usedPercent === 99)).toHaveLength(0);
});

test("a window the provider did not mention is omitted, never drawn as zero", () => {
  expect(claudeWindows(JSON.stringify({ five_hour: { utilization: 10, resets_at: null } })).map((entry) => entry.key)).toEqual(["five_hour"]);
  expect(claudeWindows(JSON.stringify({ five_hour: { utilization: 10, resets_at: null } }))[0]!.resetsAt).toBeUndefined();
  expect(codexUsage(JSON.stringify({ rate_limit: null })).windows).toEqual([]);
});

test("Codex's windows carry a seconds-based reset scaled to milliseconds, and a readable plan", () => {
  const usage = codexUsage(codexBody);
  expect(usage.plan).toBe("ChatGPT Plus");
  expect(usage.windows).toEqual([
    { key: "primary", label: "Primary", usedPercent: 30, resetsAt: 1_789_000_000_000 },
    { key: "secondary", label: "Secondary", usedPercent: 61.25 },
  ]);
  expect(codexUsage(JSON.stringify({ rate_limit: {} }), { id: "b", auth_index: "1", provider: "codex", id_token: { chatgpt_plan_type: "pro" } }).plan).toBe("Pro");
});

test("plan labels are readable and drivers map onto Telar's own two", () => {
  expect(codexPlanLabel("pro")).toBe("Pro");
  expect(codexPlanLabel("chatgpt_plus")).toBe("ChatGPT Plus");
  expect(driverOf("claude")).toBe("claude");
  expect(driverOf("codex")).toBe("codex");
  expect(driverOf("gemini")).toBeUndefined();
});

test("a malformed usage answer is an error rather than a silently empty bar", () => {
  expect(() => claudeWindows("not json")).toThrow("not JSON");
  expect(() => codexUsage("[]")).toThrow("not an object");
});

test("reading a hub skips disabled accounts and providers Telar has no driver for", async () => {
  const hub = stubHub({
    "auth-files": authFiles,
    "api-call": (body: unknown) => {
      const sent = body as { auth_index: string };
      return { status_code: 200, body: sent.auth_index === "0" ? claudeBody : codexBody };
    },
  });
  const accounts = await readHubAccounts(HUB, { fetch: hub.fetch });
  expect(accounts.map((account) => account.id)).toEqual(["claude-a", "codex-b"]);
  expect(accounts[0]).toMatchObject({ driver: "claude", email: "a@example.com", plan: "Claude subscription" });
  expect(accounts[0]!.windows.map((entry) => entry.key)).toEqual(["five_hour", "seven_day", "model:Opus 5"]);
  expect(accounts[1]).toMatchObject({ driver: "codex", plan: "ChatGPT Plus" });
});

test("one account's failure costs that account's windows and nobody else's", async () => {
  const hub = stubHub({
    "auth-files": { files: [authFiles.files[0], authFiles.files[1]] },
    "api-call": (body: unknown) => {
      const sent = body as { auth_index: string };
      return sent.auth_index === "0" ? { status_code: 403, body: "revoked" } : { status_code: 200, body: codexBody };
    },
  });
  const accounts = await readHubAccounts(HUB, { fetch: hub.fetch });
  expect(accounts[0]!.error).toContain("HTTP 403");
  expect(accounts[0]!.windows).toEqual([]);
  expect(accounts[1]!.error).toBeUndefined();
  expect(accounts[1]!.windows).toHaveLength(2);
});

test("a source snapshot never throws: a dead hub keeps its row with an error", async () => {
  const offline = (async () => {
    throw new TypeError("fetch failed");
  }) as unknown as typeof globalThis.fetch;
  const snapshot = await readUsageLimitSource(
    { id: "home", kind: "cliproxy", url: "http://localhost:8317", managementKey: "sk-hub-secret" },
    { fetch: offline, now: () => 1_000 },
  );
  expect(snapshot).toEqual({ id: "home", kind: "cliproxy", label: "localhost:8317", checkedAt: 1_000, accounts: [], error: "The hub did not answer." });
});

test("a source with no stored key reports that instead of contacting anything", async () => {
  let called = false;
  const spy = (async () => {
    called = true;
    return new Response("{}", { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const snapshot = await readUsageLimitSource({ id: "home", kind: "cliproxy", url: "http://localhost:8317", managementKey: "" }, { fetch: spy, now: () => 5 });
  expect(snapshot.error).toBe("No management key is stored for this hub.");
  expect(called).toBe(false);
});

test("a source falls back to the hub's host for its label", () => {
  expect(sourceLabel("home", { url: "http://localhost:8317" })).toBe("localhost:8317");
  expect(sourceLabel("home", { label: "  Work hub  ", url: "http://localhost:8317" })).toBe("Work hub");
  expect(sourceLabel("home", { label: "   ", url: "not a url" })).toBe("home");
});

test("a saved hub reads back with its key withheld and marked redacted", () => {
  const engine = store();
  const saved = engine.usageSources.save({ id: "home", url: "http://localhost:8317/", managementKey: "sk-hub-secret", label: "Home hub" });
  expect(saved).toMatchObject({ id: "home", kind: "cliproxy", label: "Home hub", enabled: true, managementKey: "", keyRedacted: true });
  const [listed] = engine.usageSources.list();
  expect(listed!.managementKey).toBe("");
  expect(listed!.keyRedacted).toBe(true);
  expect(fs.readFileSync(engine.paths.usageLimitSources, "utf8")).not.toContain("sk-hub-secret");
  expect(fs.readFileSync(engine.paths.usageLimitSecrets, "utf8")).toContain("sk-hub-secret");
  expect(fs.statSync(engine.paths.usageLimitSecrets).mode & 0o777).toBe(0o600);
});

test("saving the redacted shape back keeps the stored key", () => {
  const engine = store();
  engine.usageSources.save({ id: "home", url: "http://localhost:8317", managementKey: "sk-hub-secret" });
  const redacted = engine.usageSources.list()[0]!;
  engine.usageSources.save({ id: redacted.id, url: redacted.url, managementKey: redacted.managementKey, label: "Renamed" });
  const [resolved] = engine.usageSources.resolve();
  expect(resolved!.managementKey).toBe("sk-hub-secret");
  expect(engine.usageSources.list()[0]!.label).toBe("Renamed");
});

test("only enabled hubs resolve, and resolving is the one read that carries keys", () => {
  const engine = store();
  engine.usageSources.save({ id: "home", url: "http://localhost:8317", managementKey: "sk-home" });
  engine.usageSources.save({ id: "work", url: "http://localhost:8318", managementKey: "sk-work", enabled: false });
  expect(engine.usageSources.list()).toHaveLength(2);
  const resolved = engine.usageSources.resolve();
  expect(resolved.map((source) => source.id)).toEqual(["home"]);
  expect(resolved[0]!.managementKey).toBe("sk-home");
});

test("removing a hub forgets its key with it", () => {
  const engine = store();
  engine.usageSources.save({ id: "home", url: "http://localhost:8317", managementKey: "sk-hub-secret" });
  expect(engine.usageSources.remove("home")).toBe(true);
  expect(engine.usageSources.list()).toEqual([]);
  expect(fs.readFileSync(engine.paths.usageLimitSecrets, "utf8")).not.toContain("sk-hub-secret");
  expect(engine.usageSources.remove("home")).toBe(false);
});

test("a hub needs a valid http URL and a well-formed id", () => {
  const engine = store();
  expect(() => engine.usageSources.save({ id: "home", url: "not a url" })).toThrow(EngineStateError);
  expect(() => engine.usageSources.save({ id: "home", url: "file:///etc/passwd" })).toThrow("http or https");
  expect(() => engine.usageSources.save({ id: "9bad", url: "http://localhost:8317" })).toThrow(EngineStateError);
  expect(() => engine.usageSources.save({ id: "home" })).toThrow("needs a hub URL");
});

test("a hand-mangled registry costs the list, never the engine's settings read", () => {
  const engine = store();
  engine.usageSources.save({ id: "home", url: "http://localhost:8317", managementKey: "sk-hub-secret" });
  fs.writeFileSync(engine.paths.usageLimitSources, "{ not json");
  expect(engine.usageSources.list()).toEqual([]);
  expect(engine.usageSources.resolve()).toEqual([]);
});

const realFetch = globalThis.fetch;
let hubCalls = 0;
function interceptHub(answer: (path: string, body: unknown) => unknown): void {
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(typeof input === "object" && "url" in input ? input.url : input);
    const marker = url.indexOf("/v0/management/");
    if (marker < 0) return realFetch(input as never, init);
    hubCalls += 1;
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    return new Response(JSON.stringify(answer(url.slice(marker + "/v0/management/".length), body)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
}

const daemons: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  globalThis.fetch = realFetch;
  hubCalls = 0;
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
});

async function engineWithClient() {
  const { startEngine } = await import("../../daemon");
  const { connectEngine } = await import("@telar/engine-client/node");
  const directory = root();
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
  const daemon = await startEngine({ models: stubModels, engineRoot: directory });
  daemons.push(daemon);
  return { daemon, client: await connectEngine(daemon.store.paths.root) };
}

test("the routes save, list and remove a hub without ever handing the key back", async () => {
  const { client } = await engineWithClient();
  const saved = await client.saveUsageLimitSource({ id: "home", url: "http://localhost:8317", managementKey: "sk-hub-secret", label: "Home hub" });
  expect(saved.source).toMatchObject({ id: "home", label: "Home hub", managementKey: "", keyRedacted: true, enabled: true });
  const listed = await client.usageLimitSources();
  expect(JSON.stringify(listed)).not.toContain("sk-hub-secret");
  await client.saveUsageLimitSource({ id: "home", url: listed.sources[0]!.url, managementKey: "", enabled: false });
  expect((await client.usageLimitSources()).sources[0]).toMatchObject({ enabled: false, keyRedacted: true });
  expect(await client.removeUsageLimitSource("home")).toEqual({ removed: true });
  expect((await client.usageLimitSources()).sources).toEqual([]);
});

test("the limits route reads every enabled hub and keeps a failing one's row", async () => {
  const { client } = await engineWithClient();
  interceptHub((path, body) => {
    if (path === "auth-files") return { files: [authFiles.files[0], authFiles.files[1]] };
    const sent = body as { auth_index: string };
    return { status_code: 200, body: sent.auth_index === "0" ? claudeBody : codexBody };
  });
  await client.saveUsageLimitSource({ id: "home", url: "http://localhost:8317", managementKey: "sk-hub-secret" });
  await client.saveUsageLimitSource({ id: "nokey", url: "http://localhost:8319" });
  const { limits } = await client.usageLimits();
  expect(limits.sources.map((source) => source.id)).toEqual(["home", "nokey"]);
  expect(limits.sources[0]!.accounts.map((account) => account.driver)).toEqual(["claude", "codex"]);
  expect(limits.sources[1]!.error).toBe("No management key is stored for this hub.");
});

test("a second read is served from cache; ?refresh=1 goes back to the hub", async () => {
  const { client } = await engineWithClient();
  interceptHub((path, body) => {
    if (path === "auth-files") return { files: [authFiles.files[0]] };
    void body;
    return { status_code: 200, body: claudeBody };
  });
  await client.saveUsageLimitSource({ id: "home", url: "http://localhost:8317", managementKey: "sk-hub-secret" });
  const first = await client.usageLimits();
  const afterFirst = hubCalls;
  expect(afterFirst).toBeGreaterThan(0);
  const second = await client.usageLimits();
  expect(second.limits.readAt).toBe(first.limits.readAt);
  expect(hubCalls).toBe(afterFirst);
  const forced = await client.usageLimits({ refresh: true });
  expect(hubCalls).toBeGreaterThan(afterFirst);
  expect(forced.limits.readAt).toBeGreaterThanOrEqual(first.limits.readAt);
});

test("a settings change drops the cached snapshot", async () => {
  const { client } = await engineWithClient();
  interceptHub((path) => (path === "auth-files" ? { files: [] } : { status_code: 200, body: "{}" }));
  await client.saveUsageLimitSource({ id: "home", url: "http://localhost:8317", managementKey: "sk-hub-secret" });
  expect((await client.usageLimits()).limits.sources.map((source) => source.id)).toEqual(["home"]);
  await client.removeUsageLimitSource("home");
  expect((await client.usageLimits()).limits.sources).toEqual([]);
});

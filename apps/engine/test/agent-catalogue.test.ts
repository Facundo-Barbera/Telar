/**
 * THE AGENT'S DESCRIBED CATALOGUE — the merge, the cache, and the route table
 * that has to keep up with Go (#551).
 *
 * ── THE ONE TEST THAT IS NOT ABOUT THIS CODE ────────────────────────────────
 * "every id Go serves has a route" is a test about a HAND-TRANSCRIBED TABLE,
 * and its job is to fail. The mapping from model id to endpoint exists in one
 * HTML table on opencode.ai/docs/go and nowhere machine-readable, so
 * `GO_ROUTES` is a transcription of it — and a transcription goes stale the day
 * the service adds a model. The fixture beside this file is Go's own answer on
 * 2026-09-16; refreshing it after Go adds a model fails this suite until the
 * table has a row for it, which is exactly the prompt the table needs.
 *
 * Everything else here is ordinary: no network, no clock, no engine root but a
 * temporary one. `readModelsDev` takes its `fetch` and its `now`, so "models.dev
 * is down", "the cache is a day old" and "the cache is fresh" are three calls
 * rather than three environments.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CATALOGUE_TTL_MS,
  GO_ROUTES,
  catalogueCacheFile,
  defaultAgentModel,
  familyOf,
  goRouteGaps,
  goRouteOf,
  mergeCatalogue,
  parseModelsDev,
  readAgentCatalogue,
  readModelsDev,
  routeObstacle,
  routeSupported,
  type GoRoute,
  type ModelsDevEntry,
} from "../src/agent/catalogue";
import { DEFAULT_GO_MODEL } from "../src/agent/go";

const GO_FIXTURE = JSON.parse(fs.readFileSync(path.join(import.meta.dir, "fixtures", "go-models.json"), "utf8")) as {
  readAt: string;
  ids: string[];
};

let root: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-catalogue-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** models.dev's own shape, trimmed to one provider and three models. */
function modelsDevPayload(): unknown {
  return {
    anthropic: { models: { "claude-opus-5": { name: "Opus 5" } } },
    "opencode-go": {
      models: {
        "kimi-k3": {
          name: "Kimi K3",
          reasoning: true,
          tool_call: true,
          attachment: true,
          release_date: "2026-07-16",
          limit: { context: 1_048_576, output: 131_072 },
        },
        "glm-5.3": { name: "GLM-5.3", reasoning: true, tool_call: true, attachment: false, release_date: "2026-08-14", limit: { context: 1_000_000, output: 131_072 } },
        "grok-4.6": { name: "Grok 4.6", reasoning: true, tool_call: true, attachment: true, release_date: "2026-08-12", limit: { context: 500_000, output: 500_000 } },
      },
    },
  };
}

function answering(payload: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } })) as typeof fetch;
}

describe("the route table", () => {
  /**
   * THE TRIPWIRE. A non-empty answer names the ids Go has started serving that
   * nobody has transcribed a route for yet — go read the "Model ID / Endpoint"
   * table at opencode.ai/docs/go and add them to `GO_ROUTES`.
   */
  test("covers every id Go serves", () => {
    expect(goRouteGaps(GO_FIXTURE.ids)).toEqual([]);
  });

  test("places the three shapes the docs publish", () => {
    // chat/completions, verbatim from the docs table.
    expect(goRouteOf("kimi-k3")).toBe("chat");
    expect(goRouteOf("glm-5.3")).toBe("chat");
    expect(goRouteOf("deepseek-v4-pro")).toBe("chat");
    // Anthropic-shaped.
    expect(goRouteOf("minimax-m3")).toBe("messages");
    expect(goRouteOf("qwen3.8-max")).toBe("messages");
    expect(goRouteOf("union-alpha")).toBe("messages");
    // OpenAI Responses.
    expect(goRouteOf("grok-4.6")).toBe("responses");
    expect(goRouteOf("gpt-5.6-luna")).toBe("responses");
    expect(goRouteOf("muse-spark-1.3-contributor")).toBe("responses");
  });

  test("an id nobody transcribed is `unknown`, not a guess at a shape", () => {
    expect(goRouteOf("some-model-go-added-this-morning")).toBe("unknown");
    expect(goRouteGaps(["kimi-k3", "some-model-go-added-this-morning"])).toEqual(["some-model-go-added-this-morning"]);
  });

  /**
   * WHAT THIS CLIENT SPEAKS — every route Go serves, since #571.
   *
   * `model.ts` builds `ChatAnthropic` for `/messages` and `ChatOpenAI` in its
   * Responses mode for `/responses`, and `agent.live.test.ts` proved each with
   * one tool lap per id against the real service before this moved. `unknown`
   * was already selectable on purpose — see `AgentModel.supported`: a model Go
   * added yesterday that probably works beats a greyed row nobody can reach
   * until a docs page is transcribed.
   */
  test("every route this build knows about is one it speaks", () => {
    expect(routeSupported("chat")).toBe(true);
    expect(routeSupported("unknown")).toBe(true);
    expect(routeSupported("messages")).toBe(true);
    expect(routeSupported("responses")).toBe(true);
  });

  /**
   * AND NOTHING HAS AN OBSTACLE TO REPORT, which is the same fact said once.
   * `routeSupported` is DERIVED from this rather than kept beside it, so the
   * two can no longer drift into a row that is greyed out with nothing to say,
   * or explained and still pickable.
   */
  test("no route has anything to say against it, and supported is that fact inverted", () => {
    for (const route of ["chat", "messages", "responses", "unknown"] as const) {
      expect(routeObstacle(route)).toBeUndefined();
      expect(routeSupported(route)).toBe(true);
    }
  });

  /**
   * ── HOW MANY OF EACH, COUNTED RATHER THAN CLAIMED ───────────────────────────
   *
   * #554 (`bf0a2a76`) landed because three comments said "eighteen unsupported"
   * and the table said sixteen — a number written into prose is a claim like any
   * other, and prose is the one place nothing checks it. It then went stale
   * again the moment #571 measured `omen-alpha` onto chat/completions, which is
   * the whole argument for counting here instead of anywhere else.
   *
   * THE SPLIT IS THE ASSERTION, not the total. `goRouteGaps` above already
   * proves every id Go serves is placed; this proves WHERE they were placed, so
   * a one-line edit that quietly moves a family between endpoints has to say so
   * in a diff a reader can see.
   */
  test("the table places Go's 38 ids as 23 chat, 10 messages and 5 responses", () => {
    const counts = new Map<GoRoute, number>();
    for (const route of Object.values(GO_ROUTES)) counts.set(route, (counts.get(route) ?? 0) + 1);
    expect(Object.fromEntries(counts)).toEqual({ chat: 23, messages: 10, responses: 5 });
    // And the table covers the recorded list exactly — no id placed that Go
    // does not serve, which a hand-maintained map drifts into.
    expect(Object.keys(GO_ROUTES).sort()).toEqual([...GO_FIXTURE.ids].sort());
    // EVERY ONE OF THEM IS RUNNABLE, which is what #571 bought. The fifteen on
    // the two new routes are the ones that used to be greyed out.
    expect(Object.values(GO_ROUTES).every((route) => routeSupported(route))).toBe(true);
  });

  /** Every transcribed row is one of the three the docs publish — a typo'd
   *  value would otherwise read as `unknown` at the call site and hide. */
  test("every row is one of the three real endpoints", () => {
    for (const [id, route] of Object.entries(GO_ROUTES)) {
      expect([id, route]).toEqual([id, expect.stringMatching(/^(chat|messages|responses)$/)]);
    }
  });
});

describe("families", () => {
  test("group a vendor's generations together", () => {
    expect(familyOf("qwen3.8-flash")).toBe("Qwen");
    expect(familyOf("qwen3.5-plus")).toBe("Qwen");
    expect(familyOf("mimo-v2.5-pro")).toBe("MiMo");
    expect(familyOf("mimo-v2-omni")).toBe("MiMo");
    expect(familyOf("hy4-preview")).toBe("Hy");
    expect(familyOf("hy3")).toBe("Hy");
  });

  test("a vendor nobody listed still lands somewhere sensible", () => {
    expect(familyOf("zephyr4.1-turbo")).toBe("Zephyr");
  });
});

describe("the merge", () => {
  const entries: Record<string, ModelsDevEntry> = {
    "kimi-k3": { name: "Kimi K3", reasoning: true, toolCall: true, attachment: true, context: 1_048_576, output: 131_072, releaseDate: "2026-07-16" },
    "glm-5.3": { name: "GLM-5.3", releaseDate: "2026-08-14", context: 1_000_000 },
    "glm-5.1": { name: "GLM-5.1", releaseDate: "2026-04-07" },
    "grok-4.6": { name: "Grok 4.6", releaseDate: "2026-08-12" },
  };

  test("describes what models.dev knows", () => {
    const [kimi] = mergeCatalogue(["kimi-k3"], entries);
    expect(kimi).toEqual({
      id: "kimi-k3",
      name: "Kimi K3",
      family: "Kimi",
      route: "chat",
      supported: true,
      described: true,
      reasoning: true,
      toolCall: true,
      attachment: true,
      context: 1_048_576,
      output: 131_072,
      releaseDate: "2026-07-16",
    });
  });

  /** THE POINT OF `described`. Go is the authority on what exists; a third
   *  party being behind must not remove a model from the picker. */
  test("a Go-only id survives, named by its own id and marked undescribed", () => {
    const [only] = mergeCatalogue(["deepseek-flash"], entries);
    expect(only).toMatchObject({ id: "deepseek-flash", name: "deepseek-flash", family: "DeepSeek", described: false, route: "chat", supported: true });
    expect(only).not.toHaveProperty("context");
    expect(only).not.toHaveProperty("releaseDate");
  });

  test("models.dev absent entirely leaves every row listed and undescribed", () => {
    const models = mergeCatalogue(["kimi-k3", "grok-4.6"], {});
    expect(models.map((model) => model.id).sort()).toEqual(["grok-4.6", "kimi-k3"]);
    expect(models.every((model) => !model.described)).toBe(true);
    // The route table is CODE, so it survives models.dev being unreachable —
    // which is the whole reason it is not fetched. The ROUTE is still placed
    // even with no description at all; `supported` follows from it.
    expect(models.find((model) => model.id === "grok-4.6")?.route).toBe("responses");
    expect(models.find((model) => model.id === "grok-4.6")?.supported).toBe(true);
  });

  test("an id models.dev describes that Go does not serve is not invented", () => {
    expect(mergeCatalogue(["kimi-k3"], entries).map((model) => model.id)).toEqual(["kimi-k3"]);
  });

  /**
   * THE ROW STILL CARRIES ITS ROUTE, WHICH IS THE FACT THAT OUTLIVED #571.
   *
   * This test used to assert that an Anthropic-shaped and a Responses model
   * were UNSUPPORTED. They are not any more — `model.ts` speaks all three
   * endpoints and a live smoke proved it — so what is worth pinning is the
   * thing that did not change: the route is still placed per id, and the picker
   * still gets a per-row badge that says which endpoint a model answers on. A
   * catalogue that stopped carrying the route the day everything became
   * pickable would have nothing to say when a fourth one arrives.
   */
  test("every row carries its own route, and all three are runnable", () => {
    const models = mergeCatalogue(["minimax-m3", "grok-4.6", "kimi-k3"], entries);
    expect(models.map((model) => [model.id, model.route, model.supported])).toEqual(
      expect.arrayContaining([
        ["minimax-m3", "messages", true],
        ["grok-4.6", "responses", true],
        ["kimi-k3", "chat", true],
      ]),
    );
  });

  /** Newest first, within a family and between them — decided here so the
   *  phone and the desktop cannot disagree about what "newest" means. */
  test("orders families by their newest member and rows by release date", () => {
    const models = mergeCatalogue(["glm-5.1", "kimi-k3", "glm-5.3"], entries);
    expect(models.map((model) => model.id)).toEqual(["glm-5.3", "glm-5.1", "kimi-k3"]);
  });

  test("an undescribed row sorts last in its family and does not move it", () => {
    const models = mergeCatalogue(["glm-5.3", "glm-5", "kimi-k3"], entries);
    expect(models.map((model) => model.id)).toEqual(["glm-5.3", "glm-5", "kimi-k3"]);
  });
});

describe("the default model", () => {
  test("is `kimi-k3` when Go still serves it on a route this client speaks", () => {
    expect(defaultAgentModel(mergeCatalogue(["glm-5.3", "kimi-k3"], {}))).toBe(DEFAULT_GO_MODEL);
  });

  test("falls to the newest supported model when the named one moved route", () => {
    // Not a route Go publishes for it today — the point is that the default is
    // CHECKED rather than asserted.
    const moved = [
      { id: DEFAULT_GO_MODEL, supported: false },
      { id: "minimax-m3", supported: false },
      { id: "glm-5.3", supported: true },
    ];
    expect(defaultAgentModel(moved)).toBe("glm-5.3");
  });

  test("answers the named default when there is no catalogue at all", () => {
    // A Go that did not answer is not evidence that a conversation's model went
    // away, and a turn still has to name something.
    expect(defaultAgentModel([])).toBe(DEFAULT_GO_MODEL);
  });
});

describe("models.dev", () => {
  test("parses one provider out of the whole file", () => {
    const entries = parseModelsDev(modelsDevPayload());
    expect(Object.keys(entries).sort()).toEqual(["glm-5.3", "grok-4.6", "kimi-k3"]);
    expect(entries["kimi-k3"]).toEqual({
      name: "Kimi K3",
      reasoning: true,
      toolCall: true,
      attachment: true,
      context: 1_048_576,
      output: 131_072,
      releaseDate: "2026-07-16",
    });
  });

  test("keeps the fields that parsed and drops the ones that did not", () => {
    const entries = parseModelsDev({ "opencode-go": { models: { "kimi-k3": { name: "Kimi K3", reasoning: "yes", limit: { context: "lots" } } } } });
    expect(entries["kimi-k3"]).toEqual({ name: "Kimi K3" });
  });

  test("a file with no OpenCode Go in it is nothing, not a crash", () => {
    expect(parseModelsDev({ anthropic: { models: {} } })).toEqual({});
    expect(parseModelsDev(null)).toEqual({});
    expect(parseModelsDev("nonsense")).toEqual({});
  });

  test("fetches, caches under the agent directory, and stamps when", async () => {
    const answer = await readModelsDev({ agentDir: root, now: () => 1_000, fetchImpl: answering(modelsDevPayload()), url: "https://models.dev/api.json" });
    expect(answer.fetchedAt).toBe(1_000);
    expect(answer.entries["kimi-k3"]?.name).toBe("Kimi K3");
    expect(JSON.parse(fs.readFileSync(catalogueCacheFile(root), "utf8"))).toMatchObject({ version: 1, fetchedAt: 1_000 });
  });

  test("a fresh cache is served without asking models.dev", async () => {
    await readModelsDev({ agentDir: root, now: () => 1_000, fetchImpl: answering(modelsDevPayload()) });
    let asked = 0;
    const answer = await readModelsDev({
      agentDir: root,
      now: () => 1_000 + CATALOGUE_TTL_MS - 1,
      fetchImpl: (async () => {
        asked += 1;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });
    expect(asked).toBe(0);
    expect(answer.fetchedAt).toBe(1_000);
    expect(answer.entries["kimi-k3"]?.name).toBe("Kimi K3");
  });

  test("a day-old cache is refetched", async () => {
    await readModelsDev({ agentDir: root, now: () => 1_000, fetchImpl: answering(modelsDevPayload()) });
    const answer = await readModelsDev({
      agentDir: root,
      now: () => 1_000 + CATALOGUE_TTL_MS,
      fetchImpl: answering({ "opencode-go": { models: { "kimi-k4": { name: "Kimi K4" } } } }),
    });
    expect(answer.fetchedAt).toBe(1_000 + CATALOGUE_TTL_MS);
    expect(Object.keys(answer.entries)).toEqual(["kimi-k4"]);
  });

  /** STALE BEATS NOTHING. A third party having a bad minute must not revert
   *  every name in the picker to a raw id. */
  test("a stale cache is served, with its original stamp, when the refetch fails", async () => {
    await readModelsDev({ agentDir: root, now: () => 1_000, fetchImpl: answering(modelsDevPayload()) });
    const answer = await readModelsDev({
      agentDir: root,
      now: () => 1_000 + CATALOGUE_TTL_MS,
      fetchImpl: (async () => {
        throw new Error("models.dev is down");
      }) as typeof fetch,
    });
    expect(answer.fetchedAt).toBe(1_000);
    expect(answer.entries["kimi-k3"]?.name).toBe("Kimi K3");
    expect(answer.message).toContain("models.dev is down");
  });

  test("no cache and a failed fetch is nothing plus the reason", async () => {
    const answer = await readModelsDev({ agentDir: root, now: () => 1_000, fetchImpl: answering({}, 503) });
    expect(answer).toMatchObject({ entries: {}, fetchedAt: null });
    expect(answer.message).toContain("503");
  });

  /** An empty answer is not an answer: do not overwrite a good cache because
   *  the provider key was renamed upstream. */
  test("an answer with no OpenCode Go models does not replace a stale cache", async () => {
    await readModelsDev({ agentDir: root, now: () => 1_000, fetchImpl: answering(modelsDevPayload()) });
    const answer = await readModelsDev({ agentDir: root, now: () => 1_000 + CATALOGUE_TTL_MS, fetchImpl: answering({ anthropic: { models: {} } }) });
    expect(answer.fetchedAt).toBe(1_000);
    expect(answer.entries["kimi-k3"]?.name).toBe("Kimi K3");
  });

  test("a corrupt cache is re-fetched rather than half-read", async () => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(catalogueCacheFile(root), "{ not json");
    const answer = await readModelsDev({ agentDir: root, now: () => 1_000, fetchImpl: answering(modelsDevPayload()) });
    expect(answer.fetchedAt).toBe(1_000);
    expect(answer.entries["kimi-k3"]?.name).toBe("Kimi K3");
  });

  test("no agent directory means no cache and no crash", async () => {
    const answer = await readModelsDev({ now: () => 1_000, fetchImpl: answering(modelsDevPayload()) });
    expect(answer.fetchedAt).toBe(1_000);
  });
});

describe("the catalogue route's answer", () => {
  test("carries both stamps when both halves answered", async () => {
    const catalogue = await readAgentCatalogue({
      agentDir: root,
      now: () => 5_000,
      readGo: async () => ({ models: [{ id: "kimi-k3" }, { id: "grok-4.6" }] }),
      fetchImpl: answering(modelsDevPayload()),
    });
    expect(catalogue.source).toEqual({ go: 5_000, modelsDev: 5_000 });
    expect(catalogue.models.map((model) => model.name)).toEqual(["Grok 4.6", "Kimi K3"]);
    expect(catalogue.message).toBeUndefined();
  });

  /** The half that matters: no ids is no picker, and the service's own words
   *  are what the surface shows. */
  test("a Go that did not answer is an empty list, a null stamp and its reason", async () => {
    const catalogue = await readAgentCatalogue({
      agentDir: root,
      now: () => 5_000,
      readGo: async () => ({ models: [], message: "OpenCode Go answered 502 for its model list." }),
      fetchImpl: answering(modelsDevPayload()),
    });
    expect(catalogue.models).toEqual([]);
    expect(catalogue.source.go).toBeNull();
    expect(catalogue.message).toBe("OpenCode Go answered 502 for its model list.");
  });

  test("models.dev failing costs the descriptions and nothing else", async () => {
    const catalogue = await readAgentCatalogue({
      agentDir: root,
      now: () => 5_000,
      readGo: async () => ({ models: [{ id: "kimi-k3" }, { id: "minimax-m3" }] }),
      fetchImpl: answering({}, 500),
    });
    expect(catalogue.source).toEqual({ go: 5_000, modelsDev: null });
    expect(catalogue.models.map((model) => model.id).sort()).toEqual(["kimi-k3", "minimax-m3"]);
    expect(catalogue.models.every((model) => !model.described)).toBe(true);
    // The route survives the description failing, because it comes from code.
    expect(catalogue.models.find((model) => model.id === "minimax-m3")?.route).toBe("messages");
    expect(catalogue.message).toContain("500");
  });

  /** GO'S SILENCE IS THE ONE WORTH REPORTING. With no ids there is no picker;
   *  a missing name is a cosmetic loss that must not shout over it. */
  test("Go's reason wins when both halves failed", async () => {
    const catalogue = await readAgentCatalogue({
      agentDir: root,
      now: () => 5_000,
      readGo: async () => ({ models: [], message: "OpenCode Go did not answer its model list." }),
      fetchImpl: answering({}, 500),
    });
    expect(catalogue.message).toBe("OpenCode Go did not answer its model list.");
  });
});

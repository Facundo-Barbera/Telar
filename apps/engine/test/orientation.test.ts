/**
 * THE ORIENTATION, AT ITS THREE SEAMS AND ON DISK.
 *
 * WHAT IS ACTUALLY BEING PINNED. The words themselves are copy and a test that
 * quoted them would fail on every edit for no benefit. What must not drift is:
 *
 *   - that the paragraph reaches each provider EXACTLY ONCE when it is on, and
 *     NOT AT ALL when it is off — three providers, three different seams, and
 *     the whole feature is the claim that all three carry it;
 *   - that the skill on disk names every tool this engine actually serves, so a
 *     reference a model reads cannot quietly describe a wall that moved;
 *   - that installing is idempotent, that "off" DELETES rather than merely
 *     stops refreshing, and that neither ever touches a file Telar did not
 *     write.
 *
 * NO SERVER, NO CLI, NO APP. The Claude and Codex seams are read off the
 * options each driver builds; OpenCode's is read off `openCodeConfigContent`,
 * which is the same function `startOpenCodeRuntime` spawns with.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ORIENTATION_VERSION,
  TELAR_ORIENTATION,
  TELAR_SKILL,
  TELAR_SKILL_NAME,
  engineOwnedRoot,
  isTelarGenerated,
  orientationInstructionsPath,
  syncTelarSkill,
  telarSkillDigest,
  writeOrientationInstructions,
} from "../src/orientation";
import { codexHome, openCodeHome, providerSkillRoot, providerSkillRoots } from "../src/provider-skills";
import { openCodeBriefings, openCodeConfigContent } from "../src/opencode/runtime";
import { sessionsTools } from "../src/sessions-tools/tools";
import { notesTools } from "../src/notes-tools/tools";
import { displayTools } from "../src/display/tools";
import { runTools } from "../src/run/tools";
import { BROWSER_BRIEFING } from "../src/browser/briefing";
import { RUN_BRIEFING } from "../src/run/briefing";
import { createClaudeDriver } from "../src/driver";
import { EngineStore } from "../src/state";
import { startEngine, type EngineDaemon } from "../src/daemon";
import { EngineClient } from "@telar/engine-client";
import type { DriverRun } from "../src/provider-contract";
import type { ToolFactory } from "../src/tool-kit";

let home: string;
const daemons: EngineDaemon[] = [];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "orientation-"));
});

afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  rmSync(home, { recursive: true, force: true });
});

/**
 * A REAL DAEMON, WITH ITS SKILL ROOTS POINTED SOMEWHERE HARMLESS. `skillRoots`
 * is absent everywhere else on purpose (see `EngineDaemonOptions`) — a suite
 * that constructs daemons must not write into the developer's own
 * `~/.claude/skills`. Here it is passed explicitly, because installing is
 * exactly what is under test.
 */
/** Retry until it holds — the shape every other suite here uses for a fact the
 *  engine establishes off the request path. */
async function eventually(assertion: () => void, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 15));
    }
  }
}

async function engine(skillRoots: readonly string[] = []): Promise<{ daemon: EngineDaemon; client: EngineClient }> {
  const daemon = await startEngine({ engineRoot: join(home, "engine"), skillRoots });
  daemons.push(daemon);
  return { daemon, client: new EngineClient(daemon.discovery) };
}

const run = (over: Partial<DriverRun> = {}): DriverRun =>
  ({
    sessionId: "session_one",
    runId: "run_one",
    cwd: "/tmp",
    prompt: "hello",
    signal: new AbortController().signal,
    onObservations: async () => {},
    ...over,
  }) as DriverRun;

/* ------------------------------------------------------------------ *
 * The paragraph.
 * ------------------------------------------------------------------ */

test("the preamble names every word that was being read wrong", () => {
  /**
   * The issue's own list, and it is the reason this feature exists: an agent
   * that reads "the browser" as this Mac's Chrome, or "session" as the CLI's
   * own history, acts confidently on the wrong thing. A word dropped from the
   * paragraph is a word nobody is told about.
   */
  for (const word of ["Telar", "browser", "telar-browser", "session", "panel", "rail", "Looks", "surface"]) {
    expect(TELAR_ORIENTATION).toContain(word);
  }
  // …and "Warp" is NOT one of them any more (#877). Pinned as an absence so a
  // re-add has to argue with this line rather than slip back into the sentence.
  // Case-folded: the feature was capitalised in prose and lower-case as a tool
  // name, and an assertion that saw only one spelling would pass on the other.
  expect(TELAR_ORIENTATION.toLowerCase()).not.toContain("warp");
  // It points at the depth rather than carrying it — see orientation.ts.
  expect(TELAR_ORIENTATION).toContain(TELAR_SKILL_NAME);
  // And it ends by saying "ask", which is the cheapest fix for the residue.
  expect(TELAR_ORIENTATION.toLowerCase()).toContain("ask");
  // A paragraph, not a page: this is paid for on every turn of every session.
  expect(TELAR_ORIENTATION.split(/\s+/).length).toBeLessThan(200);
});

/* ------------------------------------------------------------------ *
 * The three seams.
 * ------------------------------------------------------------------ */

test("OpenCode carries the preamble as an instructions file, exactly once", async () => {
  // OpenCode has no per-turn instructions parameter; `instructions` in its
  // config is the seam, and it takes FILES. Verified against the installed
  // SDK's `Config` type (`instructions?: Array<string>`).
  const file = await writeOrientationInstructions(TELAR_ORIENTATION, { TELAR_HOME: home });
  const config = JSON.parse(openCodeConfigContent(run({ orientation: TELAR_ORIENTATION }), file)) as {
    instructions?: string[];
    permission?: string;
    share?: string;
  };
  expect(config.instructions).toEqual([file]);
  expect(readFileSync(file, "utf8")).toContain(TELAR_ORIENTATION);
  // The two settings that were already there must survive the new key.
  expect(config.permission).toBe("ask");
  expect(config.share).toBe("disabled");
});

test("OpenCode's instructions file is Telar's own, never the user's opencode.json", async () => {
  const file = await writeOrientationInstructions(TELAR_ORIENTATION, { TELAR_HOME: home });
  expect(file.startsWith(engineOwnedRoot({ TELAR_HOME: home }))).toBe(true);
  expect(file).not.toContain("opencode.json");
  // Content-addressed, so two sessions with the same briefings share one file
  // rather than overwriting each other's.
  expect(await writeOrientationInstructions(TELAR_ORIENTATION, { TELAR_HOME: home })).toBe(file);
  expect(orientationInstructionsPath("something else", { TELAR_HOME: home })).not.toBe(file);
});

test("an inbound OpenCode config keeps its own instructions and gains Telar's", () => {
  const inherited = JSON.stringify({ instructions: ["/deployment/house-rules.md"], model: "anthropic/claude" });
  const config = JSON.parse(
    openCodeConfigContent(run({ env: { OPENCODE_CONFIG_CONTENT: inherited }, orientation: TELAR_ORIENTATION }), "/telar/orientation.md"),
  ) as { instructions?: string[]; model?: string };
  expect(config.instructions).toEqual(["/deployment/house-rules.md", "/telar/orientation.md"]);
  expect(config.model).toBe("anthropic/claude");
});

test("orientation off means OpenCode is handed no instructions entry at all", () => {
  expect(openCodeBriefings(run())).toEqual([]);
  const config = JSON.parse(openCodeConfigContent(run(), undefined)) as { instructions?: string[] };
  expect(config.instructions).toBeUndefined();
});

test("the orientation leads the briefings, and the per-surface ones are not gated on it", () => {
  /**
   * The toggle governs ORIENTATION, not tool contracts. A session whose
   * orientation is off still has to be told how to drive the browser it has —
   * turning off the app's voice must not break a capability.
   */
  const withBoth = openCodeBriefings(run({ orientation: TELAR_ORIENTATION, browserSocket: { url: "http://x", token: "t" } }));
  expect(withBoth[0]).toBe(TELAR_ORIENTATION);
  expect(withBoth).toContain(BROWSER_BRIEFING);
  const withoutOrientation = openCodeBriefings(run({ browserSocket: { url: "http://x", token: "t" }, run: {} as never }));
  expect(withoutOrientation).toEqual([BROWSER_BRIEFING, RUN_BRIEFING]);
  // Once, never twice — the whole set is built in one place per driver.
  expect(withBoth.filter((entry) => entry === TELAR_ORIENTATION)).toHaveLength(1);
});

/** The Claude driver's spawn options, read off a fake SDK — the same seam
 *  `driver.test.ts` uses to assert the browser briefing. */
async function claudeSystemPrompt(extra: Record<string, unknown>): Promise<{ preset?: string; append?: string } | undefined> {
  let captured: unknown;
  const driver = createClaudeDriver(
    async () => ({
      async *query(input: { options: { systemPrompt?: unknown } }) {
        captured = input.options.systemPrompt;
        yield { type: "result", subtype: "success" };
      },
    }),
    { resolveExecutable: () => "/fake/bin/claude" },
  );
  await driver.run({
    prompt: "prompt",
    sessionId: `session_${Math.random().toString(36).slice(2)}`,
    cwd: "/tmp",
    signal: new AbortController().signal,
    onObservations: async () => {},
    ...extra,
  } as DriverRun);
  return captured as { preset?: string; append?: string } | undefined;
}

test("Claude's spawn options carry the paragraph exactly once, appended to its own preset", async () => {
  const prompt = await claudeSystemPrompt({ orientation: TELAR_ORIENTATION });
  expect(prompt?.preset).toBe("claude_code");
  // APPENDED, not replacing: Telar adds a paragraph to Claude Code's own
  // system prompt rather than taking it over.
  expect(prompt?.append).toContain(TELAR_ORIENTATION);
  expect(prompt?.append?.split(TELAR_ORIENTATION)).toHaveLength(2);
  // And it leads, so the briefings under it are read in the vocabulary it
  // teaches.
  expect(prompt?.append?.startsWith(TELAR_ORIENTATION)).toBe(true);
});

test("Claude's spawn options carry no orientation when the preamble is off", async () => {
  // Nothing at all, not an empty append: with no briefings the driver omits
  // `systemPrompt` entirely and Claude Code's own preset stands untouched.
  expect(await claudeSystemPrompt({})).toBeUndefined();
  // A session with a browser still gets its tool contract — the toggle governs
  // orientation, never a capability the session actually has.
  const withBrowser = await claudeSystemPrompt({ browserSocket: { url: "http://127.0.0.1:1/mcp", token: "t" } });
  expect(withBrowser?.append).toBe(BROWSER_BRIEFING);
  expect(withBrowser?.append).not.toContain(TELAR_ORIENTATION);
});

test("Codex's thread parameters carry the paragraph the same way, on start and on resume", () => {
  /**
   * READ OFF SOURCE for this one driver. Reaching Codex's `threadParams`
   * requires a live `codex app-server` subprocess (see `codex-driver.test.ts`,
   * which runs a fake one); what is pinned here is the SHAPE — the orientation
   * spread first and gated on its own presence, joined into the one
   * `developerInstructions` that both `thread/start` and `thread/resume` send.
   */
  const codex = readFileSync(new URL("../src/codex-driver.ts", import.meta.url), "utf8");
  expect(codex).toContain("...(orientation ? [orientation] : []),");
  expect(codex).toContain("developerInstructions: briefings.join");
  // One `threadParams` object feeds both calls, which is what makes "on resume
  // too" true rather than aspirational.
  expect(codex).toContain("thread/resume");
  expect(codex).toContain("...threadParams,");
});

/* ------------------------------------------------------------------ *
 * The skill.
 * ------------------------------------------------------------------ */

/** Every tool name this engine serves on the `telar` wall, asked of the
 *  toolkits themselves rather than copied into a list here — a copied list is
 *  exactly the drift this test exists to catch. */
function telarToolNames(): string[] {
  const names: string[] = [];
  const record: ToolFactory = (name) => {
    names.push(name);
    return null;
  };
  const capability = new Proxy({}, { get: () => () => undefined }) as never;
  sessionsTools(record, capability);
  notesTools(record, capability);
  displayTools(record, capability);
  runTools(record, capability);
  return names;
}

test("the skill names every tool on the telar wall, so it cannot drift", () => {
  const missing = telarToolNames().filter((name) => !TELAR_SKILL.includes(name));
  expect(missing).toEqual([]);
  // The loop above reaches every toolkit there is. The one tool it could NOT
  // reach was `warp` — Claude-only, with no toolkit to enumerate — and #877
  // retired it, so the skill must not name it at all. Case-folded, because the
  // feature was `warp` as a tool and "Warp" in every sentence about it.
  expect(TELAR_SKILL.toLowerCase()).not.toContain("warp");
  // The browser is a separate server with its own briefing, and the skill is
  // where its tab rules are written down in full.
  expect(TELAR_SKILL).toContain("browser_list_tabs");
});

test("the skill says the things a coordinator gets wrong", () => {
  // Every one of these is a real failure mode: a session treating a peer as a
  // child, reading settling as approval, or routing a refused action through
  // another session.
  expect(TELAR_SKILL).toContain("PEERS");
  expect(TELAR_SKILL.toLowerCase()).toContain("is shelving, not acceptance");
  expect(TELAR_SKILL).toContain("CANNOT");
  expect(TELAR_SKILL.toLowerCase()).toContain("refused");
});

test("the skill's front matter is what a provider actually reads", () => {
  expect(TELAR_SKILL.startsWith("---\n")).toBe(true);
  expect(TELAR_SKILL).toContain(`name: ${TELAR_SKILL_NAME}`);
  expect(TELAR_SKILL).toContain("description: ");
  expect(TELAR_SKILL).toContain(`telar: generated v${ORIENTATION_VERSION}`);
  expect(isTelarGenerated(TELAR_SKILL)).toBe(true);
  expect(isTelarGenerated("---\nname: telar\n---\nmy own notes")).toBe(false);
});

/* ------------------------------------------------------------------ *
 * Where it is installed, and when it is rewritten.
 * ------------------------------------------------------------------ */

test("each provider's install location is that provider's own convention", () => {
  const env = { HOME: home, CLAUDE_CONFIG_DIR: join(home, "claude"), CODEX_HOME: join(home, "codex"), XDG_CONFIG_HOME: join(home, "cfg") };
  expect(providerSkillRoot("claude", env)).toBe(join(home, "claude", "skills"));
  expect(providerSkillRoot("codex", env)).toBe(join(home, "codex", "skills"));
  // OpenCode scans `{skill,skills}` under its XDG config directory.
  expect(providerSkillRoot("opencode", env)).toBe(join(home, "cfg", "opencode", "skill"));
  expect(codexHome(env)).toBe(join(home, "codex"));
  expect(openCodeHome(env)).toBe(join(home, "cfg", "opencode"));
  // `OPENCODE_CONFIG` names a FILE, so the directory is its parent.
  expect(openCodeHome({ OPENCODE_CONFIG: join(home, "elsewhere", "opencode.json") })).toBe(join(home, "elsewhere"));
  expect(providerSkillRoots(env)).toHaveLength(3);
});

test("the skill is written once and left alone until its content hash moves", async () => {
  const root = join(home, "skills");
  const file = join(root, TELAR_SKILL_NAME, "SKILL.md");

  expect((await syncTelarSkill({ install: true, roots: [root] }))[0]?.outcome).toBe("written");
  expect(readFileSync(file, "utf8")).toBe(TELAR_SKILL);

  // THE REASON THIS MATTERS: an unconditional rewrite on every engine start
  // would move the directory's mtime, which is the stamp `provider-skills.ts`
  // caches the composer's `$` menu against — every launch would invalidate
  // every session's menu for nothing.
  expect((await syncTelarSkill({ install: true, roots: [root] }))[0]?.outcome).toBe("unchanged");

  const next = `${TELAR_SKILL}\nAnd one more thing.\n`;
  expect(telarSkillDigest(next)).not.toBe(telarSkillDigest());
  expect((await syncTelarSkill({ install: true, roots: [root], text: next }))[0]?.outcome).toBe("written");
  expect(readFileSync(file, "utf8")).toBe(next);
});

test("turning the toggle off deletes the file rather than stopping its refresh", async () => {
  const root = join(home, "skills");
  const file = join(root, TELAR_SKILL_NAME, "SKILL.md");
  await syncTelarSkill({ install: true, roots: [root] });
  expect(existsSync(file)).toBe(true);

  // "Off" means nothing Telar-authored is in the agent's context. A stale
  // SKILL.md left behind would still be read.
  expect((await syncTelarSkill({ install: false, roots: [root] }))[0]?.outcome).toBe("removed");
  expect(existsSync(file)).toBe(false);
  // Idempotent: a second start with the toggle still off has nothing to do.
  expect((await syncTelarSkill({ install: false, roots: [root] }))[0]?.outcome).toBe("absent");
});

test("a telar skill somebody wrote themselves is never overwritten and never deleted", async () => {
  const root = join(home, "skills");
  const file = join(root, TELAR_SKILL_NAME, "SKILL.md");
  const mine = "---\nname: telar\ndescription: my own\n---\n\nHand-written.\n";
  mkdirSync(join(root, TELAR_SKILL_NAME), { recursive: true });
  writeFileSync(file, mine, "utf8");

  expect((await syncTelarSkill({ install: true, roots: [root] }))[0]?.outcome).toBe("foreign");
  expect(readFileSync(file, "utf8")).toBe(mine);
  expect((await syncTelarSkill({ install: false, roots: [root] }))[0]?.outcome).toBe("foreign");
  expect(readFileSync(file, "utf8")).toBe(mine);
});

test("a root that cannot be written costs its own provider, never the engine's start", async () => {
  // A provider that is not installed has no directory. The engine must start.
  const root = join(home, "not-a-directory");
  writeFileSync(root, "this is a file", "utf8");
  const [outcome] = await syncTelarSkill({ install: true, roots: [root] });
  expect(outcome?.outcome).toBe("failed");
});

/* ------------------------------------------------------------------ *
 * The route, end to end.
 * ------------------------------------------------------------------ */

test("the toggle round-trips over HTTP, and the switches move independently", async () => {
  const { client } = await engine();

  // Both on out of the box: the orientation exists because its absence was a
  // bug, not as a feature somebody opts into.
  const first = await client.orientation();
  expect(first.orientation).toEqual({ preamble: true, skill: true });
  // The words ride the answer, so "Show the text" in Settings is a read of
  // what THIS engine injects rather than a second copy kept in the cockpit.
  expect(first.text).toBe(TELAR_ORIENTATION);

  expect((await client.setOrientation({ preamble: false })).orientation).toEqual({ preamble: false, skill: true });
  // By PRESENCE: patching one must not re-decide the other.
  expect((await client.setOrientation({ skill: false })).orientation).toEqual({ preamble: false, skill: false });
  expect((await client.orientation()).orientation).toEqual({ preamble: false, skill: false });
  expect((await client.setOrientation({ preamble: true, skill: true })).orientation).toEqual({ preamble: true, skill: true });
});

test("a claim carries the paragraph when the preamble is on, and nothing when it is off", () => {
  /**
   * THE WHOLE FEATURE, AT THE SEAM THAT DECIDES IT. The drivers read
   * `claim.orientation` and inject exactly what is there; the engine is what
   * resolves the toggle into words. A claim carrying a boolean, or carrying
   * the paragraph with the toggle off, is the regression this catches.
   */
  const store = new EngineStore(join(home, "state"));
  store.registerProject({ id: "project_one", name: "One", root: home });
  store.createSession({ id: "session_one", projectId: "project_one", driver: "codex" });

  store.submitTurn("session_one", { runId: "run_one", input: "Hello" });
  expect(store.claimNextTurn("worker_one")?.orientation).toBe(TELAR_ORIENTATION);

  store.setAgentOrientation({ preamble: false });
  // The skill's switch is a different question and must not answer this one.
  expect(store.getAgentOrientation()).toEqual({ preamble: false, skill: true });
  store.createSession({ id: "session_two", projectId: "project_one", driver: "codex" });
  store.submitTurn("session_two", { runId: "run_two", input: "Hello" });
  expect(store.claimNextTurn("worker_one")?.orientation).toBeUndefined();
});

test("switching the skill off over HTTP deletes the file that was installed", async () => {
  const root = join(home, "provider-skills");
  const { client } = await engine([root]);
  const file = join(root, TELAR_SKILL_NAME, "SKILL.md");

  // WRITTEN ON START, because the toggle defaults on — and awaited here rather
  // than asserted outright: the start-time sync is deliberately not blocking
  // `startEngine`, so a slow disk must not turn engine start into a wait.
  await eventually(() => expect(existsSync(file)).toBe(true));
  await client.setOrientation({ skill: false });
  // The PATCH re-syncs BEFORE it answers: "off" has to mean the file is gone,
  // not that it stops being refreshed.
  expect(existsSync(file)).toBe(false);
  await client.setOrientation({ skill: true });
  expect(readFileSync(file, "utf8")).toBe(TELAR_SKILL);
});

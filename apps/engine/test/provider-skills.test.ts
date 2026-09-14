import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EngineClient } from "@telar/engine-client";
import { startEngine, type EngineDaemon } from "../src/daemon";
import {
  clearProviderSkillsCache,
  fallbackDescription,
  findScopedClaudeRoots,
  installedPluginRoots,
  parseFrontMatter,
  parseSupportedCommands,
  readCommandDirectory,
  readProviderSkills,
  readProviderSkillsCached,
  readSkillDirectory,
} from "../src/provider-skills";
import { stubModels } from "./stub-models";

const roots: string[] = [];
const daemons: EngineDaemon[] = [];

const temp = (prefix: string): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(directory);
  return directory;
};

const write = (file: string, text: string): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

/**
 * THE FIXTURE THE ISSUE ASKS FOR: a checkout holding two skills and one
 * command. Written as a real `.claude` directory rather than mocked, because
 * the thing under test IS the reading of that layout — a mock of `fs` would
 * assert that this module calls the functions it calls.
 */
const fixtureCheckout = (): string => {
  const checkout = temp("telar-skills-checkout-");
  write(
    path.join(checkout, ".claude", "skills", "release-notes", "SKILL.md"),
    "---\nname: release-notes\ndescription: Draft the notes for a release.\n---\n\nBody.\n",
  );
  // No front matter at all, which is how half the skills on a real machine are
  // written — the first heading has to carry the description.
  write(path.join(checkout, ".claude", "skills", "seed-data", "SKILL.md"), "# Seed the development database\n\nSteps follow.\n");
  write(path.join(checkout, ".claude", "commands", "ship.md"), "---\ndescription: Tag and publish.\n---\n\nDo the thing.\n");
  return checkout;
};

/** A `~/.claude` of its own, so no test reads the machine's. */
const fixtureHome = (): string => temp("telar-skills-home-");

afterEach(async () => {
  for (const daemon of daemons.splice(0).reverse()) await daemon.close();
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  clearProviderSkillsCache();
});

describe("reading a checkout's skills and commands", () => {
  test("two skills and one command, each labelled with where it came from", async () => {
    const checkout = fixtureCheckout();
    const answer = await readProviderSkills({
      driver: "claude",
      checkout,
      env: { CLAUDE_CONFIG_DIR: fixtureHome() },
      loadProviderCommands: async () => [],
    });
    expect(answer.skills).toEqual([
      { name: "release-notes", description: "Draft the notes for a release.", source: "project" },
      { name: "seed-data", description: "Seed the development database", source: "project" },
    ]);
    expect(answer.commands).toEqual([{ name: "ship", description: "Tag and publish.", source: "project" }]);
  });

  test("a skill installed as a symlink is an ordinary skill", async () => {
    // `~/.claude/skills/find-skills -> ../../.agents/skills/find-skills` is a
    // real entry on a real machine; `lstat` would silently drop it.
    const checkout = temp("telar-skills-link-");
    const elsewhere = temp("telar-skills-target-");
    write(path.join(elsewhere, "SKILL.md"), "---\nname: linked\ndescription: Reached through a link.\n---\n");
    fs.mkdirSync(path.join(checkout, ".claude", "skills"), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(checkout, ".claude", "skills", "linked"));
    const answer = await readProviderSkills({
      driver: "claude",
      checkout,
      env: { CLAUDE_CONFIG_DIR: fixtureHome() },
      loadProviderCommands: async () => [],
    });
    expect(answer.skills).toEqual([{ name: "linked", description: "Reached through a link.", source: "project" }]);
  });

  test("a subdirectory of commands is namespaced the way the provider addresses it", async () => {
    const root = temp("telar-skills-commands-");
    write(path.join(root, "review", "pr.md"), "---\ndescription: Review a pull request.\n---\n");
    write(path.join(root, "top.md"), "# A top-level command\n");
    expect(await readCommandDirectory(root, "user")).toEqual([
      { name: "review:pr", description: "Review a pull request.", source: "user" },
      { name: "top", description: "A top-level command", source: "user" },
    ]);
  });

  test("the project's copy shadows the machine's, and a plugin's is namespaced", async () => {
    const checkout = temp("telar-skills-shadow-");
    const home = fixtureHome();
    write(path.join(checkout, ".claude", "skills", "review", "SKILL.md"), "---\nname: review\ndescription: The project's own.\n---\n");
    write(path.join(home, "skills", "review", "SKILL.md"), "---\nname: review\ndescription: The machine's.\n---\n");
    const pluginRoot = temp("telar-skills-plugin-");
    write(path.join(pluginRoot, "skills", "deploy", "SKILL.md"), "---\nname: deploy\ndescription: Ship it.\n---\n");
    write(
      path.join(home, "plugins", "installed_plugins.json"),
      JSON.stringify({ version: 2, plugins: { "vercel@official": [{ scope: "user", installPath: pluginRoot }] } }),
    );

    const answer = await readProviderSkills({
      driver: "claude",
      checkout,
      env: { CLAUDE_CONFIG_DIR: home },
      loadProviderCommands: async () => [],
    });
    // One `review`, and it is the checkout's — the precedence Claude Code
    // itself resolves by, so the menu says what will actually run.
    expect(answer.skills.filter((skill) => skill.name === "review")).toEqual([
      { name: "review", description: "The project's own.", source: "project" },
    ]);
    expect(answer.skills).toContainEqual({ name: "vercel:deploy", description: "Ship it.", source: "plugin" });
  });

  test("the provider's own list fills in what no file explained, and never doubles a skill", async () => {
    const checkout = fixtureCheckout();
    const answer = await readProviderSkills({
      driver: "claude",
      checkout,
      env: { CLAUDE_CONFIG_DIR: fixtureHome() },
      // Claude reports skills through `supportedCommands()` too; `release-notes`
      // is already a skill and must not appear again under commands.
      loadProviderCommands: async () => [
        { name: "release-notes", description: "duplicate", source: "provider" },
        { name: "clear", description: "Clear the conversation.", source: "provider" },
      ],
    });
    expect(answer.commands).toEqual([
      { name: "ship", description: "Tag and publish.", source: "project" },
      { name: "clear", description: "Clear the conversation.", source: "provider" },
    ]);
  });

  test("a provider with no inventory answers with two empty lists rather than a guess", async () => {
    for (const driver of ["codex", "opencode"] as const) {
      expect(
        await readProviderSkills({ driver, checkout: fixtureCheckout(), env: { CLAUDE_CONFIG_DIR: fixtureHome() } }),
      ).toEqual({ skills: [], commands: [] });
    }
  });
});

describe("the pieces that parse a file", () => {
  test("front matter yields the two scalars it is read for, and nothing else", () => {
    expect(parseFrontMatter('---\nname: a\ndescription: "Quoted words."\nallowed-tools: Read\n---\nbody')).toEqual({
      name: "a",
      description: "Quoted words.",
      "allowed-tools": "Read",
    });
    expect(parseFrontMatter("# no front matter\n")).toEqual({});
  });

  test("a file with no description falls back to its first heading, then its first sentence", () => {
    expect(fallbackDescription("---\nname: a\n---\n\n# The heading\n\nbody")).toBe("The heading");
    expect(fallbackDescription("Just a sentence.\n\n# A later heading")).toBe("Just a sentence.");
    expect(fallbackDescription("```\ncode\n```\n")).toBe("");
  });

  test("the provider's rows are narrowed, and a row with no name is dropped", () => {
    expect(
      parseSupportedCommands([
        { name: "/compact", description: "Squeeze the context.", argumentHint: "" },
        { name: "model", description: "Choose a model", argumentHint: "<name>" },
        { name: "", description: "nameless" },
        "not a row",
      ]),
    ).toEqual([
      { name: "compact", description: "Squeeze the context.", source: "provider" },
      { name: "model", description: "Choose a model <name>", source: "provider" },
    ]);
    expect(parseSupportedCommands(undefined)).toEqual([]);
  });

  test("only installed plugins are read, and a missing or broken manifest is empty", async () => {
    const home = fixtureHome();
    expect(await installedPluginRoots(home)).toEqual([]);
    write(path.join(home, "plugins", "installed_plugins.json"), "{ not json");
    expect(await installedPluginRoots(home)).toEqual([]);
    write(
      path.join(home, "plugins", "installed_plugins.json"),
      JSON.stringify({ plugins: { "a@m": [{ installPath: "/tmp/a" }], "b@m": [{}] } }),
    );
    expect(await installedPluginRoots(home)).toEqual([{ plugin: "a", root: "/tmp/a" }]);
  });

  test("an absent skills directory is an empty answer, not a throw", async () => {
    expect(await readSkillDirectory(path.join(temp("telar-skills-none-"), "nope"), "user")).toEqual([]);
  });
});

describe("the cache in front of the read", () => {
  test("a second read is served from memory, and a new skill invalidates it", async () => {
    const checkout = fixtureCheckout();
    const home = fixtureHome();
    let asked = 0;
    const input = {
      cacheKey: "session_cache",
      driver: "claude" as const,
      checkout,
      env: { CLAUDE_CONFIG_DIR: home },
      loadProviderCommands: async () => {
        asked += 1;
        return [];
      },
    };

    expect((await readProviderSkillsCached(input)).skills).toHaveLength(2);
    expect((await readProviderSkillsCached(input)).skills).toHaveLength(2);
    expect(asked).toBe(1);

    // Adding a skill moves `skills/`'s own mtime, which is exactly the change
    // the stamp exists to notice.
    write(path.join(checkout, ".claude", "skills", "third", "SKILL.md"), "---\nname: third\ndescription: New.\n---\n");
    expect((await readProviderSkillsCached(input)).skills).toHaveLength(3);
    expect(asked).toBe(2);
  });

  test("an in-place edit is picked up by the clock, which the directory mtime cannot see", async () => {
    const checkout = fixtureCheckout();
    const input = {
      cacheKey: "session_clock",
      driver: "claude" as const,
      checkout,
      env: { CLAUDE_CONFIG_DIR: fixtureHome() },
      loadProviderCommands: async () => [],
    };
    let clock = 1_000;
    expect((await readProviderSkillsCached({ ...input, now: () => clock })).skills[0]?.description).toBe("Draft the notes for a release.");
    write(
      path.join(checkout, ".claude", "skills", "release-notes", "SKILL.md"),
      "---\nname: release-notes\ndescription: Reworded.\n---\n",
    );
    // Still the cached answer inside the window…
    expect((await readProviderSkillsCached({ ...input, now: () => clock + 1_000 })).skills[0]?.description).toBe("Draft the notes for a release.");
    clock += 61_000;
    expect((await readProviderSkillsCached({ ...input, now: () => clock })).skills[0]?.description).toBe("Reworded.");
  });
});

describe("GET /v2/sessions/:id/skills", () => {
  test("the route answers a session with its own checkout's inventory", async () => {
    const checkout = fixtureCheckout();
    const home = fixtureHome();
    const engineRoot = temp("telar-skills-engine-");
    fs.writeFileSync(path.join(engineRoot, "claude-default-model.json"), JSON.stringify({ model: "claude-opus-5[1m]", at: 1 }));
    const daemon = await startEngine({ models: stubModels,
      engineRoot,
      providerSkills: {
        env: { CLAUDE_CONFIG_DIR: home },
        loadProviderCommands: async () => [{ name: "compact", description: "Squeeze the context.", source: "provider" }],
      },
    });
    daemons.push(daemon);
    const client = new EngineClient(daemon.discovery);
    await client.registerProject({ id: "project_skills", name: "Skills", root: checkout });
    // `local` so the session's checkout IS the fixture — a worktree would be a
    // fresh clone with no `.claude` in it, which is a different test.
    const session = await client.createSession({ id: "session_skills", projectId: "project_skills", envMode: "local" });

    const answer = await client.sessionSkills(session.session.id);
    expect(answer.skills.map((skill) => skill.name)).toEqual(["release-notes", "seed-data"]);
    expect(answer.commands).toEqual([
      { name: "ship", description: "Tag and publish.", source: "project" },
      { name: "compact", description: "Squeeze the context.", source: "provider" },
    ]);
  });

  test("an unknown session is a 404 rather than an empty inventory", async () => {
    const engineRoot = temp("telar-skills-engine-404-");
    const daemon = await startEngine({ models: stubModels, engineRoot, providerSkills: { env: { CLAUDE_CONFIG_DIR: fixtureHome() }, loadProviderCommands: async () => [] } });
    daemons.push(daemon);
    const response = await fetch(`http://127.0.0.1:${daemon.discovery.port}/v2/sessions/session_missing/skills`, {
      headers: { authorization: `Bearer ${daemon.discovery.token}` },
    });
    expect(response.status).toBe(404);
  });
});

/* ------------------------------------------------------------------ *
 * #500 — the directory-scoped skills, and the canvas that has no session.
 * ------------------------------------------------------------------ */

/**
 * THE THREE PLACES A SKILL CAN BE, in one checkout: the project root, a
 * subdirectory that scopes its own, and the machine.
 *
 * The middle one is what #500 is about. It is written as a real nested
 * `.claude` rather than mocked for the same reason the fixture above is: the
 * thing under test IS whether the walk reaches that directory.
 */
const fixtureThreePlaces = (): { checkout: string; home: string } => {
  const checkout = temp("telar-skills-scoped-");
  const home = fixtureHome();
  write(path.join(checkout, ".claude", "skills", "root-skill", "SKILL.md"), "---\nname: root-skill\ndescription: At the project root.\n---\n");
  write(
    path.join(checkout, "apps", "web", ".claude", "skills", "nested-skill", "SKILL.md"),
    "---\nname: nested-skill\ndescription: Scoped to apps/web.\n---\n",
  );
  write(path.join(home, "skills", "global-skill", "SKILL.md"), "---\nname: global-skill\ndescription: This machine's own.\n---\n");
  return { checkout, home };
};

describe("directory-scoped skills (#500)", () => {
  test("a root skill, a nested directory skill and a global one all appear", async () => {
    const { checkout, home } = fixtureThreePlaces();
    const answer = await readProviderSkills({
      driver: "claude",
      checkout,
      env: { CLAUDE_CONFIG_DIR: home },
      // Empty ON PURPOSE: the CLI cannot supply the nested row. Asked in a
      // checkout root it does not list a directory-scoped skill at all — only
      // a cwd inside `apps/web` produces it — so the walk is the only route.
      loadProviderCommands: async () => [],
    });
    expect(answer.skills).toEqual([
      { name: "root-skill", description: "At the project root.", source: "project" },
      // NAMESPACED BY ITS DIRECTORY, which is how Claude Code addresses one.
      { name: "apps/web:nested-skill", description: "Scoped to apps/web.", source: "project" },
      { name: "global-skill", description: "This machine's own.", source: "user" },
    ]);
  });

  test("a scoped `commands/` is namespaced the same way", async () => {
    const { checkout, home } = fixtureThreePlaces();
    write(path.join(checkout, "apps", "web", ".claude", "commands", "deploy.md"), "---\ndescription: Ship the site.\n---\n");
    const answer = await readProviderSkills({ driver: "claude", checkout, env: { CLAUDE_CONFIG_DIR: home }, loadProviderCommands: async () => [] });
    expect(answer.commands).toEqual([{ name: "apps/web:deploy", description: "Ship the site.", source: "project" }]);
  });

  test("node_modules is never walked, however deep its own `.claude` is", async () => {
    const { checkout, home } = fixtureThreePlaces();
    write(
      path.join(checkout, "node_modules", "some-package", ".claude", "skills", "theirs", "SKILL.md"),
      "---\nname: theirs\ndescription: A dependency's.\n---\n",
    );
    const answer = await readProviderSkills({ driver: "claude", checkout, env: { CLAUDE_CONFIG_DIR: home }, loadProviderCommands: async () => [] });
    expect(answer.skills.map((skill) => skill.name)).not.toContain("node_modules/some-package:theirs");
  });

  test("the walk stops before it is a walk of the whole repository", async () => {
    const checkout = temp("telar-skills-depth-");
    write(path.join(checkout, "a", "b", ".claude", "skills", "near", "SKILL.md"), "---\nname: near\ndescription: Within reach.\n---\n");
    write(path.join(checkout, "a", "b", "c", "d", "e", ".claude", "skills", "far", "SKILL.md"), "---\nname: far\ndescription: Too deep.\n---\n");
    expect((await findScopedClaudeRoots(checkout)).map((entry) => entry.scope)).toEqual(["a/b"]);
  });

  test("the cache notices a skill added to a scoped directory it already found", async () => {
    const { checkout, home } = fixtureThreePlaces();
    const input = {
      cacheKey: "scoped_cache",
      driver: "claude" as const,
      checkout,
      env: { CLAUDE_CONFIG_DIR: home },
      loadProviderCommands: async () => [],
    };
    expect((await readProviderSkillsCached(input)).skills).toHaveLength(3);
    // Served from memory — the stamp is over the same directories, which is the
    // thing that broke when the stamp was taken before the roots were known.
    expect((await readProviderSkillsCached(input)).skills).toHaveLength(3);
    write(
      path.join(checkout, "apps", "web", ".claude", "skills", "another", "SKILL.md"),
      "---\nname: another\ndescription: Added later.\n---\n",
    );
    expect((await readProviderSkillsCached(input)).skills).toHaveLength(4);
  });
});

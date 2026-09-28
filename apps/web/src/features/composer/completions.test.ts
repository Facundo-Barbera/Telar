// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import {
  availableCommands,
  buildPathIndex,
  compactBlockedReason,
  isCompactDraft,
  isResumeDraft,
  ORCHESTRATE_PROMPT,
  ORCHESTRATE_SKILL,
  PROVIDER_COMMAND_GROUP,
  providerCommandCompletions,
  rankCommands,
  rankPaths,
  rankSkills,
} from "./completions";
import { directoryReference, fileReference, skillReference } from "./drag-reference";

const FILES = [
  "README.md",
  "apps/engine/src/driver.ts",
  "apps/engine/src/store.ts",
  "apps/web/src/components/composer.tsx",
  "apps/web/src/lib/drag-reference.ts",
  "packages/core/src/ultra/runner.ts",
];

describe("the index the at-sign menu ranks", () => {
  const index = buildPathIndex(FILES);

  test("a directory exists exactly when something inside it does", () => {
    // The engine sends files only.
    const directories = index.filter((entry) => entry.directory).map((entry) => entry.path);
    expect(directories).toContain("apps/");
    expect(directories).toContain("apps/engine/src/");
    expect(directories).not.toContain("apps/engine/src/driver.ts/");
  });

  test("every file in the listing is present, once", () => {
    const files = index.filter((entry) => !entry.directory).map((entry) => entry.path);
    expect(files.sort()).toEqual([...FILES].sort());
  });

  test("a rootless file has no parent rather than a fabricated one", () => {
    expect(index.find((entry) => entry.path === "README.md")).toMatchObject({ name: "README.md", parent: "", directory: false });
  });
});

describe("ranking paths", () => {
  const index = buildPathIndex(FILES);

  test("the basename is what people type, and it outranks a deep path match", () => {
    expect(rankPaths(index, "driver")[0]?.path).toBe("apps/engine/src/driver.ts");
  });

  test("a path fragment disambiguates two files that share a name", () => {
    const both = buildPathIndex(["apps/a/util.ts", "apps/b/util.ts"]);
    expect(rankPaths(both, "b/util")[0]?.path).toBe("apps/b/util.ts");
  });

  test("nothing typed yet shows the top of the repository, not an arbitrary slice", () => {
    const first = rankPaths(index, "", 3).map((completion) => completion.path);
    expect(first[0]).toBe("apps/");
    expect(first).toContain("README.md");
  });

  test("an accepted path inserts EXACTLY what dragging the same row would", () => {
    const file = rankPaths(index, "drag-reference")[0];
    expect(file?.action).toEqual({ type: "insert", text: fileReference("apps/web/src/lib/drag-reference.ts").text });
    const folder = rankPaths(index, "ultra").find((completion) => completion.glyph === "directory");
    expect(folder?.action).toEqual({ type: "insert", text: directoryReference("packages/core/src/ultra/").text });
  });

  test("the limit is honoured, and the results stay in score order", () => {
    const ranked = rankPaths(index, "s", 3);
    expect(ranked).toHaveLength(3);
  });

  test("a query that matches nothing returns nothing rather than everything", () => {
    expect(rankPaths(index, "zzzzzzz")).toEqual([]);
  });
});

describe("what the slash menu offers", () => {
  test("stopping is offered only while something is running", () => {
    expect(availableCommands({ busy: false, fresh: false }).map((command) => command.id)).not.toContain("stop");
    expect(availableCommands({ busy: true, fresh: false }).map((command) => command.id)).toContain("stop");
  });

  test("the create-time choices are offered only before the session exists", () => {
    const running = availableCommands({ busy: false, fresh: false }).map((command) => command.id);
    expect(running).not.toContain("env:worktree");
    expect(running).not.toContain("driver:codex");
    const fresh = availableCommands({ busy: false, fresh: true }).map((command) => command.id);
    expect(fresh).toContain("env:worktree");
    expect(fresh).toContain("driver:codex");
  });

  test("the mode already in effect is still listed, and says so", () => {
    const commands = availableCommands({ busy: false, fresh: false, runtimeMode: "full-access" });
    const current = commands.find((command) => command.id === "access:full-access");
    expect(current?.detail).toContain("(current)");
    expect(commands.filter((command) => command.glyph === "access")).toHaveLength(4);
  });

  test("models and efforts appear only when the caller knows any", () => {
    expect(availableCommands({ busy: false, fresh: false }).some((command) => command.glyph === "model")).toBe(false);
    const withModels = availableCommands({
      busy: false,
      fresh: false,
      models: [{ id: "opus[1m]", label: "Opus 5" }],
      efforts: ["low", "high"],
    });
    expect(withModels.find((command) => command.glyph === "model")).toMatchObject({ label: "/model Opus 5", action: { type: "model", model: "opus[1m]" } });
    expect(withModels.filter((command) => command.glyph === "effort").map((command) => command.label)).toEqual(["/effort low", "/effort high"]);
  });
});

describe("/compact, the wheel's button reached from the keyboard", () => {
  const claude = { busy: false, fresh: false, driver: "claude" as const };

  test("it is offered on a Claude session that exists, and nowhere else", () => {
    expect(availableCommands(claude).map((command) => command.id)).toContain("compact");
    expect(availableCommands({ ...claude, driver: "codex" }).map((command) => command.id)).not.toContain("compact");
    expect(availableCommands({ ...claude, fresh: true }).map((command) => command.id)).not.toContain("compact");
    expect(availableCommands({ busy: false, fresh: false }).map((command) => command.id)).not.toContain("compact");
  });

  test("picking it submits the same gesture the wheel does", () => {
    expect(availableCommands(claude).find((command) => command.id === "compact")).toMatchObject({
      label: "/compact",
      action: { type: "compact" },
      glyph: "compact",
    });
  });

  test("a running turn or a compaction in flight disables it, with the wheel's own reason", () => {
    const running = availableCommands({ ...claude, busy: true }).find((command) => command.id === "compact");
    expect(running).toMatchObject({ disabled: true, detail: "A turn is running." });
    const already = availableCommands({ ...claude, compacting: true }).find((command) => command.id === "compact");
    expect(already).toMatchObject({ disabled: true, detail: "Already compacting." });
    expect(compactBlockedReason({ busy: true, compacting: true })).toBe("Already compacting.");
    expect(compactBlockedReason({ busy: false })).toBeUndefined();
  });

  test("an available row says what it would do rather than why it cannot", () => {
    const offered = availableCommands(claude).find((command) => command.id === "compact");
    expect(offered?.disabled).toBeUndefined();
    expect(offered?.detail).toBe("Summarise the conversation to free space.");
  });

  test("the draft that IS the gesture is exactly `/compact`, trimmed", () => {
    expect(isCompactDraft("/compact")).toBe(true);
    expect(isCompactDraft("  /compact\n")).toBe(true);
    expect(isCompactDraft("/compact the API work")).toBe(false);
    expect(isCompactDraft("please run /compact")).toBe(false);
  });
});

describe("/orchestrate, Telar Orchestrate from the keyboard", () => {
  test("offered only where the skill it names is installed", () => {
    expect(availableCommands({ busy: false, fresh: false }).map((command) => command.id)).not.toContain("orchestrate");
    const row = availableCommands({ busy: false, fresh: false, orchestrate: true }).find((command) => command.id === "orchestrate");
    expect(row?.label).toBe("/orchestrate");
    expect(rankCommands(availableCommands({ busy: false, fresh: true, orchestrate: true }), "orch")[0]?.id).toBe("orchestrate");
  });

  test("it inserts the skill named in prose, which every provider acts on", () => {
    const row = availableCommands({ busy: false, fresh: false, orchestrate: true }).find((command) => command.id === "orchestrate");
    expect(row?.action).toEqual({ type: "insert", text: ORCHESTRATE_PROMPT });
    expect(ORCHESTRATE_PROMPT).toContain(skillReference({ name: ORCHESTRATE_SKILL }).text);
    expect(ORCHESTRATE_PROMPT.startsWith("/")).toBe(false);
  });
});

describe("/resume, the empty composer's own link reached from the keyboard", () => {
  const freshResumable = { busy: false, fresh: true, canResume: true };

  test("it is offered only where the link itself would show", () => {
    expect(availableCommands(freshResumable).map((command) => command.id)).toContain("resume");
    expect(availableCommands({ ...freshResumable, fresh: false }).map((command) => command.id)).not.toContain("resume");
    expect(availableCommands({ ...freshResumable, canResume: false }).map((command) => command.id)).not.toContain("resume");
    expect(availableCommands({ busy: false, fresh: true }).map((command) => command.id)).not.toContain("resume");
  });

  test("picking it matches the link's own row", () => {
    expect(availableCommands(freshResumable).find((command) => command.id === "resume")).toMatchObject({
      label: "/resume",
      action: { type: "resume" },
      glyph: "resume",
    });
  });

  test("the draft that IS the gesture is exactly `/resume`, trimmed", () => {
    expect(isResumeDraft("/resume")).toBe(true);
    expect(isResumeDraft("  /resume\n")).toBe(true);
    expect(isResumeDraft("/resume something")).toBe(false);
    expect(isResumeDraft("please /resume")).toBe(false);
  });
});

describe("ranking commands", () => {
  const commands = availableCommands({ busy: true, fresh: true, runtimeMode: "auto" });

  test("a prefix of the name wins", () => {
    expect(rankCommands(commands, "ful")[0]?.label).toBe("/full-access");
    expect(rankCommands(commands, "sto")[0]?.label).toBe("/stop");
  });

  test("initials reach a hyphenated command, which a prefix cannot", () => {
    expect(rankCommands(commands, "fa")[0]?.label).toBe("/full-access");
  });

  test("the fuzzy tier is loose, and that is a trade rather than a bug", () => {
    // `ae` is also a subsequence of `claude`, so initials reach a command but don't reliably select it.
    expect(rankCommands(commands, "ae").map((command) => command.label)).toContain("/auto-edits");
  });

  test("a genuine prefix still beats a fuzzy hit on a shorter name", () => {
    // Fuzzy tier starts at 100, prefix at 2.
    expect(rankCommands(commands, "auto")[0]?.label).toBe("/auto");
  });

  test("a leading slash in the query is not searched for", () => {
    expect(rankCommands(commands, "/stop")[0]?.label).toBe("/stop");
  });

  test("nothing typed lists everything, in the order the menu declared them", () => {
    expect(rankCommands(commands, "")).toEqual([...commands]);
  });

  test("a query whose letters are not all there, in order, returns nothing", () => {
    expect(rankCommands(commands, "qqq")).toEqual([]);
  });

  test("the description is searchable, but ranks below the name", () => {
    const byDescription = rankCommands(commands, "prompts");
    expect(byDescription[0]?.label).toBe("/full-access");
  });
});

describe("the skills the dollar menu offers", () => {
  const SKILLS = [
    { name: "commit-messages", description: "Write a conventional commit.", source: "user" as const },
    { name: "release-notes", description: "Draft the notes for a release.", source: "project" as const },
    { name: "vercel:deploy", description: "Ship to production.", source: "plugin" as const },
  ];

  test("picking one inserts EXACTLY what the chip is read back from", () => {
    expect(rankSkills(SKILLS, "commit")[0]).toMatchObject({
      label: "commit-messages",
      action: { type: "insert", text: skillReference({ name: "commit-messages" }).text },
    });
  });

  test("nothing typed lists them in the order the engine ranked them", () => {
    expect(rankSkills(SKILLS, "").map((completion) => completion.label)).toEqual(["commit-messages", "release-notes", "vercel:deploy"]);
  });

  test("a prefix wins, and a namespace is a boundary initials can reach", () => {
    expect(rankSkills(SKILLS, "rel")[0]?.label).toBe("release-notes");
    expect(rankSkills(SKILLS, "vd")[0]?.label).toBe("vercel:deploy");
    expect(rankSkills(SKILLS, "deploy")[0]?.label).toBe("vercel:deploy");
  });

  test("the description is searchable but cannot outrank a name", () => {
    expect(rankSkills(SKILLS, "conventional")[0]?.label).toBe("commit-messages");
    expect(rankSkills(SKILLS, "release")[0]?.label).toBe("release-notes");
  });

  test("a leading dollar in the query is not searched for", () => {
    expect(rankSkills(SKILLS, "$rel")[0]?.label).toBe("release-notes");
  });

  test("a query whose letters are not all there returns nothing, and so does an empty inventory", () => {
    expect(rankSkills(SKILLS, "qqqq")).toEqual([]);
    expect(rankSkills([], "anything")).toEqual([]);
  });

  test("a row with no description says where it came from rather than nothing", () => {
    expect(rankSkills([{ name: "bare", description: "", source: "plugin" }], "")[0]?.detail).toBe("Plugin");
  });
});

describe("the provider's own slash commands", () => {
  const COMMANDS = [
    { name: "ship", description: "Tag and publish.", source: "project" as const },
    { name: "commit-commands:clean_gone", description: "Prune dead branches.", source: "plugin" as const },
  ];

  test("picking one inserts `/name`, because the HARNESS parses it rather than this box", () => {
    expect(providerCommandCompletions(COMMANDS)[0]).toMatchObject({
      label: "/ship",
      action: { type: "insert", text: "/ship" },
      group: PROVIDER_COMMAND_GROUP,
    });
  });

  test("every provider row carries the group, so the menu can head them as one section", () => {
    expect(providerCommandCompletions(COMMANDS).every((row) => row.group === PROVIDER_COMMAND_GROUP)).toBe(true);
    expect(availableCommands({ busy: true, fresh: false }).some((row) => row.group !== undefined)).toBe(false);
  });

  test("they rank by the same rules the verbs do, with the slash stripped from both sides", () => {
    const rows = providerCommandCompletions(COMMANDS);
    expect(rankCommands(rows, "ship")[0]?.label).toBe("/ship");
    expect(rankCommands(rows, "/ship")[0]?.label).toBe("/ship");
    expect(rankCommands(rows, "clean")[0]?.label).toBe("/commit-commands:clean_gone");
    expect(rankCommands(rows, "qqqq")).toEqual([]);
  });
});

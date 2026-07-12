import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentOpts } from "../src/engine";
import type { BuildPiece } from "../src/build-fanout";
import type { LensSpec } from "../src/panel";
import type { CriticContext, CriticRunOpts } from "../src/critic";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-roster-home-"));
process.env.TELAR_HOME = home;
beforeEach(() => {
  process.env.TELAR_HOME = home;
});
afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const { Roster } = await import("../src/schemas");
const { loadRoster } = await import("../src/dispatcher");
const { executeLoom } = await import("../src/executor");
const { createLoom } = await import("../src/looms");
const { createProject, getProject } = await import("../src/manifest");
const { runCritic } = await import("../src/critic");
const { VERIFIER_TOOLS } = await import("../src/verifier");

let seq = 0;
function makeGitProject(): { name: string; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-roster-proj-"));
  execFileSync("git", ["init"], { cwd: root });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Telar Test"], { cwd: root });
  fs.writeFileSync(path.join(root, "a.txt"), "original a\n");
  fs.writeFileSync(path.join(root, "b.txt"), "original b\n");
  execFileSync("git", ["add", "a.txt", "b.txt"], { cwd: root });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: root });
  const name = `roster-${seq++}`;
  createProject(root, { name });
  return { name, root };
}

const fileFromPrompt = (prompt: string): string => {
  const m = prompt.match(/modify files under: (.+?)\. Do not touch/);
  return m ? m[1]!.split(",")[0]!.trim() : "unknown.txt";
};

describe("Roster schema + loadRoster (defaults, narrow surface)", () => {
  test("empty roster parses to {} and loadRoster with no file degrades to {}", () => {
    expect(Roster.parse({})).toEqual({});
    expect(loadRoster()).toEqual({}); // no ~/.telar/roster.json present
  });

  test("a valid preset round-trips its narrow fields", () => {
    const parsed = Roster.parse({
      specialist: {
        description: "a careful refactorer",
        model: "opus",
        promptPrelude: "Be surgical.",
        tools: ["Read", "Write", "Edit"],
        disallowedTools: ["Bash"],
      },
    });
    expect(parsed.specialist.model).toBe("opus");
    expect(parsed.specialist.tools).toEqual(["Read", "Write", "Edit"]);
  });

  test("the schema OMITS restrictTools/settingSources/extraMcpServers — config can never widen or disable a capability wall", () => {
    const parsed = Roster.parse({
      hostile: {
        description: "tries to smuggle escalation config",
        restrictTools: false, // would turn the wall OFF
        settingSources: ["user", "project"], // would re-enable repo hooks
        extraMcpServers: { evil: { type: "stdio", command: "x" } }, // would add a server
        tools: ["Bash"],
      } as any,
    });
    // Unknown keys are stripped by the schema — none of the escalation levers survive.
    expect("restrictTools" in parsed.hostile).toBe(false);
    expect("settingSources" in parsed.hostile).toBe(false);
    expect("extraMcpServers" in parsed.hostile).toBe(false);
  });
});

describe("Roster applied in makePieceBuilder (end-to-end via executeLoom, fake builders)", () => {
  test("a named preset's model/tools/disallowedTools/promptPrelude override the piece defaults; an unnamed piece is byte-identical", async () => {
    const { name, root } = makeGitProject();
    const manifest = getProject(name).manifest;
    const loom = createLoom({ project: name, kind: "custom", title: "t", prompt: "x", account: manifest.account });

    const pieces: BuildPiece[] = [
      { id: "s1", title: "Aye", prompt: "do A", allowedPaths: ["a.txt"], agent: "specialist" },
      { id: "s2", title: "Bee", prompt: "do B", allowedPaths: ["b.txt"] }, // unnamed → defaults
    ];
    const roster = {
      specialist: {
        description: "d",
        model: "opus-custom",
        promptPrelude: "PRELUDE-XYZ",
        tools: ["Read", "Write"],
        disallowedTools: ["Bash", "Edit"],
      },
    };

    const calls: Array<{ prompt: string; opts: AgentOpts<any> }> = [];
    await executeLoom(loom, manifest, {
      buildFanout: { pieces, baseRef: "HEAD" },
      roster,
      run: (async (prompt: string, o: any) => {
        calls.push({ prompt, opts: o });
        const f = fileFromPrompt(prompt);
        fs.writeFileSync(path.join(o.cwd, f), `built ${f}\n`);
        return { ok: true, summary: `wrote ${f}`, files_touched: [f], blocker: null };
      }) as any,
      onEvent: () => {},
      onState: () => {},
    });

    const specialist = calls.find((c) => c.prompt.includes("# Aye"))!;
    const plain = calls.find((c) => c.prompt.includes("# Bee"))!;
    expect(specialist).toBeDefined();
    expect(plain).toBeDefined();

    // Preset OVERRIDES on the named piece.
    expect(specialist.opts.model).toBe("opus-custom");
    expect(specialist.opts.tools).toEqual(["Read", "Write"]);
    expect(specialist.opts.disallowedTools).toEqual(["Bash", "Edit"]);
    expect(specialist.prompt).toContain("PRELUDE-XYZ");

    // Unnamed piece keeps the byte-identical defaults (policy.dev model, BASE_TOOLS).
    expect(plain.opts.model).toBe("sonnet"); // policy.dev default
    expect(plain.opts.tools).toEqual(["Read", "Grep", "Glob", "Write", "Edit", "Bash"]);
    expect(plain.prompt).not.toContain("PRELUDE-XYZ");
  });
});

describe("MOAT — the roster surface can NEVER reach the read-only Verifier/Critic", () => {
  test("VERIFIER_TOOLS grants no write/spawn capability", () => {
    expect(VERIFIER_TOOLS).not.toContain("Write");
    expect(VERIFIER_TOOLS).not.toContain("Edit");
    expect(VERIFIER_TOOLS).not.toContain("Bash");
    expect(VERIFIER_TOOLS).not.toContain("Agent");
  });

  test("with a hostile roster loaded, the Critic's AgentOpts are the hard-coded read-only constants (roster never consulted)", async () => {
    // Persist a hostile roster to ~/.telar/roster.json and confirm it loads —
    // then prove the critic path is entirely unaffected by it.
    fs.writeFileSync(
      path.join(home, "roster.json"),
      JSON.stringify({ attacker: { description: "grant me everything", tools: ["Bash", "Write", "Agent"] } }),
    );
    expect(loadRoster().attacker.tools).toEqual(["Bash", "Write", "Agent"]); // it IS loaded...

    const evidenceDir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-roster-critic-"));
    const ctx: CriticContext = {
      featureName: "f",
      url: "http://localhost:3000",
      objective: "o",
      assertions: [
        { id: "a1", description: "d", type: "live-critic", observable: "x", blocker: true },
      ],
    };
    const lens: LensSpec = { class: "intent", lens: "intent/acceptance", blocker: true };

    let captured: AgentOpts<any> | null = null;
    const run = (async (_task: string, opts: AgentOpts<any>) => {
      captured = opts;
      return { lens: "x", class: "intent", blocker: false, ok: true, summary: "s", findings: [], evidence: [] };
    }) as any;

    const runOpts: CriticRunOpts = { evidenceDir, run };
    await runCritic(lens, ctx, runOpts);

    expect(captured).not.toBeNull();
    // ...yet the critic's wall is unchanged — hard-coded, never roster-derived.
    expect(captured!.tools).toEqual(VERIFIER_TOOLS);
    expect(captured!.restrictTools).toBe(true);
    expect(captured!.disallowedTools).toEqual(["Write", "Edit", "MultiEdit", "Bash", "NotebookEdit", "Agent"]);
    expect(captured!.settingSources).toEqual([]);

    fs.rmSync(evidenceDir, { recursive: true, force: true });
    fs.rmSync(path.join(home, "roster.json"), { force: true });
  });
});

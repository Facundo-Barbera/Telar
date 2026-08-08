// The four SessionProfileSpec builders, pinned against the story's own table.
//
// WHY THIS FILE EXISTS AT ALL, given packages/core already tests the fold: the
// core suite drives the resolver with SYNTHETIC specs, because core cannot
// import apps/web. So nothing in core would notice if a builder here named a
// capability that does not exist, or dropped one that does. This is the only
// place a wrong capability NAME gets caught by the gate rather than by a manual
// curl against a dev server — and, since story 2.2, the only place that can see
// BOTH copies of the tool vocabulary at once (core declares its own
// LOOM_AUTO_TOOL_NAMES / ULTRA_AUTO_TOOL_NAMES because it cannot import
// @/lib/loom-mcp; the anti-drift block below is what makes that duplication
// safe rather than merely tidy).
//
// AND THE SIDE EFFECT, which is the other half. The builders register at MODULE
// SCOPE, and app/api/chat/route.ts depends on a bare `import
// "@/lib/session-profiles";` to trigger that. Without it the registry is empty
// at request time and every chat request 500s — and no other gate would catch
// it, because there is no test file for that route anywhere in the tree.
// KINDS_AFTER_IMPORT below captures the registry the instant this module's
// import ran, so no later reset can make that assertion lie.
//
// EVERY EXPECTATION IS RE-DERIVED FROM A SOURCE CONSTANT, never restated. That
// is not style: `allow: []` shipped in story 2.1 as a restated copy of a
// measurement that was false, in a field nothing consumed, defended by a
// confident in-source comment. It survived authoring, review and a commit. A
// copy of a measurement goes stale in silence; a derivation indicts its source.
//
// NO LIVE LOOM READ RUNS IN THIS PROCESS, deliberately. buildSteererContext and
// buildEscalationContext reach core's getLoom, whose ensureMigrated() can
// RENAME directories under the resolved state root — and outside a sandboxed
// child, that root is the operator's real ~/.telar. The rows below therefore
// drive the builders with `loomId: undefined` (the no-live-read arm), the
// composition itself is covered hermetically with injected readers in
// session-prompts.test.ts, and the one assertion that genuinely needs the live
// arm spawns a CHILD with HOME and TELAR_HOME pointed at throwaway
// directories. Never mutate process.env.TELAR_HOME in the shared test process.
// @ts-expect-error no @types/bun in this workspace
import { beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BASE_ALLOWED_TOOLS,
  BROWSER_READ_TOOL_NAMES,
  LOOM_AUTO_TOOL_NAMES,
  NATIVE_CLAUDE_SETTING_SOURCES,
  ProjectManifest,
  registeredAnchorKinds,
  registeredSessionKinds,
  resetSessionProfiles,
  resolveSessionProfile,
  ULTRA_AUTO_TOOL_NAMES,
  WORKSPACE_AUTO_TOOL_NAMES,
  unmetCapabilities,
  workspaceHomeDir,
  workspaceStorePaths,
  type SessionKind,
  type SessionProfileBuilder,
  type SessionResolutionContext,
} from "@telar/core";
import { BROWSER_READ_TOOLS, browserTools } from "./browser-mcp";
import {
  LOOM_ANSWER_BLOCKED_TOOL,
  LOOM_AUTO_TOOLS,
  LOOM_ESCALATION_DISALLOWED_TOOLS,
  LOOM_ESCALATION_READONLY_TOOLS,
  LOOM_START_TOOL,
} from "./loom-mcp";
import { ULTRA_AUTO_TOOLS } from "./ultra-mcp";
import { WORKSPACE_AUTO_TOOLS, WORKSPACE_WEAVE_TOOL } from "./workspace-mcp";
import { ULTRA_AUTHORING_REFERENCE } from "./ultra-authoring";
import { makeGuardrailDecision } from "./permissions";
import {
  BROWSER_CONTROL_NOTE,
  ESCALATION_SYSTEM_PROMPT,
  PLANNER_SYSTEM_PROMPT,
  STEERER_SYSTEM_PROMPT,
  ULTRA_ANNOTATION_NOTE,
} from "./session-prompts";
import {
  buildEscalationProfile,
  buildMasterProfile,
  buildPlannerProfile,
  buildProjectProfile,
  buildSteererProfile,
  MASTER_PERMISSIONS_KEY,
  registerSessionProfiles,
} from "./session-profiles";

// Captured at MODULE SCOPE, immediately after the import above — this IS the
// side effect, observed rather than described.
const KINDS_AFTER_IMPORT = [...registeredSessionKinds()];
// The anchor half of the same side effect (story 5.6), captured in the same
// breath so no later reset can make either assertion lie.
const ANCHOR_KINDS_AFTER_IMPORT = [...registeredAnchorKinds()];

const manifest = ProjectManifest.parse({
  name: "demo",
  root: "/repos/demo",
  account: "personal",
  guardrails: { disallowedTools: ["Bash"], protectedPaths: [".env"] },
});

const ctx = (over: Partial<SessionResolutionContext> = {}): SessionResolutionContext => ({
  kind: "project",
  provider: "claude",
  manifest,
  project: "demo",
  permissionMode: "default",
  ultraAnnotated: false,
  ...over,
});

// The story's D11 table, as data. Every row is checked against the REAL builder.
//
// `staticPrompt` is the prompt constant the kind's appendix must CONTAIN — the
// symbol, never a copy of its text — and `getsUltraNote` records the one
// per-kind difference the old route expressed as `ultraAnnotated &&
// !isEscalationSession`. The three `""` appendices this table carried through
// story 2.1 were a deliberate tripwire, recorded in deferred-work.md as
// "will fail loudly the moment they change — which is the intended tripwire".
// They changed; this is what replaced them.
const D11: Array<{
  kind: SessionKind;
  build: SessionProfileBuilder;
  requiredCapabilities: readonly string[];
  staticPrompt: string | null;
  getsUltraNote: boolean;
  // STORY 5.6 — which setting sources the kind asks the harness for. A column
  // rather than a blanket assertion because the master is the first builder
  // that is NOT the native stack, and "every builder loads Claude's complete
  // native stack" would otherwise have to be deleted instead of narrowed.
  settingSources: readonly string[];
}> = [
  {
    kind: "project",
    build: buildProjectProfile,
    requiredCapabilities: [],
    staticPrompt: null,
    getsUltraNote: true,
    settingSources: NATIVE_CLAUDE_SETTING_SOURCES,
  },
  {
    kind: "planner",
    build: buildPlannerProfile,
    requiredCapabilities: ["system-prompt-append"],
    staticPrompt: PLANNER_SYSTEM_PROMPT,
    getsUltraNote: true,
    settingSources: NATIVE_CLAUDE_SETTING_SOURCES,
  },
  {
    kind: "steerer",
    build: buildSteererProfile,
    requiredCapabilities: ["system-prompt-append"],
    staticPrompt: STEERER_SYSTEM_PROMPT,
    getsUltraNote: true,
    settingSources: NATIVE_CLAUDE_SETTING_SOURCES,
  },
  {
    kind: "escalation",
    build: buildEscalationProfile,
    requiredCapabilities: ["mcp-servers", "pre-tool-use-hooks", "tool-allow-deny-lists"],
    staticPrompt: ESCALATION_SYSTEM_PROMPT,
    // NEVER. The escalation surface is offered none of ultra's tools, so
    // advertising the `ultra` tool to it would instruct it to call something
    // its own profile hard-denies. escalationAppendix has no `ultraAnnotated`
    // parameter at all, so this is enforced by a signature rather than
    // remembered.
    getsUltraNote: false,
    settingSources: NATIVE_CLAUDE_SETTING_SOURCES,
  },
  {
    // STORY 5.6's project-less master (SPEC-organization-workspace CAP-1).
    kind: "master",
    build: buildMasterProfile,
    requiredCapabilities: ["mcp-servers", "pre-tool-use-hooks", "tool-allow-deny-lists"],
    // NO APPENDIX AT ALL, and that is the story's own boundary rather than an
    // oversight: story 6 is backend-only, and the master's words (the briefing
    // bands, the receipt, the desk) are stories 7, 9 and 10. An omitted appendix
    // also requires no `system-prompt-append` capability, so it cannot 400 a
    // provider over a feature this profile does not use yet.
    staticPrompt: null,
    // NEVER. The master is offered no ultra tools — its mount is the workspace
    // server alone — so a note telling it to annotate a turn for Ultra would
    // describe a surface it cannot reach.
    getsUltraNote: false,
    // ZERO AMBIENT CONFIG DISCOVERY, the one setting the spec states as a
    // literal. brownfield.md: the master is not IN a repo, so it must not
    // inherit the operator's ~/.claude or some checkout's .mcp.json.
    settingSources: [],
  },
];

describe("the registration side effect route.ts depends on", () => {
  test("importing @/lib/session-profiles populates the registry with EVERY kind", () => {
    // If this ever reads [] the app is broken on every chat request while
    // bun test, tsc and lint all stay green. That is the whole reason this
    // assertion exists.
    expect(KINDS_AFTER_IMPORT).toEqual([
      "project",
      "planner",
      "steerer",
      "escalation",
      "master",
    ]);
  });

  test("the same import registers an ANCHOR for every one of them — story 5.6's second half", () => {
    // A kind with a builder and no anchor is a 500 in the route's pre-stream
    // preamble; a kind with an anchor and no builder is a 500 a few lines
    // later. Both registries are filled by the same module-scope call, so this
    // equality is what keeps them from being filled HALFWAY.
    expect([...ANCHOR_KINDS_AFTER_IMPORT].sort()).toEqual([...KINDS_AFTER_IMPORT].sort());
    expect(ANCHOR_KINDS_AFTER_IMPORT.length).toBeGreaterThan(0);
  });
});

// ── the core <-> web vocabulary pin (story 2.2, D4) ─────────────────────────

describe("core's tool-name tuples and @/lib's own cannot drift apart", () => {
  test("LOOM_AUTO_TOOL_NAMES is exactly LOOM_AUTO_TOOLS, and ULTRA_AUTO_TOOL_NAMES exactly ULTRA_AUTO_TOOLS", () => {
    // Core cannot import apps/web — that would invert the dependency — so the
    // auto-run vocabulary is DECLARED TWICE on purpose: once in
    // packages/core/src/session-profile.ts, where a profile's `allow` needs the
    // literal types, and once in @/lib/loom-mcp + @/lib/ultra-mcp, where the
    // servers register the tools. This file is the only one in the repo that
    // can see both, and this assertion is what makes the duplication safe:
    // drift in either copy indicts the other.
    //
    // Sorted, because the two orders are allowed to differ — core composes
    // BASE_ALLOWED_TOOLS in the route's own literal order, which is not
    // necessarily the order a server registers its tools in.
    expect([...LOOM_AUTO_TOOL_NAMES].sort()).toEqual([...LOOM_AUTO_TOOLS].sort());
    expect([...ULTRA_AUTO_TOOL_NAMES].sort()).toEqual([...ULTRA_AUTO_TOOLS].sort());
    // Anti-vacuity: two empty tuples would satisfy both equalities.
    expect(LOOM_AUTO_TOOL_NAMES.length).toBeGreaterThan(0);
    expect(ULTRA_AUTO_TOOL_NAMES.length).toBeGreaterThan(0);
  });

  test("WORKSPACE_AUTO_TOOL_NAMES is exactly WORKSPACE_AUTO_TOOLS — story 5.1's third copy of the same contract", () => {
    // The workspace vocabulary is declared twice for the identical reason: core
    // needs the literal types so a profile's `allow` can name the tools, and
    // @/lib/workspace-mcp is where the server actually registers them. This
    // assertion is the whole of what makes that duplication safe.
    //
    // UNSORTED, unlike its two siblings above, and that is a deliberate
    // strengthening rather than an inconsistency: invariants.test.ts's
    // MCP_INVENTORY compares each server's tool list as an ORDERED list, and
    // workspace-mcp.test.ts pins the registration order against
    // WORKSPACE_AUTO_TOOLS. So core's tuple, the server's constant, the
    // registration order and the pinned inventory all have to agree on ONE
    // sequence — and comparing sorted here would be the one link in that chain
    // that let a reorder through.
    expect([...WORKSPACE_AUTO_TOOL_NAMES]).toEqual([...WORKSPACE_AUTO_TOOLS]);
    expect(WORKSPACE_AUTO_TOOL_NAMES.length).toBe(4);
    // Fully qualified on BOTH sides — the bare form would produce tools that
    // never auto-run and that the resolver's runtime filter drops silently.
    for (const n of WORKSPACE_AUTO_TOOL_NAMES) expect(n.startsWith("mcp__workspace__")).toBe(true);
    // …and every one of them really is grantable, which is the point of the
    // tuple existing in core at all.
    for (const n of WORKSPACE_AUTO_TOOLS) expect([...BASE_ALLOWED_TOOLS]).toContain(n);
  });

  test("BROWSER_READ_TOOL_NAMES is exactly the browser server's read-only auto-run surface", () => {
    expect([...BROWSER_READ_TOOL_NAMES]).toEqual([...BROWSER_READ_TOOLS]);
    expect(BROWSER_READ_TOOL_NAMES.length).toBe(5);
    expect([...BROWSER_READ_TOOL_NAMES]).not.toContain("mcp__browser__browser_tabs");
    const registered = browserTools().map((entry) => entry.name);
    for (const qualified of BROWSER_READ_TOOLS) {
      expect(registered).toContain(qualified.replace("mcp__browser__", ""));
    }
  });

  test("MOAT: neither human-gated loom tool is in the auto-run vocabulary or the base union", () => {
    // Asserted against the CONSTANTS, never against literals. Both tools are
    // the human's click (docs/loom-model.md §M.6): start_loom dispatches a real
    // loom, answer_blocked resumes a parked one. Keeping them out of core's
    // tuple makes them unspellable in any profile's `allow` — a compiler-
    // enforced moat that did not exist before the tuple grew.
    for (const gated of [LOOM_START_TOOL, LOOM_ANSWER_BLOCKED_TOOL]) {
      expect([...LOOM_AUTO_TOOLS]).not.toContain(gated);
      expect([...LOOM_AUTO_TOOL_NAMES]).not.toContain(gated);
      expect([...BASE_ALLOWED_TOOLS]).not.toContain(gated);
    }
    // Anti-vacuity: the neighbouring auto-run loom tools ARE in all three, so
    // this is not passing over three empty haystacks.
    expect([...BASE_ALLOWED_TOOLS]).toContain("mcp__loom__read_bundle");
  });

  test("BASE_ALLOWED_TOOLS still OPENS with the route's old non-escalation array, element for element", () => {
    // The BEFORE table's project/planner/steerer row: six built-ins, then
    // ...LOOM_AUTO_TOOLS, then ...ULTRA_AUTO_TOOLS. Re-derived from the WEB
    // constants (the ones route.ts used to spread) so this compares the two
    // worlds rather than restating either.
    //
    // THIS WAS A `toEqual` ON THE WHOLE TUPLE UNTIL STORY 5.1, and it was right:
    // core's twenty WERE the route's old array exactly, which is what made
    // "the route composes NOTHING" checkable. 5.1 appended the workspace store's
    // four, so the relationship is now PREFIX rather than EQUALITY — and the
    // assertion is split in two rather than weakened to a `toContain`, because
    // an ordered exact-set claim is the only kind that catches a silent grant.
    // Half one: the historical array is still there, in order, untouched.
    // Half two (below): the suffix is EXACTLY the four workspace names and
    // nothing else, so a fifth name cannot arrive between them.
    const routesOldArray = [
      "Read",
      "Grep",
      "Glob",
      "WebSearch",
      "WebFetch",
      "ToolSearch",
      ...LOOM_AUTO_TOOLS,
      ...ULTRA_AUTO_TOOLS,
    ];
    expect(routesOldArray.length).toBe(21); // anti-vacuity + the measured count
    expect([...BASE_ALLOWED_TOOLS].slice(0, routesOldArray.length)).toEqual(routesOldArray);
    expect([...BASE_ALLOWED_TOOLS].slice(routesOldArray.length)).toEqual([
      ...WORKSPACE_AUTO_TOOLS,
      ...BROWSER_READ_TOOLS,
    ]);
    // …and the two halves account for the WHOLE tuple, so nothing hides in a gap.
    expect(BASE_ALLOWED_TOOLS.length).toBe(
      routesOldArray.length + WORKSPACE_AUTO_TOOLS.length + BROWSER_READ_TOOLS.length,
    );
    expect(BASE_ALLOWED_TOOLS.length).toBe(30);
    // No duplicates: unionOrdered would silently absorb one, shortening the
    // resolved allow set rather than failing.
    expect(new Set(BASE_ALLOWED_TOOLS).size).toBe(BASE_ALLOWED_TOOLS.length);
  });
});

describe("the builders carry D11's per-kind decisions", () => {
  beforeEach(() => {
    resetSessionProfiles();
    registerSessionProfiles();
  });

  for (const row of D11) {
    test(`${row.kind} declares exactly its required capabilities`, () => {
      const spec = row.build(ctx({ kind: row.kind }));
      expect([...spec.requiredCapabilities]).toEqual([...row.requiredCapabilities]);
    });

    test(`${row.kind} resolves through the registry to the same capability set`, () => {
      // Not the same assertion as above: this one goes through
      // registerSessionProfiles -> resolveSessionProfile, so a builder wired to
      // the WRONG KEY would be caught here and not by the direct call.
      const resolved = resolveSessionProfile(ctx({ kind: row.kind }));
      expect(resolved.kind).toBe(row.kind);
      expect([...resolved.requiredCapabilities]).toEqual([...row.requiredCapabilities]);
    });

    test(`${row.kind}'s appendix carries its own static prompt and nobody else's`, () => {
      const appendix = resolveSessionProfile(
        ctx({ kind: row.kind }),
      ).systemPromptAppendix;
      if (row.staticPrompt) {
        expect(appendix).toContain(row.staticPrompt);
      }
      // The exclusion half, and it is the one that catches a mis-wired builder:
      // every OTHER kind's prompt must be absent. A registry that handed the
      // steerer builder's output back under the planner key would satisfy a
      // bare "contains something" check.
      for (const other of D11) {
        if (other.kind === row.kind || !other.staticPrompt) continue;
        expect(appendix).not.toContain(other.staticPrompt);
      }
    });

    test(`${row.kind} gets the Ultra note exactly when the flag AND the kind say so`, () => {
      const off = resolveSessionProfile(
        ctx({ kind: row.kind, ultraAnnotated: false }),
      ).systemPromptAppendix;
      const on = resolveSessionProfile(
        ctx({ kind: row.kind, ultraAnnotated: true }),
      ).systemPromptAppendix;
      // The chip OFF is every ordinary turn: no note, for any kind.
      expect(off).not.toContain(ULTRA_ANNOTATION_NOTE);
      expect(on.includes(ULTRA_ANNOTATION_NOTE)).toBe(row.getsUltraNote);
      // …and the static prompt survives the flag either way, so turning the
      // chip on can never REPLACE the kind's guidance.
      if (row.staticPrompt) {
        expect(on).toContain(row.staticPrompt);
        expect(off).toContain(row.staticPrompt);
      }
    });
  }

  test("a plain CODEX project session carries browser guidance but no Ultra guidance", () => {
    // THIS ASSERTION USED TO BE ABOUT `ctx({ kind: "project" })`, WHICH DEFAULTS
    // TO CLAUDE, AND STORY 4.2 MADE IT DELIBERATELY FALSE THERE.
    //
    // What it said, and why it was right for its story: "The route's old
    // fallthrough arm: `ultraAnnotationNote ? {…append} : {…}`. "" here is what
    // keeps 'a normal session's systemPrompt is byte-for-byte unchanged' true
    // after the migration — the route branches on emptiness and passes the bare
    // preset." That claim was about story 2.2's MIGRATION: hoisting the route's
    // prompt branch into builders had to change no behaviour.
    //
    // Why it is wrong now: story 4.2 / AC8 injects the script-authoring
    // reference into every CLAUDE project/planner/steerer session, on purpose.
    // The reference is the whole point — CAP-3 says the agent must be taught how
    // to author a script, and the appendix is the only per-turn channel there
    // is.
    //
    // THE HALF THAT DID NOT CHANGE is what this test now pins, and it is the
    // half that carries the original property: on CODEX the appendix is STILL
    // exactly "" with the chip off and STILL exactly the note with it on. Codex
    // is offered no ultra tools, so it is taught no ultra authoring. The
    // escalation appendix likewise still contains no ultra text at all — see
    // "the escalation appendix carries no ultra text on either provider" below.
    const codex = { kind: "project", provider: "codex" } as const;
    expect(resolveSessionProfile(ctx(codex)).systemPromptAppendix).toBe(BROWSER_CONTROL_NOTE);
    // …and with the chip on it adds the turn note while retaining browser guidance.
    expect(
      resolveSessionProfile(ctx({ ...codex, ultraAnnotated: true })).systemPromptAppendix,
    ).toBe(ULTRA_ANNOTATION_NOTE + BROWSER_CONTROL_NOTE);
  });

  test("4.2 AC8 — a CLAUDE project session carries the authoring reference, and the chip is orthogonal to it", () => {
    const off = resolveSessionProfile(ctx({ kind: "project" })).systemPromptAppendix;
    const on = resolveSessionProfile(
      ctx({ kind: "project", ultraAnnotated: true }),
    ).systemPromptAppendix;
    // The reference is UNCONDITIONAL on Claude: it teaches the agent how to
    // author a script IF it is asked to, which is a different question from
    // whether this turn was annotated. Gating it on the chip would mean the one
    // turn the user actually asked for a run is the first turn the agent has
    // ever seen the surface API.
    expect(off).toContain(ULTRA_AUTHORING_REFERENCE);
    expect(on).toContain(ULTRA_AUTHORING_REFERENCE);
    expect(off).not.toContain(ULTRA_ANNOTATION_NOTE);
    expect(on).toContain(ULTRA_ANNOTATION_NOTE);
  });

  test("4.2 AC8 — the reference reaches planner and steerer on Claude and NEITHER of them on Codex", () => {
    for (const kind of ["project", "planner", "steerer"] as const) {
      expect(
        resolveSessionProfile(ctx({ kind, loomId: "l-1" })).systemPromptAppendix,
      ).toContain(ULTRA_AUTHORING_REFERENCE);
      expect(
        resolveSessionProfile(ctx({ kind, provider: "codex", loomId: "l-1" })).systemPromptAppendix,
      ).not.toContain(ULTRA_AUTHORING_REFERENCE);
    }
  });

  test("4.2 AC8 — the escalation appendix carries no ultra text on either provider, enforced by its TYPE", () => {
    // `escalationAppendix` has neither `ultraAnnotated` nor `provider` in its
    // signature, so this cannot regress by someone forgetting — it can only
    // regress by someone widening the type on purpose.
    for (const provider of ["claude", "codex"] as const) {
      const appendix = resolveSessionProfile(
        ctx({ kind: "escalation", provider, loomId: "l-1" }),
      ).systemPromptAppendix;
      expect(appendix).not.toContain(ULTRA_AUTHORING_REFERENCE);
      expect(appendix).not.toContain(ULTRA_ANNOTATION_NOTE);
    }
  });

  test("each builder asks for exactly the setting sources D11 gives it", () => {
    // Every project-anchored kind loads Claude's complete native stack, which
    // is what a `claude` launched in that checkout would load. The master loads
    // NOTHING, and this is the assertion that would catch it silently picking
    // up the operator's ~/.claude.
    for (const row of D11) {
      const settingSources = resolveSessionProfile(ctx({ kind: row.kind })).settingSources;
      expect([...settingSources]).toEqual([...row.settingSources]);
    }
    // Anti-vacuity: the two columns are genuinely different, so the loop above
    // is not passing because every row says the same thing.
    expect(resolveSessionProfile(ctx({ kind: "master" })).settingSources).toEqual([]);
    expect(
      resolveSessionProfile(ctx({ kind: "project" })).settingSources.length,
    ).toBeGreaterThan(0);
  });

  test("every kind's cwd IS manifest.root — AC2, by construction", () => {
    for (const row of D11) {
      expect(resolveSessionProfile(ctx({ kind: row.kind })).cwd).toBe(manifest.root);
    }
    // A different manifest root moves it, which is the only thing that may — so
    // this is not passing because cwd is a constant.
    const elsewhere = ProjectManifest.parse({ name: "other", root: "/repos/other" });
    expect(resolveSessionProfile(ctx({ kind: "project", manifest: elsewhere })).cwd).toBe(
      "/repos/other",
    );
  });

  test("every builder's guardrails UNION the manifest's — none replaces them", () => {
    for (const row of D11) {
      const resolved = resolveSessionProfile(ctx({ kind: row.kind }));
      expect(resolved.guardrails.disallowedTools).toContain("Bash");
      expect(resolved.guardrails.protectedPaths).toContain(".env");
    }
  });

  test("AskUserQuestion is denied for every kind — measured from the route's own disallowedTools", () => {
    for (const row of D11) {
      expect(resolveSessionProfile(ctx({ kind: row.kind })).toolPolicy.deny).toContain(
        "AskUserQuestion",
      );
    }
  });
});

// ── story 5.6 — the project-less master ─────────────────────────────────────

// THE PROFILE HALF (pure — every expectation derived from the constant the
// server actually registers its tools from, never a restated list of names).
// The ANCHOR half, which touches the disk, runs in a sandboxed child below.
describe("5.6 the master profile — a session anchored to no project", () => {
  beforeEach(() => {
    resetSessionProfiles();
    registerSessionProfiles();
  });

  test("the master's allow is the read triad PLUS the workspace tools, and nothing else", () => {
    const allow = [...resolveSessionProfile(ctx({ kind: "master" })).toolPolicy.allow];
    for (const name of WORKSPACE_AUTO_TOOLS) expect(allow).toContain(name);
    for (const name of ["Read", "Grep", "Glob"]) expect(allow).toContain(name);
    expect(allow.length).toBe(3 + WORKSPACE_AUTO_TOOLS.length);
    // THE EXCLUSIONS ARE THE ASSERTION. Every one of these is a name the base
    // vocabulary WOULD have granted had `allow` been omitted (a project session
    // gets all of them), so this is what makes the narrowing real:
    //   - Bash/Write/Edit — the master has a home directory, not a checkout, and
    //     nothing in CAP-1 asks it to write code.
    //   - WebSearch/WebFetch — CAP-13's external-reference surface (story 12)
    //     designs those; pre-granting them here would make that decision for it.
    //   - the loom and ultra tools — not mounted for this kind at all.
    // WebSearch/WebFetch/ToolSearch are the sharp ones: they ARE in the base
    // vocabulary, so an omitted `allow` would have granted them silently.
    for (const name of ["WebSearch", "WebFetch", "ToolSearch"]) {
      expect(allow).not.toContain(name);
      expect([...BASE_ALLOWED_TOOLS]).toContain(name);
    }
    // Bash/Write/Edit are not in the base vocabulary at all (they were never
    // auto-run for any kind); the master does not re-admit them either.
    for (const name of ["Bash", "Write", "Edit"]) {
      expect(allow).not.toContain(name);
    }
    for (const name of [...LOOM_AUTO_TOOLS, ...ULTRA_AUTO_TOOLS]) {
      expect(allow).not.toContain(name);
    }
  });

  test("the master DENIES every loom and ultra name — a card for an unmounted server is not an option", () => {
    const deny = [...resolveSessionProfile(ctx({ kind: "master" })).toolPolicy.deny];
    for (const name of [...LOOM_AUTO_TOOLS, ...ULTRA_AUTO_TOOLS]) {
      expect(deny).toContain(name);
    }
    // The two moat names too, and they are the interesting half: they are
    // UNSPELLABLE in `allow` by type, so an un-denied one would not fail to
    // compile — it would fall through to canUseTool and put a human-gated card
    // on screen for a loom server this session never mounted.
    expect(deny).toContain(LOOM_START_TOOL);
    expect(deny).toContain(LOOM_ANSWER_BLOCKED_TOOL);
    // Anti-vacuity: the deny set is a NARROWING of a mounted surface, not a
    // blanket — the workspace tools it actually has are not in it.
    for (const name of WORKSPACE_AUTO_TOOLS) expect(deny).not.toContain(name);
  });

  test("THE MOAT — weave_batch is in neither list, so it stays callable-but-human-gated", () => {
    const { toolPolicy } = resolveSessionProfile(ctx({ kind: "master" }));
    // Story 5.5 / CAP-11: a weave hands the human's own queue rows to a loom
    // and a human approves that, in every permission mode. In `allow` it would
    // auto-run; in `deny` the master's whole proposal surface would be gone.
    // Neither — exactly as escalation treats answer_blocked.
    expect([...toolPolicy.allow]).not.toContain(WORKSPACE_WEAVE_TOOL);
    expect([...toolPolicy.deny]).not.toContain(WORKSPACE_WEAVE_TOOL);
    // …and it is genuinely a workspace tool, not a name this test invented.
    expect(WORKSPACE_WEAVE_TOOL.startsWith("mcp__workspace__")).toBe(true);
    expect([...WORKSPACE_AUTO_TOOLS]).not.toContain(WORKSPACE_WEAVE_TOOL);
  });

  test("the master requires the three capabilities Codex does not publish — AD-11, not silent degradation", () => {
    const master = resolveSessionProfile(ctx({ kind: "master" }));
    // runCodexTurn has no MCP plumbing at all (brownfield.md's gap), so a
    // Codex-backed master would come up with NO workspace server and no way to
    // say so. The gate turns that into the route's existing pre-SSE 400.
    expect([...unmetCapabilities(master, "codex")]).toEqual([
      "pre-tool-use-hooks",
      "tool-allow-deny-lists",
    ]);
    expect(unmetCapabilities(master, "claude")).toEqual([]);
    // `setting-sources` is deliberately NOT required — see the D11 row.
    expect([...master.requiredCapabilities]).not.toContain("setting-sources");
  });

  test("the synthetic permissions key is not a shape a real project name takes", () => {
    // apps/web/lib/permissions.ts keys stored allow-rules by project name. A
    // project-less session with no key of its own would file its rules under
    // the string "undefined" — one bucket every future project-less surface
    // silently joins.
    expect(MASTER_PERMISSIONS_KEY).toBe("__master__");
    expect(MASTER_PERMISSIONS_KEY).not.toBe("undefined");
    expect(MASTER_PERMISSIONS_KEY.startsWith("__")).toBe(true);
  });
});

// ── story 5.6's anchor, in a sandboxed child ────────────────────────────────

describe("5.6 the master anchor resolves a cwd under TELAR_HOME, never a home directory", () => {
  test("cwd is TELAR_HOME/workspace/home, it EXISTS, and the store sits above it", () => {
    // WHY A CHILD PROCESS, for the third reason this file has one: the master
    // anchor calls ensureWorkspace(), which MKDIRS under the resolved state
    // root — and outside a sandbox that root is the operator's real ~/.telar.
    // Mutating process.env.TELAR_HOME in the shared bun process is equally
    // forbidden (every suite runs in ONE process). So: a child, with HOME and
    // TELAR_HOME pointed at throwaway directories, importing by ABSOLUTE PATH
    // so a temp dir with no node_modules of its own still resolves.
    //
    // HOME IS POINTED AT A THROWAWAY FOR A SECOND REASON HERE. The spec's
    // hardest line is "NEVER use /Users/facundo (or any home dir) as cwd —
    // trust never persists there", and the probe below asserts the resolved cwd
    // is not the home directory it was given. With the real HOME that assertion
    // would be weaker, because a wrong answer might still differ from it.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-master-anchor-"));
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "telar-master-home-"));
    const telarHome = path.join(dir, "telar");
    try {
      const probe = path.join(dir, "probe.ts");
      fs.writeFileSync(
        probe,
        [
          // The catalogue module registers both halves at module scope; the
          // resolver is core's. Importing them together is exactly what the
          // route does.
          `import ${JSON.stringify(path.join(here, "session-profiles"))};`,
          // CORE BY ABSOLUTE PATH TOO, and not by its "@telar/core" specifier:
          // the probe file lives in a temp directory, and a bare specifier
          // resolved from THERE finds a stale copy in bun's install cache —
          // measured, and it fails as a missing export rather than as a wrong
          // answer. Both this path and the one @/lib/session-profiles resolves
          // are the same real file (apps/web/node_modules/@telar/core is a
          // symlink to packages/core), so the registry the catalogue filled at
          // module scope is the registry this reads.
          `import { registerProject, resolveSessionAnchor, resolveSessionProfile } from ${JSON.stringify(
            path.join(here, "..", "..", "..", "packages", "core", "src", "index.ts"),
          )};`,
          `import fs from "node:fs";`,
          `import path from "node:path";`,
          `const anchor = resolveSessionAnchor({ kind: "master" });`,
          // The anchor feeds the fold: cwd is manifest.root, so this proves the
          // whole path from registration to the value the SDK is handed.
          `const profile = resolveSessionProfile({ kind: "master", provider: "claude", manifest: anchor.manifest, permissionMode: "default", ultraAnnotated: false });`,
          `const ws = path.dirname(profile.cwd);`,
          `console.log(JSON.stringify({`,
          `  cwd: profile.cwd,`,
          `  permissionsKey: anchor.permissionsKey,`,
          `  manifestName: anchor.manifest.name,`,
          `  guardrails: anchor.manifest.guardrails,`,
          // THE ACTUAL WRITE BOUNDARY, read off the FOLDED profile rather than
          // the manifest: `addProtectedPaths` is a spec field, so only the fold
          // can show it arriving. Reported as absolute paths and compared to
          // the sandbox's own TELAR_HOME below.
          `  protectedPaths: profile.guardrails.protectedPaths,`,
          // The anchor's project, which for THIS kind is the absence of a key.
          // Reported as a sentinel because JSON.stringify drops `undefined`.
          `  hasProject: Object.prototype.hasOwnProperty.call(anchor, "project"),`,
          `  project: anchor.project ?? null,`,
          // …and its opposite for a project-anchored kind, so "absent" reads as
          // a decision rather than as a field this shape never carries. The
          // project is registered inside the sandbox, against the sandboxed
          // TELAR_HOME, so this touches nothing real.
          `  projectAnchorProject: (() => {`,
          `    const root = path.join(${JSON.stringify(dir)}, "proj");`,
          `    fs.mkdirSync(root, { recursive: true });`,
          `    fs.writeFileSync(path.join(root, "telar.yaml"), "name: demo\\n");`,
          `    registerProject(root);`,
          `    return resolveSessionAnchor({ kind: "project", project: "demo" }).project;`,
          `  })(),`,
          // F4 — `__like_this__` is reserved, enforced at the registry's single
          // write path, because a real project by that name would file its
          // stored permission rules in the master's own bucket.
          `  reservedNameRefused: (() => {`,
          `    const root = path.join(${JSON.stringify(dir)}, "reserved");`,
          `    fs.mkdirSync(root, { recursive: true });`,
          `    fs.writeFileSync(path.join(root, "telar.yaml"), "name: __master__\\n");`,
          `    try { registerProject(root); return false; } catch { return true; }`,
          `  })(),`,
          `  exists: fs.existsSync(profile.cwd) && fs.statSync(profile.cwd).isDirectory(),`,
          `  empty: fs.readdirSync(profile.cwd).length === 0,`,
          `  workspace: ws,`,
          `  siblings: fs.readdirSync(ws).sort(),`,
          `  idempotent: (() => { const again = resolveSessionAnchor({ kind: "master" }); return again.manifest.root === profile.cwd; })(),`,
          // The other half of "the profile REPLACES the derivation": a project
          // kind still goes through getProject and still throws for an unknown
          // one, which is the route's pre-SSE 400.
          `  unknownProjectThrows: (() => { try { resolveSessionAnchor({ kind: "project", project: "nope" }); return false; } catch { return true; } })(),`,
          `  noProjectThrows: (() => { try { resolveSessionAnchor({ kind: "project" }); return false; } catch { return true; } })(),`,
          `}));`,
        ].join("\n"),
      );
      const out = spawnSync(process.execPath, [probe], {
        encoding: "utf8",
        env: { ...process.env, HOME: fakeHome, TELAR_HOME: telarHome, NODE_ENV: "test" },
      });
      const line = (out.stdout ?? "").trim().split("\n").pop() ?? "";
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        /* fall through to the diagnostic below */
      }
      if (!parsed) {
        throw new Error(
          `story 5.6: the sandboxed master-anchor probe produced no JSON. ` +
            `status=${out.status} stdout=${JSON.stringify(out.stdout)} ` +
            `stderr=${JSON.stringify(out.stderr)}. CONSEQUENCE: the master's cwd, its ` +
            `existence and the "store stays above it" boundary are ALL unproved while this ` +
            `test reads as green. NEXT STEP: fix the probe or its module resolution — do not ` +
            `weaken the assertion, and do NOT resolve the master anchor in this process ` +
            `(ensureWorkspace mkdirs under the real ~/.telar).`,
        );
      }

      // THE PATH THE SPEC NAMES, composed here from the sandbox's own
      // TELAR_HOME rather than read back from the answer.
      expect(parsed.cwd).toBe(path.join(telarHome, "workspace", "home"));
      // NEVER A HOME DIRECTORY (brownfield.md — trust never persists there).
      expect(parsed.cwd).not.toBe(fakeHome);
      expect(parsed.cwd).not.toBe(os.homedir());
      expect(String(parsed.cwd).startsWith(telarHome + path.sep)).toBe(true);
      // A cwd that does not exist is not a cwd: Claude Code tolerates an empty
      // directory, but neither harness tolerates a missing one.
      expect(parsed.exists).toBe(true);
      // DEDICATED AND EMPTY — the spec's word. It is a workspace directory, not
      // a checkout, and nothing seeds it.
      expect(parsed.empty).toBe(true);
      // THE LAYOUT, AND ONLY THE LAYOUT. This block used to end "…so a session
      // whose cwd is home/ cannot reach them by relative path at all", which is
      // false and was the load-bearing sentence of a boundary claim: siblings
      // are reachable, they are spelled `../lanes.yaml`. The layout is a
      // convenience (an accidental relative write lands in home/, not in the
      // store); the BOUNDARY is `addProtectedPaths`, asserted immediately below
      // from the resolved profile's own guardrails.
      expect(parsed.workspace).toBe(path.join(telarHome, "workspace"));
      expect(parsed.siblings).toContain("home");
      expect(parsed.siblings).toContain("lanes.yaml");
      expect(parsed.siblings).toContain("packets");
      // The synthetic identity, and the DEFAULT guardrails the spec asks for —
      // "default" meaning literally the schema's own, because the anchor parses
      // a manifest rather than hand-building one.
      expect(parsed.permissionsKey).toBe("__master__");
      expect(parsed.manifestName).toBe("__master__");
      expect(parsed.guardrails).toEqual({ disallowedTools: [], protectedPaths: [] });
      // THE WRITE BOUNDARY, as a mechanism rather than as a directory layout
      // (the review finding this probe's sibling assertion above used to stand
      // in for). The manifest's own guardrails are empty — that is the line
      // right above — so every entry here arrived through the spec's
      // `addProtectedPaths`, which is the one channel AD-10 gives a builder.
      expect(parsed.protectedPaths).toEqual([
        path.join(telarHome, "workspace", "lanes.yaml"),
        path.join(telarHome, "workspace", "packets"),
      ]);
      // home/ — the master's own cwd — is deliberately NOT protected. A session
      // that cannot write in its own working directory is not a session.
      expect(parsed.protectedPaths).not.toContain(parsed.cwd);
      // THE ANCHOR CARRIES NO PROJECT for this kind, and that absence is what
      // makes the route's project-only paths (the telar.yaml MCP union, the
      // persisted project column, the browser scope) collapse without a single
      // kind check. Asserted as a MISSING KEY, not just a falsy value.
      expect(parsed.hasProject).toBe(false);
      expect(parsed.project).toBe(null);
      // …while a project-anchored kind carries the REGISTRY's name — the wire
      // value having survived getProject, which is the thing the route reads.
      expect(parsed.projectAnchorProject).toBe("demo");
      // F4: the synthetic key's shape is reserved at the registry's own write
      // path, so a real project can never share the master's permissions
      // bucket. Registration REFUSES rather than warning.
      expect(parsed.reservedNameRefused).toBe(true);
      // AD-15: resolving twice is the same directory, not a new scratch dir per
      // turn — a stable home is what lets per-directory trust accrue at all.
      expect(parsed.idempotent).toBe(true);
      // The derivation was REPLACED for this kind, not removed for all of them.
      expect(parsed.unknownProjectThrows).toBe(true);
      expect(parsed.noProjectThrows).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  }, 30_000);
});

// ── story 5.6's write boundary, as a DECISION rather than a directory layout ─
//
// The review finding this block answers: the first cut of the master profile
// claimed "the store above it stays outside the master's write boundary" and
// implemented that claim as sibling directories. Measured, that bought one
// thing — an accidental relative write lands in home/ — and nothing else:
// `../lanes.yaml` is a path, `protectedPaths` was empty, Write/Edit/Bash being
// absent from `allow` means ASK rather than blocked, and a full-access turn
// auto-allows every non-moat tool outright. These tests drive the SAME
// predicate both enforcement points call (the PreToolUse hook and canUseTool),
// so what they assert is what the guardrail actually decides.
//
// IN-PROCESS AND STILL HERMETIC: `workspaceStorePaths()` composes paths and
// touches no disk (unlike `ensureWorkspace()`, which is why the anchor is
// probed in a child), and the manifest is parsed here rather than resolved, so
// nothing under the operator's real ~/.telar is created, read or renamed.
describe("5.6 the master's write boundary is the guardrail, not the layout", () => {
  beforeEach(() => {
    resetSessionProfiles();
    registerSessionProfiles();
  });

  // The master's own manifest shape: the schema's DEFAULT guardrails (which is
  // what the anchor really parses — the child probe above measures exactly
  // that), so every protected path in the resolved profile can only have come
  // from the spec's `addProtectedPaths`.
  const masterProfile = () =>
    resolveSessionProfile(
      ctx({
        kind: "master",
        manifest: ProjectManifest.parse({
          name: "__master__",
          root: workspaceHomeDir(),
          account: "personal",
          guardrails: { disallowedTools: [], protectedPaths: [] },
        }),
        project: undefined,
      }),
    );

  const decideMaster = (tool: string, input: Record<string, unknown>) => {
    const profile = masterProfile();
    return makeGuardrailDecision(profile, profile.cwd, tool, input);
  };

  test("the fold ADDS the store's paths to guardrails that were empty — AD-10's one channel", () => {
    const profile = masterProfile();
    // Derived from the store's own port, never restated: this is the same
    // expression the builder passes, so a store that moves its files moves this
    // expectation with it.
    expect([...profile.guardrails.protectedPaths]).toEqual([...workspaceStorePaths()]);
    // Anti-vacuity: the port is non-empty and names the two things the spec
    // does (the lanes file and the packet bodies).
    expect(workspaceStorePaths().length).toBe(2);
    expect(workspaceStorePaths().some((p) => p.endsWith("lanes.yaml"))).toBe(true);
    expect(workspaceStorePaths().some((p) => p.endsWith("packets"))).toBe(true);
    // …and the master's cwd is NOT among them. A session that cannot write in
    // its own working directory is not a session — the boundary is the store,
    // not the home.
    expect([...profile.guardrails.protectedPaths]).not.toContain(profile.cwd);
  });

  test("a RELATIVE write at the store is denied — `../lanes.yaml` is the actual attack shape", () => {
    // The sibling layout's whole defence was that the store is not under the
    // cwd. This is the path that says it is one `..` away. isProtectedPath
    // resolves both sides against the root, so the relative spelling and the
    // absolute one reduce to the same decision.
    for (const spelling of ["../lanes.yaml", workspaceStorePaths()[0]!]) {
      const d = decideMaster("Write", { file_path: spelling });
      expect(d.behavior).toBe("deny");
      expect(d.behavior === "deny" && d.message).toContain("protected path");
    }
    // A packet BODY, i.e. a path INSIDE a protected directory rather than the
    // directory itself — the containment half of the predicate.
    const inside = decideMaster("Edit", { file_path: "../packets/itm_abc/packet.json" });
    expect(inside.behavior).toBe("deny");
  });

  test("Bash is covered too — the tool whose target never appears in a path key", () => {
    // `protectedPaths` only inspects path-shaped input keys, and Bash populates
    // none of them. Without the word-split half, the master's most powerful
    // route to the store would be the one the boundary did not cover.
    const d = decideMaster("Bash", { command: "rm -rf ../packets" });
    expect(d.behavior).toBe("deny");
    expect(d.behavior === "deny" && d.message).toContain("protected path");
  });

  test("THE DISCRIMINATOR — the master can still write in its own home directory", () => {
    // Without this row a guardrail that denied everything would satisfy the
    // three above, and the "fix" would be an outage wearing a boundary's
    // clothes. notes.md is the shape CAP-1's briefing scratch work takes.
    expect(decideMaster("Write", { file_path: "notes.md" }).behavior).toBe("allow");
    expect(decideMaster("Bash", { command: "ls -la ." }).behavior).toBe("allow");
  });

  test("READING the store is NOT blocked, and saying so is the point", () => {
    // guardrails.ts is explicit: this guards MODIFICATION, not disclosure —
    // Read/Grep/Glob are never path-checked. The master is SUPPOSED to read its
    // own store; what it must not do is rewrite it behind the moat's back.
    // Asserted so the boundary's scope is recorded by a test rather than by a
    // comment that can quietly over-claim (which is exactly what happened).
    expect(decideMaster("Read", { file_path: "../lanes.yaml" }).behavior).toBe("allow");
  });

  test("a project session's guardrails are untouched by any of this", () => {
    // AD-10 is "may restrict more, never less" — for THIS kind. The store's
    // paths must not leak into a kind that never asked for them.
    const p = resolveSessionProfile(ctx({ kind: "project" }));
    expect([...p.guardrails.protectedPaths]).toEqual([".env"]);
  });
});

// ── the per-kind equivalence table (story 2.2, §6.2-A) ─────────────────────
// For each kind: does the RESOLVED profile reproduce what the route used to
// build inline? Every expectation derives from the SAME source constants the
// route spread, so a drifted builder is indicted by its own source rather than
// by a restated literal.

describe("per-kind equivalence — the profile reproduces the route's own BEFORE table", () => {
  beforeEach(() => {
    resetSessionProfiles();
    registerSessionProfiles();
  });

  // BEFORE, measured from route.ts at the story's baseline:
  //   allowedTools    = isEscalationSession ? [...LOOM_ESCALATION_READONLY_TOOLS]
  //                     : ["Read","Grep","Glob","WebSearch","WebFetch","ToolSearch",
  //                        ...LOOM_AUTO_TOOLS, ...ULTRA_AUTO_TOOLS]
  //   disallowedTools = [...manifest.guardrails.disallowedTools, "AskUserQuestion",
  //                      ...(isEscalationSession
  //                          ? [...LOOM_ESCALATION_DISALLOWED_TOOLS, ...ULTRA_AUTO_TOOLS]
  //                          : [])]
  const MANIFEST_DENY = manifest.guardrails.disallowedTools;
  // STORY 5.1 appended ...WORKSPACE_AUTO_TOOLS. The three per-kind equivalence
  // tests below are FED BY THIS CONST, so growing it here is what moves them —
  // which is exactly why every expectation in this block derives from the
  // constant the route itself spread rather than restating a literal.
  const NON_ESCALATION_ALLOW = [
    "Read",
    "Grep",
    "Glob",
    "WebSearch",
    "WebFetch",
    "ToolSearch",
    ...LOOM_AUTO_TOOLS,
    ...ULTRA_AUTO_TOOLS,
    ...WORKSPACE_AUTO_TOOLS,
    ...BROWSER_READ_TOOLS,
  ];
  const ESCALATION_ALLOW = [...LOOM_ESCALATION_READONLY_TOOLS];
  const NON_ESCALATION_DENY = [...MANIFEST_DENY, "AskUserQuestion"];
  // STORY 5.1 appended ...WORKSPACE_AUTO_TOOLS, mirroring buildEscalationProfile.
  // The escalation builder sets `allow` EXPLICITLY, so growing core's base set
  // does not reach it: without this deny the four workspace names would sit in
  // NEITHER list and fall through to canUseTool — an interactive card offering a
  // WRITE path on a read-only discuss wall.
  const ESCALATION_DENY = [
    ...MANIFEST_DENY,
    "AskUserQuestion",
    ...LOOM_ESCALATION_DISALLOWED_TOOLS,
    ...ULTRA_AUTO_TOOLS,
    ...WORKSPACE_AUTO_TOOLS,
  ];

  test("the derived expectation sets are non-empty — the anti-vacuity floor for this whole block", () => {
    // Every assertion below compares against one of these five arrays. If a
    // source constant emptied out, each comparison would hold over [] and this
    // block would pass forever while the route granted nothing.
    const floors: Array<[string, number, number]> = [
      ["NON_ESCALATION_ALLOW", NON_ESCALATION_ALLOW.length, 20],
      ["ESCALATION_ALLOW", ESCALATION_ALLOW.length, 6],
      ["NON_ESCALATION_DENY", NON_ESCALATION_DENY.length, 2],
      ["ESCALATION_DENY", ESCALATION_DENY.length, 14],
      ["MANIFEST_DENY", MANIFEST_DENY.length, 1],
    ];
    const thin = floors.filter(([, got, floor]) => got < floor);
    if (thin.length > 0) {
      throw new Error(
        `AD-9 / story 2.2 §6.2-A: a source constant this equivalence table derives from came ` +
          `back THIN — ${JSON.stringify(thin)} (name, got, floor). THE RULE: every expectation ` +
          `here is re-derived from the constant the route itself spread, never restated. ` +
          `CONSEQUENCE: a shrunken source makes every comparison below hold over a short or ` +
          `empty list, so the profile could grant nothing and this suite would stay green — ` +
          `which is exactly how \`allow: []\` survived story 2.1. NEXT STEP: fix the constant ` +
          `in @/lib/loom-mcp or @/lib/ultra-mcp, or the import here. Do not lower the floor.`,
      );
    }
    expect(thin).toEqual([]);
  });

  for (const kind of ["project", "planner", "steerer"] as const) {
    test(`${kind}'s resolved allow IS the route's non-escalation array, element for element`, () => {
      // Order matters here only because it makes this a toEqual on arrays
      // rather than an argument about sets; the SDK does not care.
      expect([...resolveSessionProfile(ctx({ kind })).toolPolicy.allow]).toEqual(
        NON_ESCALATION_ALLOW,
      );
    });

    test(`${kind}'s resolved deny IS manifest guardrails ∪ {AskUserQuestion}`, () => {
      expect([...resolveSessionProfile(ctx({ kind })).toolPolicy.deny]).toEqual(
        NON_ESCALATION_DENY,
      );
    });
  }

  test("escalation's resolved allow IS [...LOOM_ESCALATION_READONLY_TOOLS] — all six, not three", () => {
    // Three of these six are core's built-in read tools; the other three are
    // mcp__loom__ read names that only became spellable when story 2.2 grew
    // BASE_ALLOWED_TOOLS. ESCALATION_SYSTEM_PROMPT advertises Read/Grep/Glob by
    // name ("inspect the project root"), so a short allow leaves the session
    // unable to do what its own prompt tells it to.
    expect([...resolveSessionProfile(ctx({ kind: "escalation" })).toolPolicy.allow]).toEqual(
      ESCALATION_ALLOW,
    );
  });

  test("escalation's resolved deny IS manifest ∪ {AskUserQuestion} ∪ ESC_DENY ∪ ULTRA_AUTO", () => {
    expect([...resolveSessionProfile(ctx({ kind: "escalation" })).toolPolicy.deny]).toEqual(
      ESCALATION_DENY,
    );
  });

  test("ESC_READ ∩ ESC_DENY = ∅, and answer_blocked is in NEITHER — verified, not assumed", () => {
    const overlap = [...LOOM_ESCALATION_READONLY_TOOLS].filter((t) =>
      ([...LOOM_ESCALATION_DISALLOWED_TOOLS] as string[]).includes(t),
    );
    expect(overlap).toEqual([]);
    // answer_blocked stays callable-but-human-gated — the ONLY escalation write
    // path. A port that "tidies" it into the read set breaks the moat; one that
    // tidies it into the deny set breaks the surface.
    expect([...LOOM_ESCALATION_READONLY_TOOLS]).not.toContain(LOOM_ANSWER_BLOCKED_TOOL);
    expect([...LOOM_ESCALATION_DISALLOWED_TOOLS]).not.toContain(LOOM_ANSWER_BLOCKED_TOOL);
    // …and it is not silently reachable through the resolved policy either.
    const escalation = resolveSessionProfile(ctx({ kind: "escalation" })).toolPolicy;
    expect([...escalation.allow]).not.toContain(LOOM_ANSWER_BLOCKED_TOOL);
    expect([...escalation.deny]).not.toContain(LOOM_ANSWER_BLOCKED_TOOL);
  });

  test("MOAT: no kind's resolved allow contains either human-gated tool", () => {
    for (const row of D11) {
      const allow = [...resolveSessionProfile(ctx({ kind: row.kind })).toolPolicy.allow];
      expect(allow).not.toContain(LOOM_START_TOOL);
      expect(allow).not.toContain(LOOM_ANSWER_BLOCKED_TOOL);
      expect(allow.length).toBeGreaterThan(0); // anti-vacuity, per kind
    }
  });

  test("a manifest that denies a BASE tool drops it from allow and keeps it in deny", () => {
    // The one case where the fold CHANGES the resolved value versus what the
    // route passed. Before: "Read" appeared in BOTH arrays and the SDK's
    // disallow-wins guarantee denied it. After: it is in `deny` only, and a
    // tool that is neither allowed nor denied falls through to canUseTool where
    // makeGuardrailDecision denies it on the same manifest entry. Same outcome,
    // different route to it — and this is the sharpest test of the port's
    // faithfulness.
    const strict = ProjectManifest.parse({
      name: "demo",
      root: "/repos/demo",
      account: "personal",
      guardrails: { disallowedTools: ["Read"], protectedPaths: [] },
    });
    const resolved = resolveSessionProfile(ctx({ kind: "project", manifest: strict }));
    expect([...resolved.toolPolicy.allow]).not.toContain("Read");
    expect([...resolved.toolPolicy.deny]).toContain("Read");
    // The guardrail half is what actually stops the call, so it must still
    // carry the entry — that is the deliberate redundancy, not duplication.
    expect(resolved.guardrails.disallowedTools).toContain("Read");
    // Anti-vacuity: only "Read" left; the other nineteen are untouched.
    expect(resolved.toolPolicy.allow.length).toBe(BASE_ALLOWED_TOOLS.length - 1);
  });
});

// ── the live-context arm, in a sandboxed child (story 2.2, §5.4-D) ─────────

describe("the steerer/escalation builders thread the VALIDATED loomId into the live read", () => {
  test("a loomId produces a live-context block; no loomId degrades to the static prompt alone", () => {
    // WHY A CHILD PROCESS. The live readers reach core's getLoom, whose
    // ensureMigrated() can RENAME directories under the resolved state root,
    // and outside a sandbox that root is the operator's real ~/.telar — a real
    // write from a test run, which is the failure this repo has already paid
    // for once. Mutating process.env.TELAR_HOME in the shared bun process is
    // equally forbidden (every suite runs in ONE process), so the sanctioned
    // pattern is a child with HOME and TELAR_HOME pointed at throwaway
    // directories. The child imports by ABSOLUTE PATH so a temp directory with
    // no node_modules of its own still resolves the workspace's tsconfig paths.
    //
    // It also exercises the FAIL-SAFE for real: the throwaway root holds no
    // loom at all, so every read inside buildSteererContext misses — and the
    // appendix still comes back with its static prompt and its live header
    // rather than a throw.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-profiles-live-"));
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "telar-profiles-home-"));
    try {
      const probe = path.join(dir, "probe.ts");
      fs.writeFileSync(
        probe,
        [
          `import { buildSteererProfile, buildEscalationProfile } from ${JSON.stringify(
            path.join(here, "session-profiles"),
          )};`,
          `const base = { provider: "claude", manifest: { name: "demo", root: "/repos/demo", account: "personal", guardrails: { disallowedTools: [], protectedPaths: [] } }, project: "demo", permissionMode: "default" };`,
          `const app = (o) => (o.systemPromptAppendix ?? "");`,
          `console.log(JSON.stringify({`,
          `  steererWithId: app(buildSteererProfile({ ...base, kind: "steerer", loomId: "loom_probe", ultraAnnotated: false })).includes("LIVE LOOM CONTEXT"),`,
          `  steererNoId: app(buildSteererProfile({ ...base, kind: "steerer", ultraAnnotated: false })).includes("LIVE LOOM CONTEXT"),`,
          `  steererStatic: app(buildSteererProfile({ ...base, kind: "steerer", loomId: "loom_probe", ultraAnnotated: false })).includes("steering session"),`,
          `  escalationWithId: app(buildEscalationProfile({ ...base, kind: "escalation", loomId: "loom_probe" })).includes("BLOCKED LOOM CONTEXT"),`,
          `  escalationNoId: app(buildEscalationProfile({ ...base, kind: "escalation" })).includes("BLOCKED LOOM CONTEXT"),`,
          `}));`,
        ].join("\n"),
      );
      const out = spawnSync(process.execPath, [probe], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: fakeHome,
          TELAR_HOME: path.join(dir, "telar"),
          NODE_ENV: "test",
        },
      });
      const line = (out.stdout ?? "").trim().split("\n").pop() ?? "";
      let parsed: Record<string, boolean> | null = null;
      try {
        parsed = JSON.parse(line) as Record<string, boolean>;
      } catch {
        /* fall through to the diagnostic below */
      }
      if (!parsed) {
        throw new Error(
          `story 2.2 §5.4-D: the sandboxed live-context probe produced no JSON. ` +
            `status=${out.status} stdout=${JSON.stringify(out.stdout)} ` +
            `stderr=${JSON.stringify(out.stderr)}. CONSEQUENCE: the loomId pass-through and ` +
            `the pre-stream fail-safe are BOTH unproved while this test reads as green. ` +
            `NEXT STEP: fix the probe or its module resolution — do not weaken the assertion, ` +
            `and do NOT run the readers in this process (they can write to the real ~/.telar).`,
        );
      }
      // The pass-through: a VALIDATED loomId reaches the reader…
      expect(parsed.steererWithId).toBe(true);
      expect(parsed.escalationWithId).toBe(true);
      // …and its absence degrades to the static prompt rather than crashing on
      // an `undefined!` non-null assertion, which is what the route used to do.
      expect(parsed.steererNoId).toBe(false);
      expect(parsed.escalationNoId).toBe(false);
      // The fail-safe half: no loom exists in the throwaway root, yet the moat
      // language is still there.
      expect(parsed.steererStatic).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  }, 30_000);
});

// ── story 4.1 / AC2 — ctx.sessionId reaches the wake block, in the same child ──

describe("the project/planner/steerer builders thread ctx.sessionId into the wake read", () => {
  test("a sessionId with pending wakes produces the block; no sessionId, and none of them do", () => {
    // SAME SANDBOX, SAME REASON, and it now matters for a THIRD reader. The wake
    // read (pendingUltraWakes) walks TELAR_HOME/ultra and can WRITE — a stale
    // `running` manifest self-heals to `stopped` on read — so running it in this
    // shared bun process would reconcile runs in the operator's real ~/.telar.
    // Mutating process.env.TELAR_HOME here is equally forbidden (one process for
    // every suite), so this is the sanctioned child with HOME and TELAR_HOME
    // pointed at throwaways.
    //
    // NOTE ON INV-7: that invariant scans BY NAME, and it does not know that
    // buildProjectProfile transitively reaches a state-root reader. The
    // discipline still binds where the call is indirect — which is the whole
    // reason this test is a child probe rather than three in-process calls, and
    // why `ctx()` above deliberately never sets `sessionId`.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-profiles-wake-"));
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "telar-profiles-wakehome-"));
    const telar = path.join(dir, "telar");
    try {
      // A terminal run, planted in the throwaway root, owned by the probe's
      // session. This is what makes the positive arm a real read rather than an
      // assertion about an empty directory.
      const runDir = path.join(telar, "ultra", "run_probe_1");
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(
        path.join(runDir, "manifest.json"),
        JSON.stringify({
          runId: "run_probe_1",
          sessionId: "sess_probe",
          meta: { name: "probe run" },
          state: "done",
          spend: 1.25,
          result: { probed: true },
          startedAt: 1,
          updatedAt: 2,
        }),
      );
      const probe = path.join(dir, "probe.ts");
      fs.writeFileSync(
        probe,
        [
          `import { buildProjectProfile, buildPlannerProfile, buildSteererProfile, buildEscalationProfile } from ${JSON.stringify(
            path.join(here, "session-profiles"),
          )};`,
          `const base = { provider: "claude", manifest: { name: "demo", root: "/repos/demo", account: "personal", guardrails: { disallowedTools: [], protectedPaths: [] } }, project: "demo", permissionMode: "default" };`,
          `const app = (o) => (o.systemPromptAppendix ?? "");`,
          `const H = "COMPLETED ULTRA RUNS";`,
          `console.log(JSON.stringify({`,
          `  projectWith: app(buildProjectProfile({ ...base, kind: "project", ultraAnnotated: false, sessionId: "sess_probe" })).includes(H),`,
          `  projectNone: app(buildProjectProfile({ ...base, kind: "project", ultraAnnotated: false })).includes(H),`,
          `  projectOtherSession: app(buildProjectProfile({ ...base, kind: "project", ultraAnnotated: false, sessionId: "sess_other" })).includes(H),`,
          `  plannerWith: app(buildPlannerProfile({ ...base, kind: "planner", ultraAnnotated: false, sessionId: "sess_probe" })).includes(H),`,
          `  steererWith: app(buildSteererProfile({ ...base, kind: "steerer", ultraAnnotated: false, sessionId: "sess_probe" })).includes(H),`,
          `  escalationWith: app(buildEscalationProfile({ ...base, kind: "escalation", sessionId: "sess_probe" })).includes(H),`,
          `  outcomeCarried: app(buildProjectProfile({ ...base, kind: "project", ultraAnnotated: false, sessionId: "sess_probe" })).includes("probed"),`,
          `  labelCarried: app(buildProjectProfile({ ...base, kind: "project", ultraAnnotated: false, sessionId: "sess_probe" })).includes("probe run"),`,
          `  stateCarried: app(buildProjectProfile({ ...base, kind: "project", ultraAnnotated: false, sessionId: "sess_probe" })).includes("done"),`,
          `  plannerStatic: app(buildPlannerProfile({ ...base, kind: "planner", ultraAnnotated: false, sessionId: "sess_probe" })).includes("planning, not coding"),`,
          `}));`,
        ].join("\n"),
      );
      const out = spawnSync(process.execPath, [probe], {
        encoding: "utf8",
        env: { ...process.env, HOME: fakeHome, TELAR_HOME: telar, NODE_ENV: "test" },
      });
      const line = (out.stdout ?? "").trim().split("\n").pop() ?? "";
      let parsed: Record<string, boolean> | null = null;
      try {
        parsed = JSON.parse(line) as Record<string, boolean>;
      } catch {
        /* fall through to the diagnostic below */
      }
      if (!parsed) {
        throw new Error(
          `story 4.1 / AC2: the sandboxed wake-context probe produced no JSON. ` +
            `status=${out.status} stdout=${JSON.stringify(out.stdout)} ` +
            `stderr=${JSON.stringify(out.stderr)}. CONSEQUENCE: the sessionId pass-through and ` +
            `the escalation exclusion are BOTH unproved while this test reads as green. ` +
            `NEXT STEP: fix the probe or its module resolution — do not weaken the assertion, ` +
            `and do NOT run the wake read in this process (pendingUltraWakes can WRITE, via ` +
            `getUltraManifest's self-healing rewrite, into the operator's real ~/.telar).`,
        );
      }
      // The pass-through, on all three kinds that can launch a run…
      expect(parsed.projectWith).toBe(true);
      expect(parsed.plannerWith).toBe(true);
      expect(parsed.steererWith).toBe(true);
      // …and the DISCRIMINATORS, so "it always appends the block" cannot pass.
      expect(parsed.projectNone).toBe(false);
      expect(parsed.projectOtherSession).toBe(false);
      // ESCALATION never gets it — it hard-denies every ultra tool, so an
      // outcome it cannot act on has no business in its context.
      expect(parsed.escalationWith).toBe(false);
      // The block carries the OUTCOME, not just a header — AC1's
      // "{state, result|error}" clause reaching a real profile, through the
      // real production path (pendingUltraWakes -> formatUltraWakeAppendix).
      expect(parsed.outcomeCarried).toBe(true);
      expect(parsed.labelCarried).toBe(true);
      expect(parsed.stateCarried).toBe(true);
      // …and the static prompt is untouched beside it.
      expect(parsed.plannerStatic).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  }, 30_000);
});

// ── AC6 — the Codex approval seam (story 2.2, §6.2-G) ──────────────────────

describe("AC6 the profile's guardrails govern a Codex approval, not just a Claude tool call", () => {
  beforeEach(() => {
    resetSessionProfiles();
    registerSessionProfiles();
  });

  // The EXACT shape onCodexApproval builds before it would create a pending:
  //   { command: req.command ?? (req.reason ? `[file change] ${reason}` : …),
  //     ...(req.cwd ? { cwd: req.cwd } : {}) }
  // shaped as a "Bash" card, because that is the one shape ruleFor /
  // ruleOptionsFor / the card's permissionPreview already know how to render.
  const codexInput = (req: {
    command?: string;
    cwd?: string;
    reason?: string;
  }): Record<string, unknown> => ({
    command:
      req.command ?? (req.reason ? `[file change] ${req.reason}` : "Codex requested approval"),
    ...(req.cwd ? { cwd: req.cwd } : {}),
  });

  const decide = (
    guardrails: { disallowedTools?: string[]; protectedPaths?: string[] },
    req: { command?: string; cwd?: string; reason?: string },
  ) => {
    const m = ProjectManifest.parse({
      name: "demo",
      root: "/repos/demo",
      account: "personal",
      guardrails: { disallowedTools: [], protectedPaths: [], ...guardrails },
    });
    const profile = resolveSessionProfile(ctx({ kind: "project", provider: "codex", manifest: m }));
    // The route's own call, verbatim: the PROFILE where a manifest is expected
    // (makeGuardrailDecision is structural), and the profile's cwd as the root.
    return makeGuardrailDecision(profile, profile.cwd, "Bash", codexInput(req));
  };

  test("a command touching a protectedPaths entry is DENIED — no card is ever shaped", () => {
    // Showing the human a card for something project policy already forbids
    // invites them to approve it, so the decision has to land BEFORE
    // createPending. This is the value the route branches on.
    const d = decide({ protectedPaths: [".env"] }, { command: "rm -rf .env" });
    expect(d.behavior).toBe("deny");
    expect(d.behavior === "deny" && d.message).toContain("protected path");
  });

  test("a command that touches nothing protected PROCEEDS to the card", () => {
    // The discriminator. Without it, a guardrail that denied everything would
    // satisfy the row above and Codex would be unusable — a "fix" that reads as
    // a fix and is an outage.
    expect(decide({ protectedPaths: [".env"] }, { command: "bun test" }).behavior).toBe("allow");
    expect(decide({}, { command: "rm -rf .env" }).behavior).toBe("allow");
  });

  test("a project whose guardrails disallow the Bash TOOL declines a command request", () => {
    const d = decide({ disallowedTools: ["Bash"] }, { command: "bun test" });
    expect(d.behavior).toBe("deny");
    expect(d.behavior === "deny" && d.message).toContain("disallowed by this project's guardrails");
  });

  test("THE FALSE-POSITIVE GUARD — a file-change request must NOT be denied by that same Bash entry", () => {
    // This is why the route's check is gated on `req.kind === "command"`, and
    // the restriction is MEASURED rather than cautious: onCodexApproval shapes
    // BOTH request kinds as a "Bash" card, synthesizing
    // `[file change] ${reason}` when there is no command. Running the check on
    // a file change would therefore deny EVERY file edit in a project whose
    // guardrails merely disallow the Bash tool — a false positive on a request
    // that is not a shell command at all.
    //
    // The assertion is deliberately shaped as "the raw decision WOULD deny, so
    // the kind gate is what saves it": that is the fact the route's `if`
    // depends on, and if it ever stopped being true the gate would be dead code
    // rather than a guard.
    const asIfChecked = decide({ disallowedTools: ["Bash"] }, { reason: "update src/app.ts" });
    expect(asIfChecked.behavior).toBe("deny");
    // …and the input really is the synthesized file-change shape, not a command.
    expect(codexInput({ reason: "update src/app.ts" }).command).toBe(
      "[file change] update src/app.ts",
    );
  });

  test("the guardrails being consulted are the PROFILE's, folded from the manifest", () => {
    // AC2's "by construction" at this seam: the route passes `sessionProfile`,
    // so what governs a Codex approval is the resolved guardrail set — the
    // manifest's entries unioned with anything the profile added, never fewer.
    const m = ProjectManifest.parse({
      name: "demo",
      root: "/repos/demo",
      account: "personal",
      guardrails: { disallowedTools: ["Bash"], protectedPaths: ["secrets/"] },
    });
    const profile = resolveSessionProfile(ctx({ kind: "project", provider: "codex", manifest: m }));
    expect(profile.guardrails.disallowedTools).toContain("Bash");
    expect(profile.guardrails.protectedPaths).toContain("secrets/");
    expect(profile.cwd).toBe("/repos/demo");
  });
});

describe("the gate these builders feed — the behaviour change this story ships", () => {
  beforeEach(() => {
    resetSessionProfiles();
    registerSessionProfiles();
  });

  test("a project session passes the capability gate on BOTH providers — AC5, unchanged", () => {
    for (const provider of ["claude", "codex"] as const) {
      const resolved = resolveSessionProfile(ctx({ kind: "project", provider }));
      expect(unmetCapabilities(resolved, provider)).toEqual([]);
    }
  });

  test("planner, steerer and escalation all pass on Claude", () => {
    for (const kind of ["planner", "steerer", "escalation"] as const) {
      expect(unmetCapabilities(resolveSessionProfile(ctx({ kind })), "claude")).toEqual([]);
    }
  });

  test("planner and steerer now PASS on Codex — the gap the adapter upgrade closed", () => {
    // These two required exactly one thing Codex could not do: append to the
    // system prompt. The route built that appendix and `runCodexTurn` dropped
    // it, so the gate refused the session — correctly, but the refusal was the
    // symptom, not the goal. `developerInstructions` on thread/start carries it
    // now, so both kinds resolve clean and the 400 is simply gone.
    for (const kind of ["planner", "steerer"] as const) {
      expect(unmetCapabilities(resolveSessionProfile(ctx({ kind, provider: "codex" })), "codex")).toEqual(
        [],
      );
    }
  });

  test("escalation still FAILS on Codex — and this one is not a wiring gap", () => {
    // Escalation is a read-only discuss wall enforced by PreToolUse hooks and
    // a tool deny-list. Codex has neither; it governs tool access with sandbox
    // + approvalPolicy, which is a different mechanism, not a spelling of the
    // same one. Publishing those capabilities to make this pass would let the
    // session run UNGUARDED — the gate refusing is the wall working.
    const unmet = unmetCapabilities(
      resolveSessionProfile(ctx({ kind: "escalation", provider: "codex" })),
      "codex",
    );
    expect([...unmet]).toEqual(["pre-tool-use-hooks", "tool-allow-deny-lists"]);
  });
});

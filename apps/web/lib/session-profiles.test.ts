// The four SessionProfileSpec builders, pinned against the story's own table.
//
// WHY THIS FILE EXISTS AT ALL, given packages/core already tests the fold: the
// core suite drives the resolver with SYNTHETIC specs, because core cannot
// import apps/web. So nothing in core would notice if a builder here named a
// capability that does not exist, or dropped one that does. This is the only
// place a wrong capability NAME gets caught by the gate rather than by a manual
// curl against a dev server.
//
// AND THE SIDE EFFECT, which is the other half. The builders register at MODULE
// SCOPE, and app/api/chat/route.ts depends on a bare `import
// "@/lib/session-profiles";` to trigger that. Without it the registry is empty
// at request time and every chat request 500s — and no other gate would catch
// it, because there is no test file for that route anywhere in the tree.
// KINDS_AFTER_IMPORT below captures the registry the instant this module's
// import ran, so no later reset can make that assertion lie.
// @ts-expect-error no @types/bun in this workspace
import { beforeEach, describe, expect, test } from "bun:test";
import {
  BASE_ALLOWED_TOOLS,
  ProjectManifest,
  registeredSessionKinds,
  resetSessionProfiles,
  resolveSessionProfile,
  unmetCapabilities,
  type SessionKind,
  type SessionProfileBuilder,
  type SessionResolutionContext,
} from "@telar/core";
import { LOOM_ESCALATION_READONLY_TOOLS } from "./loom-mcp";
import {
  buildEscalationProfile,
  buildPlannerProfile,
  buildProjectProfile,
  buildSteererProfile,
  registerSessionProfiles,
} from "./session-profiles";

// Captured at MODULE SCOPE, immediately after the import above — this IS the
// side effect, observed rather than described.
const KINDS_AFTER_IMPORT = [...registeredSessionKinds()];

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
  ...over,
});

// The story's D11 table, as data. Every row is checked against the REAL builder.
const D11: Array<{
  kind: SessionKind;
  build: SessionProfileBuilder;
  requiredCapabilities: readonly string[];
  systemPromptAppendix: string;
}> = [
  { kind: "project", build: buildProjectProfile, requiredCapabilities: [], systemPromptAppendix: "" },
  {
    kind: "planner",
    build: buildPlannerProfile,
    requiredCapabilities: ["system-prompt-append"],
    systemPromptAppendix: "",
  },
  {
    kind: "steerer",
    build: buildSteererProfile,
    requiredCapabilities: ["system-prompt-append"],
    systemPromptAppendix: "",
  },
  {
    kind: "escalation",
    build: buildEscalationProfile,
    requiredCapabilities: ["mcp-servers", "pre-tool-use-hooks", "tool-allow-deny-lists"],
    systemPromptAppendix: "",
  },
];

describe("the registration side effect route.ts depends on", () => {
  test("importing @/lib/session-profiles populates the registry with ALL FOUR kinds", () => {
    // If this ever reads [] the app is broken on every chat request while
    // bun test, tsc and lint all stay green. That is the whole reason this
    // assertion exists.
    expect(KINDS_AFTER_IMPORT).toEqual(["project", "planner", "steerer", "escalation"]);
  });
});

describe("the four builders carry D11's per-kind decisions", () => {
  beforeEach(() => {
    resetSessionProfiles();
    registerSessionProfiles();
  });

  for (const row of D11) {
    test(`${row.kind} declares exactly its required capabilities and its appendix`, () => {
      const spec = row.build(ctx({ kind: row.kind }));
      expect([...spec.requiredCapabilities]).toEqual([...row.requiredCapabilities]);
      expect(spec.systemPromptAppendix ?? "").toBe(row.systemPromptAppendix);
    });

    test(`${row.kind} resolves through the registry to the same capability set`, () => {
      // Not the same assertion as above: this one goes through
      // registerSessionProfiles -> resolveSessionProfile, so a builder wired to
      // the WRONG KEY would be caught here and not by the direct call.
      const resolved = resolveSessionProfile(ctx({ kind: row.kind }));
      expect(resolved.kind).toBe(row.kind);
      expect([...resolved.requiredCapabilities]).toEqual([...row.requiredCapabilities]);
      expect(resolved.systemPromptAppendix).toBe(row.systemPromptAppendix);
    });
  }

  test("every builder loads the repo's settings and NOT the user's", () => {
    for (const row of D11) {
      expect(resolveSessionProfile(ctx({ kind: row.kind })).settingSources).toEqual([
        "project",
        "local",
      ]);
    }
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

  test("the escalation profile grants ONLY the base tools its own branch auto-runs", () => {
    // The route's escalation branch sets allowedTools to
    // [...LOOM_ESCALATION_READONLY_TOOLS], and three of core's six base tools
    // are in it: Read, Grep and Glob (ESCALATION_SYSTEM_PROMPT advertises them
    // by name — "inspect the project root").
    expect(resolveSessionProfile(ctx({ kind: "escalation" })).toolPolicy.allow).toEqual([
      "Read",
      "Grep",
      "Glob",
    ]);
    // …while an ordinary project session keeps the whole base set.
    expect(resolveSessionProfile(ctx({ kind: "project" })).toolPolicy.allow.length).toBe(
      BASE_ALLOWED_TOOLS.length,
    );
  });

  test("that escalation grant IS the route's own toolset ∩ the base set — measured, not restated", () => {
    // The literal above is a copy of a measurement, and a copy goes stale in
    // silence: nothing consumes toolPolicy until 2.2, so a drifted `allow`
    // would fail no test and no request. This row re-derives it from the two
    // real constants — @/lib/loom-mcp's array (which route.ts wires verbatim as
    // the escalation session's allowedTools) intersected with core's base set —
    // so if either source moves, the builder's value is what gets indicted.
    // The first revision of this file shipped `allow: []` on the claim that
    // NONE of the six appeared in that array; three do.
    const branchGrants = LOOM_ESCALATION_READONLY_TOOLS as readonly string[];
    const measured = BASE_ALLOWED_TOOLS.filter((t) => branchGrants.includes(t));
    expect(measured.length).toBeGreaterThan(0); // anti-vacuity: an empty ∩ would pass by accident
    expect([...resolveSessionProfile(ctx({ kind: "escalation" })).toolPolicy.allow].sort()).toEqual(
      [...measured].sort(),
    );
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

  test("planner, steerer and escalation all FAIL on Codex — the disclosed behaviour change", () => {
    // Deliberate, and it is the point of AD-11: today each of these returns a
    // 200 that silently drops the thing that made it that kind of session.
    for (const kind of ["planner", "steerer", "escalation"] as const) {
      const unmet = unmetCapabilities(resolveSessionProfile(ctx({ kind, provider: "codex" })), "codex");
      expect(unmet.length).toBeGreaterThan(0);
    }
  });
});

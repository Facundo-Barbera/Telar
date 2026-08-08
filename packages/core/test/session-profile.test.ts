// AD-9 / AD-10 / AD-11 — the SessionProfile port: the typed profile, the
// intersect-only tool policy, and the capability gate that fires before the
// stream opens.
//
// THE THREE THINGS THIS FILE HAS TO PROVE, in the story's own order — because
// three PROPERTIES are the story, not the field list:
//   1. THE GUARDRAIL IS OUTSIDE THE PROFILE. No field here can reach hook
//      registration, and guardrail DATA can only ever be ADDED to: a spec
//      asking for nothing still gets the manifest's entries. The field-set pin
//      itself lives in invariants.test.ts as INV-6a (AC6 asks for "the
//      invariant suite"); what this file proves is the fold's behaviour.
//   2. OVER-GRANTING DOES NOT COMPILE. `toolPolicy` is intersect-only BY ITS
//      TYPE, and a claim about a TYPE has to be proved by running the compiler
//      — packages/core/tsconfig.json is `include: ["src"], exclude: ["test",
//      "node_modules"]`, so `bunx tsc --noEmit` in this workspace NEVER SEES
//      THIS FILE and a bare `// @ts-expect-error` here would be a comment
//      wearing a test's clothes. Both directions, every time.
//   3. AN UNMET CAPABILITY FAILS EARLY. unmetCapabilities names what is
//      missing; the route turns that into its existing pre-SSE 400, and the
//      ORDERING of that call site is pinned mechanically by INV-6c.
//
// NO TELAR_HOME SANDBOX, DELIBERATELY, and the absence is the point. The port
// is PURE: it resolves no state root, reads no env, opens no file and imports
// none of node:fs / node:os / node:path. So there is nothing to sandbox, and a
// suite that pinned a root it never used would be misleading about what the
// module does. This is also why the imports below are plain static imports
// rather than the dynamic-import-after-pinning-the-root form the file-touching
// suites use. INV-3a's path-composition inventory is unchanged by this story
// for exactly the same reason.
//
// STILL TRUE AFTER STORY 5.6's anchor registry, and it is worth saying why: an
// anchor RESOLVER may touch the disk (apps/web's master anchor calls
// ensureWorkspace()), but core only stores and calls it, and every anchor in
// this file is a pure fake returning a parsed manifest. The suite that runs the
// real, disk-touching one is apps/web/lib/session-profiles.test.ts, and it runs
// it in a CHILD PROCESS with TELAR_HOME pointed at a temp dir — never in this
// shared one.
//
// MODULE-SINGLETON HAZARD. The profile registry is a module-scope Map and bun
// runs EVERY test file in ONE process, so it leaks across suites: without a
// reset a duplicate-registration throw from one file would take down another,
// in an order that is not stable. resetSessionProfiles() runs in beforeEach —
// the same discipline resetBus() and resetAdmission({}) exist for.
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
  PROVIDER_CAPABILITIES,
  PROVIDERS,
  ProjectManifest,
  providerCapabilities,
  providerPublishes,
  registerSessionAnchor,
  registerSessionProfile,
  registeredAnchorKinds,
  registeredSessionKinds,
  resetSessionProfiles,
  resolveSessionAnchor,
  resolveSessionKind,
  resolveSessionProfile,
  SESSION_KINDS,
  sessionKindFromRole,
  sessionRoleFromWire,
  ULTRA_AUTO_TOOL_NAMES,
  unmetCapabilities,
  WORKSPACE_AUTO_TOOL_NAMES,
  type ProviderCapability,
  type SessionProfileSpec,
  type SessionResolutionContext,
} from "../src/index";

beforeEach(() => {
  resetSessionProfiles();
});

// A REAL manifest, parsed through the owning zod schema rather than hand-built
// and cast: the fold reads manifest.root and manifest.guardrails, and a cast
// fixture could drift from the shape production actually hands it.
const manifestWith = (guardrails?: {
  disallowedTools?: string[];
  protectedPaths?: string[];
}): ProjectManifest =>
  ProjectManifest.parse({
    name: "demo",
    root: "/repos/demo",
    account: "personal",
    ...(guardrails ? { guardrails } : {}),
  });

const ctx = (over: Partial<SessionResolutionContext> = {}): SessionResolutionContext => ({
  kind: "project",
  provider: "claude",
  manifest: manifestWith(),
  project: "demo",
  permissionMode: "default",
  // The per-turn Ultra chip (story 2.2). Required on the context, so the
  // default here is the ordinary turn and every test that cares says so.
  ultraAnnotated: false,
  ...over,
});

// The kinds as the web builders declare them (D11's table). Registered
// here as synthetic specs because core cannot import apps/web — the REAL
// builders are pinned against this same table in
// apps/web/lib/session-profiles.test.ts, which is the only place a wrong
// capability NAME in a builder gets caught by the gate rather than by a manual
// curl.
const D11_REQUIRED: Record<string, readonly ProviderCapability[]> = {
  project: [],
  planner: ["system-prompt-append"],
  steerer: ["system-prompt-append"],
  escalation: ["mcp-servers", "pre-tool-use-hooks", "tool-allow-deny-lists"],
  // STORY 5.6's project-less master. The same three as escalation and for
  // parallel reasons — its workspace MCP mount, the moat's PreToolUse hook and
  // an allow-narrowing — and deliberately NOT `setting-sources`: the master
  // asks the harness for nothing (`settingSources: []`), so requiring the
  // capability would 400 a provider over a feature it switches off.
  master: ["mcp-servers", "pre-tool-use-hooks", "tool-allow-deny-lists"],
};

const registerEveryKind = (): void => {
  for (const kind of SESSION_KINDS) {
    registerSessionProfile(kind, () => ({
      kind,
      settingSources: [...NATIVE_CLAUDE_SETTING_SOURCES],
      // The escalation narrowing mirrors the real builder: the route's
      // escalation branch auto-ran [...LOOM_ESCALATION_READONLY_TOOLS], and
      // since story 2.2 grew BASE_ALLOWED_TOOLS to the full auto-run
      // vocabulary, ALL SIX of those names are spellable here — the three
      // built-in read tools plus the three mcp__loom__ read tools. (It read
      // `allow: ["Read","Grep","Glob"]` before the tuple grew, and `allow: []`
      // before review caught THAT claim as false. Nothing in this file asserts
      // on the value; a mirror that contradicts what it mirrors is how a wrong
      // value gets re-derived later, which is why it is kept honest.)
      //
      // Core cannot import apps/web, so this is a MIRROR and not the pin. The
      // pin — this list against @/lib/loom-mcp's real constant — lives in
      // apps/web/lib/session-profiles.test.ts, the one file that sees both
      // worlds.
      toolPolicy:
        kind === "escalation"
          ? {
              allow: [
                "Read",
                "Grep",
                "Glob",
                "mcp__loom__read_bundle",
                "mcp__loom__get_loom",
                "mcp__loom__list_looms",
              ],
              deny: ["AskUserQuestion"],
            }
          : kind === "master"
            ? {
                // STORY 5.6's master mirrors escalation's SHAPE — an explicit
                // allow-narrowing — with the workspace names in place of the
                // loom ones, because the workspace server is the only thing it
                // mounts. Same standing as the mirror above: nothing here
                // asserts on the value, and the pin against the real
                // WORKSPACE_AUTO_TOOLS constant lives in the web suite.
                allow: [
                  "Read",
                  "Grep",
                  "Glob",
                  "mcp__workspace__list_items",
                  "mcp__workspace__list_lanes",
                  "mcp__workspace__create_item",
                  "mcp__workspace__update_item",
                ],
                deny: ["AskUserQuestion"],
              }
            : { deny: ["AskUserQuestion"] },
      requiredCapabilities: D11_REQUIRED[kind]!,
      systemPromptAppendix: "",
    }));
  }
};

// ── AC1 — a typed profile, resolved from a registered kind ──────────────────

describe("AC1 the fold — a typed SessionProfile with AD-9's seven fields plus the registry key", () => {
  test("AC1 each registered kind resolves to a profile carrying all eight fields", () => {
    registerEveryKind();
    for (const kind of SESSION_KINDS) {
      const resolved = resolveSessionProfile(ctx({ kind }));
      // The field inventory, asserted as a VALUE so the diff bun prints is the
      // diagnosis. INV-6a pins the same eight against the source declaration.
      expect(Object.keys(resolved).sort()).toEqual([
        "cwd",
        "guardrails",
        "kind",
        "mcpServers",
        "requiredCapabilities",
        "settingSources",
        "systemPromptAppendix",
        "toolPolicy",
      ]);
      expect(resolved.kind).toBe(kind);
      expect(resolved.requiredCapabilities).toEqual(D11_REQUIRED[kind]!);
      expect(resolved.settingSources).toEqual(NATIVE_CLAUDE_SETTING_SOURCES);
      // No undefined at the seam: a consumer never has to read a missing field
      // as "everything", which is the reading that would turn an omission into
      // a grant.
      expect(resolved.systemPromptAppendix).toBe("");
      expect(resolved.mcpServers).toEqual({});
    }
  });

  test("AC1 cwd comes from the CONTEXT, never from the spec — no profile can redirect where a session runs", () => {
    registerEveryKind();
    const resolved = resolveSessionProfile(
      ctx({ kind: "planner", manifest: manifestWith() }),
    );
    expect(resolved.cwd).toBe("/repos/demo");
    // A different manifest root moves it, which is the only thing that may.
    const elsewhere = ProjectManifest.parse({ name: "other", root: "/repos/other" });
    expect(resolveSessionProfile(ctx({ kind: "planner", manifest: elsewhere })).cwd).toBe(
      "/repos/other",
    );
  });

  test("AC1 registering a duplicate kind THROWS, naming the collision", () => {
    registerSessionProfile("project", () => ({
      kind: "project",
      settingSources: ["project"],
      toolPolicy: { deny: [] },
      requiredCapabilities: [],
    }));
    expect(() =>
      registerSessionProfile("project", () => ({
        kind: "project",
        settingSources: ["local"],
        toolPolicy: { deny: [] },
        requiredCapabilities: [],
      })),
    ).toThrow(/session-profile: cannot register "project"/);
  });

  test("AC1 resolving an unregistered kind THROWS, naming what IS registered", () => {
    registerSessionProfile("project", () => ({
      kind: "project",
      settingSources: ["project"],
      toolPolicy: { deny: [] },
      requiredCapabilities: [],
    }));
    let message = "";
    try {
      resolveSessionProfile(ctx({ kind: "escalation" }));
    } catch (e) {
      message = (e as Error).message;
    }
    // The message has to name the missing kind AND what is declared, or it
    // cannot tell a reader that the real cause is a missing side-effect import.
    expect(message).toContain('cannot resolve "escalation"');
    expect(message).toContain("no module declared it");
    expect(message).toContain("Declared kinds: project");
    expect(message).toContain("MODULE SCOPE");
  });

  test("resetSessionProfiles() empties the registry — the module-singleton mitigation actually works", () => {
    registerEveryKind();
    expect(registeredSessionKinds()).toEqual([
      "project",
      "planner",
      "steerer",
      "escalation",
      "master",
    ]);
    resetSessionProfiles();
    expect(registeredSessionKinds()).toEqual([]);
    // …and re-registering after a reset does not throw, which is what makes
    // beforeEach a mitigation rather than a second failure mode.
    expect(() => registerEveryKind()).not.toThrow();
  });

  test("AC1 a builder returning a spec for a DIFFERENT kind is refused, not silently applied", () => {
    registerSessionProfile("planner", () => ({
      kind: "escalation",
      settingSources: ["project"],
      toolPolicy: { deny: [] },
      requiredCapabilities: [],
    }));
    expect(() => resolveSessionProfile(ctx({ kind: "planner" }))).toThrow(
      /returned a spec for "escalation"/,
    );
  });
});

// ── AC2 — guardrail DATA unions; it never replaces ──────────────────────────

describe("AC2 guardrails union — a profile may add restriction, never remove it", () => {
  const register = (spec: Partial<SessionProfileSpec>) =>
    registerSessionProfile("project", () => ({
      kind: "project",
      settingSources: ["project", "local"],
      toolPolicy: { deny: [] },
      requiredCapabilities: [],
      ...spec,
    }));

  test("AC2 a spec asking for an EMPTY guardrail set still yields the manifest's entries", () => {
    register({ addDisallowedTools: [], addProtectedPaths: [] });
    const resolved = resolveSessionProfile(
      ctx({
        manifest: manifestWith({
          disallowedTools: ["Bash", "Write"],
          protectedPaths: [".env", "secrets/"],
        }),
      }),
    );
    // This is the whole of AD-10's guardrail half: there is no way to spell
    // "replace", so a mis-authored profile cannot widen access by handing back
    // an empty set.
    expect(resolved.guardrails.disallowedTools).toEqual(["Bash", "Write"]);
    expect(resolved.guardrails.protectedPaths).toEqual([".env", "secrets/"]);
  });

  test("AC2 a spec that adds NOTHING AT ALL (both fields omitted) still yields the manifest's entries", () => {
    register({});
    const resolved = resolveSessionProfile(
      ctx({ manifest: manifestWith({ disallowedTools: ["Bash"], protectedPaths: [".env"] }) }),
    );
    expect(resolved.guardrails).toEqual({
      disallowedTools: ["Bash"],
      protectedPaths: [".env"],
    });
  });

  test("AC2 the union is a UNION — manifest entries first, spec additions after, deduplicated", () => {
    register({
      addDisallowedTools: ["Bash", "Edit"],
      addProtectedPaths: [".env", "infra/"],
    });
    const resolved = resolveSessionProfile(
      ctx({
        manifest: manifestWith({
          disallowedTools: ["Bash", "Write"],
          protectedPaths: [".env", "secrets/"],
        }),
      }),
    );
    expect(resolved.guardrails.disallowedTools).toEqual(["Bash", "Write", "Edit"]);
    expect(resolved.guardrails.protectedPaths).toEqual([".env", "secrets/", "infra/"]);
  });

  test("AC2 systemPromptAppendix is ADDITIVE-ONLY by name and defaults to \"\", never undefined", () => {
    register({ systemPromptAppendix: "extra guidance" });
    expect(resolveSessionProfile(ctx()).systemPromptAppendix).toBe("extra guidance");
    resetSessionProfiles();
    register({});
    // The route's systemPrompt is ALWAYS { type: "preset", preset:
    // "claude_code", append?: … }, so this text can only ever follow the SDK's
    // preset. There is no field here that could REPLACE it — which is what the
    // name promises and what makes it safe under AD-10.
    expect(resolveSessionProfile(ctx()).systemPromptAppendix).toBe("");
  });
});

// ── AC3 — the runtime half of intersect-only ────────────────────────────────

describe("AC3 the runtime intersect — enforced twice, so a cast cannot widen either", () => {
  const registerPolicy = (toolPolicy: SessionProfileSpec["toolPolicy"]) =>
    registerSessionProfile("project", () => ({
      kind: "project",
      settingSources: ["project"],
      toolPolicy,
      requiredCapabilities: [],
    }));

  test("AC3 an absent `allow` means the whole base set, not 'everything'", () => {
    registerPolicy({ deny: [] });
    expect(resolveSessionProfile(ctx()).toolPolicy.allow).toEqual([...BASE_ALLOWED_TOOLS]);
  });

  test("AC3 `allow` NARROWS — a subset stays a subset", () => {
    registerPolicy({ allow: ["Read", "Grep"], deny: [] });
    expect(resolveSessionProfile(ctx()).toolPolicy.allow).toEqual(["Read", "Grep"]);
  });

  test("AC3 a CAST-widened allow is filtered back to the base intersection at runtime", () => {
    // The type already forbids authoring this. The runtime intersect is the
    // second of AD-1's "enforced twice", and it is what holds against an `as`
    // cast, a JSON.parse, or a future deserialization boundary.
    registerPolicy({
      allow: ["Read", "Bash", "Write", "mcp__loom__start_loom"] as unknown as SessionProfileSpec["toolPolicy"]["allow"],
      deny: [],
    });
    expect(resolveSessionProfile(ctx()).toolPolicy.allow).toEqual(["Read"]);
  });

  test("AC3 `deny` BEATS `allow` for the same tool name — the SDK's own guarantee, held here too", () => {
    registerPolicy({ allow: ["Read", "Grep", "Glob"], deny: ["Grep"] });
    const resolved = resolveSessionProfile(ctx());
    expect(resolved.toolPolicy.allow).toEqual(["Read", "Glob"]);
    expect(resolved.toolPolicy.deny).toEqual(["Grep"]);
  });

  test("AC3 `deny` may name ANYTHING — denying more is always safe, so it is not keyed to the base union", () => {
    // All three are OUTSIDE the base union — deliberately, and the third is the
    // interesting one: mcp__loom__start_loom is the human-gated commit, and
    // core keeps it out of BASE_ALLOWED_TOOLS so no profile can ever grant it.
    // It used to read `mcp__ultra__ultra` here, which story 2.2 moved INTO the
    // union; leaving it would have turned this row into a second (and much
    // less legible) copy of the "deny beats allow" test above.
    registerPolicy({ deny: ["Bash", "AskUserQuestion", "mcp__loom__start_loom"] });
    const resolved = resolveSessionProfile(ctx());
    expect(resolved.toolPolicy.deny).toEqual(["Bash", "AskUserQuestion", "mcp__loom__start_loom"]);
    // …and denying a non-base tool does not disturb the base allow set.
    expect(resolved.toolPolicy.allow).toEqual([...BASE_ALLOWED_TOOLS]);
  });

  test("AC3 denying an MCP AUTO-RUN tool DOES narrow the allow set — it is inside the union now", () => {
    // The other half of the row above, and the behaviour change story 2.2's
    // grown tuple introduces: mcp__ultra__ultra is a BASE tool since the
    // vocabulary grew, so denying it removes it from `allow` exactly the way
    // denying "Grep" does. Before the growth this was impossible to express.
    registerPolicy({ deny: ["mcp__ultra__ultra"] });
    const allow = resolveSessionProfile(ctx()).toolPolicy.allow;
    expect(allow).not.toContain("mcp__ultra__ultra");
    expect(allow).toContain("mcp__ultra__ultra_status");
    expect(allow.length).toBe(BASE_ALLOWED_TOOLS.length - 1);
  });

  test("AC3 both resolved policy fields are non-optional, so a consumer never reads undefined as 'everything'", () => {
    registerPolicy({ deny: [] });
    const policy = resolveSessionProfile(ctx()).toolPolicy;
    expect(Object.keys(policy).sort()).toEqual(["allow", "deny"]);
    expect(Array.isArray(policy.allow)).toBe(true);
    expect(Array.isArray(policy.deny)).toBe(true);
  });
});

// ── AC4/AC5 — pre-stream kind detection, and the capability check ───────────

describe("AC4 the kind comes from what the WIRE reliably carries — under-detection is the safe direction", () => {
  test("AC4 a context with NO wire role resolves to kind `project` — under-detection, which requires nothing", () => {
    // The route derives existingChat and loomLink INSIDE its stream closure, so
    // a resumed planner/steerer whose client omitted `role` cannot be seen
    // pre-stream. Falling to `project` gives it a WEAKER requirement, never a
    // spurious 400 — which is the property that makes this design safe to ship
    // additively.
    expect(sessionKindFromRole(undefined)).toBe("project");
    expect(sessionKindFromRole("")).toBe("project");
    expect(sessionKindFromRole("something-else")).toBe("project");
  });

  test("AC4 role `escalation` on the wire resolves to kind `escalation` WITHOUT a validated loomId", () => {
    // The route's own comment: the client "sends it on every turn including
    // reattached ones", so the wire role alone is sufficient. A Codex account
    // cannot run an escalation session whether or not the loom id resolves.
    expect(sessionKindFromRole("escalation")).toBe("escalation");
    registerEveryKind();
    const resolved = resolveSessionProfile(
      ctx({ kind: sessionKindFromRole("escalation"), role: "escalation" }),
    );
    expect(resolved.kind).toBe("escalation");
    expect(resolved.requiredCapabilities).toEqual(D11_REQUIRED.escalation!);
  });

  test("AC4 planner and steerer map through the same derivation", () => {
    expect(sessionKindFromRole("planner")).toBe("planner");
    expect(sessionKindFromRole("steerer")).toBe("steerer");
  });
});

// ── story 2.2 — the SHARPENED kind, resolved from everything the preamble sees ─

describe("2.2 sessionRoleFromWire — one home for 'which strings are session roles'", () => {
  test("the four recognized values narrow, and everything else collapses to undefined", () => {
    expect(sessionRoleFromWire("planner")).toBe("planner");
    expect(sessionRoleFromWire("steerer")).toBe("steerer");
    expect(sessionRoleFromWire("escalation")).toBe("escalation");
    // STORY 5.6 — `master` is the fourth, and it is the one the route's ANCHOR
    // gate reads: a wire value this function does not recognise resolves to
    // kind `project` and gets the project gate it always had, so a master
    // session that misspells its own role degrades into a 400 rather than into
    // a project-less session with a project's tools.
    expect(sessionRoleFromWire("master")).toBe("master");
    // The fail-safe half: a stray, absent or hostile wire value can never be
    // mistaken for a real loom turn. This is the route's own eight-line ternary,
    // moved rather than reinvented — it was the SECOND copy of this fact and
    // resolveSessionKind below would have been the third.
    for (const bad of [undefined, null, "", "PLANNER", "project", 1, true, {}, ["steerer"]]) {
      expect(sessionRoleFromWire(bad)).toBeUndefined();
    }
  });

  test("it agrees with sessionKindFromRole on every value it accepts", () => {
    // Two functions answering adjacent questions about the same three strings.
    // If they ever disagree, the wire narrowing and the kind narrowing have
    // drifted and one of them is lying about what a role is.
    for (const raw of ["planner", "steerer", "escalation", "master"]) {
      expect(sessionRoleFromWire(raw)).toBe(sessionKindFromRole(raw) as never);
    }
    expect(sessionKindFromRole(sessionRoleFromWire("nonsense"))).toBe("project");
  });
});

describe("2.2 resolveSessionKind — the route's own precedence, as an ordered fold", () => {
  test("no role and no link at all resolves to `project`", () => {
    expect(resolveSessionKind({})).toBe("project");
  });

  test("wire role alone: planner resolves planner, and a bare steerer/escalation does NOT", () => {
    expect(resolveSessionKind({ role: "planner" })).toBe("planner");
    // steerer is decided by the LINK role, never by the wire role on its own —
    // the route only ever sets loomLink.role = "steerer" alongside a VALIDATED
    // loom id, so a wire `role: "steerer"` whose loom did not resolve is a
    // plain session. Under-detection, the safe direction.
    expect(resolveSessionKind({ role: "steerer" })).toBe("project");
  });

  test("escalation needs the wire role AND a resolved loomId — without the id it fails SAFE", () => {
    expect(resolveSessionKind({ role: "escalation", loomId: "loom_1" })).toBe("escalation");
    // This is T-8: a bad or foreign loomId leaves loomLink.loomId undefined and
    // the session runs as a plain one, exactly as the route has always done. It
    // must never become a 400 — a 400 that depends on whether a client resent a
    // field is a non-deterministic failure. `project` requires NO capability,
    // so this direction can never produce a spurious one.
    expect(resolveSessionKind({ role: "escalation" })).toBe("project");
    expect(resolveSessionKind({ role: "escalation", loomId: "" })).toBe("project");
  });

  test("the PERSISTED link drives a resumed session whose client omitted `role`", () => {
    // The whole reason story 2.2 hoisted getChat into the preamble. Before it,
    // these three resolved as `project` and — once query() is driven from the
    // profile — that would have silently stripped the guidance that IS the kind
    // from every resumed loom session.
    expect(resolveSessionKind({ linkRole: "planner", loomId: "loom_1" })).toBe("planner");
    expect(resolveSessionKind({ linkRole: "steerer", loomId: "loom_1" })).toBe("steerer");
    // …and a persisted ESCALATION link with no wire role is NOT escalation: the
    // route's own comment records that the client "sends it on every turn
    // including reattached ones", so the wire role is authoritative for that
    // kind. Measured from the old isEscalationSession, which read the wire
    // `role` and not loomLink.role.
    expect(resolveSessionKind({ linkRole: "escalation", loomId: "loom_1" })).toBe("project");
  });

  test("THE COLLISION CASE — persisted steerer + wire planner resolves STEERER, because order is load-bearing", () => {
    // A session can satisfy two predicates at once. In the old route this turn
    // was BOTH isSteererSession and isPlannerSession, and the systemPrompt
    // ternary chain — escalation, then steerer, then planner — resolved it as
    // steerer. An unordered Record or a set of independent `if`s would not
    // reproduce that; this is the one behaviour a careless port changes in
    // silence, so it gets its own row.
    expect(resolveSessionKind({ role: "planner", linkRole: "steerer", loomId: "loom_1" })).toBe(
      "steerer",
    );
    // …and escalation outranks steerer, the other rung of the same ladder.
    expect(
      resolveSessionKind({ role: "escalation", linkRole: "steerer", loomId: "loom_1" }),
    ).toBe("escalation");
  });

  test("`linkRole === \"planner\"` is EXACTLY the old `existingChat?.role === \"planner\"`", () => {
    // The route builds loomLink.role as
    //   existingChat?.role ?? (wireLoomId && (role === "steerer" || role === "escalation") ? role : undefined)
    // whose fallback arm can only ever produce "steerer" or "escalation" —
    // never "planner". So linkRole is "planner" IFF the persisted role is, and
    // `role === "planner" || linkRole === "planner"` is the old boolean
    // verbatim. If that fallback ever grows a third arm this equivalence dies
    // silently, which is why it is written down as an executable row.
    const oldBoolean = (wireRole?: string, persistedRole?: string) =>
      wireRole === "planner" || persistedRole === "planner";
    for (const wireRole of [undefined, "planner", "steerer", "escalation"] as const) {
      for (const persisted of [undefined, "planner", "steerer", "escalation"] as const) {
        // Reproduce the route's own merge, including its steerer/escalation-only
        // fallback arm.
        const linkRole =
          persisted ??
          (wireRole === "steerer" || wireRole === "escalation" ? wireRole : undefined);
        const kind = resolveSessionKind({ role: wireRole, linkRole, loomId: "loom_1" });
        // Whenever the old boolean said planner AND neither higher rung fired,
        // the fold must say planner too.
        const higherRungFired = wireRole === "escalation" || linkRole === "steerer";
        if (oldBoolean(wireRole, persisted) && !higherRungFired) expect(kind).toBe("planner");
      }
    }
  });

  test("resolveSessionKind DISCRIMINATES — the fold does not answer `planner` to everything", () => {
    // Anti-vacuity for the loop above, which only asserts on rows where its
    // premise holds: a fold that returned "planner" unconditionally would
    // satisfy every one of those assertions.
    const answers = new Set(
      (
        [
          {},
          { role: "planner" },
          { linkRole: "steerer", loomId: "l" },
          { role: "escalation", loomId: "l" },
          { role: "master" },
        ] as const
      ).map((i) => resolveSessionKind(i)),
    );
    expect([...answers].sort()).toEqual([
      "escalation",
      "master",
      "planner",
      "project",
      "steerer",
    ]);
  });

  test("every kind resolveSessionKind can return HAS a registered builder — no unreachable answer", () => {
    // The fold's output is a registry key. A member of SessionKind it could
    // return but nothing declares would throw on the live path, and the throw
    // would say "no module declared it" for a kind the resolver itself just
    // invented.
    registerEveryKind();
    // `master` joined this list in story 5.6 and is reachable the same way the
    // others are — from the wire, `{ role: "master" }`, asserted below.
    const reachable = ["project", "planner", "steerer", "escalation", "master"];
    expect([...registeredSessionKinds()].sort()).toEqual([...reachable].sort());
  });
});

describe("2.2 the fold unions the manifest's deny set into toolPolicy.deny", () => {
  const registerPolicy = (toolPolicy: SessionProfileSpec["toolPolicy"]) =>
    registerSessionProfile("project", () => ({
      kind: "project",
      settingSources: ["project"],
      toolPolicy,
      requiredCapabilities: [],
    }));

  test("deny ⊇ guardrails.disallowedTools — one field carries the whole deny set", () => {
    registerPolicy({ deny: ["AskUserQuestion"] });
    const resolved = resolveSessionProfile(
      ctx({ manifest: manifestWith({ disallowedTools: ["Bash", "Write"] }) }),
    );
    // Manifest entries FIRST, preserving the manifest's own ordering, then the
    // spec's additions — the unionOrdered contract. The route used to compose
    // exactly this by hand and a consumer reading toolPolicy.deny alone would
    // have silently received half of it.
    expect(resolved.toolPolicy.deny).toEqual(["Bash", "Write", "AskUserQuestion"]);
    const missing = resolved.guardrails.disallowedTools.filter(
      (t) => !resolved.toolPolicy.deny.includes(t),
    );
    expect(missing).toEqual([]);
  });

  test("the deliberate redundancy holds for EVERY registered kind, spec additions included", () => {
    resetSessionProfiles();
    registerEveryKind();
    for (const kind of SESSION_KINDS) {
      const resolved = resolveSessionProfile(
        ctx({ kind, manifest: manifestWith({ disallowedTools: ["Bash", "Write"] }) }),
      );
      // Anti-vacuity: an empty guardrail set would satisfy the subset claim.
      expect(resolved.guardrails.disallowedTools.length).toBeGreaterThan(0);
      for (const t of resolved.guardrails.disallowedTools) {
        expect(resolved.toolPolicy.deny).toContain(t);
      }
    }
  });

  test("a spec's addDisallowedTools reaches BOTH guardrails and the SDK deny list", () => {
    // The fold reads the RESOLVED guardrails, not the raw manifest, so a
    // profile that adds restriction adds it to both mechanisms rather than to
    // only the one the reader happens to consult.
    registerPolicy({ deny: ["AskUserQuestion"] });
    resetSessionProfiles();
    registerSessionProfile("project", () => ({
      kind: "project",
      settingSources: ["project"],
      toolPolicy: { deny: ["AskUserQuestion"] },
      requiredCapabilities: [],
      addDisallowedTools: ["Edit"],
    }));
    const resolved = resolveSessionProfile(
      ctx({ manifest: manifestWith({ disallowedTools: ["Bash"] }) }),
    );
    expect(resolved.guardrails.disallowedTools).toEqual(["Bash", "Edit"]);
    expect(resolved.toolPolicy.deny).toEqual(["Bash", "Edit", "AskUserQuestion"]);
  });

  test("THE SHARPEST CASE — a manifest that denies a BASE tool drops it from `allow` too", () => {
    // Before story 2.2 the route passed "Read" in BOTH allowedTools and
    // disallowedTools and leaned on the SDK's documented "a disallow beats any
    // allow" guarantee. Now it is in `deny` only, and the fold's own
    // deny-beats-allow filter removes it from `allow`. SAME OUTCOME, different
    // route to it: a tool that is neither allowed nor denied falls through to
    // canUseTool, where makeGuardrailDecision denies it on that same manifest
    // entry — which is why the redundancy in the previous test matters.
    registerPolicy({ deny: ["AskUserQuestion"] });
    const resolved = resolveSessionProfile(
      ctx({ manifest: manifestWith({ disallowedTools: ["Read"] }) }),
    );
    expect(resolved.toolPolicy.allow).not.toContain("Read");
    expect(resolved.toolPolicy.deny).toContain("Read");
    // Anti-vacuity: the rest of the base set is untouched, so this is not
    // passing because `allow` collapsed.
    expect(resolved.toolPolicy.allow.length).toBe(BASE_ALLOWED_TOOLS.length - 1);
    expect(resolved.toolPolicy.allow).toContain("Grep");
  });

  test("an omitted `allow` still means the whole base set — now twenty-four names, not six", () => {
    registerPolicy({ deny: [] });
    const allow = resolveSessionProfile(ctx()).toolPolicy.allow;
    expect(allow).toEqual([...BASE_ALLOWED_TOOLS]);
    // Order is the route's own literal order, which is what makes the
    // per-kind equivalence table in apps/web a `toEqual` on arrays rather than
    // an argument about sets.
    expect(allow.slice(0, 6)).toEqual([
      "Read",
      "Grep",
      "Glob",
      "WebSearch",
      "WebFetch",
      "ToolSearch",
    ]);
    const loomEnd = 6 + LOOM_AUTO_TOOL_NAMES.length;
    const ultraEnd = loomEnd + ULTRA_AUTO_TOOL_NAMES.length;
    const workspaceEnd = ultraEnd + WORKSPACE_AUTO_TOOL_NAMES.length;
    expect(allow.slice(6, loomEnd)).toEqual([...LOOM_AUTO_TOOL_NAMES]);
    // THE OLD ASSERTION WAS A ONE-ARGUMENT slice(6 + LOOM_AUTO_TOOL_NAMES.length)
    // — "index 17 to the end" — and it was RIGHT while ultra's three were the
    // tail. With the workspace's four appended it would compare seven elements
    // against three, so both bounds are now explicit and the tail is named.
    expect(allow.slice(loomEnd, ultraEnd)).toEqual([...ULTRA_AUTO_TOOL_NAMES]);
    expect(allow.slice(ultraEnd, workspaceEnd)).toEqual([...WORKSPACE_AUTO_TOOL_NAMES]);
    expect(allow.slice(workspaceEnd)).toEqual([...BROWSER_READ_TOOL_NAMES]);
    // The segments really do partition the whole set — a slice arithmetic slip
    // would otherwise leave a gap nothing asserts over.
    expect(workspaceEnd + BROWSER_READ_TOOL_NAMES.length).toBe(allow.length);
  });
});

describe("AC4 the capability check — pure, name-returning, never throwing", () => {
  test("AC4 unmetCapabilities names what a Codex escalation session is missing", () => {
    registerEveryKind();
    const escalation = resolveSessionProfile(ctx({ kind: "escalation", provider: "codex" }));
    // `mcp-servers` LEFT THIS LIST when the adapter learned dynamic tools —
    // Codex now reaches the same ultra/loom/workspace handlers the Claude
    // branch does, through thread/start's dynamicTools instead of through MCP.
    // What remains are the two that have no app-server equivalent at all:
    // Codex governs tool access with sandbox + approvalPolicy, which is a
    // different mechanism rather than a spelling of hooks and allow/deny lists.
    expect([...unmetCapabilities(escalation, "codex")]).toEqual([
      "pre-tool-use-hooks",
      "tool-allow-deny-lists",
    ]);
  });

  test("AC4 unmetCapabilities returns [] when the provider publishes everything required", () => {
    registerEveryKind();
    for (const kind of SESSION_KINDS) {
      const resolved = resolveSessionProfile(ctx({ kind }));
      expect(unmetCapabilities(resolved, "claude")).toEqual([]);
    }
  });

  test("AC4 a planner or steerer session on Codex is now missing NOTHING", () => {
    registerEveryKind();
    // The inversion is the fix. These two kinds require system-prompt-append
    // and nothing else, and that appendix used to be built by the route and
    // then dropped on the floor — which is what made a planner or steerer a
    // non-session on this provider. It now rides thread/start as
    // `developerInstructions`, so both kinds resolve clean.
    for (const kind of ["planner", "steerer"] as const) {
      const resolved = resolveSessionProfile(ctx({ kind, provider: "codex" }));
      expect([...unmetCapabilities(resolved, "codex")]).toEqual([]);
    }
  });

  test("AC4/AC5 the `project` kind requires NOTHING, on BOTH provider ids", () => {
    // This is what keeps AC5 true: the existing project-session path passes the
    // new gate unchanged, on Claude and on Codex alike.
    registerEveryKind();
    for (const provider of ["claude", "codex"] as const) {
      const resolved = resolveSessionProfile(ctx({ kind: "project", provider }));
      expect(resolved.requiredCapabilities).toEqual([]);
      expect(unmetCapabilities(resolved, provider)).toEqual([]);
    }
  });

  test("AC4 unmetCapabilities never throws and knows nothing about HTTP", () => {
    registerEveryKind();
    const escalation = resolveSessionProfile(ctx({ kind: "escalation" }));
    // An undefined provider id defaults to claude through providerOf, exactly
    // as every other provider lookup in the tree does.
    expect(() => unmetCapabilities(escalation, undefined)).not.toThrow();
    expect(unmetCapabilities(escalation, undefined)).toEqual([]);
  });
});

describe("AC4 the provider port publishes what it supports", () => {
  test("AC4 both PROVIDERS entries publish a capability list, and Codex's is a STRICT subset of Claude's", () => {
    const claude = [...providerCapabilities("claude")];
    const codex = [...providerCapabilities("codex")];
    expect(claude.length).toBeGreaterThan(0);
    expect(codex.length).toBeGreaterThan(0);
    expect(codex.every((c) => claude.includes(c))).toBe(true);
    // STRICT: Codex must be missing at least one, or the whole gate is inert.
    expect(codex.length).toBeLessThan(claude.length);
    expect(PROVIDERS.claude.capabilities).toEqual(claude);
    expect(PROVIDERS.codex.capabilities).toEqual(codex);
  });

  test("AC4 `interactive-approval` is published by BOTH — the false-divergence guard", () => {
    // Codex genuinely has it: onCodexApproval reuses the same
    // createPending/resolvePending machinery and the same permission-card SSE
    // contract as the Claude branch's canUseTool. A false divergence here would
    // 400 a session that works today, which is worse than a missing capability.
    expect(providerPublishes("claude", "interactive-approval")).toBe(true);
    expect(providerPublishes("codex", "interactive-approval")).toBe(true);
  });

  test("AC4 the three Claude-only capabilities are exactly the measured divergences", () => {
    // Was five. `mcp-servers` and `system-prompt-append` were closed by the
    // adapter upgrade (dynamicTools + developerInstructions on thread/start),
    // which is the point of measuring rather than assuming: this list shrinks
    // when the adapter genuinely grows, and only then.
    const claudeOnly = PROVIDER_CAPABILITIES.filter((c) => !providerPublishes("codex", c));
    expect([...claudeOnly].sort()).toEqual([
      "pre-tool-use-hooks",
      "setting-sources",
      "tool-allow-deny-lists",
    ]);
    // Every one of those is published by Claude, or the list above is naming a
    // capability nobody has.
    for (const c of claudeOnly) expect(providerPublishes("claude", c)).toBe(true);
  });

  test("AC4 PROVIDER_CAPABILITIES enumerates the WHOLE space, so nothing is published off-list", () => {
    for (const p of ["claude", "codex"] as const) {
      for (const c of providerCapabilities(p)) {
        expect(PROVIDER_CAPABILITIES).toContain(c);
      }
    }
    expect(new Set(PROVIDER_CAPABILITIES).size).toBe(PROVIDER_CAPABILITIES.length);
  });
});

// ── AC3, the compile-time half ──────────────────────────────────────────────
// packages/core/tsconfig.json is `include: ["src"], exclude: ["test",
// "node_modules"]`, so `bunx tsc --noEmit` in this workspace never sees this
// file. "It does not compile" therefore has to be proved by RUNNING the
// compiler, over fixtures generated outside the repo, in BOTH directions.
//
// The harness is the SIMPLE form (no `--types node`, no `cwd`), copied from
// event-bus.test.ts rather than session-lease.test.ts: that variant exists only
// because runner/lease.ts imports node:fs and its fixture's program therefore
// needs the node ambient types. session-profile.ts imports no node:* module at
// all, and the fixture below imports only BASE_ALLOWED_TOOLS and the two types
// — never the Agent SDK — so the throwaway program never has to resolve
// @anthropic-ai/claude-agent-sdk from a directory with no node_modules of its
// own. The port's own imports still resolve, from their real location in the
// workspace.
//
// Duplicated a third time on purpose: packages/core/test holds 100+
// self-contained *.test.ts files and has never held a helper module.
// Budget: ~0.35 s per fixture, so the count below is small and deliberate.
const CORE_ROOT = fileURLToPath(new URL("../", import.meta.url));
const REPO_TSC = path.join(CORE_ROOT, "node_modules", "typescript", "bin", "tsc");
const PROFILE_MODULE = path.join(CORE_ROOT, "src", "session-profile");

// The fixture authors a policy by handing it to a function that TAKES a
// ToolPolicy, rather than by annotating a variable. That is not stylistic: it
// is what makes the diagnostic name the TYPE. MEASURED — a direct
// `const p: ToolPolicy = { … }` makes tsc report only the element mismatch
// (`Type '"Bash"' is not assignable to type '"Read" | "Grep" | …'`) with no
// mention of ToolPolicy anywhere, because the CLI does not print the
// related-information span that names the declaring type. In argument position
// tsc leads with `Argument of type … is not assignable to parameter of type
// 'ToolPolicy'` and THEN gives the element reason, so one output carries both
// the offending tool name and the type name. `as const` on the authored object
// is what keeps the literal `"Bash"` in the message instead of widening it to
// `string[]`.
const FIXTURE_PRELUDE = [
  `import { BASE_ALLOWED_TOOLS, type BaseAllowedTool, type ToolPolicy } from ${JSON.stringify(
    PROFILE_MODULE,
  )};`,
  `void BASE_ALLOWED_TOOLS;`,
  `type _Base = BaseAllowedTool;`,
  `declare function authorToolPolicy(p: ToolPolicy): void;`,
].join("\n");

const typecheck = (source: string): { ok: boolean; output: string } => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "telar-profile-compile-"));
  try {
    const file = path.join(dir, "fixture.ts");
    fs.writeFileSync(file, `${FIXTURE_PRELUDE}\n${source}\n`);
    // Run the compiler through THIS runtime: node_modules/.bin/tsc is a
    // `#!/usr/bin/env node` shim and this repo is bun-only, so there may be no
    // `node` on PATH at all.
    const out = spawnSync(
      process.execPath,
      [
        REPO_TSC,
        "--noEmit",
        "--ignoreConfig", // files-on-the-commandline + a tsconfig alongside is an error otherwise
        "--strict",
        "--target",
        "es2022",
        "--module",
        "esnext",
        "--moduleResolution",
        "bundler",
        "--skipLibCheck",
        file,
      ],
      { encoding: "utf8" },
    );
    return { ok: out.status === 0, output: `${out.stdout ?? ""}${out.stderr ?? ""}` };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

describe("AC3 over-granting DOES NOT COMPILE — the type, checked by tsc in both directions", () => {
  test("AC3 an `allow` naming a tool outside the base union does NOT typecheck", () => {
    const r = typecheck(
      `const authored = { deny: [], allow: ["Bash"] } as const;\nauthorToolPolicy(authored);`,
    );
    expect(r.ok).toBe(false);
    // Not merely "some error": a fixture that stopped compiling for an
    // unrelated reason (a bad path, a renamed export) would otherwise read as a
    // passing proof. The diagnostic must name the offending TOOL and the TYPE.
    expect(r.output).toContain("Bash");
    expect(r.output).toContain("ToolPolicy");
    // …and enough of the base union that this cannot pass over a DIFFERENT
    // union. It used to assert the whole rendered union
    // (`'"Read" | "Grep" | … | "ToolSearch"'`) so a change to
    // BASE_ALLOWED_TOOLS surfaced here rather than leaving a stale proof green.
    // Story 2.2 grew the tuple to twenty names and TypeScript now ELIDES the
    // middle — MEASURED, this is what the compiler actually prints:
    //
    //   Type 'readonly ["Bash"]' is not assignable to type 'readonly
    //   ("mcp__loom__draft_bundle_file" | "mcp__loom__propose_contract" | …
    //   | "mcp__loom__steer_loom" | ... 13 more ... | "ToolSearch")[]'.
    //
    // So the "the union is EXACTLY these N names" claim moved to a RUNTIME
    // set-equality assertion in the sibling test below — the property is still
    // pinned somewhere executable, which is the whole point — and what stays
    // here are the parts of the diagnostic that still DISCRIMINATE: one member
    // from each end of the rendered union, and the elision marker itself, which
    // is what proves the union is long rather than short.
    expect(r.output).toContain(`"mcp__loom__draft_bundle_file"`);
    expect(r.output).toContain(`"ToolSearch"`);
    expect(r.output).toContain("more ...");
  });

  test("AC3 BASE_ALLOWED_TOOLS is EXACTLY the twenty-four auto-run names, in the route's own order", () => {
    // The runtime half of the pin the compile diagnostic can no longer carry
    // (see the elision note above). Re-derived from the THREE tuples core
    // declares rather than restated as one flat literal, so growing any one of
    // them moves this expectation with it — and the six built-in names are
    // spelled out because they are the part that has NO other source in this
    // package.
    //
    // IT WAS TWENTY UNTIL STORY 5.1, and the old expectation was right for its
    // tree: the twenty were exactly the chat route's own literal non-escalation
    // allowedTools array, element for element, which is where the ordering came
    // from. Story 5.1 appended the workspace store's four (FR-OW-12: a session
    // reads its project's slice, creates items and modifies them; list_lanes is
    // the fourth because a session cannot file into "the right lane" without
    // knowing which lanes exist, and lanes are user data rather than an enum).
    // THE WORKSPACE NAMES GO LAST so the first twenty still reproduce the
    // route's old array exactly and the growth reads as a suffix.
    expect([...BASE_ALLOWED_TOOLS]).toEqual([
      "Read",
      "Grep",
      "Glob",
      "WebSearch",
      "WebFetch",
      "ToolSearch",
      ...LOOM_AUTO_TOOL_NAMES,
      ...ULTRA_AUTO_TOOL_NAMES,
      ...WORKSPACE_AUTO_TOOL_NAMES,
      ...BROWSER_READ_TOOL_NAMES,
    ]);
    // Anti-vacuity: a tuple that emptied out would satisfy a `toEqual` against
    // an equally-empty derivation.
    expect(BASE_ALLOWED_TOOLS.length).toBe(30);
    expect(LOOM_AUTO_TOOL_NAMES.length).toBeGreaterThan(0);
    expect(ULTRA_AUTO_TOOL_NAMES.length).toBeGreaterThan(0);
    expect(WORKSPACE_AUTO_TOOL_NAMES.length).toBe(4);
    expect(BROWSER_READ_TOOL_NAMES.length).toBe(5);
    // FULLY QUALIFIED, like its two siblings and unlike invariants.test.ts's
    // MCP_INVENTORY, which pins the BARE names. Writing the bare form here
    // produces tools that never auto-run AND that the runtime filter in
    // resolveSessionProfile drops without a word.
    for (const n of WORKSPACE_AUTO_TOOL_NAMES) expect(n.startsWith("mcp__workspace__")).toBe(true);
    // No duplicates: `unionOrdered` would silently absorb one, so a copy-paste
    // slip in either tuple would shorten the resolved allow set rather than
    // fail.
    expect(new Set(BASE_ALLOWED_TOOLS).size).toBe(BASE_ALLOWED_TOOLS.length);
  });

  test("MOAT: neither human-gated tool is spellable in any profile's `allow` — they are not in the base union", () => {
    // mcp__loom__start_loom (the commit that dispatches a real loom) and
    // mcp__loom__answer_blocked (the escalation write that resumes a parked
    // loop) are the two tools docs/loom-model.md §M.6 says a human must approve
    // every single time. Keeping them OUT of BASE_ALLOWED_TOOLS makes them
    // unspellable in `allow` — enforced by the compiler, not by review — which
    // is strictly stronger than the literal tool array the route used to build.
    //
    // Asserted against the values, and cross-checked against the web-side
    // constants in apps/web/lib/session-profiles.test.ts, which is the only
    // suite that can import both.
    const humanGated = ["mcp__loom__start_loom", "mcp__loom__answer_blocked"];
    const leaked = humanGated.filter((t) =>
      (BASE_ALLOWED_TOOLS as readonly string[]).includes(t),
    );
    if (leaked.length > 0) {
      throw new Error(
        `AD-1/AD-10: ${JSON.stringify(leaked)} entered BASE_ALLOWED_TOOLS. THE RULE: the two ` +
          `human-gated loom tools are never in any allowedTools and always force-routed to the ` +
          `interactive card by the route's PreToolUse hook, in EVERY permission mode. ` +
          `CONSEQUENCE: a profile could now GRANT the commit action, so the SDK would pre-approve ` +
          `it before canUseTool ever ran and the human's Approve click — which IS the provenance ` +
          `stamp startLoomFromBundle/answerBlocked record as \`by\` — would be skipped. NEXT ` +
          `STEP: remove it from the tuple. It is deliberately absent from LOOM_AUTO_TOOLS for ` +
          `the same reason; do not "complete" the vocabulary.`,
      );
    }
    expect(leaked).toEqual([]);
    // Anti-vacuity: the neighbouring auto-run loom tools ARE present, so this
    // is not passing because the loom names are absent wholesale.
    expect([...BASE_ALLOWED_TOOLS]).toContain("mcp__loom__read_bundle");
  });

  test("AC3 the SAME fixture with a base tool DOES compile, with empty output — the discriminator", () => {
    const r = typecheck(
      `const authored = { deny: [], allow: ["Read"] } as const;\nauthorToolPolicy(authored);`,
    );
    expect(r.output).toBe("");
    expect(r.ok).toBe(true);
  });

  test("AC3 an MCP tool name cannot be granted either — the base union is closed, not merely short", () => {
    const r = typecheck(
      `const authored = { deny: [], allow: ["mcp__loom__start_loom"] } as const;\nauthorToolPolicy(authored);`,
    );
    expect(r.ok).toBe(false);
    expect(r.output).toContain("mcp__loom__start_loom");
    expect(r.output).toContain("ToolPolicy");
  });

  test("AC3 `deny` accepts ANY string — denying more is always safe, and that must keep compiling", () => {
    const r = typecheck(
      `const authored = { deny: ["Bash", "mcp__loom__start_loom", "anything"] } as const;\nauthorToolPolicy(authored);`,
    );
    expect(r.output).toBe("");
    expect(r.ok).toBe(true);
  });

  test("AC3 a THIRD field on an authored policy is refused BY NAME — there is no way to add a grant", () => {
    // The value-level companion to the Equal<> pin below: excess-property
    // checking on a direct object literal names both the rogue field and the
    // type it does not belong to.
    const r = typecheck(
      `const p: ToolPolicy = { deny: [], allow: ["Read"], grant: ["Bash"] };\nvoid p;`,
    );
    expect(r.ok).toBe(false);
    expect(r.output).toContain("grant");
    expect(r.output).toContain("ToolPolicy");
  });

  test("AC3 ToolPolicy is EXACTLY { deny, allow? } — adding a field breaks this compile", () => {
    // A type-level identity assertion, so a third field (a `grant`, a
    // `permissionMode`, a `hooks`) breaks the build even when every runtime
    // test still passes. `Equal` is the standard conditional-type identity
    // trick; the shape here is session-lease.test.ts's `AC11 the union is
    // EXACTLY held | reclaimable` pin, adapted.
    const r = typecheck(
      [
        `type Equal<A, B> = (<G>() => G extends A ? 1 : 2) extends (<G>() => G extends B ? 1 : 2) ? true : false;`,
        `type Expect<T extends true> = T;`,
        `type _Pinned = Expect<Equal<ToolPolicy, { readonly deny: readonly string[]; readonly allow?: readonly BaseAllowedTool[] }>>;`,
        `const tools: Array<BaseAllowedTool> = [...BASE_ALLOWED_TOOLS];`,
        `void tools;`,
      ].join("\n"),
    );
    expect(r.output).toBe("");
    expect(r.ok).toBe(true);
  });

  test("AC3 the compile pin DISCRIMINATES — a wrong expectation really does fail", () => {
    // Without this, a fixture that silently stopped compiling anything at all
    // would read as a passing structural proof.
    const r = typecheck(
      [
        `type Equal<A, B> = (<G>() => G extends A ? 1 : 2) extends (<G>() => G extends B ? 1 : 2) ? true : false;`,
        `type Expect<T extends true> = T;`,
        `type _Wrong = Expect<Equal<ToolPolicy, { readonly deny: readonly string[]; readonly allow?: readonly string[] }>>;`,
      ].join("\n"),
    );
    expect(r.ok).toBe(false);
  });

  test("AC3 `allow: readonly string[]` is NOT assignable — the widening AC3 exists to forbid", () => {
    const r = typecheck(
      [
        `const widened = { deny: [] as readonly string[], allow: ["Bash"] as readonly string[] };`,
        `authorToolPolicy(widened);`,
      ].join("\n"),
    );
    expect(r.ok).toBe(false);
    expect(r.output).toContain("ToolPolicy");
    expect(r.output).toContain("string");
  });
});

// ── prove-run leg L6 ────────────────────────────────────────────────────────
// ── story 5.6 — the ANCHOR registry: what a session of this kind runs AGAINST ─

// THE PROJECT-LESS SESSION IS THE WHOLE REASON THIS EXISTS. Until story 5.6 the
// chat route computed `manifest = getProject(project).manifest` before anything
// else, which is a 400 for a session that HAS no project — and SPEC
// -organization-workspace's master is exactly that session. AD-9 forbids the
// obvious repair ("a new surface adds a profile, it does not add an `if`"), and
// widening SessionProfileSpec with a `cwd` was rejected for a sharper reason:
// INV-6a pins that field set, and a spec field that redirects where a session
// RUNS is a grant, not a restriction — every profile in the tree could then move
// its own working directory.
//
// So the DERIVATION became per-kind data, in a second registry beside the
// builders. Core still composes no path and reads no file: an anchor resolver
// is a function this module STORES and calls, and the one that touches the disk
// lives in apps/web (its cwd comes from the workspace store's own exported
// port, never a path composed here — AD-5/INV-3a).
describe("5.6 the anchor registry — the project gate replaced, not skipped", () => {
  const fakeManifest = (name: string, root: string): ProjectManifest =>
    ProjectManifest.parse({ name, root });

  const registerBothHalves = (): void => {
    registerEveryKind();
    for (const kind of SESSION_KINDS) {
      registerSessionAnchor(kind, ({ project }) =>
        kind === "master"
          ? { manifest: fakeManifest("__master__", "/state/workspace/home"), permissionsKey: "__master__" }
          : { manifest: fakeManifest(project ?? "", `/repos/${project ?? ""}`), permissionsKey: project ?? "" },
      );
    }
  };

  test("an anchored kind answers with a manifest AND the key its permission rules live under", () => {
    registerBothHalves();
    const project = resolveSessionAnchor({ kind: "project", project: "demo" });
    expect(project.manifest.root).toBe("/repos/demo");
    expect(project.permissionsKey).toBe("demo");

    // The master takes NO project and still resolves — the one property the old
    // `getProject(project)` line made impossible.
    const master = resolveSessionAnchor({ kind: "master" });
    expect(master.manifest.root).toBe("/state/workspace/home");
    expect(master.permissionsKey).toBe("__master__");
  });

  test("the permissions key is SEPARATE from the manifest root, so a project-less session cannot share a bucket", () => {
    registerBothHalves();
    // A session with no project would otherwise key its stored allow-rules
    // under the string "undefined" — one shared bucket every future
    // project-less surface silently joins. The master's key is its own.
    const master = resolveSessionAnchor({ kind: "master" });
    const keys = SESSION_KINDS.filter((k) => k !== "master").map(
      (k) => resolveSessionAnchor({ kind: k, project: "demo" }).permissionsKey,
    );
    expect(keys.every((k) => k === "demo")).toBe(true);
    expect(keys).not.toContain(master.permissionsKey);
    expect(master.permissionsKey).not.toBe("undefined");
  });

  test("an UNDECLARED kind throws and names what IS declared — never a silent default anchor", () => {
    registerSessionAnchor("project", () => ({
      manifest: fakeManifest("demo", "/repos/demo"),
      permissionsKey: "demo",
    }));
    // The failure this refuses to have: falling back to "the project anchor"
    // would run a new kind in some project's checkout with that project's
    // guardrails, which is the widest possible wrong answer.
    let message = "";
    try {
      resolveSessionAnchor({ kind: "master" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('cannot anchor "master"');
    expect(message).toContain("no module declared one");
    expect(message).toContain("Declared kinds: project");
    expect(message).toContain("MODULE SCOPE");
  });

  test("a DUPLICATE anchor registration throws — two modules cannot disagree about where a kind runs", () => {
    const anchor = () => ({
      manifest: fakeManifest("demo", "/repos/demo"),
      permissionsKey: "demo",
    });
    registerSessionAnchor("project", anchor);
    // Same discipline as the builder registry: import order deciding a
    // session's cwd is not a stable answer.
    expect(() => registerSessionAnchor("project", anchor)).toThrow(/already declared/);
  });

  test("resetSessionProfiles() clears anchors TOO — one seam, or a suite leaks half the registry", () => {
    registerBothHalves();
    expect([...registeredAnchorKinds()].sort()).toEqual([...SESSION_KINDS].sort());
    resetSessionProfiles();
    expect(registeredAnchorKinds()).toEqual([]);
    expect(registeredSessionKinds()).toEqual([]);
    // …and re-registering after the reset does not throw, which is what makes
    // beforeEach a mitigation rather than a second failure mode.
    expect(() => registerBothHalves()).not.toThrow();
  });

  test("EVERY kind with a builder has an anchor — a half-registered kind 500s in the route preamble", () => {
    registerBothHalves();
    // The two registries are consulted a few lines apart in the same pre-stream
    // preamble: a kind with a builder and no anchor throws before the profile
    // resolves, a kind with an anchor and no builder throws just after. The
    // real pin over the SHIPPED lists is in apps/web/lib/session-profiles.test.ts,
    // which is the only file that can import the catalogue.
    expect([...registeredAnchorKinds()].sort()).toEqual([...registeredSessionKinds()].sort());
  });
});

// SPEC-runtime-foundations' success signal is ONE SCRIPTED RUN in which every
// port serves a consumer. Story 1.3 delivered L1–L5 in
// packages/core/test/track-a-prove-run.test.ts; this is Track B's leg, and it
// lives HERE rather than there because that file is story 1.3's deliverable,
// its header is pinned prose, and a Track B leg appended to a file titled
// "Track A" would be worse than two commands.
//
// L6's HONEST SCOPE, stated because an over-claimed prove-run is worse than a
// scoped one: this leg cannot open a real HTTP stream. It proves the two halves
// that are provable in one process — the checker names the unmet capability,
// and the route's SOURCE orders the resolve call before `new ReadableStream`.
// The second half is asserted mechanically by INV-6c in
// packages/core/test/invariants.test.ts and is CITED here rather than re-run,
// the same way L1–L5 cite the suites that own their exhaustive coverage. The
// human-visible 400 is the story's curl, captured in the Debug Log.
const transcript = (leg: string, what: string) => console.log(`[track-b] ${leg} ${what}`);

describe("prove-run L6", () => {
  test("L6 a profile declaring a capability the provider port does not publish fails before the stream opens", () => {
    resetSessionProfiles();
    registerEveryKind();

    // The port serves a consumer FOR REAL: an escalation profile resolves, and
    // the checker reports what Codex does not publish.
    const escalation = resolveSessionProfile(ctx({ kind: "escalation", provider: "codex" }));
    const unmet = unmetCapabilities(escalation, "codex");
    expect(unmet.length).toBeGreaterThan(0);
    expect([...unmet]).toEqual(["pre-tool-use-hooks", "tool-allow-deny-lists"]);

    // …and the same profile on Claude passes, so the gate is a gate and not a
    // wall.
    expect(unmetCapabilities(escalation, "claude")).toEqual([]);

    // The ordering half, cited rather than re-run. If INV-6c is renamed, this
    // citation fails here instead of rotting silently.
    const invariants = fs.readFileSync(
      path.join(CORE_ROOT, "test", "invariants.test.ts"),
      "utf8",
    );
    expect(invariants).toContain(
      "INV-6c the chat route resolves the session profile BEFORE the stream opens",
    );

    transcript(
      "L6",
      `a "${escalation.kind}" profile requires ${escalation.requiredCapabilities.join(", ")}; ` +
        `codex publishes ${providerCapabilities("codex").join(", ")}; unmet = ${unmet.join(", ")} ` +
        `→ a pre-SSE 400, and INV-6c pins the call site ahead of new ReadableStream`,
    );
  });
});

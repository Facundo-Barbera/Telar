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
  PROVIDER_CAPABILITIES,
  PROVIDERS,
  ProjectManifest,
  providerCapabilities,
  providerPublishes,
  registerSessionProfile,
  registeredSessionKinds,
  resetSessionProfiles,
  resolveSessionProfile,
  SESSION_KINDS,
  sessionKindFromRole,
  unmetCapabilities,
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
  ...over,
});

// The four kinds as the web builders declare them (D11's table). Registered
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
};

const registerFourKinds = (): void => {
  for (const kind of SESSION_KINDS) {
    registerSessionProfile(kind, () => ({
      kind,
      settingSources: ["project", "local"],
      // The escalation narrowing mirrors the real builder: the route's
      // escalation branch auto-runs [...LOOM_ESCALATION_READONLY_TOOLS], whose
      // Read/Grep/Glob are three of the six here. (It read `allow: []` until
      // review caught that claim as false — nothing in this file asserts on the
      // value, but a mirror that contradicts what it mirrors is how a wrong
      // value gets re-derived later.)
      toolPolicy:
        kind === "escalation"
          ? { allow: ["Read", "Grep", "Glob"], deny: ["AskUserQuestion"] }
          : { deny: ["AskUserQuestion"] },
      requiredCapabilities: D11_REQUIRED[kind]!,
      systemPromptAppendix: "",
    }));
  }
};

// ── AC1 — a typed profile, resolved from a registered kind ──────────────────

describe("AC1 the fold — a typed SessionProfile with AD-9's seven fields plus the registry key", () => {
  test("AC1 each of the four registered kinds resolves to a profile carrying all eight fields", () => {
    registerFourKinds();
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
      expect(resolved.settingSources).toEqual(["project", "local"]);
      // No undefined at the seam: a consumer never has to read a missing field
      // as "everything", which is the reading that would turn an omission into
      // a grant.
      expect(resolved.systemPromptAppendix).toBe("");
      expect(resolved.mcpServers).toEqual({});
    }
  });

  test("AC1 cwd comes from the CONTEXT, never from the spec — no profile can redirect where a session runs", () => {
    registerFourKinds();
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
    registerFourKinds();
    expect(registeredSessionKinds()).toEqual(["project", "planner", "steerer", "escalation"]);
    resetSessionProfiles();
    expect(registeredSessionKinds()).toEqual([]);
    // …and re-registering after a reset does not throw, which is what makes
    // beforeEach a mitigation rather than a second failure mode.
    expect(() => registerFourKinds()).not.toThrow();
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
    registerPolicy({ deny: ["Bash", "AskUserQuestion", "mcp__ultra__ultra"] });
    const resolved = resolveSessionProfile(ctx());
    expect(resolved.toolPolicy.deny).toEqual(["Bash", "AskUserQuestion", "mcp__ultra__ultra"]);
    // …and denying a non-base tool does not disturb the base allow set.
    expect(resolved.toolPolicy.allow).toEqual([...BASE_ALLOWED_TOOLS]);
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
    registerFourKinds();
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

describe("AC4 the capability check — pure, name-returning, never throwing", () => {
  test("AC4 unmetCapabilities names what a Codex escalation session is missing", () => {
    registerFourKinds();
    const escalation = resolveSessionProfile(ctx({ kind: "escalation", provider: "codex" }));
    expect([...unmetCapabilities(escalation, "codex")]).toEqual([
      "mcp-servers",
      "pre-tool-use-hooks",
      "tool-allow-deny-lists",
    ]);
  });

  test("AC4 unmetCapabilities returns [] when the provider publishes everything required", () => {
    registerFourKinds();
    for (const kind of SESSION_KINDS) {
      const resolved = resolveSessionProfile(ctx({ kind }));
      expect(unmetCapabilities(resolved, "claude")).toEqual([]);
    }
  });

  test("AC4 a planner or steerer session on Codex is missing exactly system-prompt-append", () => {
    registerFourKinds();
    for (const kind of ["planner", "steerer"] as const) {
      const resolved = resolveSessionProfile(ctx({ kind, provider: "codex" }));
      expect([...unmetCapabilities(resolved, "codex")]).toEqual(["system-prompt-append"]);
    }
  });

  test("AC4/AC5 the `project` kind requires NOTHING, on BOTH provider ids", () => {
    // This is what keeps AC5 true: the existing project-session path passes the
    // new gate unchanged, on Claude and on Codex alike.
    registerFourKinds();
    for (const provider of ["claude", "codex"] as const) {
      const resolved = resolveSessionProfile(ctx({ kind: "project", provider }));
      expect(resolved.requiredCapabilities).toEqual([]);
      expect(unmetCapabilities(resolved, provider)).toEqual([]);
    }
  });

  test("AC4 unmetCapabilities never throws and knows nothing about HTTP", () => {
    registerFourKinds();
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

  test("AC4 the five Claude-only capabilities are exactly the measured divergences", () => {
    const claudeOnly = PROVIDER_CAPABILITIES.filter((c) => !providerPublishes("codex", c));
    expect([...claudeOnly].sort()).toEqual([
      "mcp-servers",
      "pre-tool-use-hooks",
      "setting-sources",
      "system-prompt-append",
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
    // …and the whole base union, so a change to BASE_ALLOWED_TOOLS surfaces
    // here rather than leaving a stale proof green.
    expect(r.output).toContain(
      `'"Read" | "Grep" | "Glob" | "WebSearch" | "WebFetch" | "ToolSearch"'`,
    );
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
    registerFourKinds();

    // The port serves a consumer FOR REAL: an escalation profile resolves, and
    // the checker reports what Codex does not publish.
    const escalation = resolveSessionProfile(ctx({ kind: "escalation", provider: "codex" }));
    const unmet = unmetCapabilities(escalation, "codex");
    expect(unmet.length).toBeGreaterThan(0);
    expect([...unmet]).toEqual(["mcp-servers", "pre-tool-use-hooks", "tool-allow-deny-lists"]);

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

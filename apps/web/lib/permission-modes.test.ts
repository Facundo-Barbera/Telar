// THE MIGRATION, which is the only part of the unification a user can lose
// something to. The vocabulary itself is proved in packages/core/test/
// runtime-mode.test.ts; what is proved here is that every value already written
// down — in a Chat row, in the composer's per-project memory, in ui-prefs, or in
// the body of a POST from a tab that was open across the deploy — reads forward
// to a mode that is the same as, or MORE CAUTIOUS than, what its owner chose.
//
// The direction is the whole test. A mapping that lands a session somewhere
// stricter is a visible surprise the user can undo; one that lands it somewhere
// looser is a session running with freedom nobody granted it, discovered after
// the fact if at all.
// bun provides "bun:test" at runtime; @types/bun isn't a dependency of this Next
// app, so the web tsconfig (which includes **/*.ts) can't resolve it. Suppress
// just the import — the runtime is `bun test`, not tsc.
// @ts-expect-error no @types/bun in this workspace
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_RUNTIME_MODE,
  MOST_CAUTIOUS_RUNTIME_MODE,
  RUNTIME_MODES,
  SELECTABLE_RUNTIME_MODES,
  isSelectableRuntimeMode,
  runtimeModeFromLegacy,
  runtimeModeOrDefault,
  type RuntimeMode,
} from "./permission-modes";
import { claudePermissionMode, codexThreadConfig } from "@telar/core/runtime-mode";

const rank = (m: RuntimeMode) => RUNTIME_MODES.indexOf(m);

describe("what this build will accept", () => {
  test("full-access is in the vocabulary and out of the selectable set", () => {
    // It needs the SDK's allowDangerouslySkipPermissions opt-in, which the chat
    // route does not set. The enum keeps it so the ceiling has a top rung.
    expect(RUNTIME_MODES).toContain("full-access");
    expect(SELECTABLE_RUNTIME_MODES).not.toContain("full-access");
    expect(isSelectableRuntimeMode("full-access")).toBe(false);
  });

  test("the other three are selectable, and nothing else is", () => {
    expect([...SELECTABLE_RUNTIME_MODES]).toEqual([
      "approval-required",
      "auto-accept-edits",
      "auto",
    ]);
    expect(isSelectableRuntimeMode("acceptEdits")).toBe(false);
    expect(isSelectableRuntimeMode("workspace-write")).toBe(false);
    expect(isSelectableRuntimeMode(undefined)).toBe(false);
  });

  test("the product default is selectable — a new session must be startable", () => {
    expect(isSelectableRuntimeMode(DEFAULT_RUNTIME_MODE)).toBe(true);
    expect(DEFAULT_RUNTIME_MODE).toBe("auto");
  });

  test("the cautious fallback is the bottom rung, not the product default", () => {
    // Two different questions with two different right answers — see the
    // constant's own note. If these ever collapse into one value, the route's
    // "a request that said nothing" arm has silently become a way to get more.
    expect(MOST_CAUTIOUS_RUNTIME_MODE).toBe("approval-required");
    expect(rank(MOST_CAUTIOUS_RUNTIME_MODE)).toBe(0);
  });
});

describe("Claude's old vocabulary maps forward", () => {
  // The three values PERMISSION_MODES held, and what each becomes.
  const TABLE: ReadonlyArray<[string, RuntimeMode]> = [
    ["default", "approval-required"],
    ["acceptEdits", "auto-accept-edits"],
    ["auto", "auto"],
  ];

  for (const [old, expected] of TABLE) {
    test(`"${old}" → ${expected}`, () => {
      expect(runtimeModeFromLegacy({ permissionMode: old })).toBe(expected);
    });
  }

  test("it ROUND-TRIPS through the Claude adapter, with one stated nuance", () => {
    // acceptEdits and auto come back as the literal strings the route used to
    // send. "default" comes back as undefined — no permissionMode field at all
    // — which the SDK documents as its own standard behaviour and is therefore
    // equivalent to sending "default". Equivalent, not identical.
    expect(claudePermissionMode(runtimeModeFromLegacy({ permissionMode: "acceptEdits" })!)).toBe(
      "acceptEdits",
    );
    expect(claudePermissionMode(runtimeModeFromLegacy({ permissionMode: "auto" })!)).toBe("auto");
    expect(
      claudePermissionMode(runtimeModeFromLegacy({ permissionMode: "default" })!),
    ).toBeUndefined();
  });
});

describe("Codex's old preset pairs map forward", () => {
  // The four CODEX_APPROVAL_PRESETS as they arrived on the wire — the resolved
  // {sandbox, approvalPolicy} pair, never the preset id.
  const TABLE: ReadonlyArray<{ id: string; sandbox: string; approvalPolicy: string; to: RuntimeMode }> = [
    { id: "read-only", sandbox: "read-only", approvalPolicy: "never", to: "approval-required" },
    {
      id: "auto (the old default)",
      sandbox: "workspace-write",
      approvalPolicy: "on-request",
      to: "auto-accept-edits",
    },
    { id: "ask", sandbox: "workspace-write", approvalPolicy: "untrusted", to: "approval-required" },
    { id: "full", sandbox: "danger-full-access", approvalPolicy: "never", to: "auto" },
  ];

  for (const row of TABLE) {
    test(`${row.id} {${row.sandbox}, ${row.approvalPolicy}} → ${row.to}`, () => {
      expect(runtimeModeFromLegacy({ sandbox: row.sandbox, approvalPolicy: row.approvalPolicy })).toBe(
        row.to,
      );
    });
  }

  test("the old DEFAULT preset is LOSSLESS — a stale tab keeps exactly its posture", () => {
    // This is the row that decides whether the rename changes anybody's
    // behaviour. {workspace-write, on-request} is byte-identical to
    // auto-accept-edits' thread config; `auto` is the same pair PLUS a gateway
    // reviewer answering in the user's place, so landing there would be a real
    // widening arriving under a rename.
    const mapped = runtimeModeFromLegacy({ sandbox: "workspace-write", approvalPolicy: "on-request" })!;
    const cfg = codexThreadConfig(mapped);
    expect(cfg.sandbox).toBe("workspace-write");
    expect(cfg.approvalPolicy).toBe("on-request");
    expect(cfg.approvalsReviewer).toBe("user");
  });

  test("no old pair maps to a sandbox WIDER than it had", () => {
    const width = { "read-only": 0, "workspace-write": 1, "danger-full-access": 2 } as const;
    for (const row of TABLE) {
      const got = codexThreadConfig(runtimeModeFromLegacy(row)!).sandbox;
      expect(width[got]).toBeLessThanOrEqual(width[row.sandbox as keyof typeof width]);
    }
  });
});

describe("nothing resolves upward, ever", () => {
  test("an unmappable value falls to the caller's default, never to full access", () => {
    expect(runtimeModeFromLegacy({})).toBeUndefined();
    expect(runtimeModeFromLegacy({ permissionMode: "plan" })).toBeUndefined();
    expect(runtimeModeFromLegacy({ sandbox: "nonsense" })).toBeUndefined();
    expect(runtimeModeOrDefault({ permissionMode: "bypassPermissions" })).toBe(DEFAULT_RUNTIME_MODE);
    expect(runtimeModeOrDefault({})).toBe(DEFAULT_RUNTIME_MODE);
  });

  test("a stored full-access — from a build that shipped it — is CAPPED, not honoured", () => {
    // The file could have been hand-edited, or written by a future build. It
    // must open the session rather than reject it, and it must not run at a
    // mode this build cannot actually enforce.
    const got = runtimeModeFromLegacy({ runtimeMode: "full-access" })!;
    expect(isSelectableRuntimeMode(got)).toBe(true);
    expect(rank(got)).toBeLessThan(rank("full-access"));
  });

  test("the new spelling wins when a row carries both", () => {
    // A row written after the rename, whose legacy field was never cleared.
    expect(
      runtimeModeFromLegacy({ runtimeMode: "approval-required", permissionMode: "auto" }),
    ).toBe("approval-required");
  });

  test("a body carrying BOTH old vocabularies takes the more cautious reading", () => {
    // Telar's own old client never sent both — the composer picked one shape by
    // provider — but the route accepts any body for one release, and the answer
    // must not be decided by which branch is consulted first. The Claude half
    // here says "auto-accept edits" and the only Codex-shaped field says
    // read-only; a session that came back write-capable off that body would be
    // a widening produced by an ordering rather than by a row.
    expect(
      runtimeModeFromLegacy({
        permissionMode: "acceptEdits",
        sandbox: "read-only",
        approvalPolicy: "untrusted",
      }),
    ).toBe("approval-required");
    // …and the rule is symmetric: the cautious one wins from either side.
    expect(
      runtimeModeFromLegacy({
        permissionMode: "default",
        sandbox: "workspace-write",
        approvalPolicy: "on-request",
      }),
    ).toBe("approval-required");
  });

  test("every legacy input this suite names lands on a selectable mode", () => {
    const inputs = [
      { permissionMode: "default" },
      { permissionMode: "acceptEdits" },
      { permissionMode: "auto" },
      { sandbox: "read-only", approvalPolicy: "never" },
      { sandbox: "workspace-write", approvalPolicy: "on-request" },
      { sandbox: "workspace-write", approvalPolicy: "untrusted" },
      { sandbox: "danger-full-access", approvalPolicy: "never" },
      { runtimeMode: "full-access" },
      {},
    ];
    for (const input of inputs) {
      expect(isSelectableRuntimeMode(runtimeModeOrDefault(input))).toBe(true);
    }
  });
});

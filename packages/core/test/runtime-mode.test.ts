// The unification's proof. What matters here is not that each function returns
// a value — it is that the SAME mode produces CORRESPONDING behaviour on two
// harnesses that share no wire vocabulary. A table that drifts on one side is
// exactly how "Auto" came to mean something on Claude and nothing on Codex.
//
// Every expected value is transcribed from t3code, verified 2026-08-01:
//   Claude — apps/server/src/provider/Layers/ClaudeAdapter.ts runtimeModeToPermission
//   Codex  — apps/server/src/provider/Layers/CodexSessionRuntime.ts runtimeModeToThreadConfig
import { describe, expect, test } from "bun:test";
import {
  bypassesToolApproval,
  claudePermissionMode,
  codexThreadConfig,
  codexTurnSandboxPolicy,
  DEFAULT_RUNTIME_MODE,
  isRuntimeMode,
  profileRuntimeModeCeiling,
  promptsForApproval,
  RUNTIME_MODE_OPTIONS,
  RUNTIME_MODES,
  runtimeModeLabel,
} from "../src/runtime-mode";

describe("the vocabulary", () => {
  test("is exactly the four levels, least permissive first", () => {
    expect([...RUNTIME_MODES]).toEqual([
      "approval-required",
      "auto-accept-edits",
      "auto",
      "full-access",
    ]);
  });

  test("every mode has a label and a description, in the same order", () => {
    expect(RUNTIME_MODE_OPTIONS.map((o) => o.value)).toEqual([...RUNTIME_MODES]);
    for (const o of RUNTIME_MODE_OPTIONS) {
      expect(o.label.length).toBeGreaterThan(0);
      expect(o.description.length).toBeGreaterThan(0);
    }
  });

  test("defaults to auto — deliberately NOT t3code's full-access", () => {
    // The one place this file diverges from the reference. Shipping
    // "no prompts" as the out-of-box posture would contradict the moat.
    expect(DEFAULT_RUNTIME_MODE).toBe("auto");
  });

  test("isRuntimeMode refuses the old vocabularies", () => {
    expect(isRuntimeMode("auto")).toBe(true);
    // Claude's old client values...
    expect(isRuntimeMode("acceptEdits")).toBe(false);
    expect(isRuntimeMode("default")).toBe(false);
    // ...and a Codex knob.
    expect(isRuntimeMode("workspace-write")).toBe(false);
    expect(isRuntimeMode(undefined)).toBe(false);
  });

  test("runtimeModeLabel round-trips every mode", () => {
    expect(RUNTIME_MODES.map(runtimeModeLabel)).toEqual([
      "Supervised",
      "Auto-accept edits",
      "Auto",
      "Full access",
    ]);
  });
});

describe("Claude translation", () => {
  test("matches t3code's table", () => {
    expect(claudePermissionMode("auto-accept-edits")).toBe("acceptEdits");
    expect(claudePermissionMode("auto")).toBe("auto");
    expect(claudePermissionMode("full-access")).toBe("bypassPermissions");
  });

  test("approval-required sends NO permissionMode — the SDK's own ask default", () => {
    // t3code's table omits this row rather than mapping it; omitting the field
    // is what produces ask-every-time.
    expect(claudePermissionMode("approval-required")).toBeUndefined();
  });
});

describe("Codex translation", () => {
  test("approval-required is read-only and untrusted", () => {
    expect(codexThreadConfig("approval-required")).toEqual({
      approvalPolicy: "untrusted",
      sandbox: "read-only",
      approvalsReviewer: "user",
    });
  });

  test("full-access never asks", () => {
    expect(codexThreadConfig("full-access")).toEqual({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      approvalsReviewer: "user",
    });
  });

  test("NO mode delegates approvals to the harness's own reviewer", () => {
    // THE GUARDRAIL REACHABILITY TEST, and the reason Telar diverges from
    // t3code's `auto` row. Every approval request Codex raises is answered by
    // route.ts's onCodexApproval, which is the single site where
    // makeGuardrailDecision runs on this harness and the single site that
    // raises a permission card. `auto_review` hands those requests to the
    // harness's subagent instead, so the project's guardrails.disallowedTools /
    // protectedPaths would go inert and no card would ever be shown. If this
    // assertion is being changed, the Codex arm needs a guardrail seam that
    // survives delegated review FIRST.
    for (const m of RUNTIME_MODES) {
      expect(codexThreadConfig(m).approvalsReviewer).toBe("user");
    }
  });

  test("approvalsReviewer is ALWAYS set — never omitted", () => {
    // Omitting it on resume keeps the thread's previous reviewer, so a thread
    // another client started under auto_review would stay there for life.
    for (const m of RUNTIME_MODES) {
      expect(codexThreadConfig(m).approvalsReviewer).toBeDefined();
    }
  });

  test("the per-turn sandbox policy never contradicts the thread's", () => {
    const pairs: Record<string, string> = {
      "read-only": "readOnly",
      "workspace-write": "workspaceWrite",
      "danger-full-access": "dangerFullAccess",
    };
    for (const m of RUNTIME_MODES) {
      expect(codexTurnSandboxPolicy(m).type).toBe(pairs[codexThreadConfig(m).sandbox]!);
    }
  });
});

describe("the two harnesses agree", () => {
  test("exactly one mode bypasses per-tool approval, on both", () => {
    for (const m of RUNTIME_MODES) {
      const claudeBypasses = claudePermissionMode(m) === "bypassPermissions";
      const codexBypasses = codexThreadConfig(m).approvalPolicy === "never";
      expect(claudeBypasses).toBe(codexBypasses);
      expect(claudeBypasses).toBe(bypassesToolApproval(m));
    }
  });

  test("promptsForApproval gives the same answer for both providers", () => {
    for (const m of RUNTIME_MODES) {
      expect(promptsForApproval("claude", m)).toBe(promptsForApproval("codex", m));
    }
    expect(promptsForApproval("claude", "full-access")).toBe(false);
    expect(promptsForApproval("codex", "auto")).toBe(true);
  });

  test("promptsForApproval reads the REVIEWER, not just the policy", () => {
    // A policy that raises approval requests plus a reviewer that answers them
    // for the user is not a human in the loop. Nothing in this build sends
    // auto_review (see codexThreadConfig), so this exercises the predicate
    // against a hand-built config rather than a shipped row — the point is that
    // the function would report the truth if the table ever changed.
    for (const m of RUNTIME_MODES) {
      const config = codexThreadConfig(m);
      const humanAsked = config.approvalPolicy !== "never" && config.approvalsReviewer === "user";
      expect(promptsForApproval("codex", m)).toBe(humanAsked);
    }
  });
});

// THE PROOF THAT THE TWO HARNESSES NOW AGREE, as one table read left to right.
// The per-provider describes above check each side against its own source; this
// one exists so a reviewer can see BOTH answers for a single mode without
// holding two tables in their head — which is the thing that was impossible
// while "how careful is this session" had two vocabularies.
//
// The Codex column is the FULL thread config, reviewer included, because that
// third field is where a widening would hide. Two of its rows are currently
// identical — `auto` and `auto-accept-edits` — and the table prints them that
// way on purpose rather than eliding one: the difference between those modes is
// real on Claude and is deliberately not yet expressible on Codex.
describe("the end-to-end table", () => {
  const TABLE: ReadonlyArray<{
    mode: (typeof RUNTIME_MODES)[number];
    claude: ReturnType<typeof claudePermissionMode>;
    codex: ReturnType<typeof codexThreadConfig>;
    turn: ReturnType<typeof codexTurnSandboxPolicy>;
  }> = [
    {
      mode: "approval-required",
      claude: undefined,
      codex: { approvalPolicy: "untrusted", sandbox: "read-only", approvalsReviewer: "user" },
      turn: { type: "readOnly" },
    },
    {
      mode: "auto-accept-edits",
      claude: "acceptEdits",
      codex: { approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "user" },
      turn: { type: "workspaceWrite" },
    },
    {
      mode: "auto",
      claude: "auto",
      // IDENTICAL to auto-accept-edits on this provider, and that is the
      // deliberate state: the field that would distinguish them
      // (approvalsReviewer "auto_review") takes the approval requests away from
      // Telar's only Codex guardrail seam. See codexThreadConfig's own block.
      codex: {
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        approvalsReviewer: "user",
      },
      turn: { type: "workspaceWrite" },
    },
    {
      mode: "full-access",
      claude: "bypassPermissions",
      codex: { approvalPolicy: "never", sandbox: "danger-full-access", approvalsReviewer: "user" },
      turn: { type: "dangerFullAccess" },
    },
  ];

  test("covers the vocabulary exactly — no mode is missing a row", () => {
    // Without this, adding a fifth mode leaves it untranslated on both sides and
    // every row below still passes.
    expect(TABLE.map((r) => r.mode)).toEqual([...RUNTIME_MODES]);
  });

  for (const row of TABLE) {
    test(`${row.mode} → Claude ${row.claude ?? "(no permissionMode field)"} / Codex ${row.codex.sandbox} ${row.codex.approvalPolicy} ${row.codex.approvalsReviewer}`, () => {
      expect(claudePermissionMode(row.mode)).toBe(row.claude);
      expect(codexThreadConfig(row.mode)).toEqual(row.codex);
      expect(codexTurnSandboxPolicy(row.mode)).toEqual(row.turn);
    });
  }
});

describe("a profile may restrict but never widen", () => {
  test("a lower ceiling wins", () => {
    expect(profileRuntimeModeCeiling("full-access", "approval-required")).toBe("approval-required");
    expect(profileRuntimeModeCeiling("auto", "auto-accept-edits")).toBe("auto-accept-edits");
  });

  test("a higher ceiling does NOT upgrade the session's choice", () => {
    // The whole point: an authored profile cannot quietly hand a supervised
    // session full access.
    expect(profileRuntimeModeCeiling("approval-required", "full-access")).toBe("approval-required");
    expect(profileRuntimeModeCeiling("auto-accept-edits", "auto")).toBe("auto-accept-edits");
  });

  test("equal is a no-op, and every pair resolves to one of its inputs", () => {
    for (const a of RUNTIME_MODES) {
      for (const b of RUNTIME_MODES) {
        const r = profileRuntimeModeCeiling(a, b);
        expect([a, b]).toContain(r);
        expect(RUNTIME_MODES.indexOf(r)).toBeLessThanOrEqual(
          Math.max(RUNTIME_MODES.indexOf(a), RUNTIME_MODES.indexOf(b)),
        );
      }
    }
  });
});

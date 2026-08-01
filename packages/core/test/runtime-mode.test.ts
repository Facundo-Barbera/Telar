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

  test("auto differs from auto-accept-edits by the REVIEWER alone", () => {
    // The load-bearing row. If these two ever stop differing by exactly this
    // one field, "Auto" has lost its meaning on this provider.
    const edits = codexThreadConfig("auto-accept-edits");
    const auto = codexThreadConfig("auto");
    expect(auto.approvalPolicy).toBe(edits.approvalPolicy);
    expect(auto.sandbox).toBe(edits.sandbox);
    expect(edits.approvalsReviewer).toBe("user");
    expect(auto.approvalsReviewer).toBe("auto_review");
  });

  test("approvalsReviewer is ALWAYS set — never omitted", () => {
    // Omitting it on resume keeps the thread's previous reviewer, leaving
    // auto_review sticky after switching away from Auto.
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

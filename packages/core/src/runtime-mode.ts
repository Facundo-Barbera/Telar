// RUNTIME MODE — how much the agent may do on its own, asked once, answered
// the same way on every harness.
//
// THE PROBLEM THIS ENDS. Telar asked this question twice, in two vocabularies.
// Claude sessions chose a `permissionMode` of default/auto/acceptEdits; Codex
// sessions chose one of four "approval presets" that fanned out into a
// `{sandbox, approvalPolicy}` pair. Same decision, two option sets, two sets of
// words, two controls in the composer — so "how careful is this session" had no
// answer you could state without first asking which agent was driving. A
// profile, a project memory, or a person could not carry the answer across.
//
// The shape here is taken from t3code (verified against the source on
// 2026-08-01, not from memory), because it has already solved this across five
// harnesses: ONE provider-neutral enum, translated inside each adapter at the
// last possible moment. Cited inline below.
//
// WHAT IS DELIBERATELY NOT HERE. No sandbox, no approvalPolicy, no
// permissionMode — those are harness spellings and they live in the translation
// functions, not in the vocabulary. If a sixth field from one harness leaks up
// into this file, the abstraction has failed and the fix is to push it back
// down rather than to widen the enum.
import type { ProviderId } from "./schemas";

export const RUNTIME_MODES = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
] as const;
export type RuntimeMode = (typeof RUNTIME_MODES)[number];

export const isRuntimeMode = (v: unknown): v is RuntimeMode =>
  typeof v === "string" && (RUNTIME_MODES as readonly string[]).includes(v);

// TELAR DEFAULTS TO `auto`, WHERE t3code DEFAULTS TO `full-access`.
//
// A deliberate divergence from the reference, and the one place this file does
// not follow it. Telar's whole claim is a human-accept moat; shipping
// "commands and edits run without prompts" as the out-of-box posture would
// contradict the product before a user made a single choice. `auto` keeps a
// reviewer in the loop for anything risky and is what Telar already defaulted
// to, so no existing project's posture changes on upgrade.
export const DEFAULT_RUNTIME_MODE: RuntimeMode = "auto";

/** Presentation, owned here so every surface says the same words. The order is
 *  least-permissive first and is load-bearing: the composer renders these in
 *  array order, and a control that lists "Full access" first teaches the wrong
 *  reflex. */
export const RUNTIME_MODE_OPTIONS: ReadonlyArray<{
  value: RuntimeMode;
  label: string;
  description: string;
}> = [
  {
    value: "approval-required",
    label: "Supervised",
    description: "Ask before commands and file changes.",
  },
  {
    value: "auto-accept-edits",
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
  },
  {
    value: "auto",
    label: "Auto",
    description: "A reviewer approves routine actions; risky ones still ask.",
  },
  {
    value: "full-access",
    label: "Full access",
    description: "Allow commands and edits without prompts.",
  },
];

export const runtimeModeLabel = (m: RuntimeMode): string =>
  RUNTIME_MODE_OPTIONS.find((o) => o.value === m)?.label ?? m;

// ── Claude ─────────────────────────────────────────────────────────────────

/** The SDK permission modes a runtime mode can produce. `undefined` means
 *  "send no permissionMode", which is the SDK's own ask-every-time default —
 *  t3code's table has no entry for `approval-required` for exactly this reason
 *  (ClaudeAdapter.ts's runtimeModeToPermission omits it). */
export type ClaudePermissionMode = "acceptEdits" | "auto" | "bypassPermissions" | undefined;

// Transcribed from t3code apps/server/src/provider/Layers/ClaudeAdapter.ts
// (`runtimeModeToPermission`), which maps three of the four and leaves
// `approval-required` to fall through to the SDK default.
export function claudePermissionMode(mode: RuntimeMode): ClaudePermissionMode {
  switch (mode) {
    case "auto-accept-edits":
      return "acceptEdits";
    case "auto":
      return "auto";
    case "full-access":
      return "bypassPermissions";
    case "approval-required":
    default:
      return undefined; // ask every time — the SDK's own default
  }
}

// WHAT `full-access` ACTUALLY COSTS, stated rather than buried, because this
// value was previously unreachable BY CONSTRUCTION: ProfilePermissionMode
// excludes "bypassPermissions" and the chat route 400s it.
//
//   · IT BYPASSES: the per-tool interactive approval. `bypassPermissions` is
//     honoured by the SDK BEFORE canUseTool is invoked, so no permission card
//     is ever shown for a tool call. On Codex the equivalent is approvalPolicy
//     "never" plus a danger-full-access sandbox. Choosing this mode is choosing
//     that, and the option's own description says so in the user's words.
//   · IT DOES NOT BYPASS: the loom's structural human-accept. `ready → done`
//     is a lifecycle gate in the loom state machine, not a tool permission, and
//     nothing in this file can reach it. Nor does it reach `disallowedTools`,
//     which is why the verifier's capability wall and a profile's guardrails
//     still hold — they union rather than replace.
//
// So the moat that makes a Telar verdict un-self-issuable is intact at
// full-access; what a user gives up is being asked before each command. That
// is a real choice a person may want, and it is now sayable — but it is opt-in,
// never the default, and never something a profile can select on a user's
// behalf (profiles still cannot carry it; see profileRuntimeModeCeiling).
export const bypassesToolApproval = (mode: RuntimeMode): boolean => mode === "full-access";

/** A profile may RESTRICT what a session chose but never widen it. Returns the
 *  more cautious of the two, using RUNTIME_MODES' least-permissive-first order
 *  as the ranking — the same union-not-replace rule guardrails already follow.
 *  This is what stops an authored profile from quietly upgrading a supervised
 *  session to full access. */
export function profileRuntimeModeCeiling(chosen: RuntimeMode, ceiling: RuntimeMode): RuntimeMode {
  const rank = (m: RuntimeMode) => RUNTIME_MODES.indexOf(m);
  return rank(chosen) <= rank(ceiling) ? chosen : ceiling;
}

// ── Codex ──────────────────────────────────────────────────────────────────

export type CodexThreadConfig = {
  approvalPolicy: "untrusted" | "on-request" | "never";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  // ALWAYS SENT EXPLICITLY, never omitted. Omitting it on resume keeps the
  // thread's PREVIOUS reviewer, which leaves auto_review sticky after a switch
  // away from `auto` — t3code's own comment flags this and it is the kind of
  // bug that reads as "the mode control does nothing".
  approvalsReviewer: "user" | "auto_review";
};

// Transcribed from t3code apps/server/src/provider/Layers/CodexSessionRuntime.ts
// (`runtimeModeToThreadConfig`).
//
// THE LOAD-BEARING ROW IS `auto`. It differs from `auto-accept-edits` by ONE
// field — approvalsReviewer "auto_review" instead of "user" — and that field is
// the entire meaning of Auto on this provider: the gateway's own reviewer
// approves routine actions. Telar's Codex adapter has never sent
// approvalsReviewer at all, which is why "Auto" had no Codex behaviour to point
// at and why the two providers' option sets could not be reconciled by
// renaming alone.
export function codexThreadConfig(mode: RuntimeMode): CodexThreadConfig {
  switch (mode) {
    case "approval-required":
      return { approvalPolicy: "untrusted", sandbox: "read-only", approvalsReviewer: "user" };
    case "auto-accept-edits":
      return { approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "user" };
    case "auto":
      return {
        approvalPolicy: "on-request",
        sandbox: "workspace-write",
        approvalsReviewer: "auto_review",
      };
    case "full-access":
    default:
      return {
        approvalPolicy: "never",
        sandbox: "danger-full-access",
        approvalsReviewer: "user",
      };
  }
}

/** The per-TURN sandbox policy, which the app-server takes separately from the
 *  thread's. Derived from the same mode so the two can never disagree — a turn
 *  running under a wider policy than its thread was started with is the failure
 *  this shares a source to prevent. Transcribed from
 *  `runtimeModeToTurnSandboxPolicy`. */
export function codexTurnSandboxPolicy(
  mode: RuntimeMode,
): { type: "readOnly" } | { type: "workspaceWrite" } | { type: "dangerFullAccess" } {
  switch (mode) {
    case "approval-required":
      return { type: "readOnly" };
    case "auto-accept-edits":
    case "auto":
      return { type: "workspaceWrite" };
    case "full-access":
    default:
      return { type: "dangerFullAccess" };
  }
}

// ── the seam ───────────────────────────────────────────────────────────────

/** Does this provider need to prompt the human per tool call under this mode?
 *  One question, one answer, whichever harness — what the composer and the
 *  session header both read instead of each deriving it from provider knobs. */
export function promptsForApproval(provider: ProviderId, mode: RuntimeMode): boolean {
  if (mode === "full-access") return false;
  return provider === "codex" ? codexThreadConfig(mode).approvalPolicy !== "never" : true;
}

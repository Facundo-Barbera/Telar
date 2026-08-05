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
//
// REACHABLE FROM THE CLIENT BUNDLE, which is the whole reason package.json
// publishes it as its own `@telar/core/runtime-mode` subpath. The package index
// re-exports modules that open files and spawn subprocesses, so a "use client"
// module importing `@telar/core` breaks the build — and the previous answer to
// that was apps/web/lib/permission-modes.ts holding a SECOND copy of the
// vocabulary. Two copies of "how careful is this session" is the bug this file
// exists to end, so it must not be re-introduced one layer down. Keep this
// module free of anything but type-only imports.
import type { ProviderId } from "./schemas";
// TYPE-ONLY, and it has to stay that way — ./session-profile reads files and is
// not client-reachable, so a value edge here would break the subpath this
// module exists to publish. The cycle is fine because it is erased: that file
// imports `type RuntimeMode` from this one.
import type { SessionKind } from "./session-profile";

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
// value has never been reachable: the chat route 400s it, and the profile
// context's own type used to exclude "bypassPermissions" outright.
//
// AND IT IS STILL NOT REACHABLE — the third bullet is why. The vocabulary
// carries the value so the ladder is complete and profileRuntimeModeCeiling has
// a top rung; what a client may SELECT is narrower, and that gate lives in
// apps/web/lib/permission-modes.ts (SELECTABLE_RUNTIME_MODES) with its reason
// attached. Turning it on is a reviewed change to the query() options, not a
// filter someone deletes.
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
//   · IT DOES NOT WORK YET, on Claude. The SDK requires a second field beside
//     the mode — `allowDangerouslySkipPermissions: true`, per its own
//     Options doc ("Bypass all permission checks (requires
//     allowDangerouslySkipPermissions)") — and Telar's query() call sets no
//     such field. Sending `permissionMode: "bypassPermissions"` alone is
//     therefore a request the harness will not honour, so shipping this option
//     today would offer a control that lies. Wiring that flag is its own
//     reviewed change to the grant site; it did not get to ride in on a rename.
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

// The most permissive runtime mode a session of this kind may end up in, no
// matter what its composer chose. Fed to profileRuntimeModeCeiling at the
// route, which returns the more cautious of the two — so this table can only
// ever narrow, and a kind that wants MORE than the user picked has no way to
// say so.
//
// It is a function of the kind and NOT a SessionProfileSpec field, deliberately.
// A spec field would be authorable, and an authorable ceiling is an authorable
// widening one typo away (`runtimeMode: "full-access"` on a profile reads as a
// grant, and INV-6a would fail it for exactly that reason). Here the surface
// supplies no value at all: it declares a kind, and the cap follows.
//
// IT LIVES IN THIS FILE so the composer can ask it too. The route capping a
// choice the control still offers is a control that visibly moves and changes
// nothing — the exact failure the reviewer stickiness comment above names — so
// the surface reads this function to disable the rungs it cannot have, and the
// route reads it to enforce them. One table, both ends.
//
// Every kind sits at the top of the ladder except escalation. That one is the
// blocked-loom "discuss with the orchestrator" chat, whose whole shape is a
// read-only conversation — its toolPolicy already allows only six read tools,
// so approval-required costs it nothing (an allowedTools entry is pre-approved
// by the SDK before any prompt) and closes the case where a composer default
// hands a discussion session a write-capable Codex sandbox.
export function runtimeModeCeiling(kind: SessionKind): RuntimeMode {
  return kind === "escalation" ? "approval-required" : "full-access";
}

// ── Codex ──────────────────────────────────────────────────────────────────

export type CodexThreadConfig = {
  approvalPolicy: "untrusted" | "on-request" | "never";
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  // ALWAYS SENT EXPLICITLY, never omitted, and — see the block below — always
  // "user" in this build. Omitting it on resume keeps the thread's PREVIOUS
  // reviewer, so a thread some other client started under `auto_review` would
  // stay under it for the rest of its life. Sending it on every start and
  // resume is what makes that unreachable.
  approvalsReviewer: "user" | "auto_review";
};

// Transcribed from t3code apps/server/src/provider/Layers/CodexSessionRuntime.ts
// (`runtimeModeToThreadConfig`), with ONE deliberate divergence — the second in
// this file, after the default.
//
// t3code's `auto` row sends `approvalsReviewer: "auto_review"`, and that field
// is the whole Codex meaning of Auto: the harness's own subagent answers the
// approval requests instead of the human. Telar does NOT send it, and the
// reason is not taste. Quoting the shipped app-server's own schema text:
// "Configures who approval requests are routed to for review. Examples include
// sandbox escapes, blocked network access, MCP approval prompts, and ARC
// escalations. Defaults to `user`. `auto_review` uses a carefully prompted
// subagent to … approv[e] or deny[] the request."
//
// Those requests are the ONLY seam Telar has on this harness. `onCodexApproval`
// (apps/web/app/api/chat/route.ts) is where `makeGuardrailDecision` runs for a
// Codex session — the single site enforcing a project's
// guardrails.disallowedTools and guardrails.protectedPaths — and where the
// permission card is raised. Routing approvals to the harness's reviewer does
// not soften that check; it stops it from ever being asked. The Claude arm has
// a second gate underneath (`preToolUseGuardrail` fires regardless of mode);
// Codex publishes neither pre-tool-use-hooks nor tool-allow-deny-lists, so
// there is nothing behind this one.
//
// THE COST OF THE DIVERGENCE, stated rather than hidden: on Codex, `auto` and
// `auto-accept-edits` produce identical thread config. The rung is real on
// Claude (permissionMode "auto" is the SDK's classifier) and is currently a
// no-op on Codex. That is the honest state — and it is what every Codex session
// did before this vocabulary landed, since Telar never sent the field at all.
// Turning it on is a change at the grant site: it needs a Codex-side guardrail
// that survives delegated review, and it must not ride in on a table edit.
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
        approvalsReviewer: "user",
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

// PUBLISHED BUT NOT YET CONSUMED, said out loud so nobody reads a claim into
// silence: `promptsForApproval`, `bypassesToolApproval` and `runtimeModeLabel`
// have no production caller today. They are the questions a surface will ask
// when the session header stops describing permissions in its own words
// (phase 6), and they exist here so that answer has one source. `codexTurnSandboxPolicy`
// WAS in this list and is not any more — the Codex adapter now derives its
// per-turn policy from it, which is what makes its "the two can never disagree"
// docstring a mechanism rather than a hope.

/** Does this provider ask the HUMAN before a tool call under this mode? One
 *  question, one answer, whichever harness — so a surface can offer a
 *  human-in-the-loop affordance without deriving it from provider knobs.
 *
 *  Both Codex fields are read, not just the policy. A policy that produces
 *  approval requests and a reviewer that answers them on the user's behalf is
 *  not a human in the loop, and a function that looked only at the policy would
 *  have said it was. */
export function promptsForApproval(provider: ProviderId, mode: RuntimeMode): boolean {
  if (mode === "full-access") return false;
  if (provider !== "codex") return true;
  const config = codexThreadConfig(mode);
  return config.approvalPolicy !== "never" && config.approvalsReviewer === "user";
}

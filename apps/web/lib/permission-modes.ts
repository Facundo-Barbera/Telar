// THE ONE PERMISSION VOCABULARY, as the client bundle sees it, plus the two
// things core cannot own: which modes this build actually ships, and how a
// value written under the OLD vocabularies reads today.
//
// This file used to declare a vocabulary of its own — `PERMISSION_MODES =
// ["default", "auto", "acceptEdits"]`, the Claude half of the split that
// packages/core/src/runtime-mode.ts exists to end. It now re-exports that
// module instead. The import is the `@telar/core/runtime-mode` SUBPATH, never
// the package index: the index re-exports modules that touch node:fs and spawn
// subprocesses, so importing `@telar/core` here would break every "use client"
// consumer (session-view.tsx, store.ts, ui-prefs.ts). runtime-mode.ts has only
// type-only imports, which is what makes the subpath safe and is stated in its
// own header as a rule to keep.

export {
  DEFAULT_RUNTIME_MODE,
  RUNTIME_MODE_OPTIONS,
  RUNTIME_MODES,
  isRuntimeMode,
  // The two halves of the ceiling, re-exported for the CLIENT: the composer has
  // to cap what it offers by the same rule the route enforces, or it shows a
  // control that moves and changes nothing.
  profileRuntimeModeCeiling,
  runtimeModeCeiling,
  runtimeModeLabel,
  type RuntimeMode,
} from "@telar/core/runtime-mode";

import {
  DEFAULT_RUNTIME_MODE,
  RUNTIME_MODE_OPTIONS,
  RUNTIME_MODES,
  isRuntimeMode,
  profileRuntimeModeCeiling,
  type RuntimeMode,
} from "@telar/core/runtime-mode";

// --- What this build will actually accept ------------------------------------

// `full-access` is in the VOCABULARY (the ladder needs a top rung for
// profileRuntimeModeCeiling to cap against) but is not in the SHIPPABLE SET,
// and the reason is mechanical rather than a matter of taste.
//
// It maps to Claude's `permissionMode: "bypassPermissions"`, which the Agent
// SDK honours only alongside a second option — `allowDangerouslySkipPermissions:
// true`, per its own Options doc: "Bypass all permission checks (requires
// allowDangerouslySkipPermissions)". That field appears nowhere in this repo.
// Offering the mode today would offer a control that does not do what its label
// says, on one of the two providers.
//
// It is filtered HERE rather than trimmed out of RUNTIME_MODES, so core stays a
// faithful transcription of the shape it was taken from, and so turning the
// mode on later is a change to the query() options plus one line here — a
// reviewed edit to the grant site, not a filter someone quietly deletes.
export const SELECTABLE_RUNTIME_MODES: readonly RuntimeMode[] = RUNTIME_MODES.filter(
  (m) => m !== "full-access",
);

export const SELECTABLE_RUNTIME_MODE_OPTIONS = RUNTIME_MODE_OPTIONS.filter((o) =>
  SELECTABLE_RUNTIME_MODES.includes(o.value),
);

/** What the chat route's 400 check asks. Narrower than `isRuntimeMode` on
 *  purpose: the route must reject a mode this build cannot honour even though
 *  the vocabulary can spell it. */
export const isSelectableRuntimeMode = (v: unknown): v is RuntimeMode =>
  isRuntimeMode(v) && SELECTABLE_RUNTIME_MODES.includes(v);

/** The bottom rung, named so call sites can say WHY they picked it. This is not
 *  the product default (`DEFAULT_RUNTIME_MODE` is, and it is what a NEW session
 *  starts on) — it is what a request that never said anything resolves to. The
 *  two questions have different right answers: "what should a person get by
 *  default" is a product decision, "what should we assume when nobody told us"
 *  is a safety one. */
export const MOST_CAUTIOUS_RUNTIME_MODE: RuntimeMode = RUNTIME_MODES[0];

// --- Reading a value written under the old vocabularies ----------------------

// THE RULE FOR EVERY ROW BELOW: map forward, or map DOWN. Never up. A stored
// choice that has no exact counterpart resolves to the more cautious mode and
// the user sees a control that is stricter than they left it — which is a
// recoverable surprise. The other direction is a session quietly running with
// more freedom than the person who configured it agreed to, which is not.

/** Claude's old client vocabulary — the three values PERMISSION_MODES held.
 *  Lossless, and it round-trips: `claudePermissionMode()` turns each result
 *  back into what the route used to send, with one nuance a reviewer will ask
 *  about. "default" resolves to `approval-required`, which sends NO
 *  permissionMode field at all where the route previously sent the literal
 *  "default" — the SDK documents 'default' as its own standard behaviour, so
 *  the two are behaviourally equivalent. Equivalent, not identical. */
function fromClaudePermissionMode(v: unknown): RuntimeMode | undefined {
  switch (v) {
    case "default":
      return "approval-required";
    case "acceptEdits":
      return "auto-accept-edits";
    case "auto":
      return "auto";
    default:
      return undefined;
  }
}

/** Codex's old wire pair. Two of the four presets have no exact counterpart, so
 *  this table is where "never upward" is actually paid for:
 *
 *    {read-only, never}            → approval-required  gains prompts
 *    {workspace-write, on-request} → auto-accept-edits  EXACT
 *    {workspace-write, untrusted}  → approval-required  loses the write sandbox
 *    {danger-full-access, never}   → auto               see below
 *
 *  The second row is the one that matters most: it is the old DEFAULT preset,
 *  and it lands on the mode that is byte-identical to it rather than on `auto`,
 *  whose Codex meaning is the same pair PLUS a gateway reviewer approving
 *  routine actions in the user's place. A tab left open across a deploy keeps
 *  exactly the posture it had; a session that picks Auto afterwards gets the
 *  reviewer because someone chose it.
 *
 *  The last row cannot be exact — `full-access` is the exact counterpart and is
 *  not selectable in this build. `auto` is the most capable mode that IS, and
 *  it sits BELOW full-access on the ladder, so the rule holds. */
function fromCodexApprovalPair(sandbox: unknown, approvalPolicy: unknown): RuntimeMode | undefined {
  if (sandbox === "read-only") return "approval-required";
  if (sandbox === "workspace-write") {
    return approvalPolicy === "untrusted" ? "approval-required" : "auto-accept-edits";
  }
  if (sandbox === "danger-full-access") return DEFAULT_RUNTIME_MODE;
  return undefined;
}

/** Everything that has ever meant "how much may this agent do on its own",
 *  resolved to today's word — or `undefined` when nothing in the input says.
 *
 *  ONE function for all four call sites (the chat route's wire compatibility,
 *  Chat rows in store.ts, the composer's per-project memory, and ui-prefs'
 *  agent default) so they cannot disagree about what an old value meant. The
 *  new spelling always wins when both are present. */
export function runtimeModeFromLegacy(input: {
  runtimeMode?: unknown;
  permissionMode?: unknown;
  sandbox?: unknown;
  approvalPolicy?: unknown;
}): RuntimeMode | undefined {
  if (isSelectableRuntimeMode(input.runtimeMode)) return input.runtimeMode;
  // A stored `full-access` — from a build that shipped it, or a hand-edited
  // file — is a real runtime mode this build will not run. Cap it rather than
  // reject it, so the session opens.
  if (isRuntimeMode(input.runtimeMode)) return DEFAULT_RUNTIME_MODE;
  const claude = fromClaudePermissionMode(input.permissionMode);
  const codex =
    input.sandbox != null || input.approvalPolicy != null
      ? fromCodexApprovalPair(input.sandbox, input.approvalPolicy)
      : undefined;
  // BOTH OLD VOCABULARIES AT ONCE resolves to the more cautious of the two, not
  // to whichever is consulted first. Telar's own old client could not produce
  // such a body — it sent `provider === "codex" ? {sandbox, approvalPolicy} :
  // {permissionMode}`, mutually exclusive — but the route accepts any body for
  // one release, and precedence deciding the answer is exactly the case where
  // "map forward or map DOWN, never up" would have been violated by an ordering
  // rather than by a row: `{permissionMode: "acceptEdits", sandbox:
  // "read-only"}` would otherwise open a write-capable session off a body whose
  // only Codex-shaped field said read-only.
  if (claude && codex) return profileRuntimeModeCeiling(claude, codex);
  return claude ?? codex;
}

/** The same question with the fallback applied — for the call sites that must
 *  end up with a mode no matter what they were handed. Never resolves upward:
 *  `DEFAULT_RUNTIME_MODE` is `auto`, below `full-access` on the ladder. */
export function runtimeModeOrDefault(input: Parameters<typeof runtimeModeFromLegacy>[0]): RuntimeMode {
  return runtimeModeFromLegacy(input) ?? DEFAULT_RUNTIME_MODE;
}

// --- The old vocabulary, kept alive for one release --------------------------

// The composer and the settings pane still speak these while their own rebuild
// lands; the chat route no longer does. Nothing NEW may use them — the wire
// carries `runtimeMode`, and these exist only so the surfaces that have not
// been converted yet keep compiling. Delete with their last importer.

/** @deprecated The three values Claude sessions used to choose between. Use
 *  `SELECTABLE_RUNTIME_MODES`. */
export const PERMISSION_MODES = ["default", "auto", "acceptEdits"] as const;
/** @deprecated Use `RuntimeMode`. */
export type ClientPermissionMode = (typeof PERMISSION_MODES)[number];
/** @deprecated Use `isSelectableRuntimeMode`. */
export function isValidPermissionMode(mode: unknown): mode is ClientPermissionMode {
  return typeof mode === "string" && (PERMISSION_MODES as readonly string[]).includes(mode);
}

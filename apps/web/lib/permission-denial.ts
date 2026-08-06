// WHAT AN AUTO-DENIAL ACTUALLY SAYS TO THE MODEL.
//
// WHAT WAS WRONG. The Agent SDK emits `permission_denied` for every tool call
// refused WITHOUT an interactive prompt — the auto-mode classifier, a
// working-directory boundary, a safety check, `dontAsk` mode, a deny rule. Its
// `message` field is the text handed to the model in the tool_result, and in
// the common case that text reads:
//
//     "The user doesn't want to take this action right now. STOP what you are
//      doing and wait for the user to tell you how to proceed."
//
// telar forwarded that verbatim. When the denial came from a classifier or a
// path boundary the sentence is FALSE — the user was never asked and did not
// refuse — and the model believes it, apologises, stops, and (in a sub-agent)
// spends the rest of its turn budget waiting for a human who was never
// consulted. An afternoon of runs was lost to agents politely standing down
// from a refusal nobody made.
//
// WHY REWRITE RATHER THAN SUPPRESS. The denial is real and the model must know
// the call did not happen; what it must not be told is WHO decided. The SDK
// already hands us the discriminator (`decision_reason_type`) on the same
// message, so this is a matter of saying the true thing rather than of
// inventing information.
//
// THE ONE THAT IS STILL THE USER'S. `rule` means a rule the human previously
// wrote and telar stored. That IS the user's decision — just not one made in
// this instant — and it keeps a message that says so, because telling a model
// "a policy blocked this, try again" when a human deliberately banned the tool
// would invite exactly the retry loop the rule exists to stop.
//
// STAYS A PURE FUNCTION with no SDK import, so the route hands it strings and
// the test drives it without a harness — the same posture ultra/child-guard.ts
// takes for hook shapes.

/** The discriminators the SDK documents on `SDKPermissionDeniedMessage`
 *  (`sdk.d.ts`, `decision_reason_type`). Kept as a wide `string` at the call
 *  site: this list is the SDK's to extend, and an unknown value must degrade to
 *  the generic phrasing rather than crash a live turn. */
export type DenialReasonType =
  | "rule"
  | "mode"
  | "subcommandResults"
  | "permissionPromptTool"
  | "hook"
  | "asyncAgent"
  | "sandboxOverride"
  | "workingDir"
  | "safetyCheck"
  | "classifier"
  | "other";

/** True when the denial represents a decision the human actually made. Only
 *  `rule` qualifies — every other discriminator on this event is, by the
 *  event's own definition, a refusal that happened WITHOUT asking anyone. */
export function isHumanDecision(reasonType?: string): boolean {
  return reasonType === "rule";
}

/** What the model should be told. `sdkMessage` is the SDK's own text, kept as
 *  the fallback for the case this function is least sure about: no
 *  discriminator at all. */
export function autoDenialMessage(
  reasonType: string | undefined,
  reason: string | undefined,
  sdkMessage: string,
): string {
  // No discriminator — an older CLI, or a path the SDK has not tagged. Passing
  // its text through unchanged is the honest move: we do not know enough to
  // contradict it.
  if (!reasonType) return sdkMessage;

  // The human's own standing decision. Say so, and do NOT invite a retry.
  if (isHumanDecision(reasonType)) {
    return (
      "Denied by a permission rule in telar. This is a standing decision the user " +
      "made earlier, not a transient failure — do not retry this call. " +
      (reason ? `Rule: ${reason}. ` : "") +
      "If the work genuinely requires it, say so and let the user change the rule."
    );
  }

  const detail = reason ? ` (${reason})` : "";

  switch (reasonType) {
    case "classifier":
      return (
        "Blocked by telar's automatic permission classifier" + detail + ". " +
        "THE USER WAS NOT ASKED and has not refused anything. This is a policy " +
        "check that did not approve the call, not a human decision. Continue with " +
        "the rest of your task; if this specific call is essential, say plainly " +
        "that it was auto-blocked and what you needed it for."
      );
    case "workingDir":
      return (
        "Blocked because this path is outside the session's working directory" +
        detail + ". The user was not asked. Work within the session's directory, " +
        "or state which path you need and why."
      );
    case "safetyCheck":
      return (
        "Blocked by a safety check" + detail + ". The user was not asked. " +
        "This call was judged to need explicit human approval; describe what you " +
        "intended to do rather than attempting a variation to get around it."
      );
    case "sandboxOverride":
      return (
        "Blocked by the session's sandbox policy" + detail + ". The user was not " +
        "asked. The sandbox governs what this session may touch; continue with " +
        "work that fits inside it."
      );
    case "mode":
      return (
        "Not pre-approved, and this session's permission mode does not prompt" +
        detail + ". The user was not asked. Continue with tools that are " +
        "available to you."
      );
    case "asyncAgent":
      return (
        "Blocked because a background agent cannot raise an interactive " +
        "permission prompt" + detail + ". The user was not asked and is not " +
        "ignoring you. Continue with what you can do unattended, and report what " +
        "you could not reach."
      );
    case "hook":
      return (
        "Blocked by a telar guardrail" + detail + ". The user was not asked in " +
        "this instant; this is the project's configured policy. Do not retry — " +
        "report what you needed."
      );
    case "subcommandResults":
      return (
        "Blocked because part of this compound command was not approved" + detail +
        ". The user was not asked. Try the parts you need individually rather " +
        "than re-sending the whole chain."
      );
    case "permissionPromptTool":
      return (
        "Blocked by the configured permission-prompt tool" + detail + ". " +
        "The user was not asked directly."
      );
    default:
      // Includes 'other' and anything the SDK adds later.
      //
      // THE SDK'S OWN TEXT IS DELIBERATELY NOT CARRIED HERE, and the test that
      // forced this is worth keeping in mind: quoting it back re-introduces the
      // exact false sentence this module exists to remove, inside a message
      // that has just finished contradicting it. A model reading both believes
      // the more specific-sounding one.
      //
      // Dropping it costs nothing. This event fires ONLY for denials made
      // without an interactive prompt, so "nobody was asked" is true whatever
      // the discriminator says, and every case-specific detail the SDK actually
      // has travels in `reason`, not in this boilerplate.
      return (
        "Automatically blocked" + detail + ". The user was not asked and has not " +
        "refused. Continue with the rest of your task and report what you could " +
        "not reach."
      );
  }
}

// A CANCELLED TOOL CALL IS NOT A REFUSED ONE, AND TELAR MUST STOP SHOWING THEM
// THE SAME WAY.
//
// WHAT GOES WRONG. When a turn is interrupted, the Claude Code CLI fills any
// pending tool_use with a synthetic result:
//
//     "The user doesn't want to take this action right now. STOP what you are
//      doing and wait for the user to tell you how to proceed."
//
// That text is compiled into the CLI binary — its string-table neighbours are
// "[Request interrupted by user]", "[Request interrupted by user for tool use]"
// and "API Error: Request was aborted." telar cannot change what the model
// reads. But telar renders that result too, and today it renders identically to
// a genuine refusal: a red error blob with the sentence in it.
//
// The cost of that conflation is not hypothetical (#28). An interrupt leaks
// forward onto the next few unrelated calls, and because the surface says the
// user refused them, hours went into looking for a permission bug that was never
// there. The failing call is cheap; being unable to tell WHY it failed is not.
//
// WHY A STRING MATCH, AND WHAT REPLACES IT. The CLI records the real answer in
// its own transcript as `toolDenialKind` — "cancelled" / "user-rejected" /
// "automode-blocked" / "permission-rule" — but that field is not on the SDK
// stream telar consumes on 0.3.204, and `grep toolDenialKind` across this repo
// returns nothing. Newer SDKs expose structured non-execution metadata
// (`tool_result_meta.non_execution_kind`); WHEN TELAR IS ON ONE, DELETE THIS
// MODULE and read that field instead. The constant below is the CLI's own, kept
// verbatim so the comparison is exact rather than fuzzy.
//
// FAILING OPEN IS THE RIGHT DIRECTION HERE. If the CLI reworded its message,
// this stops matching and a cancelled call renders as a plain error — which is
// what happens today. It can never mark a genuine refusal as a cancellation,
// because a real refusal carries telar's OWN text (see lib/permission-denial.ts,
// which produces "Denied by a permission rule in telar", "Blocked by telar's
// automatic permission classifier", and so on — none of them this sentence).

/** The CLI's canonical text for a tool call cut short by an interrupt. Verbatim
 *  from the binary; do not "tidy" the wording. */
export const CLI_INTERRUPTED_TOOL_TEXT =
  "The user doesn't want to take this action right now. STOP what you are doing " +
  "and wait for the user to tell you how to proceed.";

/** The distinctive opening clause. Matched rather than the whole string because
 *  the CLI has been seen to wrap or append to it, and a prefix that specific is
 *  not going to collide with real tool output. */
const SIGNATURE = "The user doesn't want to take this action right now";

/** True when a tool result is the CLI's interrupted-call filler rather than a
 *  decision anyone made.
 *
 *  Deliberately NOT exported as a general "was this denied" check: it answers
 *  one narrow question, and a broader one would invite callers to treat telar's
 *  own honest denials as cancellations too. */
export function isCancelledToolResult(output: string | undefined): boolean {
  if (!output) return false;
  return output.includes(SIGNATURE);
}

/** What telar shows in place of the CLI's sentence.
 *
 *  It says three things the original does not: that the call did not run, that
 *  nobody refused it, and that retrying is fine. The last one matters — a
 *  sub-agent reading the CLI's text stands down and burns its remaining budget
 *  waiting for a human who was never asked. */
export const CANCELLED_TOOL_NOTE =
  "Cancelled — this call was interrupted before it ran. Nobody refused it.";

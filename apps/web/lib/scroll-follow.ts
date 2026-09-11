/**
 * WHEN A TRANSCRIPT THAT STOPPED FOLLOWING SHOULD START AGAIN.
 *
 * use-stick-to-bottom follows growth only while its own `isAtBottom` is set,
 * and that flag is DROPPED by several things that are not a reader deciding to
 * read something (useStickToBottom.js, v1.1.6):
 *
 *   • the deferred scroll branch, on any event whose `scrollTop` fell below the
 *     previous one (~271-274), including one the library's own spring caused
 *     when its `ignoreScrollToTop` guard missed — that guard is cleared by the
 *     FIRST scroll event (~236) while the animation may assign `scrollTop`
 *     more than once in a frame;
 *   • the wheel handler, on ANY upward notch (~296-302) — a trackpad's inertial
 *     rebound at the end of a downward flick counts, and nothing requires the
 *     viewport to have actually moved;
 *   • `isSelecting()` (~260-264), which is true whenever a mouse button is down
 *     ANYWHERE in the document and a selection range exists whose common
 *     ancestor contains the viewport — `document.body` does.
 *
 * GROWTH NEVER UNDOES IT. The resize path asks for `preserveScrollPosition`
 * (~337-342) and `scrollToBottom` only re-arms when that option is absent
 * (~135-137), so the animation's first act is to see the dropped flag and stop
 * (~153-156). The library's only two recoveries are a scroll EVENT landing near
 * the bottom (~278-280) and a NEGATIVE resize (~350-353). A transcript sitting
 * still at its own end produces neither — so one spurious escape lasts the rest
 * of the turn.
 *
 * WHY THE PACED REVEAL MADE IT A BUG REPORT. Before `lib/streaming-reveal.ts`,
 * an answer arrived in bursts: each one grew the content by more than the
 * library's 70px near-bottom slack, so a stuck transcript at least SHOWED the
 * jump button (`isAtBottom` is reported as `isAtBottom || isNearBottom`, and
 * the button reads that). The pacer reveals a line at a time — every increment
 * stays inside the slack, `isNearBottom` never goes false, and the transcript
 * quietly stops following with no button offering the way back.
 *
 * THE RULE, then: an escape the READER did not perform is undone. Their own
 * gesture is sacred — scrolling up during a long turn must survive the next
 * token — so the only thing separating the two is whether a pointer gesture
 * landed on the viewport just before the flag dropped. Kept here, pure, because
 * every part of it is a judgement rather than a DOM call.
 */

/** The library's own `STICK_TO_BOTTOM_OFFSET_PX`: how far from the end still
 *  counts as being at it. Re-declared rather than imported — it is not
 *  exported, and a viewport further out than this has visibly left. */
export const FOLLOW_SLACK_PX = 70;

/**
 * How recently a gesture has to have landed for the escape to be ITS doing.
 * The library decides one scroll event later (a 1ms `setTimeout`), and momentum
 * keeps wheel events coming for the length of a flick; a third of a second
 * covers both without reaching back to something the reader did and finished.
 */
export const READER_GESTURE_MS = 300;

export type FollowSignal = {
  /** The library's `escapedFromLock`. */
  escaped: boolean;
  /** Distance from the end in px — the library's `state.scrollDifference`. */
  distance: number;
  /** Milliseconds since a pointer gesture last landed on the viewport;
   *  `Infinity` when none ever has. */
  gestureAgo: number;
};

/** Whether to put the viewport back at the end and re-arm following. */
export function shouldRefollow({ escaped, distance, gestureAgo }: FollowSignal): boolean {
  // Nothing to undo: the library is still following on its own.
  if (!escaped) return false;
  // The reader's own doing. Leave them where they put themselves — they get
  // back by scrolling down, which the library notices for itself.
  if (gestureAgo <= READER_GESTURE_MS) return false;
  // No gesture, but the viewport is a long way from the end: something moved it
  // deliberately (a jump to a match, a restored position). Treat that as a
  // reader's decision too; the jump button is showing at this distance.
  return distance <= FOLLOW_SLACK_PX;
}

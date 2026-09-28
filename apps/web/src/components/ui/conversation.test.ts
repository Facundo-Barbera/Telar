/**
 * SWITCHING SESSIONS LANDS ON THE TAIL, and does not crawl there.
 *
 * The regression this pins is a sequence, not a state. `initial="instant"` is
 * spent on the first resize of a content ELEMENT, and the cockpit keeps one
 * element across a route change from one session to the next — so the opening
 * arrived as three separate growths (the previous session's rows, still in
 * state; the cached photograph; the live read) and only the first of them was
 * instant. The rest were `resize="smooth"`: a spring animation down from
 * wherever the scrollbar had been clamped to.
 *
 * So the assertions are about the SEQUENCE a switch produces: every commit
 * before the live transcript lands is an opening, the one that carries it is
 * the last of them, and the commits after it are ordinary growth that may
 * animate. The two ends matter equally — a viewport that never stops placing
 * itself is one the reader can never scroll up in.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { nextPlacement } from "./conversation";

/** The sync key the cockpit names a conversation by. */
const A = '["local","session-a"]';
const B = '["local","session-b"]';

/**
 * Replays a run of commits through the rule the way the layout effect does,
 * carrying `settledAt` forward, and reports which of them placed the viewport.
 */
function replay(commits: { at: string; landed: boolean }[]): boolean[] {
  let settledAt: string | undefined;
  return commits.map((commit) => {
    const next = nextPlacement(commit.at, commit.landed, settledAt);
    settledAt = next.settledAt;
    return next.place;
  });
}

describe("placing the viewport on the conversation it is showing", () => {
  test("a switch places every commit until the live transcript lands", () => {
    // The sequence itself: B's route is on screen while A's rows are still in
    // state, then the recording, then the read that finally belongs to B.
    expect(
      replay([
        { at: B, landed: false }, // still holding A's turns
        { at: B, landed: false }, // the cached photograph of B
        { at: B, landed: true }, // B's live transcript
      ]),
    ).toEqual([true, true, true]);
  });

  test("growth after the transcript has landed is left to animate", () => {
    // A turn streaming under a reader who is already at the bottom is the one
    // thing that SHOULD animate, and it is every commit after the opening.
    expect(
      replay([
        { at: B, landed: false },
        { at: B, landed: true },
        { at: B, landed: true },
        { at: B, landed: true },
      ]),
    ).toEqual([true, true, false, false]);
  });

  test("landing does not stop the commit that carries it from being placed", () => {
    // The live rows and the fact that they are live arrive in ONE commit, so
    // the transcript grows on the same render that ends the opening. Reading
    // this the other way round is exactly the animated crawl: the growth would
    // be treated as ordinary and sprung from wherever the scrollbar sat.
    expect(nextPlacement(B, true, undefined)).toEqual({ place: true, settledAt: B });
  });

  test("a conversation that has landed once is not placed again", () => {
    expect(nextPlacement(B, true, B)).toEqual({ place: false, settledAt: B });
  });

  test("switching away re-arms the placement, and back again re-arms it too", () => {
    // Only one conversation is ever settled — the one on screen — so returning
    // to A after B opens A again rather than leaving it wherever it was.
    expect(
      replay([
        { at: A, landed: true }, // A opens
        { at: A, landed: true }, // …and is left alone
        { at: B, landed: false }, // switch: B is opening
        { at: B, landed: true },
        { at: A, landed: false }, // switch back: A is opening again
        { at: A, landed: true },
        { at: A, landed: true },
      ]),
    ).toEqual([true, false, true, true, true, true, false]);
  });

  test("an opening that never lands keeps placing — which is why a failed read must land", () => {
    // Stated as the rule's edge rather than left implicit: while nothing
    // answers for this conversation, every commit re-places the viewport. The
    // cockpit therefore reports a read that FAILED as landed too, or a reader
    // under an unreachable engine is pinned to the bottom of the recording and
    // cannot scroll up through it.
    expect(replay([
      { at: B, landed: false },
      { at: B, landed: false },
      { at: B, landed: false },
    ])).toEqual([true, true, true]);
    // …and the moment anything answers, the pinning stops.
    expect(replay([
      { at: B, landed: false },
      { at: B, landed: true },
      { at: B, landed: false },
    ])).toEqual([true, true, false]);
  });
});

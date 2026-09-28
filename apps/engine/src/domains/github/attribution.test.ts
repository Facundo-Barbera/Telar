/**
 * THE MARKER THAT LANDS ON GITHUB.COM AND STAYS THERE — issue #791.
 *
 * What must not drift:
 *
 *   - a marker carries a session id and NOTHING ELSE: every shape that could
 *     name this machine — a path, a hostname, an email, a token with
 *     punctuation — is refused rather than escaped;
 *   - a body with no marker parses to NOTHING, which is the direction that
 *     makes the other one mean something;
 *   - the last marker wins, because a reply quotes the comment it answers;
 *   - the marker is invisible to a markdown reader and removable for one that
 *     reads raw text.
 */
import { expect, test } from "bun:test";
import {
  isPublishableSessionId,
  parseSessionAttribution,
  sessionMarker,
  stripSessionMarker,
  withSessionMarker,
} from "../src/github-attribution";

const SESSION = "session_db5cb38d5339445aa30d5d1b2fdd71a2";

test("a marker carries the session id and nothing else", () => {
  const marker = sessionMarker(SESSION);
  expect(marker).toBe(`<!-- telar-session: ${SESSION} -->`);
  // The whole publication rule, stated as a property rather than as a string
  // compare: everything in the marker is the fixed frame or the id itself.
  expect(marker.replace(SESSION, "")).toBe("<!-- telar-session:  -->");
});

/**
 * THE REFUSALS ARE THE FEATURE.
 *
 * Each of these is a real thing that could reach this function if a caller
 * passed the wrong variable, and each one would be permanent the moment it was
 * posted. They are refused by the ID CHARSET rather than by a blocklist — `/`,
 * `.`, `@`, ` ` and `:` are simply not in it — so a shape nobody thought of is
 * refused too.
 */
test("anything that could name this machine is refused, not escaped", () => {
  const forbidden = [
    "/Volumes/Focaltec HD/live/Telar/791-worktree", // a worktree location
    "/Users/facundo/Library/Application Support/Telar", // a local path
    "facundos-macbook.local", // a hostname
    "facundo.barbera@gmail.com", // an email
    "session id with spaces",
    "session_a -->malicious<!-- ", // an attempt to close the comment early
    "",
    "x".repeat(129), // past the length bound
  ];
  for (const value of forbidden) {
    expect(isPublishableSessionId(value)).toBe(false);
    expect(() => sessionMarker(value)).toThrow(/session id and nothing else/);
  }
  expect(isPublishableSessionId(SESSION)).toBe(true);
  /**
   * AND THE LIMIT OF THIS GUARD, STATED RATHER THAN IMPLIED. A bare token shape
   * — `ghp_` plus letters and digits — is inside the id charset and PASSES.
   * This guard proves "no path, no hostname, no address, no whitespace"; it
   * does not and cannot prove "not a secret". What keeps a secret out is the
   * write path: the only argument that reaches `sessionMarker` is a session id
   * the ENGINE read off a verified claim, never a caller's string.
   */
  expect(isPublishableSessionId("ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH")).toBe(true);
});

test("a stamped body round-trips, and an unstamped one attributes to nobody", () => {
  const stamped = withSessionMarker("Reviewed and pushed a fix.", SESSION);
  expect(parseSessionAttribution(stamped)).toEqual({ sessionId: SESSION });

  // THE FAILURE DIRECTION. Without this, every assertion above is satisfied by
  // a parser that returns the same session id for any input at all.
  expect(parseSessionAttribution("Reviewed and pushed a fix.")).toBeUndefined();
  expect(parseSessionAttribution("")).toBeUndefined();
  // Prose that merely TALKS about the marker is not one — it is not on its own
  // line, which is what the anchor is for. This file's own documentation, and
  // the issue body describing the feature, are both this case.
  expect(parseSessionAttribution("we append a `<!-- telar-session: x -->` line")).toBeUndefined();
});

test("the marker goes last, after a blank line", () => {
  const body = withSessionMarker("The finding.", SESSION);
  const lines = body.split("\n");
  expect(lines[0]).toBe("The finding.");
  expect(lines[1]).toBe("");
  expect(lines[2]).toBe(sessionMarker(SESSION));
  // A body that is only whitespace does not get a leading blank line.
  expect(withSessionMarker("   \n\n", SESSION)).toBe(sessionMarker(SESSION));
});

test("the last marker wins, because a reply quotes what it answers", () => {
  const quoted = withSessionMarker("earlier", "session_older");
  const reply = withSessionMarker(`> ${quoted.split("\n").join("\n> ")}\n\nAgreed.`, SESSION);
  // The quoted marker survives the quoting (`> ` is leading whitespace to
  // markdown but not to this anchor), so the rule has to be the LAST one.
  expect(parseSessionAttribution(reply)).toEqual({ sessionId: SESSION });
});

test("stripping leaves the comment and removes only the marker", () => {
  const body = withSessionMarker("Two lines\nof finding.", SESSION);
  expect(stripSessionMarker(body)).toBe("Two lines\nof finding.");
  // Nothing to strip is not an error, and does not eat the body.
  expect(stripSessionMarker("plain")).toBe("plain");
  expect(stripSessionMarker(sessionMarker(SESSION))).toBe("");
});

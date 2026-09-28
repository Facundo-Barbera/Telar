import { expect, test } from "bun:test";
import {
  isPublishableSessionId,
  parseSessionAttribution,
  sessionMarker,
  stripSessionMarker,
  withSessionMarker,
} from "./attribution";

const SESSION = "session_db5cb38d5339445aa30d5d1b2fdd71a2";

test("a marker carries the session id and nothing else", () => {
  const marker = sessionMarker(SESSION);
  expect(marker).toBe(`<!-- telar-session: ${SESSION} -->`);
  expect(marker.replace(SESSION, "")).toBe("<!-- telar-session:  -->");
});

test("anything that could name this machine is refused, not escaped", () => {
  const forbidden = [
    "/Volumes/Focaltec HD/live/Telar/791-worktree",
    "/Users/facundo/Library/Application Support/Telar",
    "facundos-macbook.local",
    "facundo.barbera@gmail.com",
    "session id with spaces",
    "session_a -->malicious<!-- ",
    "",
    "x".repeat(129),
  ];
  for (const value of forbidden) {
    expect(isPublishableSessionId(value)).toBe(false);
    expect(() => sessionMarker(value)).toThrow(/session id and nothing else/);
  }
  expect(isPublishableSessionId(SESSION)).toBe(true);
  expect(isPublishableSessionId("ghp_AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH")).toBe(true);
});

test("a stamped body round-trips, and an unstamped one attributes to nobody", () => {
  const stamped = withSessionMarker("Reviewed and pushed a fix.", SESSION);
  expect(parseSessionAttribution(stamped)).toEqual({ sessionId: SESSION });

  expect(parseSessionAttribution("Reviewed and pushed a fix.")).toBeUndefined();
  expect(parseSessionAttribution("")).toBeUndefined();
  expect(parseSessionAttribution("we append a `<!-- telar-session: x -->` line")).toBeUndefined();
});

test("the marker goes last, after a blank line", () => {
  const body = withSessionMarker("The finding.", SESSION);
  const lines = body.split("\n");
  expect(lines[0]).toBe("The finding.");
  expect(lines[1]).toBe("");
  expect(lines[2]).toBe(sessionMarker(SESSION));
  expect(withSessionMarker("   \n\n", SESSION)).toBe(sessionMarker(SESSION));
});

test("the last marker wins, because a reply quotes what it answers", () => {
  const quoted = withSessionMarker("earlier", "session_older");
  const reply = withSessionMarker(`> ${quoted.split("\n").join("\n> ")}\n\nAgreed.`, SESSION);
  expect(parseSessionAttribution(reply)).toEqual({ sessionId: SESSION });
});

test("stripping leaves the comment and removes only the marker", () => {
  const body = withSessionMarker("Two lines\nof finding.", SESSION);
  expect(stripSessionMarker(body)).toBe("Two lines\nof finding.");
  expect(stripSessionMarker("plain")).toBe("plain");
  expect(stripSessionMarker(sessionMarker(SESSION))).toBe("");
});

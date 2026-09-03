// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { decideFollow, parseFollowMode } from "./host-follow";

const published = { updatedAt: 1_700_000_000_000, appearance: { version: 2 } };

describe("parseFollowMode", () => {
  test("a fresh window follows; only an explicit detach does not", () => {
    expect(parseFollowMode(null)).toBe("follow");
    expect(parseFollowMode("follow")).toBe("follow");
    expect(parseFollowMode("garbage")).toBe("follow");
    expect(parseFollowMode("detached")).toBe("detached");
  });
});

describe("decideFollow", () => {
  test("a remote window that has not seen this publication wears it", () => {
    expect(decideFollow({ mode: "follow", isHost: false, applied: null, answer: published })).toBe("apply");
    expect(decideFollow({ mode: "follow", isHost: false, applied: 1, answer: published })).toBe("apply");
  });

  test("the same publication is not worn twice", () => {
    expect(decideFollow({ mode: "follow", isHost: false, applied: published.updatedAt, answer: published })).toBe("skip");
  });

  // THE HOST NEVER FOLLOWS: it is the publisher, and the packaged desktop
  // shell is a host even when it is browsing another Mac.
  test("the host window never follows, whatever the store says", () => {
    expect(decideFollow({ mode: "follow", isHost: true, applied: null, answer: published })).toBe("skip");
  });

  test("a detached window keeps its own taste", () => {
    expect(decideFollow({ mode: "detached", isHost: false, applied: null, answer: published })).toBe("skip");
  });

  test("nothing published, or nothing readable, is nothing to wear", () => {
    expect(decideFollow({ mode: "follow", isHost: false, applied: null, answer: { updatedAt: null, appearance: null } })).toBe("skip");
    expect(decideFollow({ mode: "follow", isHost: false, applied: null, answer: { updatedAt: 5, appearance: null } })).toBe("skip");
  });
});

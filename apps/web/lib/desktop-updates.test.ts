/**
 * WHAT THE UPDATE PANE SAYS, AND WHICH BUTTON IT OFFERS.
 *
 * These are the two decisions in that surface, pulled out of the component so
 * they can be checked without a shell to talk to. Both matter more than they
 * look: the sentence is the only place a stalled or failed update is ever
 * explained, and the button is the difference between "install this" and
 * "restart a download that is already running".
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { updateAction, updateStatusHint } from "./desktop-updates";

describe("updateStatusHint", () => {
  test("a version it does not have never renders as vundefined", () => {
    // `version` is optional on the wire, and the shell only learns it from
    // `update-available` — so a `downloading` broadcast that arrives without one
    // is a normal event, not a bug to render as a broken string.
    expect(updateStatusHint({ status: "available" })).toBe("Downloading…");
    expect(updateStatusHint({ status: "downloading", percent: 42 })).toBe("Downloading… 42%");
    expect(updateStatusHint({ status: "downloading", version: "1.2.3", percent: 42 })).toBe("Downloading v1.2.3… 42%");
  });

  test("a percentage is rounded, because 41.99999 is not a thing to show a person", () => {
    expect(updateStatusHint({ status: "downloading", percent: 41.99999 })).toBe("Downloading… 42%");
    // Absent progress reads as 0% rather than NaN%.
    expect(updateStatusHint({ status: "downloading" })).toBe("Downloading… 0%");
  });

  test("a locally packaged build says WHY it will never update", () => {
    // The honest failure. A build with no feed baked in is not broken and is not
    // up to date; saying "You're on the latest build" there would be a lie that
    // takes a while to catch.
    expect(updateStatusHint({ status: "unsupported" })).toContain("packaged locally");
  });

  test("an error carries the shell's own message", () => {
    expect(updateStatusHint({ status: "error", message: "ENOTFOUND updates.example" })).toContain("ENOTFOUND updates.example");
  });

  test("nothing to do reads as reassurance, not silence", () => {
    expect(updateStatusHint({ status: "not-available" })).toBe("You're on the latest build.");
  });
});

describe("updateAction", () => {
  test("only two states carry a decision", () => {
    expect(updateAction({ status: "downloaded", version: "1.2.3" })).toBe("install");
    expect(updateAction({ status: "not-available" })).toBe("check");
    expect(updateAction({ status: "error", message: "boom" })).toBe("check");
    expect(updateAction({ status: "unsupported" })).toBe("check");
  });

  test("an update already arriving offers no button", () => {
    // `available` and `downloading` are things happening TO you. "Check for
    // updates" there is at best a no-op and at worst restarts a check for
    // something already on its way down.
    expect(updateAction({ status: "available", version: "1.2.3" })).toBe("progress");
    expect(updateAction({ status: "downloading", percent: 10 })).toBe("progress");
    expect(updateAction({ status: "checking" })).toBe("check");
  });
});

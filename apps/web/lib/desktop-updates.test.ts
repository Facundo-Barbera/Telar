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
import { updateAction, updateLabel, updateStatusHint, updateToast, type UpdateStatus } from "./desktop-updates";

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

  test("a restart in progress says so, in the present tense (#389)", () => {
    // The state that used to be silence — the seconds between the press and
    // the quit, which read as a dead button.
    expect(updateStatusHint({ status: "restarting", version: "1.2.3" })).toBe("Restarting to install v1.2.3…");
    expect(updateStatusHint({ status: "restarting" })).toBe("Restarting to install…");
  });
});

describe("updateAction", () => {
  /** Every status the shell can broadcast, so a new one cannot be added
   *  without deciding which of the three controls it draws. */
  const EVERY_STATUS: UpdateStatus["status"][] = [
    "checking",
    "available",
    "not-available",
    "downloading",
    "downloaded",
    "restarting",
    "error",
    "unsupported",
  ];

  test("every status lands in exactly one state, and none of them is undefined", () => {
    for (const status of EVERY_STATUS) {
      expect(`${status}: ${updateAction({ status })}`).toBe(
        `${status}: ${
          status === "restarting"
            ? "restarting"
            : status === "downloaded"
              ? "apply"
              : status === "available" || status === "downloading"
                ? "download"
                : "check"
        }`,
      );
    }
  });

  test("only one state carries a decision the user makes", () => {
    expect(updateAction({ status: "downloaded", version: "1.2.3" })).toBe("apply");
  });

  test("idle, failed and unsupported all offer the check", () => {
    // The glyph for these is the arrow-circle — NOT the download arrow the
    // idle button used to draw, which is the complaint #389 opens with.
    expect(updateAction({ status: "not-available" })).toBe("check");
    expect(updateAction({ status: "error", message: "boom" })).toBe("check");
    expect(updateAction({ status: "unsupported" })).toBe("check");
    expect(updateAction({ status: "checking" })).toBe("check");
  });

  test("an update already arriving reports rather than asks", () => {
    // `available` and `downloading` are things happening TO you. "Check for
    // updates" there is at best a no-op and at worst restarts a check for
    // something already on its way down — so the control draws the download
    // glyph and the press does nothing.
    expect(updateAction({ status: "available", version: "1.2.3" })).toBe("download");
    expect(updateAction({ status: "downloading", percent: 10 })).toBe("download");
  });

  test("a restart is its own state, not a kind of apply", () => {
    expect(updateAction({ status: "restarting", version: "1.2.3" })).toBe("restarting");
  });
});

describe("updateLabel", () => {
  test("an idle control offers the action rather than reporting a state", () => {
    expect(updateLabel({ status: "not-available" })).toBe("Check for app updates");
  });

  test("the states with something to report keep their sentence", () => {
    expect(updateLabel({ status: "checking" })).toBe("Checking for a newer build…");
    expect(updateLabel({ status: "downloading", version: "1.2.3", percent: 42 })).toBe("Downloading v1.2.3… 42%");
    expect(updateLabel({ status: "restarting", version: "1.2.3" })).toBe("Restarting to install v1.2.3…");
    expect(updateLabel({ status: "error", message: "feed unreachable" })).toContain("feed unreachable");
  });

  test("apply names the version it is about to install, and never vundefined", () => {
    expect(updateLabel({ status: "downloaded", version: "1.2.3" })).toBe("Install v1.2.3 and restart");
    expect(updateLabel({ status: "downloaded" })).toBe("Install the update and restart");
  });

  test("a failure of this surface's own calls wins over whatever the shell last said", () => {
    // The one state nothing else can describe: a rejected IPC call, or a
    // restart that was accepted and then did not happen. What the update was
    // doing before that is no longer what the reader needs.
    expect(updateLabel({ status: "downloaded", version: "1.2.3" }, "The app has not restarted after 10s. Click to try again.")).toBe(
      "The app has not restarted after 10s. Click to try again.",
    );
    expect(updateLabel({ status: "not-available" }, "Install failed: squirrel refused")).toBe("Install failed: squirrel refused");
  });
});

describe("updateToast", () => {
  test("exactly three moments raise one", () => {
    // News that arrived without being asked for. A press's own answer is
    // already on the control that was pressed.
    expect(updateToast({ status: "available", version: "1.2.3" })?.message).toBe("v1.2.3 is available — downloading…");
    expect(updateToast({ status: "downloaded", version: "1.2.3" })?.message).toBe("v1.2.3 downloaded — restart to install.");
    expect(updateToast({ status: "restarting", version: "1.2.3" })?.message).toBe("Restarting to install v1.2.3…");
  });

  test("a press's own answer is not news", () => {
    for (const status of ["checking", "not-available", "error", "unsupported", "downloading"] as UpdateStatus["status"][]) {
      expect(`${status}: ${updateToast({ status, message: "boom", percent: 5 })}`).toBe(`${status}: null`);
    }
  });

  test("the key changes only when the news does", () => {
    // A `downloading` broadcast arrives many times a second and a re-render
    // arrives whenever React likes; neither may re-raise a toast that has
    // already been read. Only a new key does that.
    const first = updateToast({ status: "downloaded", version: "1.2.3" })!;
    expect(updateToast({ status: "downloaded", version: "1.2.3" })!.key).toBe(first.key);
    expect(updateToast({ status: "downloaded", version: "1.2.4" })!.key).not.toBe(first.key);
    // The same version at two points of its life is two pieces of news.
    expect(updateToast({ status: "available", version: "1.2.3" })!.key).not.toBe(first.key);
  });

  test("a version the shell never sent still reads as a sentence", () => {
    expect(updateToast({ status: "available" })?.message).toBe("An update is available — downloading…");
    expect(updateToast({ status: "downloaded" })?.message).toBe("Update downloaded — restart to install.");
  });
});

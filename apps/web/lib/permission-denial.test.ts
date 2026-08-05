// bun provides "bun:test" at runtime; @types/bun isn't a dependency of this Next
// app, so the web tsconfig (which includes **/*.ts) can't resolve it. Suppress
// just the import — the runtime is `bun test`, not tsc.
// @ts-expect-error no @types/bun in this workspace
import { describe, expect, test } from "bun:test";

import { autoDenialMessage, isHumanDecision } from "@/lib/permission-denial";

// The exact string the SDK hands over in the common auto-deny case. Pinned as a
// literal because the whole point of this module is that telar must STOP
// repeating it, and a test that built the string from the module could never
// catch the module going back to passing it through.
const SDK_TEXT =
  "The user doesn't want to take this action right now. STOP what you are doing " +
  "and wait for the user to tell you how to proceed.";

describe("auto-denial messages never claim the user refused", () => {
  // The regression this module exists for. A classifier denial that keeps the
  // SDK's wording tells a sub-agent to stop and wait for a human who was never
  // consulted — which is how an afternoon of runs was lost.
  test("a classifier denial does not say the user refused, and says so explicitly", () => {
    const message = autoDenialMessage("classifier", undefined, SDK_TEXT);
    expect(message).not.toContain("user doesn't want");
    expect(message).not.toContain("wait for the user");
    expect(message).toContain("THE USER WAS NOT ASKED");
  });

  // Every non-`rule` discriminator the SDK documents. Written as a loop over the
  // list rather than one test each, so a discriminator added to the module
  // without a decision about its wording fails HERE rather than shipping with
  // the SDK's sentence intact.
  const AUTOMATIC = [
    "classifier",
    "workingDir",
    "safetyCheck",
    "sandboxOverride",
    "mode",
    "asyncAgent",
    "hook",
    "subcommandResults",
    "permissionPromptTool",
    "other",
  ];

  for (const reasonType of AUTOMATIC) {
    test(`'${reasonType}' states that the user was not asked`, () => {
      const message = autoDenialMessage(reasonType, undefined, SDK_TEXT);
      expect(message.toLowerCase()).toContain("was not asked");
      expect(message).not.toContain("The user doesn't want to take this action");
    });
  }

  test("an unknown discriminator degrades to the generic phrasing WITHOUT quoting the SDK", () => {
    // The SDK owns this union and will extend it, so an unrecognised value must
    // still lose the false claim.
    //
    // It must also not quote the SDK's text back. An earlier cut of this module
    // appended "Original message: <sdk text>" to preserve detail, which put the
    // sentence "The user doesn't want to take this action" back inside a
    // message that had just denied it — and a model reading both believes the
    // more specific-sounding one. This assertion is what caught that.
    const message = autoDenialMessage("somethingNewInTheSDK", undefined, SDK_TEXT);
    expect(message).toContain("was not asked");
    expect(message).not.toContain("The user doesn't want to take this action");
  });

  test("no discriminator at all passes the SDK's text through untouched", () => {
    // The one case this module is least sure about: without a reason type we
    // cannot know the denial was automatic, so contradicting the SDK would be
    // inventing information.
    expect(autoDenialMessage(undefined, undefined, SDK_TEXT)).toBe(SDK_TEXT);
  });
});

describe("a stored rule stays the user's own decision", () => {
  test("'rule' is the only discriminator treated as a human decision", () => {
    expect(isHumanDecision("rule")).toBe(true);
    for (const other of ["classifier", "workingDir", "mode", "hook", undefined]) {
      expect(isHumanDecision(other)).toBe(false);
    }
  });

  test("a rule denial tells the model NOT to retry", () => {
    // The asymmetry that matters: an automatic block invites continuing, a rule
    // the human wrote does not. Telling a model "policy blocked this, try
    // again" when a human deliberately banned the tool would produce exactly
    // the retry loop the rule exists to prevent.
    const message = autoDenialMessage("rule", "Bash(rm:*)", SDK_TEXT);
    expect(message).toContain("do not retry");
    expect(message).toContain("Bash(rm:*)");
    expect(message).not.toContain("was not asked");
  });
});

describe("the reason detail is carried when the SDK supplies one", () => {
  test("a supplied reason is included in the message", () => {
    const message = autoDenialMessage("workingDir", "/etc/passwd is outside /repo", SDK_TEXT);
    expect(message).toContain("/etc/passwd is outside /repo");
  });

  test("an absent reason leaves no empty parenthetical", () => {
    // Cosmetic, but this text goes to a model: a stray "()" is noise that reads
    // as a truncated message.
    expect(autoDenialMessage("workingDir", undefined, SDK_TEXT)).not.toContain("()");
  });
});

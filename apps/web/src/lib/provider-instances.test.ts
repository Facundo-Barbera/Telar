/**
 * What the Providers pane says, and what it refuses to say.
 *
 * The summary is the part worth pinning hardest: it is the sentence a person
 * reads when an account is not working, and every wrong version of it sends
 * them to fix the wrong thing.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { ProviderInstance, ProviderProbe } from "@telar/engine-client";
import {
  displayNameOf,
  humanizeInstanceId,
  isDefaultInstance,
  isValidInstanceId,
  providerSummary,
  signInCommand,
  sortInstances,
  STATUS_DOT,
  suggestInstanceId,
  updateAdvisory,
  versionLabel,
} from "./provider-instances";

const instance = (id: string, over: Partial<ProviderInstance> = {}): ProviderInstance => ({
  id,
  driver: "claude",
  enabled: true,
  env: [],
  createdAt: 0,
  updatedAt: 0,
  ...over,
});

const probe = (over: Partial<ProviderProbe> = {}): ProviderProbe => ({
  instanceId: "claude",
  driver: "claude",
  status: "ready",
  installed: true,
  signIn: "unknown",
  checkedAt: 0,
  ...over,
});

describe("providerSummary", () => {
  test("a missing engine answer is 'checking', not 'broken'", () => {
    // Before the first probe lands there is nothing to report, and a red row
    // that turns green a second later teaches people to ignore the colour.
    expect(providerSummary(undefined)).toBe("Checking");
  });

  test("off outranks everything, including a missing CLI", () => {
    expect(providerSummary(probe({ status: "disabled", installed: false }))).toBe("Off");
  });

  test("a missing CLI outranks any sign-in note", () => {
    // There is no point telling somebody their config folder looks fine when
    // the CLI it configures is not installed.
    expect(providerSummary(probe({ status: "error", installed: false, signIn: "signed-in", message: "not on PATH" }))).toBe("Not installed");
  });

  test("a working login gets no badge at all, however it was proved", () => {
    /**
     * THE ONE THIS FILE EXISTS FOR, restated for the badge (#357). Claude's
     * token is in the Keychain, so "installed" was all that could be measured —
     * and the old copy said so in a sentence on every healthy row ("Base login
     * — sign-in state cannot be verified from disk"). Claiming "Signed in"
     * would be a confident wrong answer; saying nothing is the honest one, and
     * the row reads name · version · switch.
     */
    expect(providerSummary(probe({ signIn: "unknown" }))).toBeNull();
    expect(providerSummary(probe({ signIn: "signed-in" }))).toBeNull();
  });

  test("the states a reader has to act on keep their word", () => {
    expect(providerSummary(probe({ status: "warning", signIn: "signed-out" }))).toBe("Not signed in");
    expect(providerSummary(probe({ status: "warning", signIn: "missing-config-dir" }))).toBe("Config folder missing");
  });
});

test("a switched-off instance is muted, not amber", () => {
  // t3 paints `disabled` amber. Off is a decision, not a problem, and colouring
  // it like one sends people to fix something they chose.
  expect(STATUS_DOT.disabled).toBe("bg-muted-foreground/40");
  expect(STATUS_DOT.error).toBe("bg-destructive");
});

test("the version is extracted from whatever sentence the CLI printed", () => {
  // BOTH OF THESE ARE REAL OUTPUT from the installed harnesses, and they do not
  // agree on a shape. The earlier rule — prefix `v` unless it starts with one —
  // rendered the second as `vcodex-cli 0.145.0`, which is what driving the page
  // showed and no test had asked about.
  expect(versionLabel("2.1.229 (Claude Code)")).toBe("v2.1.229");
  expect(versionLabel("codex-cli 0.145.0")).toBe("v0.145.0");
  expect(versionLabel("v2.1.0")).toBe("v2.1.0");
  // No number to find: pass it through rather than invent one. A build id is
  // still the most useful thing that could be shown.
  expect(versionLabel("nightly-build")).toBe("nightly-build");
  expect(versionLabel(undefined)).toBeNull();
  expect(versionLabel("   ")).toBeNull();
});

describe("displayNameOf", () => {
  test("the built-in slot is the brand name", () => {
    expect(isDefaultInstance(instance("claude"))).toBe(true);
    expect(displayNameOf(instance("claude"))).toBe("Claude");
    expect(displayNameOf(instance("codex", { driver: "codex" }))).toBe("Codex");
  });

  test("an unnamed custom login is still distinguishable", () => {
    // Two logins of one provider both rendering as "Claude" is the failure this
    // fallback exists to prevent.
    expect(displayNameOf(instance("claude_work"))).toBe("Claude Work");
    expect(humanizeInstanceId("myCustomInstance")).toBe("My Custom Instance");
  });

  test("a name the user gave wins over both", () => {
    expect(displayNameOf(instance("claude_work", { displayName: "Day job" }))).toBe("Day job");
  });
});

test("the built-in slot sorts first within its driver, and drivers keep their order", () => {
  const sorted = sortInstances([
    instance("claude_work"),
    instance("codex", { driver: "codex" }),
    instance("claude"),
    instance("codex_alt", { driver: "codex" }),
  ]);
  expect(sorted.map((entry) => entry.id)).toEqual(["claude", "claude_work", "codex", "codex_alt"]);
});

describe("suggestInstanceId", () => {
  test("derives a permanent id from a name somebody typed", () => {
    // The id is the routing key every session stores, so the dialog derives one
    // rather than making a permanent decision a required second field.
    expect(suggestInstanceId("claude", "Day job", [])).toBe("claude_day_job");
    expect(suggestInstanceId("codex", "  Work!  ", [])).toBe("codex_work");
    expect(suggestInstanceId("claude", "", [])).toBe("claude_instance");
  });

  test("a collision gets a suffix rather than an error", () => {
    // "Work" twice is a reasonable thing for a person to do.
    expect(suggestInstanceId("claude", "Work", ["claude_work"])).toBe("claude_work_2");
    expect(suggestInstanceId("claude", "Work", ["claude_work", "claude_work_2"])).toBe("claude_work_3");
  });

  test("everything it suggests is something the engine will accept", () => {
    for (const name of ["Day job", "", "9 lives", "---", "Ünïcödé"]) {
      expect(isValidInstanceId(suggestInstanceId("claude", name, []))).toBe(true);
    }
    // And the mirror of the engine's rule refuses what the engine refuses.
    expect(isValidInstanceId("-force")).toBe(false);
    expect(isValidInstanceId("9lives")).toBe(false);
    expect(isValidInstanceId("claude_work")).toBe(true);
  });
});

test("the sign-in command is the user's to run, and names the account", () => {
  // Without the prefix the CLI signs the BASE login in, which on a machine with
  // several config folders is the one account they were not trying to fix.
  expect(signInCommand({ driver: "claude" })).toBe("claude auth login");
  expect(signInCommand({ driver: "claude", configDir: "~/.claude-work" })).toBe(
    'CLAUDE_CONFIG_DIR="~/.claude-work" claude auth login',
  );
  expect(signInCommand({ driver: "codex", configDir: "~/.codex-work" })).toBe('CODEX_HOME="~/.codex-work" codex login');
});

describe("updateAdvisory", () => {
  test("a healthy row says nothing at all", () => {
    // An advisory that renders when there is nothing to say becomes a permanent
    // mark on every row, and people stop reading marks that are always there.
    expect(updateAdvisory({ update: { status: "current", latest: "2.1.232" } }, "Claude")).toBeNull();
    expect(updateAdvisory({ update: { status: "unknown" } }, "Claude")).toBeNull();
    // No engine answer yet, and a probe from a build that did not send one.
    expect(updateAdvisory(undefined, "Claude")).toBeNull();
    expect(updateAdvisory({}, "Claude")).toBeNull();
  });

  test("behind names the version and hands over the command", () => {
    const advisory = updateAdvisory(
      { update: { status: "behind", latest: "2.1.232", method: "native", command: "claude update" } },
      "Claude",
    );
    expect(advisory?.detail).toContain("v2.1.232");
    expect(advisory?.command).toBe("claude update");
  });

  test("behind with no command explains why there is no button", () => {
    // The honest gap: the CLI is old and Telar could not tell how it was
    // installed. Saying so beats offering a guessed installer that would
    // silently replace a self-built binary with a published one.
    const advisory = updateAdvisory({ update: { status: "behind", latest: "0.147.0" } }, "Codex");
    expect(advisory?.command).toBeUndefined();
    expect(advisory?.detail).toContain("the way you installed it");
  });

  test("pinned reports the newer version and refuses to offer it", () => {
    /**
     * THE STATE THE DONOR HAS NO NAME FOR. Something newer exists AND what is
     * installed is exactly what this build of Telar pairs with. The version is
     * still named — the choice belongs to the person — but there is no command,
     * because the engine sends none and this surface must not invent one.
     */
    const advisory = updateAdvisory({ update: { status: "pinned", latest: "2.1.232" } }, "Claude");
    expect(advisory?.detail).toContain("v2.1.232");
    expect(advisory?.detail).toContain("tested against");
    expect(advisory?.command).toBeUndefined();
  });
});

// The proof for provider DETECTION — the module that replaced the login driver.
//
// The probe seam is injected in every case here, so this suite never touches a
// real `claude` / `codex` binary and its result does not depend on what happens
// to be installed on the machine running it.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "telar-detect-"));
process.env.TELAR_HOME = home;
beforeEach(() => {
  process.env.TELAR_HOME = home;
});

const {
  detectProvider,
  detectProviders,
  planLabel,
  signInCommand,
  readProviderCache,
  writeProviderCache,
} = await import("../src/detect");

afterAll(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

const at = () => new Date("2026-07-31T12:00:00.000Z");
const found = (v: string) => async () => v;
const missing = async () => null;

describe("detectProvider", () => {
  test("a version means installed and ready", async () => {
    const p = await detectProvider("claude", { probe: found("2.1.220"), now: at });
    expect(p.installed).toBe(true);
    expect(p.version).toBe("2.1.220");
    expect(p.status).toBe("ready");
    expect(p.configDirEnv).toBe("CLAUDE_CONFIG_DIR");
    expect(p.checkedAt).toBe("2026-07-31T12:00:00.000Z");
  });

  test("no version means not-installed — and never a guess about auth", async () => {
    const p = await detectProvider("codex", { probe: missing, now: at });
    expect(p.installed).toBe(false);
    expect(p.version).toBeNull();
    expect(p.status).toBe("not-installed");
    expect(p.auth.status).toBe("unknown");
  });

  test("a known plan arrives as data and is labelled", async () => {
    const p = await detectProvider("claude", { probe: found("2.1.220"), planType: "max", now: at });
    expect(p.auth.status).toBe("authenticated");
    expect(p.auth.type).toBe("max");
    expect(p.auth.label).toBe("Claude Max Subscription");
  });

  test("no plan reported is 'unknown', NOT 'unauthenticated'", async () => {
    // Not having probed is a different fact from having probed and found
    // nobody signed in. The surface must not print the second for the first.
    const p = await detectProvider("claude", { probe: found("2.1.220"), now: at });
    expect(p.auth.status).toBe("unknown");
    expect(p.auth.type).toBeNull();
    expect(p.auth.label).toBeNull();
  });

  test("an unrecognized plan keeps its raw id and gets no invented name", async () => {
    const p = await detectProvider("codex", { probe: found("0.121.0"), planType: "prolite", now: at });
    expect(p.auth.type).toBe("prolite");
    expect(p.auth.label).toBeNull();
  });

  test("detectProviders covers both shipping providers", async () => {
    const all = await detectProviders(
      { claude: "max", codex: "plus" },
      { probe: found("1.0.0"), now: at },
    );
    expect(all.map((p) => p.provider).sort()).toEqual(["claude", "codex"]);
    expect(all.find((p) => p.provider === "codex")?.auth.label).toBe("ChatGPT Plus Subscription");
  });
});

describe("planLabel", () => {
  test("maps the plan ids we have actually seen", () => {
    expect(planLabel("claude", "max")).toBe("Claude Max Subscription");
    expect(planLabel("claude", "MAX")).toBe("Claude Max Subscription");
    expect(planLabel("codex", "plus")).toBe("ChatGPT Plus Subscription");
  });

  test("returns null rather than naming a plan it doesn't know", () => {
    expect(planLabel("codex", "prolite")).toBeNull();
    expect(planLabel("claude", null)).toBeNull();
    expect(planLabel("claude", undefined)).toBeNull();
  });
});

describe("signInCommand", () => {
  test("the base login gets the bare command", () => {
    expect(signInCommand({ provider: "claude" })).toBe("claude auth login");
    expect(signInCommand({ provider: "codex" })).toBe("codex login");
  });

  test("an account with a config folder gets the env prefix that targets it", () => {
    // Without the prefix the command signs in the BASE login — the one account
    // the user was not trying to fix.
    expect(signInCommand({ provider: "claude", configDir: "~/.claude-work" })).toBe(
      'CLAUDE_CONFIG_DIR="~/.claude-work" claude auth login',
    );
    expect(signInCommand({ provider: "codex", configDir: "~/.codex" })).toBe(
      'CODEX_HOME="~/.codex" codex login',
    );
  });

  test("provider defaults to claude when absent", () => {
    expect(signInCommand({})).toBe("claude auth login");
  });
});

describe("provider cache", () => {
  test("round-trips through ~/.telar/providers.json", async () => {
    expect(readProviderCache()).toEqual([]);
    const probed = await detectProviders({ claude: "max" }, { probe: found("2.1.220"), now: at });
    writeProviderCache(probed);
    const back = readProviderCache();
    expect(back).toHaveLength(2);
    expect(back.find((p) => p.provider === "claude")?.auth.label).toBe("Claude Max Subscription");
  });

  test("a corrupt cache reads as empty rather than throwing", () => {
    fs.writeFileSync(path.join(home, "providers.json"), "{not json");
    expect(readProviderCache()).toEqual([]);
  });
});

// ── plan parsing ───────────────────────────────────────────────────────────
// Regression: the surface printed "stripe_subscription" as the plan, because
// `seatTier` is null on subscription accounts and the old code fell through to
// `billingType` — which says how the account PAYS, not what it pays for.
const { planFamily, planMultiplier } = await import("../src/account-identity");

describe("plan parsing", () => {
  test("the plan family comes from organizationType, normalized", () => {
    expect(planFamily("claude_max", null)).toBe("max");
    expect(planFamily("claude_pro", null)).toBe("pro");
    expect(planFamily("CLAUDE_MAX", null)).toBe("max");
  });

  test("seatTier wins when the account actually carries one", () => {
    expect(planFamily("claude_max", "enterprise")).toBe("enterprise");
  });

  test("billingType is not a plan and has no way in", () => {
    // Both real profiles on the machine this was written on report
    // seatTier=null, billingType="stripe_subscription",
    // organizationType="claude_max" — the exact shape that produced the bug.
    expect(planFamily(null, null)).toBeNull();
    expect(planFamily("claude_max", null)).toBe("max");
  });

  test("the multiplier is read off the rate-limit tier", () => {
    expect(planMultiplier("default_claude_max_20x")).toBe("20x");
    expect(planMultiplier("default_claude_max_5x")).toBe("5x");
  });

  test("no stated multiplier is null, never an assumed 1x", () => {
    expect(planMultiplier("default_claude_pro")).toBeNull();
    expect(planMultiplier(null)).toBeNull();
    expect(planMultiplier(undefined)).toBeNull();
  });
});

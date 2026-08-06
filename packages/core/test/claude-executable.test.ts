// @ts-expect-error no @types/bun in this workspace
import { describe, expect, test } from "bun:test";
import {
  claudeCliUsable,
  expectedCliVersion,
  resolveClaudeCli,
  type ClaudeCliResolution,
} from "../src/claude-executable";

// These pin the DECISIONS, not the machine. resolveClaudeCli() reads the real
// filesystem, so anything asserting a specific version here would fail on the
// next Claude Code auto-update — which is precisely the drift this module
// exists to notice.

describe("expectedCliVersion", () => {
  test("derives the CLI version from the installed wrapper's patch component", () => {
    const expected = expectedCliVersion();
    // The wrapper is a real dependency of this package, so this must resolve.
    expect(expected).toBeDefined();
    // Wrapper 0.3.<patch> ships CLI 2.1.<patch> — the patch number is the
    // release-train identity, and the whole point is that it is DERIVED. If the
    // upstream versioning scheme ever changes, this is the test that says so
    // rather than the app silently gating on a version that never existed.
    expect(expected).toMatch(/^2\.1\.\d+$/);
  });
});

describe("claudeCliUsable", () => {
  const at = (status: ClaudeCliResolution["status"]): ClaudeCliResolution => ({ status });

  test("refuses a missing CLI", () => {
    expect(claudeCliUsable(at("missing"))).toBe(false);
  });

  test("refuses a different control-protocol family", () => {
    expect(claudeCliUsable(at("incompatible"))).toBe(false);
  });

  test("ALLOWS a drifted patch version", () => {
    // Load-bearing: gating on every unrecognised release would lock a user out
    // of their own app the day Claude Code ships faster than telar does, and a
    // patch ahead demonstrably works (2.1.222 against a 2.1.204 wrapper).
    expect(claudeCliUsable(at("drifted"))).toBe(true);
  });

  test("ALLOWS an unreported version rather than assuming the worst", () => {
    expect(claudeCliUsable(at("unknown"))).toBe(true);
  });

  test("allows an exact match", () => {
    expect(claudeCliUsable(at("ok"))).toBe(true);
  });
});

describe("resolveClaudeCli", () => {
  test("always reports a status, and carries a path unless nothing was found", () => {
    const r = resolveClaudeCli();
    expect(["ok", "drifted", "incompatible", "missing", "unknown"]).toContain(r.status);
    if (r.status === "missing") expect(r.path).toBeUndefined();
    else expect(typeof r.path).toBe("string");
  });

  test("every non-ok status carries an actionable message", () => {
    const r = resolveClaudeCli();
    // A status the user cannot act on is the failure this module replaced: the
    // old resolver returned {} and the turn died inside the SDK with no
    // attribution. Whatever this machine's state, a non-ok verdict must explain
    // itself.
    if (r.status !== "ok") expect((r.message ?? "").length).toBeGreaterThan(0);
  });

  test("is stable across calls (version detection is cached)", () => {
    // Spawning `claude --version` per turn would be a cost every session pays
    // forever; the cache is keyed on (path, mtime) so a self-upgrading CLI is
    // still noticed.
    const a = resolveClaudeCli();
    const b = resolveClaudeCli();
    expect(b.status).toBe(a.status);
    expect(b.version).toBe(a.version);
    expect(b.path).toBe(a.path);
  });
});

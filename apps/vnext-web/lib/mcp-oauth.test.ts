/**
 * What a sign-in row says, and which button it offers.
 *
 * The summary is the part worth pinning hardest, for the same reason the
 * Providers pane's is: it is the sentence somebody reads when a tool is not
 * working, and every wrong version sends them to fix the wrong thing.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { McpOAuthStatus } from "@telar/engine-client";
import { HEALTH_DOT, signInAction, signInSummary, statusFor } from "./mcp-oauth";

const status = (over: Partial<McpOAuthStatus> = {}): McpOAuthStatus => ({
  serverId: "linear",
  requiresOAuth: true,
  connected: false,
  health: "needs-auth",
  ...over,
});

describe("signInAction", () => {
  test("a server that never asked for OAuth gets no button", () => {
    // A Connect that cannot work is worse than no Connect: it produces a flow
    // that fails at discovery with a sentence about metadata.
    expect(signInAction(status({ requiresOAuth: false, health: "connected" }))).toBe("none");
    expect(signInAction(undefined)).toBe("none");
  });

  test("wanting OAuth without a grant offers to connect", () => {
    expect(signInAction(status())).toBe("connect");
  });

  test("a rejected grant offers to sign in again, not merely to sign out", () => {
    expect(signInAction(status({ connected: true, health: "needs-auth" }))).toBe("reconnect");
  });

  test("a working grant's primary action is sign out", () => {
    expect(signInAction(status({ connected: true, health: "connected" }))).toBe("disconnect");
    // Including when the SERVER is down: the grant is still the thing there is
    // to act on, and re-running a sign-in would not fix an unreachable server.
    expect(signInAction(status({ connected: true, health: "error" }))).toBe("disconnect");
  });
});

describe("signInSummary", () => {
  test("an unreachable server never reads as one needing a login", () => {
    // THE ONE THIS FILE EXISTS FOR. The two want opposite actions, and only one
    // of them is the reader's to take.
    expect(signInSummary(status({ requiresOAuth: false, health: "error" }))).toBe("No sign-in needed — but the server did not answer.");
    expect(signInSummary(status({ connected: true, health: "error", issuer: "https://auth.linear.app" }))).toBe(
      "Signed in through auth.linear.app — but the server did not answer.",
    );
  });

  test("it names which account, by the issuer's host", () => {
    const now = 1_000_000;
    expect(signInSummary(status({ connected: true, health: "connected", issuer: "https://auth.linear.app/oauth" }), now)).toBe(
      "Signed in through auth.linear.app.",
    );
  });

  test("an expiry is only mentioned when it is news", () => {
    const now = 1_000_000;
    // Refreshed automatically before every turn, so an hour out is not
    // something to warn about — printing one trains people to ignore the line
    // by the time it means something.
    expect(signInSummary(status({ connected: true, health: "connected", expiresAt: now + 6 * 60 * 60_000 }), now)).toBe("Signed in.");
    expect(signInSummary(status({ connected: true, health: "connected", expiresAt: now + 5 * 60_000 }), now)).toBe(
      "Signed in, renewing in 5 minutes.",
    );
    // Already past: said plainly rather than counted in negative minutes.
    expect(signInSummary(status({ connected: true, health: "connected", expiresAt: now - 60_000 }), now)).toBe(
      "Signed in, and the token has expired.",
    );
  });

  test("no status yet is 'checking', not 'broken'", () => {
    // The probe costs two network round trips; a red row that turns green a
    // second later teaches people to ignore the colour.
    expect(signInSummary(undefined)).toBe("Checking this server…");
  });
});

test("a switched-off dot is muted, and only a failure is red", () => {
  expect(HEALTH_DOT.connected).toBe("bg-success");
  expect(HEALTH_DOT["needs-auth"]).toBe("bg-warning");
  expect(HEALTH_DOT.error).toBe("bg-destructive");
  expect(HEALTH_DOT.unknown).toBe("bg-muted-foreground/40");
});

test("a status matches on the scope pair, never on the id alone", () => {
  // An id-only match would show a project's server the MACHINE's login, which
  // is the one mistake here that looks correct on screen.
  const statuses = [status({ serverId: "linear" }), status({ serverId: "linear", projectId: "app", connected: true })];
  expect(statusFor(statuses, { id: "linear" })?.connected).toBe(false);
  expect(statusFor(statuses, { id: "linear", projectId: "app" })?.connected).toBe(true);
  expect(statusFor(statuses, { id: "linear", projectId: "other" })).toBeUndefined();
});

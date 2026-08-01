// WHO is signed in on an account — the line the Providers surface prints under
// each row ("Authenticated as someone@example.com · Claude Max").
//
// THE SOURCE IS A CONFIG FILE, NOT A CREDENTIAL. Claude Code records the signed-in
// profile in `.claude.json` under `oauthAccount`: email, display name, org, and
// the plan tier. That file sits NEXT TO the credentials, never inside them — it
// holds no token, no refresh secret, nothing that could authenticate a request.
// This module reads exactly the handful of profile fields listed below and
// ignores the rest of the file (which also carries project history and MCP
// state). It never reads `.credentials.json`, and never reads Codex's
// `auth.json` — that one IS a credential file, so Codex simply reports no
// identity rather than having one extracted from its token.
//
// WHERE the file lives follows the same rule as everything else about an
// account: the base login keeps it at `~/.claude.json`, and an account pinned
// to a config dir keeps it at `<configDir>/.claude.json`. Measured, not
// assumed — two config dirs on this machine hold two different emails, which is
// precisely what makes this worth reading.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AccountProfile, ProviderId } from "./schemas";

export interface AccountIdentity {
  email: string | null;
  displayName: string | null;
  organization: string | null;
  // The plan family as the provider words it, normalized: "max" | "pro" | … A
  // second, local witness for the same thing the usage probe reports as
  // subscriptionType.
  tier: string | null;
  // The rate multiplier when the account carries one ("20x", "5x").
  multiplier: string | null;
  // Ready-to-print name: "Claude Max 20x". Null when the profile says nothing
  // about the plan — the caller then falls back to the detected subscription
  // type rather than printing a guess.
  planLabel: string | null;
}

const expandHome = (p: string): string =>
  p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;

// Claude's profile file for an account: `<configDir>/.claude.json`, or
// `~/.claude.json` for the base login (which by design pins no configDir).
export function claudeProfilePath(configDir?: string): string {
  return configDir
    ? path.join(expandHome(configDir), ".claude.json")
    : path.join(os.homedir(), ".claude.json");
}

const str = (v: unknown): string | null =>
  typeof v === "string" && v.trim().length > 0 ? v.trim() : null;

// WHICH FIELD IS THE PLAN, and which only looks like it. `billingType` holds
// values like "stripe_subscription" — that is HOW the account pays, not WHAT it
// pays for, and rendering it as the plan is how this surface came to announce
// "stripe_subscription" next to a Max account. It is deliberately not read.
//
// The plan actually lives in two fields, measured against real profiles:
//   organizationType          "claude_max"            → the family
//   organizationRateLimitTier "default_claude_max_20x" → the multiplier
// `seatTier` is preferred when present (it is the per-seat wording some
// accounts carry) but is null on subscription accounts, which is exactly the
// case that used to fall through to billingType.
const FAMILY_NAMES: Record<string, string> = {
  max: "Max",
  pro: "Pro",
  team: "Team",
  enterprise: "Enterprise",
  free: "Free",
};

// "claude_max" → "max"; "max" → "max". Anything else keeps its own wording.
export function planFamily(organizationType?: string | null, seatTier?: string | null): string | null {
  const raw = str(seatTier) ?? str(organizationType);
  if (!raw) return null;
  return raw.toLowerCase().replace(/^claude[_-]/, "");
}

// "default_claude_max_20x" → "20x". No trailing multiplier ⇒ null, never "1x":
// an account without a stated multiplier is not the same as one pinned at 1×.
export function planMultiplier(rateLimitTier?: string | null): string | null {
  const raw = str(rateLimitTier);
  return raw?.toLowerCase().match(/(\d+x)$/)?.[1] ?? null;
}

function planLabelOf(family: string | null, multiplier: string | null): string | null {
  if (!family) return null;
  const name = FAMILY_NAMES[family] ?? family.replace(/[_-]/g, " ");
  return `Claude ${name}${multiplier ? ` ${multiplier}` : ""}`;
}

export function readAccountIdentity(account: AccountProfile): AccountIdentity | null {
  const provider: ProviderId = account.provider ?? "claude";
  // Codex keeps its plan in auth.json (a credential file) and nowhere else we
  // are willing to read. Its plan still reaches the UI — via the rate-limit
  // payload the usage meters already capture — but its email does not.
  if (provider !== "claude") return null;

  let raw: string;
  try {
    raw = fs.readFileSync(claudeProfilePath(account.configDir), "utf8");
  } catch {
    return null; // no profile file ⇒ nothing signed in here that we can name
  }

  let parsed: { oauthAccount?: Record<string, unknown> };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const oauth = parsed.oauthAccount;
  if (!oauth || typeof oauth !== "object") return null;

  const tier = planFamily(
    typeof oauth.organizationType === "string" ? oauth.organizationType : null,
    typeof oauth.seatTier === "string" ? oauth.seatTier : null,
  );
  const multiplier = planMultiplier(
    typeof oauth.organizationRateLimitTier === "string" ? oauth.organizationRateLimitTier : null,
  );
  const identity: AccountIdentity = {
    email: str(oauth.emailAddress),
    displayName: str(oauth.displayName),
    organization: str(oauth.organizationName),
    tier,
    multiplier,
    planLabel: planLabelOf(tier, multiplier),
  };
  // Everything absent means the key existed but held nothing usable — report
  // nothing rather than an object of nulls the UI would render as blanks.
  return identity.email || identity.displayName || identity.organization || identity.tier
    ? identity
    : null;
}

// Provider DETECTION. Telar does not create logins; it discovers the ones the
// machine already has. This module is the whole of what replaced the old login
// driver: it answers "is this provider's CLI installed, which version, and
// which plan is signed in" and writes the answer to ~/.telar/providers.json so
// a surface can render it without re-probing on every paint.
//
// Modeled on the per-provider descriptor cache T3 Code keeps at
// ~/.t3/caches/<provider>.json — {provider, installed, version, status, auth:
// {status, type, label}, checkedAt} — because that is the shape a
// detect-don't-configure settings surface actually needs.
//
// WHAT THIS MODULE WILL NOT DO. It runs `<bin> --version` and nothing else. It
// does not run an auth subcommand to scrape sign-in state out of CLI prose (the
// output format is not a contract, and a phrasing change would turn into a
// confident wrong answer), and it never reads a credentials file. The plan a
// provider is signed in as arrives as DATA from the caller — Claude's
// subscription_type off the SDK's init handshake, Codex's plan_type off its
// rollout rate-limit payload — both already captured for the usage meters. So
// auth here is reported, not guessed, or it is reported as unknown.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { atomicWrite, telarDir } from "./manifest";
import { providerOf } from "./providers";
import type { ProviderId } from "./schemas";

const execFileP = promisify(execFile);

export interface ProviderAuth {
  // "authenticated" only when a plan actually came back from a real signal.
  // Absent evidence is "unknown", never "unauthenticated" — not having probed
  // is a different fact from having probed and found nobody signed in.
  status: "authenticated" | "unknown";
  type: string | null; // raw plan id: "max" | "pro" | "plus" | "prolite" | …
  label: string | null; // human name, or null when the plan id isn't one we know
}

export interface ProviderStatus {
  provider: ProviderId;
  label: string; // the provider's display name, from its descriptor
  bin: string; // the executable we probed
  installed: boolean;
  version: string | null;
  status: "ready" | "not-installed";
  auth: ProviderAuth;
  configDirEnv: string; // e.g. CLAUDE_CONFIG_DIR — what an account's folder sets
  checkedAt: string; // ISO 8601
}

// Plan ids we have actually SEEN, mapped to the names their vendors use. An id
// outside this table keeps its raw value in `type` and gets a null `label` —
// the surface renders the raw id rather than a name we invented for it.
const PLAN_LABELS: Record<ProviderId, Record<string, string>> = {
  claude: {
    pro: "Claude Pro Subscription",
    max: "Claude Max Subscription",
    team: "Claude Team",
    enterprise: "Claude Enterprise",
  },
  codex: {
    plus: "ChatGPT Plus Subscription",
    pro: "ChatGPT Pro Subscription",
  },
};

export function planLabel(provider: ProviderId, type?: string | null): string | null {
  if (!type) return null;
  return PLAN_LABELS[provider][type.toLowerCase()] ?? null;
}

// The executable name for a provider. Both CLIs are invoked by their own id
// today; kept as a function so a provider whose binary differs from its id has
// one place to say so.
const binOf = (id: ProviderId): string => id;

// `<bin> --version` → the first line, trimmed. A missing binary (ENOENT), a
// non-zero exit, or a hang past the timeout all mean the same thing to a
// detector: we cannot prove it is installed.
async function probeVersion(bin: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP(bin, ["--version"], {
      timeout: 5000,
      env: process.env,
      maxBuffer: 1 << 20,
    });
    return stdout.trim().split("\n")[0]?.trim() || null;
  } catch {
    return null;
  }
}

export interface DetectOptions {
  // The plan this provider is signed in as, if a caller already knows it.
  planType?: string | null;
  // Test seam — never touches a real CLI in a test.
  probe?: (bin: string) => Promise<string | null>;
  now?: () => Date;
}

export async function detectProvider(
  id: ProviderId,
  opts: DetectOptions = {},
): Promise<ProviderStatus> {
  const desc = providerOf(id);
  const bin = binOf(id);
  const version = await (opts.probe ?? probeVersion)(bin);
  const planType = opts.planType ?? null;
  return {
    provider: id,
    label: desc.label,
    bin,
    installed: version !== null,
    version,
    status: version !== null ? "ready" : "not-installed",
    auth: {
      status: planType ? "authenticated" : "unknown",
      type: planType,
      label: planLabel(id, planType),
    },
    configDirEnv: desc.configDirEnv,
    checkedAt: (opts.now ?? (() => new Date()))().toISOString(),
  };
}

export async function detectProviders(
  planTypes: Partial<Record<ProviderId, string | null>> = {},
  opts: Omit<DetectOptions, "planType"> = {},
): Promise<ProviderStatus[]> {
  const ids: ProviderId[] = ["claude", "codex"];
  return Promise.all(
    ids.map((id) => detectProvider(id, { ...opts, planType: planTypes[id] ?? null })),
  );
}

// The exact command that signs THIS account in, for the user to run in their
// own terminal. Telar hands it over; it never runs it. One implementation so
// the Accounts surface, the chat preflight's "not logged in" 4xx and the
// Doctor's remedy cannot drift into telling the user three different things.
//
// The config-dir env prefix is what makes the command account-specific: without
// it the CLI signs the BASE login in, which for a machine with several config
// folders is the one account the user was not trying to fix.
export function signInCommand(account: {
  provider?: ProviderId;
  configDir?: string;
}): string {
  const desc = providerOf(account.provider);
  const cmd = `${binOf(desc.id)} ${desc.loginArgs.join(" ")}`.trim();
  return account.configDir ? `${desc.configDirEnv}="${account.configDir}" ${cmd}` : cmd;
}

// --- cache ---------------------------------------------------------------
// Detection costs a subprocess per provider, so the last answer is kept on disk
// with its checkedAt and re-probed on demand. A missing or corrupt cache is not
// an error: it just means nothing has been detected yet.

const providersFile = () => path.join(telarDir(), "providers.json");

export function readProviderCache(): ProviderStatus[] {
  try {
    const data = JSON.parse(fs.readFileSync(providersFile(), "utf8"));
    return Array.isArray(data?.providers) ? (data.providers as ProviderStatus[]) : [];
  } catch {
    return [];
  }
}

export function writeProviderCache(providers: ProviderStatus[]): void {
  atomicWrite(providersFile(), JSON.stringify({ version: 1, providers }, null, 2));
}

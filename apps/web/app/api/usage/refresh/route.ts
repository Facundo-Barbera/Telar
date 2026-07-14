import { query } from "@anthropic-ai/claude-agent-sdk";
import {
  accountEnv,
  accountHealth,
  getAccount,
  listAccounts,
  type AccountProfile,
} from "@telar/core";
import os from "os";
import {
  readPlanUsage,
  savePlanUsage,
  type PlanSnapshot,
  type PlanWindow,
} from "@/lib/store";
import { codexUsageSnapshot } from "@/lib/codex-usage";

export const dynamic = "force-dynamic";

// The shape of the SDK's experimental usage control call. It's untyped in the
// SDK, so we describe just the fields we read — enough to map into PlanSnapshot
// without reaching for `any`.
type UsageResult = {
  rate_limits_available?: boolean;
  subscription_type?: string | null;
  rate_limits?: {
    five_hour?: PlanWindow | null;
    seven_day?: PlanWindow | null;
    seven_day_opus?: PlanWindow | null;
    seven_day_sonnet?: PlanWindow | null;
    model_scoped?: PlanSnapshot["modelScoped"];
  };
} | null;

// Refresh one account's real plan-usage snapshot without spending inference.
// The trick: the SDK's usage control call resolves off the init handshake, so
// we spawn a minimal subprocess, read the rate limits the instant it comes up,
// then abort — killing the subprocess before it ever runs the "usage" prompt.
async function refreshOne(profile: AccountProfile): Promise<void> {
  const abort = new AbortController();
  // Guards the wait for the *first* (init) message: if the subprocess never
  // emits anything — e.g. it's stuck on an interactive re-auth prompt for a
  // stale/expired token — `for await` below would hang forever and this
  // function's own `finally` would never run. This timer fires abort()
  // independently of that loop so a wedged subprocess always gets killed.
  const initTimeout = setTimeout(() => abort.abort(), 10_000);
  try {
    const q = query({
      prompt: "usage",
      options: {
        model: "claude-haiku-4-5",
        maxTurns: 1,
        env: accountEnv(profile),
        cwd: os.tmpdir(),
        allowedTools: [],
        abortController: abort,
      },
    });

    for await (const msg of q) {
      if (msg.type === "system" && msg.subtype === "init") {
        clearTimeout(initTimeout);
        const usageFn = (
          q as unknown as Record<string, () => Promise<UsageResult>>
        ).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET;
        const usagePromise: Promise<UsageResult> | null = usageFn
          ? usageFn.call(q).catch(() => null)
          : null;
        const u: UsageResult = usagePromise
          ? await Promise.race([
              usagePromise,
              new Promise<UsageResult>((resolve) =>
                setTimeout(() => resolve(null), 10_000),
              ),
            ])
          : null;
        if (u?.rate_limits_available && u.rate_limits) {
          const rl = u.rate_limits;
          const snapshot: Partial<PlanSnapshot> = {
            subscriptionType: u.subscription_type ?? null,
            fiveHour: rl.five_hour ?? null,
            sevenDay: rl.seven_day ?? null,
            sevenDayOpus: rl.seven_day_opus ?? null,
            sevenDaySonnet: rl.seven_day_sonnet ?? null,
            modelScoped: rl.model_scoped ?? [],
          };
          savePlanUsage(profile.name, snapshot);
        }
        // Kill the subprocess the moment we have (or gave up on) the snapshot,
        // before it can burn a turn on the prompt.
        abort.abort();
        break;
      }
    }
  } finally {
    // Belt-and-suspenders: a throw or timeout above must never leave a zombie
    // subprocess behind. abort() is idempotent, so a double-call is harmless.
    clearTimeout(initTimeout);
    abort.abort();
  }
}

// POST { account? } — refresh one account, or all when omitted. Accounts run
// sequentially and per-account failures are tolerated (noted, not fatal), so a
// single account's SDK hiccup never blocks the other's snapshot.
export async function POST(req: Request) {
  let account: string | undefined;
  try {
    const body = await req.json();
    account = typeof body?.account === "string" ? body.account : undefined;
  } catch {
    // no/empty body → refresh every account
  }

  if (account && !getAccount(account)) {
    return Response.json({ error: `Unknown account "${account}".` }, { status: 400 });
  }

  const profiles = account ? [getAccount(account)!] : listAccounts();

  // Transient/unexpected failures (SDK hiccup, network) vs. accounts that are
  // simply not logged in on this machine. The latter are separated out and,
  // crucially, SKIPPED before we ever spawn a subprocess — a not-logged-in
  // account otherwise wedges on an interactive re-auth prompt until the 10s
  // init timeout fires. Health tells us that up front, for free.
  const errors: Record<string, string> = {};
  const skipped: Record<string, string> = {};
  for (const profile of profiles) {
    const health = accountHealth(profile);
    if (health.status === "missing-config-dir" || health.status === "never-logged-in") {
      skipped[profile.name] = `Not logged in on this machine — ${health.detail}`;
      continue;
    }
    try {
      if ((profile.provider ?? "claude") === "codex") {
        // Zero-cost: read the latest limits cached in Codex's session rollouts.
        const snap = codexUsageSnapshot(profile.configDir);
        if (snap) savePlanUsage(profile.name, snap);
      } else {
        await refreshOne(profile);
      }
    } catch (e) {
      errors[profile.name] = e instanceof Error ? e.message : String(e);
    }
  }

  return Response.json({
    plan: readPlanUsage(),
    ...(Object.keys(errors).length ? { errors } : {}),
    ...(Object.keys(skipped).length ? { skipped } : {}),
  });
}

import type { TokenUsage, UsageDigest, UsageSignal } from "@telar/engine-client";

const total = (tokens: TokenUsage): number => tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreate;
const share = (part: number, whole: number): number => (whole === 0 ? 0 : Math.round((part / whole) * 1000) / 1000);

export function usageSignals(digest: Omit<UsageDigest, "signals">): UsageSignal[] {
  const month = digest.windows["30d"].totals;
  const all = total(month.tokens);
  const top = digest.topSessions;
  const signals: UsageSignal[] = [];
  const flag = (id: string, value: number, threshold: number, sessions?: string[]) => {
    if (value >= threshold) signals.push({ id, value, threshold, ...(sessions?.length ? { sessions: sessions.slice(0, 5) } : {}) });
  };

  flag("cache_read_dominant", share(month.tokens.cacheRead, all), 0.9);

  const long = top.filter((session) => session.turns >= 300);
  flag("long_lived_session", long.length, 1, long.map((session) => session.id));

  const longContext = top.filter((session) => session.longContext);
  flag("long_context_window", share(longContext.reduce((sum, session) => sum + total(session.tokens), 0), all), 0.3, longContext.map((session) => session.id));

  const builders = top.filter((session) => session.startedBy && /opus/i.test(session.model));
  flag("opus_builders", share(builders.reduce((sum, session) => sum + total(session.tokens), 0), all), 0.2, builders.map((session) => session.id));

  const effortful = top.filter((session) => session.effort && ["high", "xhigh", "max"].includes(session.effort));
  flag("high_effort", share(effortful.reduce((sum, session) => sum + total(session.tokens), 0), all), 0.5, effortful.map((session) => session.id));

  const woken = top.filter((session) => {
    const turns = Object.values(session.origins).reduce((sum, count) => sum + count, 0);
    return share(turns - (session.origins.user ?? 0), turns) >= 0.5 && turns >= 50;
  });
  flag("wake_heavy", woken.length, 1, woken.map((session) => session.id));

  const frequent = digest.schedules.filter((schedule) => schedule.enabled && (schedule.periodMinutes ?? Infinity) <= 60);
  flag("frequent_schedule", frequent.length, 1, frequent.flatMap((schedule) => (schedule.session ? [schedule.session] : [])));

  const uncompacted = top.filter((session) => (session.contextUsed ?? 0) >= 150_000 && session.compactions === 0);
  flag("no_compaction", uncompacted.length, 1, uncompacted.map((session) => session.id));

  const rateLimits = top.reduce((sum, session) => sum + session.providerWaits.rateLimit + session.providerWaits.apiRetry, 0);
  flag("rate_limit_loops", rateLimits, 5);

  const bigOutputs = top.filter((session) => session.largeToolOutputs > 0);
  flag("big_tool_outputs", bigOutputs.reduce((sum, session) => sum + session.largeToolOutputs, 0), 20, bigOutputs.map((session) => session.id));

  const claude = digest.providerLogs.find((entry) => entry.provider === "claude");
  if (claude) flag("outside_telar", share(Math.max(0, claude.tokens - claude.telarTokens), claude.tokens), 0.5);

  const fanOut = digest.trees.filter((tree) => tree.sessions >= 5);
  flag("wide_fan_out", share(fanOut.reduce((sum, tree) => sum + tree.tokens, 0), all), 0.3, fanOut.map((tree) => tree.root));

  return signals;
}

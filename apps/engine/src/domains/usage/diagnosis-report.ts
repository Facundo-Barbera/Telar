import { UsageDiagnosisReport, type UsageDigest, type UsageSignal } from "@telar/engine-client";

export function parseDiagnosisReport(text: string): { report: UsageDiagnosisReport } | { error: string } {
  const unfenced = text.replace(/```(?:json)?/g, "");
  const start = unfenced.indexOf("{");
  const end = unfenced.lastIndexOf("}");
  if (start < 0 || end <= start) return { error: "the answer held no JSON object" };
  let value: unknown;
  try {
    value = JSON.parse(unfenced.slice(start, end + 1));
  } catch {
    return { error: "the answer's JSON did not parse" };
  }
  const parsed = UsageDiagnosisReport.safeParse(value);
  return parsed.success ? { report: parsed.data } : { error: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ") };
}

const FALLBACK: Record<string, { title: string; why: string; setting: UsageDiagnosisReport["findings"][number]["fix"]["setting"]; action: string }> = {
  cache_read_dominant: { title: "Long contexts are re-read on every call", why: "Most tokens are cache reads: each tool call sends the whole context again.", setting: "compaction", action: "Start fresh sessions per task and compact earlier." },
  long_lived_session: { title: "Some sessions have run for hundreds of turns", why: "Every turn in a long session pays for its whole history.", setting: "compaction", action: "Start a new session per task." },
  long_context_window: { title: "Much of the use is on 1M-token windows", why: "A 1M window lets a context grow far before it compacts.", setting: "new-sessions-model", action: "Use the standard window unless a task needs more." },
  opus_builders: { title: "Builders run on the largest model", why: "Delegated sessions on the largest model multiply the cost of every fan-out.", setting: "new-sessions-model", action: "Run builders on a smaller model." },
  high_effort: { title: "High effort on heavy sessions", why: "High effort means more thinking and more tool calls per turn.", setting: "new-sessions-effort", action: "Use medium effort by default." },
  wake_heavy: { title: "Sessions are woken often", why: "Each wake runs a whole turn on the session's existing context.", setting: "settle-delegated", action: "Batch results and settle delegated conversations sooner." },
  frequent_schedule: { title: "A schedule fires often", why: "Each run is a full turn on the session's context.", setting: "schedules", action: "Lengthen the schedule or point it at a fresh session." },
  no_compaction: { title: "Large contexts never compact", why: "A context that never compacts is re-read whole on every call.", setting: "compaction", action: "Lower the compaction threshold." },
  rate_limit_loops: { title: "Turns keep meeting rate limits", why: "Retries after a limit spend the next window straight away.", setting: "continue-after-reset", action: "Run fewer sessions at once." },
  big_tool_outputs: { title: "Tool outputs are very large", why: "Large outputs stay in the context and are re-read on every call.", setting: "mcp-servers", action: "Use narrower commands and fewer MCP servers." },
  outside_telar: { title: "Most use happens outside Telar", why: "The provider's own logs show more use than Telar's sessions account for.", setting: "none", action: "Check Claude Code runs started outside Telar." },
  wide_fan_out: { title: "Wide fan-outs dominate", why: "Each builder brings its own context, model and effort.", setting: "new-sessions-model", action: "Fan out to fewer builders on a smaller model." },
};

export function fallbackReport(digest: UsageDigest): UsageDiagnosisReport {
  const month = digest.windows["30d"].totals;
  const all = month.tokens.input + month.tokens.output + month.tokens.cacheRead + month.tokens.cacheCreate;
  const findings = digest.signals
    .filter((signal): signal is UsageSignal => signal.id in FALLBACK)
    .slice(0, 6)
    .map((signal) => {
      const known = FALLBACK[signal.id]!;
      return { signal: signal.id, severity: signal.value >= signal.threshold * 2 ? ("high" as const) : ("medium" as const), title: known.title, why: known.why, evidence: [{ metric: signal.id, value: signal.value }], fix: { setting: known.setting, action: known.action } };
    });
  return {
    window: "30d",
    summary: `${Math.round(all / 1e6)}M tokens over 30 days across ${month.sessions} sessions; ${Math.round(month.cacheHit * 100)}% were cache reads.`,
    topConsumers: digest.topSessions.slice(0, 5).map((session) => {
      const tokens = session.tokens.input + session.tokens.output + session.tokens.cacheRead + session.tokens.cacheCreate;
      return { id: session.id, share: all === 0 ? 0 : Math.round((tokens / all) * 100) / 100, reason: `${session.turns} turns on ${session.model}` };
    }),
    findings,
  };
}

const PATTERNS: RegExp[] = [
  /\b(?:https?|file):\/\/\S+/gi,
  /(?:~|\/(?:Users|Volumes|home|private|var|tmp|opt|etc))(?:\/[^\s"'`,;)]+)+/g,
  /\b[A-Za-z]:\\[^\s"'`]+/g,
  /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g,
  /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  /\b(?:session|run|project|request|item|diag|schedule|toolu|msg)_[A-Za-z0-9_-]{6,}\b/g,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
  /\b(?:sk|pk|rk|ghp|gho|ghs|xox[abp])[-_][A-Za-z0-9_-]{10,}\b/g,
  /\b[A-Za-z0-9+/_-]{32,}={0,2}/g,
  /\b[\w-]+\.(?:local|lan|internal|home)\b/gi,
];

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The last step before anything is shown for sending: free text loses anything that names a place, person or secret. */
export function redactText(text: string, denyList: readonly string[]): string {
  let out = text;
  for (const pattern of PATTERNS) out = out.replace(pattern, "[redacted]");
  const words = [...new Set(denyList.map((word) => word.trim()).filter((word) => word.length >= 3))].sort((a, b) => b.length - a.length);
  for (const word of words) out = out.replace(new RegExp(`(?<![\\w-])${escape(word)}(?![\\w-])`, "gi"), "[redacted]");
  return out;
}

export function redactReport(report: UsageDiagnosisReport, denyList: readonly string[], digest: UsageDigest): UsageDiagnosisReport {
  const clean = (text: string) => redactText(text, denyList);
  const known = new Set(digest.topSessions.map((session) => session.id));
  return {
    window: report.window,
    summary: clean(report.summary),
    topConsumers: report.topConsumers.filter((entry) => known.has(entry.id)).map((entry) => ({ ...entry, reason: clean(entry.reason) })),
    findings: report.findings.map((finding) => ({
      ...finding,
      signal: clean(finding.signal),
      title: clean(finding.title),
      why: clean(finding.why),
      evidence: finding.evidence.map((entry) => ({ ...entry, metric: clean(entry.metric) })),
      fix: { setting: finding.fix.setting, action: clean(finding.fix.action) },
    })),
  };
}

import type { UsageDiagnosis } from "@telar/engine-client";
import { formatShare, formatTokens, formatUsd } from "./model";

export function diagnosisFeedbackText(diagnosis: UsageDiagnosis): string {
  const report = diagnosis.report;
  if (!report) return "";
  const totals = diagnosis.totals;
  const lines = ["Usage diagnosis report", "", `**Summary:** ${report.summary}`];
  if (totals) {
    const processed = totals.tokens.input + totals.tokens.output + totals.tokens.cacheRead + totals.tokens.cacheCreate;
    lines.push(`**30 days:** ${formatTokens(processed)} tokens · ${formatUsd(totals.costUsd)} · ${formatShare(totals.cacheHit)} cache reads · ${totals.turns} turns · ${totals.sessions} sessions`);
  }
  lines.push(`**Diagnosed with:** ${diagnosis.model ?? "unknown"}, prompt v${diagnosis.promptVersion}${diagnosis.fallback ? ", from the engine's checks alone" : ""}`);
  const logs = diagnosis.logs;
  const logged = logs ? logs.buckets.store.tokens + logs.buckets.telar.tokens + logs.buckets.outside.tokens : 0;
  if (logs && logged > 0) {
    const part = (tokens: number) => `${formatTokens(tokens)} (${formatShare(tokens / logged)})`;
    lines.push(`**Claude logs, 30 days:** this Telar ${part(logs.buckets.store.tokens)} · Telar elsewhere ${part(logs.buckets.telar.tokens)} · outside Telar ${part(logs.buckets.outside.tokens)}`);
    lines.push(`**Top models in the logs:** ${logs.models.slice(0, 4).map((model) => `${model.model} ${formatTokens(model.tokens)}`).join(", ")}`);
  }
  if (report.topConsumers.length > 0) {
    lines.push("", "### Top consumers", ...report.topConsumers.map((entry) => `- ${entry.id}: ${formatShare(entry.share)}. ${entry.reason}`));
  }
  if (report.findings.length > 0) {
    lines.push("", "### Findings");
    report.findings.forEach((finding, index) => {
      lines.push(`${index + 1}. **[${finding.severity}] ${finding.title}** (${finding.signal}). ${finding.why}`);
      if (finding.evidence.length > 0) lines.push(`   Evidence: ${finding.evidence.map((entry) => `${entry.metric} ${entry.value}`).join(", ")}`);
      lines.push(`   Fix (${finding.fix.setting}): ${finding.fix.action}${finding.estSavingsPct === undefined ? "" : ` (~${finding.estSavingsPct}% less)`}`);
    });
  }
  return lines.join("\n");
}

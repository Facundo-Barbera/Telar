"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { StethoscopeIcon } from "lucide-react";
import type { UsageDiagnosis, UsageDiagnosisReport, UsageLogAttribution, UsageLogBucket } from "@telar/engine-client";
import { createEngineApi } from "@/platform/engine";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { Spinner } from "@/ui/spinner";
import { Segmented } from "@/features/settings";
import { formatShare, formatTokens, formatUsd } from "../model";
import { SendDiagnosisFeedback } from "./diagnosis-feedback";

const api = createEngineApi();
const POLL_MS = 4000;

type Model = "sonnet" | "haiku" | "opus";
const MODELS: { value: Model; label: string }[] = [
  { value: "sonnet", label: "Sonnet" },
  { value: "haiku", label: "Haiku" },
  { value: "opus", label: "Opus" },
];

const FIX_LABEL: Record<UsageDiagnosisReport["findings"][number]["fix"]["setting"], string> = {
  "new-sessions-model": "Settings → New sessions → Model",
  "new-sessions-effort": "Settings → New sessions → Effort",
  "continue-after-reset": "Settings → New sessions → Continue after a reset",
  "settle-delegated": "Settings → Settling",
  "generated-text-model": "Settings → Generated text → Model",
  compaction: "Settings → Providers → Compaction",
  schedules: "The session's schedule",
  "mcp-servers": "Settings → Tools → MCP servers",
  none: "Nothing in Telar",
};

const SEVERITY: Record<string, "destructive" | "secondary" | "outline"> = { high: "destructive", medium: "secondary", low: "outline" };

function useDiagnosis() {
  const [diagnosis, setDiagnosis] = useState<UsageDiagnosis | null>();
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    try {
      setDiagnosis((await api.usageDiagnosis()).diagnosis);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);
  useEffect(() => {
    const task = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(task);
  }, [load]);
  const running = diagnosis?.state === "running";
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [running, load]);
  const act = async (call: () => Promise<{ diagnosis: UsageDiagnosis | null }>) => {
    try {
      setDiagnosis((await call()).diagnosis);
      setError(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };
  return {
    diagnosis,
    error,
    start: (model: Model) => act(() => api.startUsageDiagnosis({ model, effort: "medium" })),
    stop: () => act(() => api.stopUsageDiagnosis()),
  };
}

function Report({ diagnosis, report }: { diagnosis: UsageDiagnosis; report: UsageDiagnosisReport }) {
  const totals = diagnosis.totals;
  const processed = totals ? totals.tokens.input + totals.tokens.output + totals.tokens.cacheRead + totals.tokens.cacheCreate : 0;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm">{report.summary}</p>
      {totals && (
        <div className="grid grid-cols-3 gap-4">
          <Figure label="Tokens, 30 days" value={formatTokens(processed)} />
          <Figure label="Cost, 30 days" value={formatUsd(totals.costUsd)} />
          <Figure label="Cache reads" value={formatShare(totals.cacheHit)} />
        </div>
      )}
      {report.topConsumers.length > 0 && (
        <ul aria-label="Top consumers" className="flex flex-col gap-1 text-sm">
          {report.topConsumers.map((entry) => (
            <li key={entry.id} className="flex items-baseline gap-2">
              <span className="font-mono text-xs text-muted-foreground">{entry.id}</span>
              <span className="min-w-0 truncate">{diagnosis.names?.[entry.id] ?? entry.id}</span>
              <span className="shrink-0 tabular-nums text-muted-foreground">{formatShare(entry.share)}</span>
              <span className="min-w-0 truncate text-muted-foreground">{entry.reason}</span>
            </li>
          ))}
        </ul>
      )}
      {diagnosis.logs && <LogBreakdown logs={diagnosis.logs} names={diagnosis.names ?? {}} />}
      <ul aria-label="Findings" className="flex flex-col gap-3">
        {report.findings.map((finding) => (
          <li key={`${finding.signal}-${finding.title}`} className="rounded-lg border border-border p-3">
            <div className="flex items-center gap-2">
              <Badge variant={SEVERITY[finding.severity] ?? "outline"}>{finding.severity}</Badge>
              <p className="min-w-0 truncate text-sm font-medium">{finding.title}</p>
              {finding.estSavingsPct !== undefined && <span className="ml-auto shrink-0 text-xs text-muted-foreground">~{finding.estSavingsPct}% less</span>}
            </div>
            <p className="mt-1.5 text-sm text-muted-foreground">{finding.why}</p>
            {finding.evidence.length > 0 && (
              <p className="mt-1.5 flex flex-wrap gap-1.5 text-xs">
                {finding.evidence.map((entry) => (
                  <span key={entry.metric} className="rounded bg-muted px-1.5 py-0.5 tabular-nums">
                    {entry.metric} {entry.value.toLocaleString()}
                  </span>
                ))}
              </p>
            )}
            <p className="mt-2 text-sm">
              <span className="text-muted-foreground">{FIX_LABEL[finding.fix.setting]}: </span>
              {finding.fix.action}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

const BUCKET_LABEL: Record<UsageLogBucket, string> = { store: "This Telar", telar: "Telar, elsewhere", outside: "Outside Telar" };

function LogBreakdown({ logs, names }: { logs: UsageLogAttribution; names: Record<string, string> }) {
  const all = logs.buckets.store.tokens + logs.buckets.telar.tokens + logs.buckets.outside.tokens;
  if (all === 0) return null;
  return (
    <div aria-label="Claude logs" className="flex flex-col gap-2 text-sm">
      <p className="text-xs text-muted-foreground">Claude usage on this computer, 30 days</p>
      <div className="grid grid-cols-3 gap-4">
        {(Object.keys(BUCKET_LABEL) as UsageLogBucket[]).map((bucket) => (
          <Figure key={bucket} label={BUCKET_LABEL[bucket]} value={`${formatTokens(logs.buckets[bucket].tokens)} · ${formatShare(logs.buckets[bucket].tokens / all)}`} />
        ))}
      </div>
      {logs.buckets.telar.tokens > 0 && logs.storeCoverage < 0.5 && (
        <p className="text-xs text-muted-foreground">This Telar&apos;s data holds {formatShare(logs.storeCoverage)} of the Telar runs in your logs; the rest ran from another install or data folder.</p>
      )}
      <ul aria-label="Heaviest folders" className="flex flex-col gap-1">
        {logs.projects.slice(0, 5).map((project) => (
          <li key={`${project.id}-${project.bucket}`} className="flex items-baseline gap-2">
            <span className="font-mono text-xs text-muted-foreground">{project.id}</span>
            <span className="min-w-0 truncate">{names[project.id] ?? project.id}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{BUCKET_LABEL[project.bucket]}</span>
            <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">{formatTokens(project.tokens)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Figure({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="truncate text-xs text-muted-foreground">{label}</p>
      <p className="mt-0.5 truncate text-lg font-medium tabular-nums">{value}</p>
    </div>
  );
}

export function UsageDiagnosisSection() {
  const { diagnosis, error, start, stop } = useDiagnosis();
  const [model, setModel] = useState<Model>("sonnet");
  const running = diagnosis?.state === "running";
  return (
    <section id="diagnose" aria-label="Diagnosis" className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <StethoscopeIcon className="size-4 text-muted-foreground" />
        <h2 className="text-sm font-medium">Diagnosis</h2>
        {!running && (
          <div className="ml-auto flex items-center gap-2">
            <Segmented<Model> value={model} onChange={setModel} options={MODELS} />
            <Button size="sm" variant="outline" onClick={() => void start(model)} disabled={diagnosis === undefined}>
              {diagnosis ? "Run again" : "Diagnose usage"}
            </Button>
          </div>
        )}
      </div>
      {!diagnosis && !running && (
        <p className="text-sm text-muted-foreground">An agent reads this computer&apos;s usage in the background, read-only, and explains what drives it.</p>
      )}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {running && (
        <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          Diagnosing with {diagnosis.model ?? "the chosen model"}. This takes a few minutes.
          <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void stop()}>
            Stop
          </Button>
        </div>
      )}
      {diagnosis?.state === "failed" && <p className="text-sm text-destructive">{diagnosis.error ?? "The diagnosis did not finish."}</p>}
      {diagnosis?.state === "ready" && diagnosis.report && (
        <>
          <Report diagnosis={diagnosis} report={diagnosis.report} />
          {diagnosis.fallback && <p className="text-xs text-muted-foreground">The agent&apos;s answer could not be used, so this report comes from the engine&apos;s own checks.</p>}
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span>{diagnosis.model}</span>
            <Link href={`/sessions/${encodeURIComponent(diagnosis.sessionId)}`} className="underline-offset-2 hover:text-foreground hover:underline">
              Open transcript
            </Link>
            <div className="ml-auto">
              <SendDiagnosisFeedback diagnosis={diagnosis} />
            </div>
          </div>
        </>
      )}
    </section>
  );
}

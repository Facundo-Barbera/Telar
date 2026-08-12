"use client";

// The machine-readiness surface: renders GET /api/doctor as check rows with an
// ok/warn/fail glyph, the inline remedy for anything not green, and a re-run
// button. All the probing happens server-side (lib/server/doctor.ts) — this is
// a pure presenter. The report types are imported TYPE-ONLY, so the server
// lib's child_process/@telar/core deps never reach the client bundle.
import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2Icon,
  AlertTriangleIcon,
  XCircleIcon,
  RotateCwIcon,
} from "lucide-react";
import type { DoctorReport, DoctorCheck, DoctorSection, CheckStatus } from "@/lib/server/doctor";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { SettingsGroup } from "@/components/settings/settings-shell";

const GLYPH: Record<CheckStatus, { Icon: typeof CheckCircle2Icon; tint: string; label: string }> = {
  ok: { Icon: CheckCircle2Icon, tint: "text-emerald-500", label: "OK" },
  warn: { Icon: AlertTriangleIcon, tint: "text-amber-500", label: "Warning" },
  fail: { Icon: XCircleIcon, tint: "text-destructive", label: "Action needed" },
};

function CheckRow({ check }: { check: DoctorCheck }) {
  const g = GLYPH[check.status];
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <g.Icon className={cn("mt-0.5 size-4 shrink-0", g.tint)} aria-label={g.label} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-sm font-medium">{check.label}</span>
          {check.value && (
            <span className="truncate font-mono text-[11px] text-muted-foreground" title={check.value}>
              {check.value}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">{check.detail}</p>
        {check.remedy && (
          <code className="mt-1.5 block overflow-x-auto rounded-md border bg-muted/40 px-2 py-1 font-mono text-[11px] whitespace-pre">
            {check.remedy}
          </code>
        )}
      </div>
    </div>
  );
}

function Section({ section }: { section: DoctorSection }) {
  const bad = section.checks.filter((c) => c.status !== "ok").length;
  return (
    <SettingsGroup
      title={
        <span className="flex items-center gap-2">
          {section.title}
          {bad > 0 && (
            <Badge variant="outline" className="text-[10px]">
              {bad} to fix
            </Badge>
          )}
        </span>
      }
      description={section.description}
    >
      {section.checks.length === 0 ? (
        <div className="px-4 py-3 text-xs text-muted-foreground">Nothing to check.</div>
      ) : (
        section.checks.map((c) => <CheckRow key={c.id} check={c} />)
      )}
    </SettingsGroup>
  );
}

export function DoctorSettings() {
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch("/api/doctor", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setReport((await r.json()) as DoctorReport);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const s = report?.summary;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <p className="flex-1 text-xs text-muted-foreground">
          A read-only check of what a loom run needs on this machine. Nothing here logs in or reads a
          credential — it only inspects what's already installed.
        </p>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          {loading ? <Spinner /> : <RotateCwIcon />} Re-run
        </Button>
      </div>

      {s && (
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="gap-1.5 text-[11px]">
            <CheckCircle2Icon className="size-3 text-emerald-500" /> {s.ok} OK
          </Badge>
          {s.warn > 0 && (
            <Badge variant="outline" className="gap-1.5 text-[11px]">
              <AlertTriangleIcon className="size-3 text-amber-500" /> {s.warn} warning
              {s.warn === 1 ? "" : "s"}
            </Badge>
          )}
          {s.fail > 0 && (
            <Badge variant="outline" className="gap-1.5 text-[11px]">
              <XCircleIcon className="size-3 text-destructive" /> {s.fail} to fix
            </Badge>
          )}
        </div>
      )}

      {error && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-xs text-destructive">
          Couldn&apos;t run the doctor: <span className="font-mono">{error}</span>
        </div>
      )}

      {loading && !report ? (
        <div className="flex items-center gap-2 px-1 py-6 text-xs text-muted-foreground">
          <Spinner /> Checking this machine…
        </div>
      ) : (
        report?.sections.map((sec) => <Section key={sec.id} section={sec} />)
      )}
    </div>
  );
}

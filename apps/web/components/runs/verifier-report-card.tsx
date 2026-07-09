"use client";

import { useState } from "react";
import {
  ChevronRightIcon,
  CircleCheckIcon,
  CircleXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type {
  CriterionResult,
  Evidence,
  VerifierReport,
} from "@telar/core";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

const VERDICT_BADGE: Record<
  CriterionResult["verdict"],
  { className: string; label: string }
> = {
  pass: { className: "bg-emerald-500/15 text-emerald-400", label: "pass" },
  fail: { className: "bg-destructive/15 text-destructive", label: "fail" },
  flaky: { className: "bg-amber-500/15 text-amber-400", label: "flaky" },
};

function screenshots(evidence: Evidence[]) {
  return evidence.filter((e) => e.kind === "screenshot" && e.path);
}

function textEvidence(evidence: Evidence[]) {
  return evidence.filter(
    (e) =>
      (e.kind === "console" || e.kind === "network") &&
      (e.text || e.path),
  );
}

function EvidenceImage({ runId, evidence }: { runId: string; evidence: Evidence }) {
  const [broken, setBroken] = useState(false);
  if (broken) {
    return (
      <div className="flex h-24 items-center justify-center rounded-md bg-muted/40 text-[11px] text-muted-foreground ring-1 ring-border">
        screenshot unavailable
      </div>
    );
  }
  return (
    <figure className="flex flex-col gap-1">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={`/api/runs/${runId}/evidence/${evidence.path}`}
        alt={evidence.label || "screenshot"}
        loading="lazy"
        onError={() => setBroken(true)}
        className="max-w-full rounded-md ring-1 ring-border"
      />
      {evidence.label && (
        <figcaption className="text-[11px] text-muted-foreground">
          {evidence.label}
        </figcaption>
      )}
    </figure>
  );
}

function CriterionRow({
  runId,
  criterion,
}: {
  runId: string;
  criterion: CriterionResult;
}) {
  const [open, setOpen] = useState(false);
  const badge = VERDICT_BADGE[criterion.verdict];
  const shots = screenshots(criterion.evidence);
  const texts = textEvidence(criterion.evidence);
  const hasDetails = criterion.repro.length > 0 || texts.length > 0;

  return (
    <div className="flex flex-col gap-2 rounded-lg bg-muted/30 p-2.5 ring-1 ring-border">
      <div className="flex items-start gap-2 text-sm">
        <Badge className={cn("mt-px shrink-0 font-mono text-[10px]", badge.className)}>
          {badge.label}
        </Badge>
        <span className="leading-snug">{criterion.criterion}</span>
      </div>
      {criterion.observed && (
        <p className="pl-1 text-xs text-muted-foreground">{criterion.observed}</p>
      )}

      {shots.length > 0 && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {shots.map((e, i) => (
            <EvidenceImage key={e.path ?? i} runId={runId} evidence={e} />
          ))}
        </div>
      )}

      {hasDetails && (
        <Collapsible open={open} onOpenChange={setOpen}>
          <CollapsibleTrigger className="flex w-full items-center gap-1.5 rounded-md py-1 text-left text-xs text-muted-foreground transition-colors hover:text-foreground">
            <ChevronRightIcon
              className={cn("size-3.5 transition-transform", open && "rotate-90")}
            />
            <span>
              {criterion.repro.length > 0
                ? `Repro (${criterion.repro.length} step${criterion.repro.length === 1 ? "" : "s"})`
                : "Details"}
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent className="flex flex-col gap-2 pt-1">
            {criterion.repro.length > 0 && (
              <ol className="flex flex-col gap-1 pl-1">
                {criterion.repro.map((step, i) => (
                  <li key={i} className="flex gap-2 text-xs">
                    <span className="shrink-0 font-mono text-muted-foreground/70">
                      {i + 1}.
                    </span>
                    <span>
                      <span className="font-medium">{step.action}</span>{" "}
                      {step.target}
                      {step.value ? (
                        <span className="text-muted-foreground"> = {step.value}</span>
                      ) : null}
                      {step.locator ? (
                        <span className="block font-mono text-[10px] text-muted-foreground/70">
                          {step.locator}
                        </span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ol>
            )}
            {texts.map((e, i) => (
              <div key={e.path ?? i} className="flex flex-col gap-1">
                <span className="font-mono text-[10px] text-muted-foreground/70">
                  {e.kind}
                  {e.label ? ` · ${e.label}` : ""}
                </span>
                <pre className="max-h-40 overflow-auto rounded-md bg-background/60 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground ring-1 ring-border">
                  {e.text ?? e.path}
                </pre>
              </div>
            ))}
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

export function VerifierReportCard({
  runId,
  report,
}: {
  runId: string;
  report: VerifierReport;
}) {
  return (
    <Card size="sm" className="bg-muted/20">
      <CardHeader className="flex flex-row items-start gap-2">
        {report.ok ? (
          <CircleCheckIcon className="mt-px size-4 shrink-0 text-emerald-400" />
        ) : (
          <TriangleAlertIcon className="mt-px size-4 shrink-0 text-amber-400" />
        )}
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="font-heading text-sm font-medium">Verifier</span>
            <Badge
              className={cn(
                "font-mono text-[10px]",
                report.ok
                  ? "bg-emerald-500/15 text-emerald-400"
                  : "bg-destructive/15 text-destructive",
              )}
            >
              {report.ok ? "pass" : "fail"}
            </Badge>
          </div>
          {report.summary && (
            <p className="text-xs leading-snug text-muted-foreground">
              {report.summary}
            </p>
          )}
        </div>
      </CardHeader>

      {report.criteria.length > 0 && (
        <CardContent className="flex flex-col gap-2">
          {report.criteria.map((c, i) => (
            <CriterionRow key={c.criterion || i} runId={runId} criterion={c} />
          ))}
        </CardContent>
      )}
    </Card>
  );
}

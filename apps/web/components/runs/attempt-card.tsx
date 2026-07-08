"use client";

import { useState } from "react";
import {
  ChevronRightIcon,
  CircleCheckIcon,
  CircleXIcon,
  Loader2Icon,
  TriangleAlertIcon,
} from "lucide-react";
import type { AttemptRecord, GateResult } from "@telar/core";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { fmtCost, shortId } from "@/lib/format";
import { fmtDuration, fmtMs } from "./utils";

function GateRow({ gate }: { gate: GateResult }) {
  const [open, setOpen] = useState(false);
  const hasOutput = gate.output.trim().length > 0;
  const status = gate.timedOut
    ? "timeout"
    : gate.exitCode === null
      ? "error"
      : `exit ${gate.exitCode}`;

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger
        disabled={!hasOutput}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
          hasOutput ? "hover:bg-muted/50" : "cursor-default",
        )}
      >
        {gate.ok ? (
          <CircleCheckIcon className="size-4 shrink-0 text-emerald-400" />
        ) : (
          <CircleXIcon className="size-4 shrink-0 text-destructive" />
        )}
        <span className="truncate font-medium">{gate.name}</span>
        <span
          className={cn(
            "ml-auto shrink-0 font-mono text-xs",
            gate.ok ? "text-muted-foreground" : "text-destructive",
          )}
        >
          {status}
        </span>
        <span className="shrink-0 font-mono text-xs text-muted-foreground">
          {fmtMs(gate.durationMs)}
        </span>
        {hasOutput && (
          <ChevronRightIcon
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
        )}
      </CollapsibleTrigger>
      {hasOutput && (
        <CollapsibleContent>
          <pre className="mt-1 max-h-56 overflow-auto rounded-md bg-background/60 p-2.5 font-mono text-[11px] leading-relaxed text-muted-foreground ring-1 ring-border">
            {gate.output.trimEnd()}
          </pre>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}

export function AttemptCard({ attempt }: { attempt: AttemptRecord }) {
  const running = attempt.endedAt === undefined;
  const verdict = attempt.verdict ?? null;
  const duration =
    attempt.endedAt !== undefined
      ? fmtDuration(attempt.endedAt - attempt.startedAt)
      : null;

  return (
    <Card size="sm">
      <CardHeader className="flex flex-row items-center gap-2">
        <span className="font-heading text-sm font-medium">
          Attempt {attempt.n}
        </span>
        <Badge variant="secondary" className="font-mono text-[10px]">
          {attempt.role} · {attempt.model}
        </Badge>
        {running && (
          <Loader2Icon className="size-3.5 animate-spin text-sky-400" />
        )}
        <div className="ml-auto flex items-center gap-2 font-mono text-xs text-muted-foreground">
          {duration && <span>{duration}</span>}
          {attempt.costUsd !== undefined && <span>{fmtCost(attempt.costUsd)}</span>}
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        {attempt.sessionId && (
          <div className="font-mono text-[11px] text-muted-foreground/70">
            session {shortId(attempt.sessionId)}
          </div>
        )}

        {verdict && (
          <div className="flex flex-col gap-1.5 rounded-lg bg-muted/30 p-2.5 ring-1 ring-border">
            <div className="flex items-start gap-2 text-sm">
              {verdict.ok ? (
                <CircleCheckIcon className="mt-px size-4 shrink-0 text-emerald-400" />
              ) : (
                <TriangleAlertIcon className="mt-px size-4 shrink-0 text-amber-400" />
              )}
              <span className="leading-snug">{verdict.summary}</span>
            </div>
            {verdict.blocker && (
              <p className="pl-6 text-xs text-amber-300/90">
                Blocker: {verdict.blocker}
              </p>
            )}
            {verdict.files_touched.length > 0 && (
              <div className="flex flex-wrap gap-1 pl-6">
                {verdict.files_touched.map((f) => (
                  <Badge
                    key={f}
                    variant="outline"
                    className="max-w-full px-1.5 py-0 font-mono text-[10px]"
                  >
                    <span className="truncate">{f}</span>
                  </Badge>
                ))}
              </div>
            )}
          </div>
        )}

        {attempt.gates && attempt.gates.length > 0 && (
          <div className="flex flex-col gap-0.5">
            {attempt.gates.map((g) => (
              <GateRow key={g.name} gate={g} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

"use client";

/**
 * PROCESSES — what this app itself is burning, per process type.
 *
 * ISSUE #488, AND A NEW SURFACE RATHER THAN A CHART CHANGE. The rest of this
 * page counts what the PROVIDERS were paid: tokens and dollars, scanned out of
 * transcripts, over days. This is the machine's own present tense, and folding
 * it into those charts would have meant one page where "usage" silently meant
 * two unrelated things measured in two unrelated units.
 *
 * WHY IT EXISTS. On nightly .9 a renderer sat at 100% of one core for fifty
 * minutes with no tab, no window and no visible page, and it was found with
 * Activity Monitor and `sample`, an hour in (#487). The shell now kills that
 * renderer and logs the line — both of which happen where nobody is looking.
 * This is the part a person can see.
 *
 * NO CHART, AND THAT IS DELIBERATE. What somebody comes here to find is a
 * single row that is wrong: one renderer at 96% while the rest sit at 0. A
 * stacked bar of process types answers "how is it divided", which is a question
 * nobody has about their own laptop's fans. Numbers, largest first, and the one
 * sentence that says which process it is.
 *
 * THE PAGE MUST BE OPEN. That is this surface's honest limit and it is stated
 * in the section rather than hidden: a per-type total nobody is looking at
 * catches nothing, which is why the poll is live while the tab is visible and
 * why a persistent indicator is filed separately rather than smuggled in here.
 */

import { RotateCwIcon, TriangleAlertIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  concerning,
  describeProcess,
  formatCpu,
  formatMemory,
  formatWindow,
  useProcessMetrics,
  type ProcessMetricsSummary,
} from "@/lib/desktop-metrics";
import { cn } from "@/lib/utils";

/** @internal Exported for the test that pins what a runaway renderer looks
 *  like on this page, without standing a desktop shell up to produce one. */
export function ProcessMetricsView({ summary, error }: { summary: ProcessMetricsSummary | undefined; error?: string }) {
  const cell = "px-2 py-1.5";
  const num = cn(cell, "text-right tabular-nums");
  const alerts = concerning(summary);

  return (
    <div className="flex flex-col gap-3">
      {error && <p className="text-xs text-destructive">{error}</p>}

      {/* THE SENTENCE THE INCIDENT NEEDED. Not a colour, not a badge — the pid
          and what it is, because the next thing a person does with it is look
          it up or wait for the shell to kill it. */}
      {alerts.map(({ row, kind }) => (
        <p key={row.pid} className="flex items-start gap-1.5 text-xs">
          <TriangleAlertIcon className={cn("mt-0.5 size-3.5 shrink-0", kind === "runaway" ? "text-destructive" : "text-muted-foreground")} />
          <span>
            {kind === "runaway" ? (
              <>
                <span className="font-medium">A renderer with no page is at {formatCpu(row.cpuPercent)}</span> (pid {row.pid}). Telar
                kills a renderer that stays this busy with nothing on screen; if this line persists, the kill is being refused because no
                service worker could be named for it — see the shell log.
              </>
            ) : (
              <>
                {describeProcess(row)} is at {formatCpu(row.cpuPercent)} (pid {row.pid}). It is showing a page, so this is work rather
                than a runaway.
              </>
            )}
          </span>
        </p>
      ))}

      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="text-3xl font-semibold tabular-nums">{summary ? formatCpu(summary.totals.cpuPercent) : "—"}</p>
        <p className="text-xs text-muted-foreground">
          {summary
            ? `of one core, across ${summary.totals.processes} process${summary.totals.processes === 1 ? "" : "es"} · ${formatWindow(summary.windowMs)}`
            : "Reading this app's processes…"}
        </p>
      </div>

      {summary && summary.types.length > 0 && (
        <div className="overflow-x-auto rounded-xl ring-1 ring-foreground/10">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/60 text-left text-xs text-muted-foreground">
                <th className={cn(cell, "font-medium")}>Process type</th>
                <th className={cn(num, "font-medium")}>Processes</th>
                <th className={cn(num, "font-medium")}>CPU</th>
                <th className={cn(num, "font-medium")}>Memory</th>
              </tr>
            </thead>
            <tbody>
              {summary.types.map((entry) => (
                <tr key={entry.type} className="border-b border-border/40 last:border-0">
                  <td className={cell}>
                    <span className="truncate">{entry.label}</span>
                    {/* The count that mattered in #487: renderers showing
                        nothing. Silent at zero — every app has none most of the
                        time, and a permanent "0 with no page" would train the
                        eye to skip the column that carries the finding. */}
                    {entry.pagelessCount > 0 && (
                      <span className="ml-2 text-xs text-muted-foreground">
                        {entry.pagelessCount} with no page
                      </span>
                    )}
                  </td>
                  <td className={num}>{entry.count}</td>
                  <td className={num}>{formatCpu(entry.cpuPercent)}</td>
                  <td className={num}>{formatMemory(entry.memoryKb)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {summary && summary.busiest.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs font-medium text-muted-foreground">Busiest processes</p>
          <ul className="flex flex-col gap-1">
            {summary.busiest.map((row) => (
              <li key={row.pid} className="flex items-baseline gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate">
                  {describeProcess(row)}
                  <span className="ml-1.5 text-muted-foreground">pid {row.pid}</span>
                  {row.hostsPage === false && <span className="ml-1.5 text-muted-foreground">· no page</span>}
                </span>
                <span className="w-16 text-right tabular-nums">{formatCpu(row.cpuPercent)}</span>
                <span className="w-20 text-right tabular-nums text-muted-foreground">{formatMemory(row.memoryKb)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function ProcessMetricsSection() {
  const { summary, error, supported, refresh } = useProcessMetrics();

  // Not inside the desktop app: there are no processes of ours to report, and
  // a heading explaining that to somebody on a phone would be the first thing
  // on the page every time. `undefined` is the first read not having answered
  // yet — also silence, for the same reason the Limits section gives.
  if (supported !== true) return null;

  return (
    <section>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Processes</p>
        <Button size="icon-sm" variant="ghost" aria-label="Refresh processes" onClick={refresh}>
          <RotateCwIcon />
        </Button>
      </div>
      <ProcessMetricsView summary={summary} error={error} />
      {/* SAY WHAT THIS DOES NOT DO. It refreshes while the page is in front of
          somebody and not otherwise, so it cannot catch a spin nobody watched —
          which is a real limit and better written down than discovered. */}
      <p className="mt-2 text-xs text-muted-foreground">
        Live while this page is open. Telar&rsquo;s watchdog keeps running either way and kills a renderer that burns a core with no page.
      </p>
    </section>
  );
}

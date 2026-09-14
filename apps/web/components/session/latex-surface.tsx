"use client";

/**
 * THE LATEX TAB: the last compile, its diagnostics, and the log tail.
 *
 * ONE SURFACE, NO SUB-STRIP — unlike Data, everything here is one view of one
 * compile. The PDF is deliberately NOT rendered here: the compile writes it
 * beside its source and "Open PDF" opens a file tab through the same routing
 * every other file uses, so when a PDF renderer lands in the panel this
 * button starts using it without a line changing here.
 *
 * Diagnostics are clickable: an error knows its file, and the fix lives
 * there, not in this list.
 */
import { useCallback, useEffect, useState } from "react";
import { ChevronDownIcon, ChevronRightIcon, FileTextIcon, Loader2Icon, PlayIcon, TriangleAlertIcon } from "lucide-react";
import type { LatexCompileStatus, LatexDiagnostic, TurnState } from "@telar/engine-client";
import { createEngineApi } from "@/lib/engine/client";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";

const api = createEngineApi();

type Status = LatexCompileStatus | { status: "never" };

function severityLabel(diagnostic: LatexDiagnostic): string {
  return diagnostic.severity === "error" ? "error" : "warning";
}

export function LatexSurface({ sessionId, active, onOpenFile }: { sessionId?: string; active?: TurnState; onOpenFile?: (path: string) => void }) {
  const [status, setStatus] = useState<Status>({ status: "never" });
  const [compiling, setCompiling] = useState(false);
  const [failure, setFailure] = useState<string>();
  const [logOpen, setLogOpen] = useState(false);
  const [target, setTarget] = useState("");
  const [defaultFile, setDefaultFile] = useState<string>();

  const read = useCallback(async () => {
    if (!sessionId) return;
    try {
      setStatus(await api.latexStatus(sessionId));
    } catch {
      // Not opted in, or the engine is away — the empty state below says so.
    }
  }, [sessionId]);

  // Re-read when a turn settles: the agent may have compiled mid-turn.
  useEffect(() => {
    const first = window.setTimeout(() => void read(), 0);
    return () => window.clearTimeout(first);
  }, [read, active]);

  useEffect(() => {
    if (!sessionId) return;
    const task = window.setTimeout(() => {
      void api.sessionLatexToolchain(sessionId)
        .then((toolchain) => {
          setDefaultFile(toolchain.mainFile);
          setTarget((current) => current || toolchain.mainFile || "");
        })
        .catch(() => {});
    }, 0);
    return () => window.clearTimeout(task);
  }, [sessionId]);

  const compile = async () => {
    if (!sessionId || compiling) return;
    setCompiling(true);
    setFailure(undefined);
    try {
      await api.latexCompile(sessionId, target.trim() ? { path: target.trim() } : {});
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error));
    } finally {
      setCompiling(false);
      void read();
    }
  };

  const last = status.status === "never" ? undefined : status;
  const errors = last?.diagnostics.filter((d) => d.severity === "error") ?? [];
  const warnings = last?.diagnostics.filter((d) => d.severity === "warning") ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5">
        <Input
          value={target}
          onChange={(event) => setTarget(event.target.value)}
          placeholder={defaultFile ? `Default: ${defaultFile}` : "report/main.tex"}
          className="h-7 min-w-0 flex-1 font-mono text-2xs"
          aria-label="LaTeX document to compile"
        />
        <button
          type="button"
          onClick={() => void compile()}
          disabled={!sessionId || compiling}
          className="flex items-center gap-1.5 rounded-md bg-muted px-2 py-1 text-xs font-medium text-foreground outline-none hover:bg-muted/70 focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
        >
          {compiling ? <Loader2Icon className="size-3 animate-spin" /> : <PlayIcon className="size-3" />}
          {compiling ? "Compiling..." : "Compile"}
        </button>
        {last && (
          <span
            className={cn(
              "rounded-full px-2 py-0.5 text-2xs font-medium",
              last.status === "ok" && "bg-success/15 text-success",
              last.status === "failed" && "bg-destructive/15 text-destructive",
              last.status === "running" && "bg-muted text-muted-foreground",
              last.status === "cancelled" && "bg-muted text-muted-foreground",
            )}
          >
            {last.status === "ok" ? "Compiled" : last.status === "failed" ? "Failed" : last.status}
          </span>
        )}
        {last && <span className="truncate text-xs text-muted-foreground">{last.path}</span>}
        {last?.pdfPath && onOpenFile && (
          <button
            type="button"
            onClick={() => onOpenFile(last.pdfPath!)}
            className="ml-auto flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground outline-none hover:bg-muted/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <FileTextIcon className="size-3" />
            Open PDF
          </button>
        )}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-3">
        {!last && !failure && (
          <p className="text-xs leading-relaxed text-muted-foreground">
            Nothing has been compiled in this session yet. Type a .tex path and press Compile, or ask the agent; its <code className="font-mono">latex_compile</code> lands here too.
          </p>
        )}
        {failure && (
          <p className="mb-3 rounded-md border border-destructive/30 bg-destructive/5 px-2.5 py-2 text-xs leading-relaxed text-destructive">{failure}</p>
        )}
        {last && last.diagnostics.length > 0 && (
          <ul className="flex flex-col gap-1">
            {last.diagnostics.map((diagnostic, index) => (
              <li key={index}>
                <button
                  type="button"
                  disabled={!diagnostic.file || !onOpenFile}
                  onClick={() => diagnostic.file && onOpenFile?.(diagnostic.file)}
                  className={cn(
                    "flex w-full items-start gap-2 rounded-md border border-border px-2.5 py-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    diagnostic.file && onOpenFile && "hover:bg-muted/50",
                  )}
                >
                  <TriangleAlertIcon
                    className={cn("mt-0.5 size-3 shrink-0", diagnostic.severity === "error" ? "text-destructive" : "text-warning")}
                    aria-label={severityLabel(diagnostic)}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs leading-snug text-foreground">{diagnostic.message}</span>
                    <span className="block truncate text-2xs text-muted-foreground">
                      {diagnostic.file ? `${diagnostic.file}${diagnostic.line ? `:${diagnostic.line}` : ""}` : severityLabel(diagnostic)}
                      {diagnostic.suggestion ? ` — ${diagnostic.suggestion}` : ""}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {last && last.diagnostics.length === 0 && last.status === "ok" && (
          <p className="text-xs text-muted-foreground">Clean compile — no errors, no warnings.</p>
        )}
        {last && (
          <div className="mt-3">
            <button
              type="button"
              onClick={() => setLogOpen((open) => !open)}
              className="flex items-center gap-1 rounded-sm text-2xs font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              {logOpen ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />}
              Log tail
            </button>
            {logOpen && (
              <pre className="mt-1.5 overflow-x-auto rounded-md bg-muted/50 p-2 font-mono text-2xs leading-relaxed text-muted-foreground">
                {last.logTail.join("\n") || "(empty)"}
              </pre>
            )}
          </div>
        )}
        {errors.length + warnings.length > 0 && (
          <p className="mt-3 text-2xs text-muted-foreground">
            {errors.length} error{errors.length === 1 ? "" : "s"}, {warnings.length} warning{warnings.length === 1 ? "" : "s"}.
          </p>
        )}
      </div>
    </div>
  );
}

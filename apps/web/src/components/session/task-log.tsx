"use client";

/**
 * A BACKGROUND TASK'S LOG, inside its row on the Processes tab.
 *
 * READ-ONLY, AND POLLED. The provider wrote the file, not Telar — there is no
 * PTY to adopt and nothing to type into — so this reads the engine's
 * `…/tasks/:taskId/output` a page at a time from a byte cursor: the tail on
 * open, then whatever arrived since, once a second while the task runs and
 * once more when it ends. Through the host hop like every other read, so a
 * session on another Mac shows its log the same way.
 */
import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { TaskOutputPage } from "@telar/engine-client";
import { createEngineApi, EngineApiError } from "@/platform/engine";
import { LOCAL_HOST_ID } from "@telar/engine-client";
import { hostFetcher } from "@/lib/hosts/client";
import { cssColorReader, cssVariableReader, loadTerminalFonts, terminalFont, terminalTheme } from "@/features/terminal";
import { cn } from "@/lib/utils";

/** How often a running task's log is asked for. */
const TASK_LOG_POLL_MS = 1000;
/** Pages read back to back before yielding to the next tick — a log that grew
 *  by megabytes between two polls is caught up over a few ticks, not one. */
const MAX_PAGES_PER_TICK = 8;

type Drained = { cursor: number | undefined; missing: boolean; wrote: boolean };

/**
 * Read pages from `after` until the engine has nothing more, handing each to
 * `write`. `restart` is true on a page that does not continue the previous
 * one — the file was rewritten, so what is on screen is not its prefix.
 */
export async function drainTaskOutput(
  read: (after?: number) => Promise<TaskOutputPage>,
  after: number | undefined,
  write: (page: TaskOutputPage, restart: boolean) => void,
): Promise<Drained> {
  let cursor = after;
  let wrote = false;
  for (let pages = 0; pages < MAX_PAGES_PER_TICK; pages += 1) {
    const page = await read(cursor);
    if (page.missing) return { cursor, missing: true, wrote };
    const restart = cursor !== undefined && (page.truncated || page.cursor < cursor);
    if (page.text || restart) {
      write(page, restart);
      wrote = true;
    }
    cursor = page.cursor;
    if (!page.more) break;
  }
  return { cursor, missing: false, wrote };
}

type Props = {
  sessionId: string;
  taskId: string;
  hostId?: string;
  /** Still running: keep polling. A finished task is read once more and left. */
  live: boolean;
  /** The panel is on screen; a hidden one does not poll. */
  visible?: boolean;
};

export function TaskLog({ sessionId, taskId, hostId, live, visible = true }: Props) {
  const host = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const cursor = useRef<number | undefined>(undefined);
  const [status, setStatus] = useState<"loading" | "empty" | "missing" | "ready">("loading");
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let disposed = false;
    const read = cssColorReader(element, document.createElement("canvas"));
    const { fontFamily, fontSize } = terminalFont(cssVariableReader(element));
    const fontsReady = loadTerminalFonts(fontFamily, fontSize);
    const term = new Terminal({
      allowProposedApi: true,
      theme: terminalTheme(read),
      fontFamily,
      fontSize,
      scrollback: 5000,
      // A log file's lines end in a bare \n; without this each would start
      // where the last one ended.
      convertEol: true,
      disableStdin: true,
      cursorBlink: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(element);
    // Nothing is waiting for input here; a cursor under the log says otherwise.
    term.write("\x1b[?25l");
    termRef.current = term;
    let frame = 0;
    const measure = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (!disposed && element.clientWidth > 0) fit.fit();
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    void fontsReady.then(() => {
      if (!disposed) measure();
    });
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      observer.disconnect();
      term.dispose();
      termRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!visible) return;
    const api = createEngineApi(hostFetcher(hostId ?? LOCAL_HOST_ID));
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const drained = await drainTaskOutput(
          (after) => api.taskOutput(sessionId, taskId, after),
          cursor.current,
          (page, restart) => {
            if (stopped) return;
            const term = termRef.current;
            if (restart) term?.reset();
            if (page.truncated) setTruncated(true);
            if (page.text) term?.write(page.text);
          },
        );
        if (stopped) return;
        cursor.current = drained.cursor;
        setError(undefined);
        setStatus((current) =>
          drained.wrote || current === "ready" ? "ready" : drained.missing ? (live ? "empty" : "missing") : "empty",
        );
      } catch (caught) {
        if (stopped) return;
        setError(caught instanceof EngineApiError ? caught.message : "Telar could not read this log.");
      }
      if (!stopped && live) timer = setTimeout(() => void tick(), TASK_LOG_POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId, taskId, hostId, live, visible]);

  const notice =
    error ??
    (status === "loading"
      ? "Reading the log…"
      : status === "missing"
        ? "This log is no longer available."
        : status === "empty"
          ? live
            ? "No output yet."
            : "This task wrote no output."
          : undefined);

  return (
    <div className="flex flex-col gap-1">
      {truncated && <p className="text-3xs text-muted-foreground">Showing the end of a longer log.</p>}
      <div className="relative h-60 overflow-hidden rounded-md border border-border bg-background p-1">
        <div ref={host} className="size-full" data-testid="task-log-terminal" />
        {notice && (
          <p className={cn("pointer-events-none absolute inset-0 flex items-center justify-center text-2xs", error ? "text-destructive" : "text-muted-foreground")}>
            {notice}
          </p>
        )}
      </div>
    </div>
  );
}

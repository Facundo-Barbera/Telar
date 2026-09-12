"use client";

/**
 * A CSV, TSV OR PARQUET FILE AS A GRID: windowed rows from the engine, a sticky
 * header, click-to-sort. Rows come in pages of 200 as you scroll rather than
 * in one read, so a million-row file opens at the speed of its first page.
 * The virtualiser is hand-rolled — fixed row height, an offset transform —
 * because a table needs exactly that and nothing a library adds.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, TableIcon } from "lucide-react";
import type { TurnState } from "@telar/engine-client";
import { createEngineApi, EngineApiError } from "@/lib/engine/client";
import type { TableWindow } from "@/lib/ds";
import { EditorAddressRow } from "@/components/session/editor-chrome";
import { PanelEmpty } from "@/components/ui/panel";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

const api = createEngineApi();
const ROW = 22;
const PAGE = 200;

export function TableSurface({ path, sessionId, active }: { path: string; sessionId?: string; active?: TurnState }) {
  const [meta, setMeta] = useState<Pick<TableWindow, "columns" | "dtypes" | "total" | "truncated">>();
  const [rows, setRows] = useState<Map<number, unknown[]>>(new Map());
  const [error, setError] = useState<string>();
  const [sort, setSort] = useState<{ column: string; desc: boolean }>();
  const [scrollTop, setScrollTop] = useState(0);
  const [height, setHeight] = useState(400);
  const scroller = useRef<HTMLDivElement>(null);
  const inflight = useRef<Set<number>>(new Set());

  const fetchPage = useCallback(
    async (offset: number) => {
      if (!sessionId || inflight.current.has(offset)) return;
      inflight.current.add(offset);
      try {
        const window = await api.sessionTable(sessionId, path, { offset, limit: PAGE, ...(sort ? { sort: sort.column, desc: sort.desc } : {}) });
        setMeta({ columns: window.columns, dtypes: window.dtypes, total: window.total, truncated: window.truncated });
        setRows((current) => {
          const next = new Map(current);
          window.rows.forEach((row, index) => next.set(offset + index, row));
          return next;
        });
        setError(undefined);
      } catch (cause) {
        setError(cause instanceof EngineApiError ? cause.message : "The engine did not answer.");
      } finally {
        inflight.current.delete(offset);
      }
    },
    [sessionId, path, sort],
  );

  /** A new sort or file empties the cache — as a render-phase adjustment
   *  keyed on `fetchPage`'s identity, the app's own pattern for "state that
   *  follows a prop", rather than a setState inside an effect. */
  const cacheKey = `${sessionId ?? ""}\0${path}\0${sort?.column ?? ""}\0${sort?.desc ? 1 : 0}`;
  const [cachedFor, setCachedFor] = useState(cacheKey);
  if (cachedFor !== cacheKey) {
    setCachedFor(cacheKey);
    setRows(new Map());
  }
  useEffect(() => {
    const first = window.setTimeout(() => void fetchPage(0), 0);
    return () => window.clearTimeout(first);
  }, [fetchPage, active]);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    // The observer fires once on observe, so the initial measure rides it.
    const observer = new ResizeObserver(() => setHeight(element.clientHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const total = meta?.total ?? 0;
  const first = Math.max(0, Math.floor(scrollTop / ROW) - 10);
  const last = Math.min(total, Math.ceil((scrollTop + height) / ROW) + 10);
  useEffect(() => {
    const wanted: number[] = [];
    for (let page = Math.floor(first / PAGE) * PAGE; page < last; page += PAGE) {
      if (!rows.has(page) && page < total) wanted.push(page);
    }
    if (!wanted.length) return;
    // Deferred, like every other read in this panel.
    const task = window.setTimeout(() => wanted.forEach((page) => void fetchPage(page)), 0);
    return () => window.clearTimeout(task);
  }, [first, last, rows, total, fetchPage]);

  if (!sessionId) return <PanelEmpty icon={<TableIcon />} title="No session">A table view needs a session&apos;s checkout.</PanelEmpty>;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* The shared address row (session/editor-chrome.tsx). The glyph names the
          VIEW rather than the extension, because a grid is what is unusual
          about this tab; the figure it reports is a shape, not a size. */}
      <EditorAddressRow
        path={path}
        icon={<TableIcon className="size-3.5 shrink-0 text-muted-foreground" />}
        {...(meta ? { detail: `${meta.total.toLocaleString()} rows × ${meta.columns.length}${meta.truncated ? " · partial read" : ""}` } : {})}
      />
      {error ? (
        <PanelEmpty icon={<TableIcon />} title="Could not read this table">{error}</PanelEmpty>
      ) : !meta ? (
        <p className="flex items-center gap-2 px-4 py-3 text-[0.6875rem] text-muted-foreground"><Spinner className="size-3" /> reading…</p>
      ) : (
        <div ref={scroller} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)} className="min-h-0 flex-1 overflow-auto">
          <table className="w-max min-w-full border-collapse font-mono text-[0.6875rem] tabular-nums">
            <thead className="sticky top-0 z-10 bg-background">
              <tr>
                <th className="w-12 border-b border-r border-border bg-muted/60 px-2 text-right text-muted-foreground/60">#</th>
                {meta.columns.map((column, index) => {
                  const sorted = sort?.column === column;
                  return (
                    <th key={column} onClick={() => setSort(sorted && !sort.desc ? { column, desc: true } : sorted ? undefined : { column, desc: false })} className="cursor-pointer select-none whitespace-nowrap border-b border-border bg-muted/60 px-2 py-1 text-left font-medium hover:bg-muted">
                      {column}
                      <span className="ml-1 font-normal text-muted-foreground">{meta.dtypes?.[index]}</span>
                      {sorted && (sort.desc ? <ArrowDownIcon className="ml-1 inline size-2.5" /> : <ArrowUpIcon className="ml-1 inline size-2.5" />)}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {first > 0 && <tr style={{ height: first * ROW }}><td colSpan={meta.columns.length + 1} /></tr>}
              {Array.from({ length: Math.max(0, last - first) }, (_, i) => first + i).map((index) => {
                const row = rows.get(index);
                return (
                  <tr key={index} style={{ height: ROW }} className="odd:bg-muted/20">
                    <td className="border-r border-border px-2 text-right text-muted-foreground/60">{index + 1}</td>
                    {row ? row.map((cell, c) => (
                      <td key={c} className={cn("max-w-96 truncate whitespace-nowrap px-2", (cell === null || cell === "") && "text-muted-foreground/40")}>{cell === null ? "null" : String(cell)}</td>
                    )) : <td colSpan={meta.columns.length} className="px-2 text-muted-foreground/40">…</td>}
                  </tr>
                );
              })}
              {last < total && <tr style={{ height: (total - last) * ROW }}><td colSpan={meta.columns.length + 1} /></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, TableIcon } from "lucide-react";
import type { TurnState } from "@telar/engine-client";
import { createEngineApi, EngineApiError } from "@/platform/engine/index";
import type { TableWindow } from "@/features/plugins/index";
import { EditorAddressRow } from "./editor-chrome";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { PanelEmpty } from "@/components/ui/panel";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

const api = createEngineApi();
const ROW = 22;
const PAGE = 200;

function HeaderMenu({
  column,
  sort,
  onSort,
  children,
}: {
  column: string;
  sort: "asc" | "desc" | "none";
  onSort: (next: { column: string; desc: boolean } | undefined) => void;
  children: React.ReactNode;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<span />}>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-auto">
        <ContextMenuRadioGroup
          value={sort}
          onValueChange={(next: string) => onSort(next === "none" ? undefined : { column, desc: next === "desc" })}
        >
          <ContextMenuRadioItem value="asc" closeOnClick>
            Sort ascending
          </ContextMenuRadioItem>
          <ContextMenuRadioItem value="desc" closeOnClick>
            Sort descending
          </ContextMenuRadioItem>
          <ContextMenuRadioItem value="none" closeOnClick>
            Clear sort
          </ContextMenuRadioItem>
        </ContextMenuRadioGroup>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => void navigator.clipboard.writeText(column)}>Copy column name</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function CellMenu({ value, children }: { value: string; children: React.ReactNode }) {
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<span />}>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-auto">
        <ContextMenuItem onClick={() => void navigator.clipboard.writeText(value)}>Copy value</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

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
    const task = window.setTimeout(() => wanted.forEach((page) => void fetchPage(page)), 0);
    return () => window.clearTimeout(task);
  }, [first, last, rows, total, fetchPage]);

  if (!sessionId) return <PanelEmpty icon={<TableIcon />} title="No session">A table view needs a session&apos;s checkout.</PanelEmpty>;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <EditorAddressRow
        path={path}
        icon={<TableIcon className="size-3.5 shrink-0 text-muted-foreground" />}
        {...(meta ? { detail: `${meta.total.toLocaleString()} rows × ${meta.columns.length}${meta.truncated ? " · partial read" : ""}` } : {})}
      />
      {error ? (
        <PanelEmpty icon={<TableIcon />} title="Could not read this table">{error}</PanelEmpty>
      ) : !meta ? (
        <p className="flex items-center gap-2 px-4 py-3 text-2xs text-muted-foreground"><Spinner className="size-3" /> reading…</p>
      ) : (
        <div ref={scroller} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)} className="min-h-0 flex-1 overflow-auto">
          <table className="w-max min-w-full border-collapse font-mono text-2xs tabular-nums">
            <thead className="sticky top-0 z-10 bg-background">
              <tr>
                <th className="w-12 border-b border-r border-border bg-muted/60 px-2 text-right text-muted-foreground/60">#</th>
                {meta.columns.map((column, index) => {
                  const sorted = sort?.column === column;
                  return (
                    <th key={column} onClick={(event) => event.currentTarget.contains(event.target as Node) && setSort(sorted && !sort.desc ? { column, desc: true } : sorted ? undefined : { column, desc: false })} className="cursor-pointer select-none whitespace-nowrap border-b border-border bg-muted/60 px-2 py-1 text-left font-medium hover:bg-muted">
                      <HeaderMenu column={column} sort={sorted ? (sort.desc ? "desc" : "asc") : "none"} onSort={setSort}>
                        {column}
                        <span className="ml-1 font-normal text-muted-foreground">{meta.dtypes?.[index]}</span>
                        {sorted && (sort.desc ? <ArrowDownIcon className="ml-1 inline size-2.5" /> : <ArrowUpIcon className="ml-1 inline size-2.5" />)}
                      </HeaderMenu>
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
                      <td key={c} className={cn("max-w-96 truncate whitespace-nowrap px-2", (cell === null || cell === "") && "text-muted-foreground/40")}>
                        <CellMenu value={cell === null ? "null" : String(cell)}>{cell === null ? "null" : String(cell)}</CellMenu>
                      </td>
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

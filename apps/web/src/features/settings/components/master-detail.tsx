"use client";

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "@/ui/utils";
import { usePendingReveal } from "./settings-shell";

export type MasterDetailItem = {
  id: string;
  label: string;
  icon?: ReactNode;
  description?: ReactNode;
  badge?: ReactNode;
  control?: ReactNode;
  unavailable?: ReactNode;
  dimmed?: boolean;
  detail?: ReactNode;
};

function readParam(param: string): string | null {
  return new URLSearchParams(window.location.search).get(param);
}

function writeParam(param: string, value: string) {
  const url = new URL(window.location.href);
  url.searchParams.set(param, value);
  window.history.replaceState(window.history.state, "", url);
}

export function MasterDetail({
  title,
  description,
  items,
  param,
  empty,
  footer,
  select,
  bounded = false,
}: {
  title: string;
  description?: ReactNode;
  items: readonly MasterDetailItem[];
  param: string;
  empty?: ReactNode;
  footer?: ReactNode;
  select?: string;
  bounded?: boolean;
}) {
  const [chosen, setChosen] = useState<string>();
  const list = useRef<HTMLDivElement>(null);
  const pending = usePendingReveal();
  const withDetail = items.filter((item) => item.detail !== undefined);
  const selected = withDetail.find((item) => item.id === chosen) ?? withDetail[0];

  useEffect(() => {
    const task = window.setTimeout(() => {
      const named = readParam(param);
      if (named) setChosen(named);
    }, 0);
    return () => window.clearTimeout(task);
  }, [param]);

  useEffect(() => {
    if (!select) return;
    const task = window.setTimeout(() => setChosen(select), 0);
    return () => window.clearTimeout(task);
  }, [select]);

  useEffect(() => {
    if (!pending) return;
    const holder = document.getElementById(pending)?.closest<HTMLElement>("[data-detail-for]");
    const id = holder?.dataset.detailFor;
    if (!id || id === selected?.id) return;
    const task = window.setTimeout(() => setChosen(id), 0);
    return () => window.clearTimeout(task);
  });

  const choose = (id: string) => {
    setChosen(id);
    writeParam(param, id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    if (!selected) return;
    const at = withDetail.indexOf(selected);
    const next = withDetail[at + (event.key === "ArrowDown" ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    choose(next.id);
    list.current?.querySelector<HTMLElement>(`[data-master-item="${CSS.escape(next.id)}"]`)?.focus();
  };

  const renderItem = (item: MasterDetailItem) => {
    const on = item === selected;
    return (
      <div key={item.id} className={cn("flex items-start gap-2 px-3 py-2.5 transition-colors", on ? "bg-muted" : item.detail !== undefined && "hover:bg-muted/40")}>
        <button
          type="button"
          role="option"
          aria-selected={on}
          data-master-item={item.id}
          tabIndex={on || (!selected && item === items[0]) ? 0 : -1}
          disabled={item.detail === undefined}
          onClick={() => choose(item.id)}
          className={cn(
            "flex min-w-0 flex-1 items-start gap-2.5 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring",
            item.detail === undefined && "cursor-default",
            item.dimmed && "opacity-60",
          )}
        >
          {item.icon && <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-muted-foreground/80">{item.icon}</span>}
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className={cn("truncate text-sm text-foreground", on && "font-medium")}>{item.label}</span>
              {item.badge}
            </span>
            {(item.unavailable ?? item.description) && (
              <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">{item.unavailable ?? item.description}</span>
            )}
          </span>
        </button>
        {item.control && (
          <span inert={item.unavailable ? true : undefined} className={cn("flex shrink-0 items-center", item.unavailable && "opacity-50")}>
            {item.control}
          </span>
        )}
      </div>
    );
  };

  return (
    <section className="@container/master mb-6 last:mb-0">
      <div className="mb-2 px-4">
        <h4 className="font-heading text-xs-plus font-semibold tracking-tight text-foreground">{title}</h4>
        {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
      </div>
      <div
        className={cn(
          "grid gap-6",
          withDetail.length > 0 && "@min-[44rem]/master:grid-cols-[15rem_minmax(0,1fr)] @min-[44rem]/master:items-start",
          bounded && withDetail.length > 0 && "@min-[44rem]/master:h-[min(44rem,calc(100dvh-11rem))] @min-[44rem]/master:min-h-[24rem] @min-[44rem]/master:items-stretch",
        )}
      >
        <div
          className={cn(
            "flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-1",
            bounded ? "@min-[44rem]/master:min-h-0" : "@min-[44rem]/master:sticky @min-[44rem]/master:top-0",
          )}
        >
          <div ref={list} role="listbox" aria-label={title} onKeyDown={onKeyDown} className={cn("divide-y divide-border/60", bounded && "min-h-0 flex-1 overflow-y-auto")}>
            {items.length === 0 && <div className="px-4">{empty}</div>}
            {items.map((item) => renderItem(item))}
          </div>
          {footer && <div className="shrink-0 border-t border-border/60 px-4">{footer}</div>}
        </div>
        {withDetail.length > 0 && (
          <div
            data-detail-pane
            className={cn(
              "min-w-0",
              bounded && "max-h-[max(20rem,70dvh)] overflow-y-auto overscroll-contain @min-[44rem]/master:max-h-none @min-[44rem]/master:min-h-0",
            )}
          >
            {withDetail.map((item) => (
              <div key={item.id} data-detail-for={item.id} hidden={item !== selected}>
                {item.detail}
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

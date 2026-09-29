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
}: {
  title: string;
  description?: ReactNode;
  items: readonly MasterDetailItem[];
  param: string;
  empty?: ReactNode;
  footer?: ReactNode;
  select?: string;
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

  const split = withDetail.length > 0;

  return (
    <section className="@container/master mb-6 last:mb-0">
      <div className="mb-2 px-4">
        <h4 className="font-heading text-xs-plus font-semibold tracking-tight text-foreground">{title}</h4>
        {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
      </div>
      <div
        className={cn(
          "grid gap-6",
          split &&
            "@min-[44rem]/master:h-[min(44rem,calc(100dvh-11rem))] @min-[44rem]/master:min-h-[24rem] @min-[44rem]/master:grid-cols-[15rem_minmax(0,1fr)]",
        )}
      >
        <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-card shadow-1 @min-[44rem]/master:min-h-0">
          <div ref={list} role="listbox" aria-label={title} onKeyDown={onKeyDown} className="min-h-0 flex-1 divide-y divide-border/60 overflow-y-auto">
            {items.length === 0 && <div className="px-4">{empty}</div>}
            {items.map((item) => (
              <ListItem key={item.id} item={item} on={item === selected} focusable={item === selected || (!selected && item === items[0])} onChoose={() => choose(item.id)} />
            ))}
          </div>
          {footer && <div className="shrink-0 border-t border-border/60 px-4">{footer}</div>}
        </div>
        {split && (
          <div
            data-detail-frame
            className="flex max-h-[max(20rem,70dvh)] min-w-0 flex-col overflow-hidden rounded-xl border border-border bg-card shadow-1 @min-[44rem]/master:max-h-none @min-[44rem]/master:min-h-0"
          >
            <div data-detail-pane className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
              {withDetail.map((item) => (
                <div key={item.id} data-detail-for={item.id} hidden={item !== selected}>
                  <DetailHeader item={item} />
                  <div className="p-4">{item.detail}</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function ListItem({ item, on, focusable, onChoose }: { item: MasterDetailItem; on: boolean; focusable: boolean; onChoose: () => void }) {
  return (
    <div className={cn("flex items-start gap-2 px-3 py-2.5 transition-colors", on ? "bg-muted" : item.detail !== undefined && "hover:bg-muted/40")}>
      <button
        type="button"
        role="option"
        aria-selected={on}
        data-master-item={item.id}
        tabIndex={focusable ? 0 : -1}
        disabled={item.detail === undefined}
        onClick={onChoose}
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
}

function DetailHeader({ item }: { item: MasterDetailItem }) {
  return (
    <div data-detail-header className="sticky top-0 z-10 flex items-start gap-2.5 border-b border-border/60 bg-card/95 px-4 py-3 backdrop-blur">
      {item.icon && <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-muted-foreground/80">{item.icon}</span>}
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <h5 className="truncate text-sm font-semibold text-foreground">{item.label}</h5>
          {item.badge}
        </div>
        {(item.unavailable ?? item.description) && <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{item.unavailable ?? item.description}</p>}
      </div>
      {item.control && (
        <span inert={item.unavailable ? true : undefined} className={cn("flex shrink-0 items-center", item.unavailable && "opacity-50")}>
          {item.control}
        </span>
      )}
    </div>
  );
}

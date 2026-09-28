"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, type ComponentType, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import { ArrowLeftIcon, CircleAlertIcon, InfoIcon, Undo2Icon } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { settingsRowId, type SettingsSearchEntry, type SettingsSearchIndex } from "../search";
import { SettingsSearchNav } from "./settings-search-nav";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { APP_SIDEBAR_STORAGE_KEY, APP_SIDEBAR_MAIN_MIN_WIDTH, clampSidebarWidth, keepsRoomForMain, setSidebarWidth, SIDEBAR_RESIZE_MIN_WIDTH, useSidebarPrefs } from "@/lib/sidebar-width";

export type SettingsSection = {
  id: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  count?: number;
  group?: string; // optional side-nav grouping header
  scope?: SettingsScope;
};

const SettingsPaneContext = createContext<string | undefined>(undefined);
const SettingsGroupContext = createContext<string | undefined>(undefined);

export function revealSettingsRow(id: string): boolean {
  const row = document.getElementById(id);
  if (!row) return false;
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
  row.scrollIntoView({ block: "center", behavior: still ? "auto" : "smooth" });
  row.focus({ preventScroll: true });
  if (!still) {
    row.classList.remove("settings-search-target-pulse");
    void row.offsetWidth;
    row.classList.add("settings-search-target-pulse");
    row.addEventListener("animationend", () => row.classList.remove("settings-search-target-pulse"), { once: true });
  }
  return true;
}

const REVEAL_TIMEOUT_MS = 2_000;

type RestoreRegistry = { add: (restore: () => void | Promise<void>) => () => void };
const SettingsRestoreContext = createContext<RestoreRegistry | undefined>(undefined);

export function useRestoreDefaults(restore: () => void | Promise<void>): void {
  const registry = useContext(SettingsRestoreContext);
  const latest = useRef(restore);
  useEffect(() => {
    latest.current = restore;
  });
  useEffect(() => {
    if (!registry) return;
    return registry.add(() => latest.current());
  }, [registry]);
}

export function SettingsShell({
  title,
  subtitle,
  sections,
  active,
  onSelect,
  backHref,
  headerActions,
  search,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  sections: SettingsSection[];
  active: string;
  onSelect: (id: string) => void;
  backHref?: string;
  headerActions?: ReactNode;
  search?: SettingsSearchIndex;
  children: ReactNode;
}) {
  const activeSection = sections.find((s) => s.id === active) ?? sections[0];
  const [restorers, setRestorers] = useState<ReadonlyArray<() => void | Promise<void>>>([]);
  const restoreRegistry = useMemo<RestoreRegistry>(
    () => ({
      add: (restore) => {
        setRestorers((current) => [...current, restore]);
        return () => setRestorers((current) => current.filter((entry) => entry !== restore));
      },
    }),
    [],
  );
  const prefsWidth = useSidebarPrefs(APP_SIDEBAR_STORAGE_KEY).width ?? SIDEBAR_RESIZE_MIN_WIDTH;
  const [dragWidth, setDragWidth] = useState<number>();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const navWidth = dragWidth ?? prefsWidth;

  useEffect(() => {
    if (dragWidth === undefined) return;
    const stop = () => {
      setSidebarWidth(APP_SIDEBAR_STORAGE_KEY, dragWidth);
      setDragWidth(undefined);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    const move = (event: PointerEvent) => {
      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      const rect = wrapper.getBoundingClientRect();
      const current = dragWidth;
      const proposed = event.clientX - rect.left;
      const max = Math.max(SIDEBAR_RESIZE_MIN_WIDTH, rect.width - APP_SIDEBAR_MAIN_MIN_WIDTH);
      const next = clampSidebarWidth(proposed, SIDEBAR_RESIZE_MIN_WIDTH, max);
      if (keepsRoomForMain(current, next, rect.width, APP_SIDEBAR_MAIN_MIN_WIDTH)) setDragWidth(next);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    window.addEventListener("pointercancel", stop, { once: true });
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, [dragWidth]);

  const [pendingRow, setPendingRow] = useState<string>();
  useEffect(() => {
    if (!pendingRow) return;
    const deadline = Date.now() + REVEAL_TIMEOUT_MS;
    let frame = 0;
    const look = () => {
      if (revealSettingsRow(pendingRow) || Date.now() > deadline) {
        setPendingRow(undefined);
        return;
      }
      frame = window.requestAnimationFrame(look);
    };
    frame = window.requestAnimationFrame(look);
    return () => window.cancelAnimationFrame(frame);
  }, [pendingRow]);

  const jumpTo = (entry: SettingsSearchEntry) => {
    onSelect(entry.pageId);
    setPendingRow(entry.id);
  };

  const groups = sections.some((s) => s.group)
    ? Array.from(new Set(sections.map((s) => s.group ?? ""))).map((g) => ({
        group: g,
        items: sections.filter((s) => (s.group ?? "") === g),
      }))
    : [{ group: "", items: sections }];

  const paneList = (
    <div className="flex min-h-0 flex-1 flex-col gap-4">
      {groups.map(({ group, items }) => (
        <div key={group} className="flex flex-col gap-0.5">
          {group && (
            <div className="px-2 pb-1 text-3xs font-medium uppercase tracking-wider text-muted-foreground/60">{group}</div>
          )}
          {items.map((s) => {
            const Icon = s.icon;
            const on = s.id === active;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => onSelect(s.id)}
                className={cn(
                  "group flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm transition-colors",
                  on ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                )}
              >
                <Icon className={cn("size-4 shrink-0", on ? "text-foreground" : "text-muted-foreground/70")} />
                <span className="flex-1 truncate">{s.label}</span>
                {s.count != null && <span className="text-2xs tabular-nums text-muted-foreground/60">{s.count}</span>}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );

  return (
    <div
      data-surfaces
      ref={wrapperRef}
      className="app-ground flex h-full min-h-0 bg-background text-foreground md:gap-2 md:bg-transparent"
      style={{ "--settings-nav-width": `${navWidth}px` } as CSSProperties}
    >
      <nav
        className={cn(
          "flex w-[var(--settings-nav-width)] shrink-0 flex-col gap-4 overflow-x-hidden overflow-y-auto border-r border-border bg-sidebar p-3",
          "md:w-[calc(var(--settings-nav-width)-1rem)] md:rounded-xl md:border-r-0 md:shadow-1 md:ring-1 md:ring-sidebar-border",
        )}
      >
        <div
          className={cn(
            "app-drag -m-3 mb-0 flex h-[var(--titlebar-height)] shrink-0 items-center border-b border-sidebar-border/60 px-3",
            "pl-[max(12px,calc(var(--titlebar-inset)+4px))]",
            "md:h-[var(--titlebar-band-height)]",
          )}
        >
          <span className="px-1.5 font-heading text-lg font-semibold tracking-tight text-foreground">Telar</span>
        </div>
        <div className="px-1 pt-1">
          <div className="px-1">
            <h2 className="font-heading text-sm font-semibold tracking-tight text-foreground">
              {title}
            </h2>
            {subtitle && (
              <div className="mt-0.5 text-xs text-muted-foreground">{subtitle}</div>
            )}
          </div>
        </div>
        {search ? (
          <SettingsSearchNav index={search} onChoose={jumpTo}>
            {paneList}
          </SettingsSearchNav>
        ) : (
          paneList
        )}
        {backHref && (
          <div className="mt-auto shrink-0 pt-2">
            <Link
              href={backHref}
              className="group flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
            >
              <ArrowLeftIcon className="size-4 shrink-0 text-muted-foreground/70" />
              <span className="flex-1 truncate">Back</span>
            </Link>
          </div>
        )}
      </nav>
      <button
        type="button"
        aria-label="Resize settings sidebar"
        title="Drag to resize settings sidebar"
        onPointerDown={(event) => {
          event.preventDefault();
          setDragWidth(navWidth);
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
        }}
        className="app-no-drag -mx-2 hidden w-4 shrink-0 cursor-col-resize focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:block"
      />

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden md:rounded-xl md:bg-sidebar md:shadow-1 md:ring-1 md:ring-sidebar-border">
        <header className="app-drag app-ground sticky top-0 z-10 flex h-[var(--titlebar-height)] shrink-0 items-center gap-2.5 border-b border-border bg-background/65 px-5 text-foreground backdrop-blur md:h-[var(--titlebar-band-height)]">
          <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5">
            <span className="shrink-0 text-sm text-muted-foreground">{title}</span>
            <span aria-hidden className="shrink-0 text-sm text-muted-foreground/50">
              /
            </span>
            <h3 aria-current="page" className="truncate font-heading text-sm font-semibold tracking-tight">
              {activeSection.label}
            </h3>
            {activeSection.scope && (
              <span className="app-no-drag ml-1">
                <ScopeBadge scope={activeSection.scope} />
              </span>
            )}
          </nav>
          <div className="app-no-drag ml-auto flex items-center gap-2">
            {headerActions}
            {restorers.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => {
                  for (const restore of restorers) void restore();
                }}
              >
                <Undo2Icon className="size-3.5" />
                Restore defaults
              </Button>
            )}
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-2xl px-5 py-5">
            <SettingsPaneContext.Provider value={activeSection.id}>
              <SettingsRestoreContext.Provider value={restoreRegistry}>{children}</SettingsRestoreContext.Provider>
            </SettingsPaneContext.Provider>
          </div>
        </div>
      </div>
    </div>
  );
}

function InfoTip({
  info,
  label = "More about this setting",
  attribute = "data-info",
  children,
}: {
  info: ReactNode;
  label?: string;
  attribute?: "data-info" | "data-scope-info";
  children?: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={label}
            {...{ [attribute]: typeof info === "string" ? info : undefined }}
            className="flex shrink-0 items-center gap-1 text-muted-foreground/60 transition-colors hover:text-foreground"
          >
            {children}
            <InfoIcon className="size-3.5" />
          </button>
        }
      />
      <TooltipContent side="top" className="max-w-72 text-xs leading-snug">
        {info}
      </TooltipContent>
    </Tooltip>
  );
}

export type SettingsScope = "mac" | "project" | "browser" | "host";

const SCOPE_LABEL: Record<SettingsScope, string> = {
  mac: "This Mac",
  project: "This project",
  browser: "This browser",
  host: "This host",
};

const SCOPE_INFO: Record<SettingsScope, string> = {
  mac: "Kept by Telar on this Mac, so every window and paired device that uses it sees the same value.",
  project: "Kept with the selected project. Other projects keep their own.",
  browser: "Kept in this window's own storage. Another browser, or a phone, keeps its own.",
  host: "Kept by the Mac this window is connected to, not the one in front of you.",
};

function ScopeBadge({ scope }: { scope: SettingsScope }) {
  return (
    <InfoTip info={SCOPE_INFO[scope]} label={`Scope: ${SCOPE_LABEL[scope]}`} attribute="data-scope-info">
      <span data-scope={scope} className="text-2xs font-medium tracking-wide text-muted-foreground uppercase">
        {SCOPE_LABEL[scope]}
      </span>
    </InfoTip>
  );
}

export function SettingsGroup({
  title,
  description,
  action,
  scope,
  children,
}: {
  title?: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  scope?: SettingsScope;
  children: ReactNode;
}) {
  return (
    <section className="mb-6 last:mb-0">
      {(title || description || action || scope) && (
        <div className="mb-2 flex items-start gap-3 px-4">
          <div className="min-w-0 flex-1">
            {(title || scope) && (
              <div className="flex items-center gap-2">
                {title && <h4 className="font-heading text-xs-plus font-semibold tracking-tight text-foreground">{title}</h4>}
                {scope && <ScopeBadge scope={scope} />}
              </div>
            )}
            {description && <p className="mt-1 text-xs text-muted-foreground">{description}</p>}
          </div>
          {action && <div className="shrink-0">{action}</div>}
        </div>
      )}
      <div className="divide-y divide-border/60 rounded-xl border border-border bg-card shadow-1 [&>*]:px-4">
        <SettingsGroupContext.Provider value={typeof title === "string" ? title : undefined}>{children}</SettingsGroupContext.Provider>
      </div>
    </section>
  );
}

export function Row({
  id,
  label,
  hint,
  info,
  icon: Icon,
  status,
  control,
  onRevert,
  error,
  unavailable,
  children,
}: {
  id?: string;
  label: ReactNode;
  hint?: ReactNode;
  info?: ReactNode;
  icon?: ComponentType<{ className?: string }>;
  status?: ReactNode;
  control?: ReactNode;
  onRevert?: () => void;
  error?: ReactNode;
  unavailable?: { reason: ReactNode };
  children?: ReactNode;
}) {
  const page = useContext(SettingsPaneContext);
  const group = useContext(SettingsGroupContext);
  const anchor =
    id ??
    (typeof label === "string"
      ? settingsRowId({ ...(page ? { page } : {}), ...(group ? { group } : {}), label })
      : undefined);
  const explanation = unavailable ? unavailable.reason : hint;

  return (
    <div
      {...(anchor ? { id: anchor } : {})}
      tabIndex={-1}
      className="flex flex-wrap items-start gap-x-4 gap-y-2 py-3 outline-none">
      <div className="flex min-w-48 flex-1 items-start gap-2.5">
        {Icon && (
          <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center text-muted-foreground/70">
            <Icon className="size-4" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium text-foreground">{label}</span>
            {info && <InfoTip info={info} />}
            {status && <span className="shrink-0">{status}</span>}
            <span className="flex size-3 shrink-0 items-center justify-center">
              {onRevert && (
                <button
                  type="button"
                  title="Back to the default"
                  aria-label="Revert to the default"
                  onClick={onRevert}
                  className="text-muted-foreground/60 transition-colors hover:text-foreground"
                >
                  <Undo2Icon className="size-3" />
                </button>
              )}
            </span>
          </div>
          {explanation && <p className="mt-0.5 text-xs leading-snug text-muted-foreground">{explanation}</p>}
          {error && (
            <p role="alert" className="mt-1 flex items-start gap-1.5 text-xs leading-snug text-destructive">
              <CircleAlertIcon className="mt-px size-3 shrink-0" />
              <span>{error}</span>
            </p>
          )}
          {children}
        </div>
      </div>
      {control && (
        <div
          inert={unavailable ? true : undefined}
          className={cn("flex shrink-0 items-center justify-end", unavailable && "opacity-50")}
        >
          {control}
        </div>
      )}
    </div>
  );
}

export function Dropdown<T extends string>({
  value,
  onChange,
  options,
  className,
  label,
  disabled,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode; text?: string }[];
  className?: string;
  label?: string;
  disabled?: boolean;
}) {
  const chosen = options.find((option) => option.value === value);
  return (
    <Select value={value} onValueChange={(next) => typeof next === "string" && onChange(next as T)} disabled={disabled}>
      <SelectTrigger size="sm" className={cn("w-44", className)} {...(label ? { "aria-label": label } : {})}>
        <SelectValue>{chosen?.text ?? chosen?.label ?? value}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode }[];
}) {
  return (
    <div className="inline-flex items-center rounded-md border border-border">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            className={cn(
              "flex items-center gap-1.5 px-2.5 py-1 text-xs transition-colors first:rounded-l-[5px] last:rounded-r-[5px] not-first:border-l not-first:border-border",
              on ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode }[];
}) {
  return (
    <div role="tablist" className="flex items-center gap-4 border-b border-border">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(o.value)}
            className={cn(
              "-mb-px flex items-center gap-1.5 border-b-2 px-0.5 pb-2 text-sm transition-colors",
              on ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function ToggleRow({
  id,
  label,
  hint,
  icon,
  status,
  checked,
  onCheckedChange,
  onRevert,
  error,
  unavailable,
  info,
}: {
  id?: string;
  label: ReactNode;
  hint?: ReactNode;
  info?: ReactNode;
  icon?: ComponentType<{ className?: string }>;
  status?: ReactNode;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  onRevert?: () => void;
  error?: ReactNode;
  unavailable?: { reason: ReactNode };
}) {
  return (
    <Row
      {...(id ? { id } : {})}
      label={label}
      hint={hint}
      icon={icon}
      {...(status ? { status } : {})}
      {...(onRevert ? { onRevert } : {})}
      {...(error ? { error } : {})}
      {...(unavailable ? { unavailable } : {})}
      {...(info ? { info } : {})}
      control={<Switch checked={checked} onCheckedChange={onCheckedChange} />}
    />
  );
}

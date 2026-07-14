"use client";

// Shared settings frame for the settings lane. Both the General and Project
// redesigns render through this so they read as one system: a fixed side-nav
// (no page scroll — the point of concern 4/5) and an internally-scrolling
// content pane with a sticky sub-header + Save affordance. Dark + light via
// theme tokens only; nothing hard-codes a palette.
import type { ComponentType, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";

export type SettingsSection = {
  id: string;
  label: string;
  icon: ComponentType<{ className?: string }>;
  count?: number;
  group?: string; // optional side-nav grouping header
};

export function SettingsShell({
  title,
  subtitle,
  sections,
  active,
  onSelect,
  dirty,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  sections: SettingsSection[];
  active: string;
  onSelect: (id: string) => void;
  dirty?: boolean;
  children: ReactNode;
}) {
  const activeSection = sections.find((s) => s.id === active) ?? sections[0];
  const ActiveIcon = activeSection.icon;

  // Group the nav if any section declares a group; otherwise flat.
  const groups = sections.some((s) => s.group)
    ? Array.from(new Set(sections.map((s) => s.group ?? ""))).map((g) => ({
        group: g,
        items: sections.filter((s) => (s.group ?? "") === g),
      }))
    : [{ group: "", items: sections }];

  return (
    <div className="flex h-full min-h-[560px] bg-background">
      {/* Side-nav — fixed, never scrolls the shell */}
      <nav className="flex w-60 shrink-0 flex-col gap-4 overflow-y-auto border-r border-border bg-sidebar/40 p-3">
        <div className="px-2 pt-1">
          <h2 className="font-heading text-sm font-semibold tracking-tight">{title}</h2>
          {subtitle && <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>}
        </div>
        <div className="flex flex-col gap-4">
          {groups.map(({ group, items }) => (
            <div key={group} className="flex flex-col gap-0.5">
              {group && (
                <div className="px-2 pb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/60">
                  {group}
                </div>
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
                      on
                        ? "bg-muted font-medium text-foreground"
                        : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                    )}
                  >
                    <Icon
                      className={cn(
                        "size-4 shrink-0",
                        on ? "text-foreground" : "text-muted-foreground/70",
                      )}
                    />
                    <span className="flex-1 truncate">{s.label}</span>
                    {s.count != null && (
                      <span className="text-[11px] tabular-nums text-muted-foreground/60">
                        {s.count}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </nav>

      {/* Content pane — sticky header + internal scroll */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-10 flex min-h-13 shrink-0 items-center gap-2.5 border-b border-border bg-background/80 px-5 py-2 backdrop-blur">
          <ActiveIcon className="size-4 text-muted-foreground" />
          <h3 className="font-heading text-sm font-semibold tracking-tight">
            {activeSection.label}
          </h3>
          <div className="ml-auto flex items-center gap-2">
            {dirty && (
              <Badge variant="outline" className="gap-1.5 text-[10px]">
                <span className="size-1.5 rounded-full bg-amber-500" />
                Unsaved
              </Badge>
            )}
            <Button size="sm" variant={dirty ? "default" : "outline"} disabled={!dirty}>
              Save changes
            </Button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-2xl px-5 py-5">{children}</div>
        </div>
      </div>
    </div>
  );
}

// A titled block of setting rows inside the content pane.
export function SettingsGroup({
  title,
  description,
  children,
}: {
  title?: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="mb-6 last:mb-0">
      {(title || description) && (
        <div className="mb-2.5">
          {title && <h4 className="text-sm font-medium">{title}</h4>}
          {description && (
            <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          )}
        </div>
      )}
      <div className="divide-y divide-border overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
        {children}
      </div>
    </section>
  );
}

// One dense row: label + hint on the left, a control on the right. This is the
// unit that kills the long-scroll form — related controls stack tightly instead
// of each owning a full Card+header block.
export function Row({
  label,
  hint,
  icon: Icon,
  control,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  icon?: ComponentType<{ className?: string }>;
  control?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-4 px-4 py-3">
      {Icon && <Icon className="size-4 shrink-0 text-muted-foreground/70" />}
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
        {children}
      </div>
      {control && <div className="shrink-0">{control}</div>}
    </div>
  );
}

// Labelled toggle row — the Auto Mode / notifications workhorse.
export function ToggleRow({
  label,
  hint,
  icon,
  checked,
  onCheckedChange,
}: {
  label: ReactNode;
  hint?: ReactNode;
  icon?: ComponentType<{ className?: string }>;
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
}) {
  return (
    <Row
      label={label}
      hint={hint}
      icon={icon}
      control={<Switch checked={checked} onCheckedChange={onCheckedChange} />}
    />
  );
}

// Segmented control — theme / effort / density pickers. Reads like the app's
// button-group idiom but self-contained.
export function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="inline-flex items-center rounded-lg border border-border bg-muted/40 p-0.5">
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={cn(
              "rounded-[7px] px-2.5 py-1 text-xs font-medium transition-colors",
              on
                ? "bg-background text-foreground shadow-sm ring-1 ring-foreground/10"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

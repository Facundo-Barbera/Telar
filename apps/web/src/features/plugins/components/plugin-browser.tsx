"use client";

import { useEffect, useState, type ComponentType, type ReactNode } from "react";
import { ArrowLeftIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@/ui/button";
import { Row, SettingsGroup, usePendingReveal } from "@/features/settings";

export type PluginListItem = {
  id: string;
  name: string;
  icon: ComponentType<{ className?: string }>;
  hint?: ReactNode;
  control: ReactNode;
  unavailable?: ReactNode;
  status?: ReactNode;
  page?: ReactNode;
};

export function PluginBrowser({
  title,
  description,
  items,
  empty,
  footer,
}: {
  title: string;
  description: ReactNode;
  items: readonly PluginListItem[];
  empty: ReactNode;
  footer?: ReactNode;
}) {
  const [open, setOpen] = useState<string>();
  const pending = usePendingReveal();
  const shown = items.find((item) => item.id === open && item.page !== undefined);

  useEffect(() => {
    if (!pending) return;
    const holder = document.getElementById(pending)?.closest<HTMLElement>("[data-plugin-page]");
    if (!holder) return;
    const task = window.setTimeout(() => setOpen(holder.dataset.pluginPage || undefined), 0);
    return () => window.clearTimeout(task);
  });

  return (
    <>
      <div data-plugin-page="" hidden={shown !== undefined} className="mb-6 last:mb-0">
        <SettingsGroup title={title} description={description}>
          {items.length === 0 && empty}
          {items.map((item) => (
            <Row
              key={item.id}
              icon={item.icon}
              label={
                item.page === undefined ? (
                  item.name
                ) : (
                  <button
                    type="button"
                    onClick={() => setOpen(item.id)}
                    aria-label={`Open ${item.name}`}
                    className="inline-flex items-center gap-1 rounded-sm hover:underline hover:underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {item.name}
                    <ChevronRightIcon className="size-3.5 text-muted-foreground" />
                  </button>
                )
              }
              hint={item.hint}
              {...(item.status ? { status: item.status } : {})}
              {...(item.unavailable ? { unavailable: { reason: item.unavailable } } : {})}
              control={item.control}
            />
          ))}
          {footer}
        </SettingsGroup>
      </div>
      {items.map(
        (item) =>
          item.page !== undefined && (
            <div key={item.id} data-plugin-page={item.id} hidden={shown?.id !== item.id} className="mb-6 last:mb-0">
              <Button variant="ghost" size="sm" className="mb-3 -ml-2" onClick={() => setOpen(undefined)}>
                <ArrowLeftIcon />
                {title}
              </Button>
              {item.page}
            </div>
          ),
      )}
    </>
  );
}

export function NothingToConfigure({ hint }: { hint: string }) {
  return <p className="py-3 text-xs text-muted-foreground">Nothing to configure. {hint}</p>;
}

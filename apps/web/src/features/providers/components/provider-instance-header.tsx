"use client";

import { ArrowUpCircleIcon, Trash2Icon } from "lucide-react";
import type { ProviderInstance, ProviderProbe } from "@telar/engine-client";
import { cn } from "@/ui/utils";
import { Badge } from "@/ui/badge";
import { Button } from "@/ui/button";
import { displayNameOf, DRIVER_LABEL, isDefaultInstance, providerSummary, STATUS_DOT, STATUS_LABEL, updateAdvisory, versionLabel } from "../provider-instances";
import { ProviderIcon } from "./provider-icon";

export function ProviderInstanceHeader({
  instance,
  probe,
  onRemove,
}: {
  instance: ProviderInstance;
  probe?: ProviderProbe | undefined;
  onRemove?: (() => void) | undefined;
}) {
  const title = displayNameOf(instance);
  const status = instanceStatus(instance, probe);
  const summary = providerSummary(probe);
  const version = versionLabel(probe?.version);
  const isDefault = isDefaultInstance(instance);
  const advisory = updateAdvisory(probe, DRIVER_LABEL[instance.driver]);

  return (
    <div className="px-3 py-3 sm:px-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <ProviderMark instance={instance} status={status} />
            <h3 className="truncate text-sm font-medium text-foreground">{title}</h3>
            {title !== instance.id && (
              <code className="truncate rounded bg-muted/60 px-1 py-0.5 text-3xs text-muted-foreground">{instance.id}</code>
            )}
            {version && <code className="text-xs text-muted-foreground">{version}</code>}
            {advisory && (
              <span title={advisory.headline} aria-label={`${advisory.headline} — ${title}`} className="inline-flex items-center text-warning">
                <ArrowUpCircleIcon className="size-3.5" />
              </span>
            )}
            {isDefault && (
              <Badge variant="outline" className="text-3xs" title="The provider's base login, detected rather than added">
                built-in
              </Badge>
            )}
            {summary && (
              <Badge variant={status === "error" ? "destructive" : "outline"} className="text-3xs">
                {summary}
              </Badge>
            )}
          </div>
        </div>
        <div className="flex w-full shrink-0 items-center gap-1 sm:w-auto sm:justify-end">
          {onRemove && (
            <Button
              variant="ghost"
              size="icon-sm"
              className="size-7 text-muted-foreground hover:text-destructive"
              title="Forget how this login was configured. Its login on disk is left untouched, and sessions fall back to the built-in slot."
              onClick={onRemove}
              aria-label={`Remove ${title}`}
            >
              <Trash2Icon className="size-3.5" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

export function instanceStatus(instance: ProviderInstance, probe: ProviderProbe | undefined): ProviderProbe["status"] {
  return probe?.status ?? (instance.enabled ? "warning" : "disabled");
}

export function ProviderMark({ instance, status }: { instance: ProviderInstance; status: ProviderProbe["status"] }) {
  return (
    <span className="relative inline-flex size-5 shrink-0 items-center justify-center">
      <span
        className="flex size-5 items-center justify-center rounded-[5px] ring-1 ring-inset ring-border/60"
        style={
          instance.accentColor
            ? {
                backgroundColor: `color-mix(in srgb, ${instance.accentColor} 22%, transparent)`,
                boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${instance.accentColor} 55%, transparent)`,
              }
            : undefined
        }
      >
        <ProviderIcon provider={instance.driver} size={13} />
      </span>
      <span
        title={STATUS_LABEL[status]}
        aria-label={`Status: ${STATUS_LABEL[status]}`}
        className={cn("pointer-events-none absolute -left-0.5 -top-0.5 size-2 rounded-full ring-2 ring-card", STATUS_DOT[status])}
      />
    </span>
  );
}

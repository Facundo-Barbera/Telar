"use client";

import { CheckIcon, StarIcon } from "lucide-react";
import type { ProviderDriverKind } from "@telar/engine-client";
import type { ModelFamily } from "@/lib/model-families";
import { connectionLabel, routeOf, routedModelLabel } from "@/lib/model-connections";
import { PROVIDER_LABEL } from "@/components/session/provider-icon";
import { ModelRowIcon } from "@/components/session/connection-icon";
import { cn } from "@/lib/utils";

/** One model family: its name, then the harness and connection serving it, since one model can be reached through several. */
export function FamilyRow({
  family,
  driver,
  selected,
  starred,
  readOnly,
  onSelect,
  onStar,
}: {
  family: ModelFamily;
  driver: ProviderDriverKind;
  selected: boolean;
  starred: boolean;
  readOnly: boolean;
  onSelect: () => void;
  onStar: () => void;
}) {
  const route = routeOf(family.id);
  const label = route ? routedModelLabel(route.model) : family.label;
  const origin = route ? `${PROVIDER_LABEL[driver]} · ${connectionLabel(route.connection)}` : PROVIDER_LABEL[driver];
  return (
    <div className="group/model flex items-center gap-0.5">
      <button
        type="button"
        data-model-row
        disabled={readOnly}
        onClick={onSelect}
        title={family.rows.map((row) => row.id).join("\n")}
        className={cn(
          "flex min-w-0 flex-1 items-center gap-2.5 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors",
          selected ? "bg-accent" : "hover:bg-accent/60",
          readOnly && "cursor-default opacity-60",
        )}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="truncate leading-tight">{label}</span>
          <span className="flex min-w-0 items-center gap-1 text-3xs leading-tight text-muted-foreground">
            <ModelRowIcon driver={driver} modelId={family.id} size={11} className="shrink-0" />
            <span className="truncate">{origin}</span>
          </span>
        </span>
        {family.badge === "new" && <span className="shrink-0 rounded-sm border px-1 text-3xs text-muted-foreground">New</span>}
        {family.isDefault && <span className="shrink-0 text-3xs text-muted-foreground">Default</span>}
        <span className="flex size-3.5 shrink-0 items-center justify-center">
          {selected && <CheckIcon className="size-3.5 text-primary" />}
        </span>
      </button>
      <button
        type="button"
        aria-label={starred ? `Unstar ${label}` : `Star ${label}`}
        title={starred ? "Unstar" : "Star"}
        onClick={onStar}
        className={cn(
          "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-opacity hover:text-foreground",
          starred ? "opacity-100" : "opacity-0 group-hover/model:opacity-60 focus-visible:opacity-100",
        )}
      >
        <StarIcon className={cn("size-3.5", starred && "fill-current text-primary")} />
      </button>
    </div>
  );
}

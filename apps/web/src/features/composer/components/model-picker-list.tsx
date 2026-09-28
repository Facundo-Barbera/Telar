"use client";

import { ChevronRightIcon, SearchIcon, StarIcon } from "lucide-react";
import type { ProviderDriverKind } from "@telar/engine-client";
import type { ModelChoice } from "@/lib/models";
import { ProviderIcon, PROVIDER_LABEL } from "@/components/session/provider-icon";
import { cn } from "@/lib/utils";
import type { ModelPicker } from "../hooks/use-model-picker";
import { PROVIDERS } from "../model-options";
import { CompactRow, MenuHeading } from "./control-primitives";
import { FamilyRow } from "./family-row";

const MODEL_LIST_ID = "telar-model-picker-list";

const railClass = (active: boolean) =>
  cn(
    "flex size-8 items-center justify-center rounded-lg transition-colors",
    active ? "bg-accent text-foreground shadow-1 ring-1 ring-border" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
  );

export function ModelPickerRail({
  picker,
  driver,
  onDriverChange,
}: {
  picker: ModelPicker;
  driver: ProviderDriverKind;
  onDriverChange?: (driver: ProviderDriverKind) => void;
}) {
  return (
    <div className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-border bg-muted/20 p-1.5">
      <button type="button" onClick={() => picker.showView("favorites")} aria-label="Favourites" title="Favourites" className={railClass(picker.view === "favorites")}>
        <StarIcon className={cn("size-4", picker.view === "favorites" && "fill-current text-primary")} />
      </button>
      {PROVIDERS.map((option) => (
        <button
          key={option}
          type="button"
          // Portalled, so outside InputGroup's has-disabled reach. The current provider stays live to leave favourites.
          disabled={!onDriverChange && option !== driver}
          onClick={() => {
            picker.showView(option);
            if (option !== driver) onDriverChange?.(option);
          }}
          aria-label={PROVIDER_LABEL[option]}
          title={onDriverChange || option === driver ? PROVIDER_LABEL[option] : `${PROVIDER_LABEL[option]} — fixed for this session`}
          className={cn(railClass(option === picker.view), "disabled:cursor-default", option !== driver && !onDriverChange && "opacity-40")}
        >
          <ProviderIcon provider={option} size={15} />
        </button>
      ))}
    </div>
  );
}

function SearchField({ picker, driver, canSwitch }: { picker: ModelPicker; driver: ProviderDriverKind; canSwitch: boolean }) {
  return (
    <div className="flex shrink-0 items-center gap-1.5 border-b border-border px-2.5 py-1.5">
      <SearchIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <input
        value={picker.query}
        onChange={(event) => picker.setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            document.getElementById(MODEL_LIST_ID)?.querySelector("button")?.focus();
          }
        }}
        placeholder={canSwitch ? "Search every provider…" : `Search ${PROVIDER_LABEL[driver]} models…`}
        aria-label="Search models by name or connection"
        className="h-6 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground/70"
      />
      {picker.searching && (
        <button type="button" aria-label="Clear search" onClick={() => picker.setQuery("")} className="shrink-0 rounded px-1 text-3xs text-muted-foreground hover:text-foreground">
          clear
        </button>
      )}
    </div>
  );
}

const walkRows = (event: React.KeyboardEvent<HTMLDivElement>) => {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("[data-model-row]")];
  const at = rows.findIndex((row) => row === document.activeElement);
  if (at === -1) return;
  event.preventDefault();
  const next = event.key === "ArrowDown" ? Math.min(at + 1, rows.length - 1) : at - 1;
  if (next < 0) (event.currentTarget.previousElementSibling?.querySelector("input") as HTMLInputElement | null)?.focus();
  else rows[next]?.focus();
};

const Note = ({ children }: { children: React.ReactNode }) => <p className="px-2 py-1.5 text-2xs leading-snug text-muted-foreground">{children}</p>;

export function ModelPickerList({
  picker,
  driver,
  choice,
  readOnly,
  canSwitch,
}: {
  picker: ModelPicker;
  driver: ProviderDriverKind;
  choice: ModelChoice;
  readOnly: boolean;
  canSwitch: boolean;
}) {
  const { searching, view, listed, legacy, models, catalogue, asking } = picker;
  const browsing = view !== "favorites" && !searching;
  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <SearchField picker={picker} driver={driver} canSwitch={canSwitch} />
      <div id={MODEL_LIST_ID} className="min-h-0 flex-1 overflow-y-auto p-1" onKeyDown={walkRows}>
        {!searching && view === "favorites" && <MenuHeading>Favourites</MenuHeading>}
        {listed.map(({ from, family }) => (
          <FamilyRow
            key={`${from}:${family.id}`}
            family={family}
            driver={from}
            selected={from === driver && family.id === picker.selectedFamily?.id}
            starred={picker.favorites.has(family.id)}
            readOnly={readOnly}
            onSelect={() => picker.pickFamily(family, from)}
            onStar={() => picker.starFamily(from, family.id)}
          />
        ))}
        {browsing && legacy.length > 0 && !picker.showLegacy && (
          <button
            type="button"
            onClick={() => picker.setShowLegacy(true)}
            className="flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm text-muted-foreground transition-colors hover:bg-accent/60"
          >
            <span className="min-w-0 flex-1 truncate">Legacy models</span>
            <span className="shrink-0 text-3xs">{legacy.length}</span>
            <ChevronRightIcon className="size-3.5 shrink-0" />
          </button>
        )}
        {browsing && choice.model && models.length > 0 && !picker.selectedFamily && (
          <CompactRow label={choice.model} hint="external" selected disabled onSelect={() => undefined} />
        )}
        {asking && <p className="px-2 py-1.5 text-2xs text-muted-foreground">Asking {PROVIDER_LABEL[asking]}…</p>}
        {searching && listed.length === 0 && (
          <Note>
            Nothing matches “{picker.query.trim()}”
            {picker.crossProvider ? " on any provider" : ` in ${PROVIDER_LABEL[driver]}, the provider this session is fixed to`} — names, ids and connections are searched.
          </Note>
        )}
        {view === "favorites" && !asking && !searching && listed.length === 0 && <Note>Star a model to keep it here.</Note>}
        {browsing && catalogue && models.length === 0 && <Note>{catalogue.message ?? `${PROVIDER_LABEL[driver]} did not report any models.`}</Note>}
      </div>
    </div>
  );
}

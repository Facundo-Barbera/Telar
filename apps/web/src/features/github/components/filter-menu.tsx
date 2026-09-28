"use client";

import { ListFilterIcon, MilestoneIcon, TagIcon, UserRoundIcon, XIcon } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { filterChips } from "@/lib/github-forge";
import type { GitHubList } from "../hooks/use-github-list";
import { STATES, type ForgeFilter, type ForgeListKind } from "../model";

/** Loading and empty are different: an empty submenu mid-read would claim the repository has none. */
function FacetList({ loading, empty, children }: { loading: boolean; empty: string; children?: React.ReactNode }) {
  const has = Array.isArray(children) ? children.some(Boolean) : Boolean(children);
  if (loading && !has) {
    return (
      <p className="flex items-center gap-2 px-2 py-1.5 text-2xs text-muted-foreground">
        <Spinner className="size-3" /> asking gh…
      </p>
    );
  }
  if (!has) return <p className="px-2 py-1.5 text-2xs leading-snug text-muted-foreground">{empty}</p>;
  return <>{children}</>;
}

function MilestoneMenu({ list }: { list: GitHubList }) {
  const { filter, facets, loadingFacets, choose } = list;
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <MilestoneIcon />
        <span className="flex-1 truncate">Milestone</span>
        <span className="max-w-24 truncate text-muted-foreground">{filter.milestone ?? "any"}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-56">
        <FacetList loading={loadingFacets} empty="This repository has no milestones.">
          {facets?.milestones.length ? (
            <DropdownMenuRadioGroup value={filter.milestone ?? ""} onValueChange={(next) => choose({ milestone: next || undefined })}>
              <DropdownMenuRadioItem value="">Any milestone</DropdownMenuRadioItem>
              {facets.milestones.map((milestone) => (
                <DropdownMenuRadioItem key={milestone.title} value={milestone.title}>
                  <span className="flex-1 truncate">{milestone.title}</span>
                  <span className="ml-1 shrink-0 font-mono text-4xs text-muted-foreground tabular-nums">{milestone.open}</span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          ) : null}
        </FacetList>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function AssigneeMenu({ list }: { list: GitHubList }) {
  const { filter, facets, loadingFacets, choose } = list;
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <UserRoundIcon />
        <span className="flex-1 truncate">Assignee</span>
        <span className="max-w-24 truncate text-muted-foreground">{filter.assignee ?? "anyone"}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-56">
        <FacetList loading={loadingFacets} empty="No assignees to choose from.">
          <DropdownMenuRadioGroup value={filter.assignee ?? ""} onValueChange={(next) => choose({ assignee: next || undefined })}>
            <DropdownMenuRadioItem value="">Anyone</DropdownMenuRadioItem>
            {facets?.viewer && <DropdownMenuRadioItem value={facets.viewer}>{facets.viewer} · me</DropdownMenuRadioItem>}
            {(facets?.assignees ?? [])
              .filter((login) => login !== facets?.viewer)
              .map((login) => (
                <DropdownMenuRadioItem key={login} value={login}>
                  <span className="truncate">{login}</span>
                </DropdownMenuRadioItem>
              ))}
          </DropdownMenuRadioGroup>
        </FacetList>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

function LabelsMenu({ list }: { list: GitHubList }) {
  const { filter, facets, loadingFacets, toggleLabel } = list;
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <TagIcon />
        <span className="flex-1 truncate">Labels</span>
        <span className="shrink-0 text-muted-foreground">{filter.labels.length > 0 ? filter.labels.length : "any"}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-72 w-56 overflow-y-auto">
        <FacetList loading={loadingFacets} empty="This repository has no labels.">
          {(facets?.labels ?? []).map((entry) => (
            <DropdownMenuCheckboxItem
              key={entry.name}
              checked={filter.labels.includes(entry.name)}
              onCheckedChange={() => toggleLabel(entry.name)}
              closeOnClick={false}
            >
              <span className="truncate">{entry.name}</span>
            </DropdownMenuCheckboxItem>
          ))}
        </FacetList>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/** Every narrowing in one menu; opening it is what fetches the facets. */
export function FilterMenu({ kind, label, list }: { kind: ForgeListKind; label: string; list: GitHubList }) {
  const { filter, openFacets, choose, clearFilters } = list;
  const options = STATES[kind];
  const chosen = options.find((entry) => entry.id === filter.state) ?? options[0];
  const chips = filterChips(filter);
  return (
    <DropdownMenu onOpenChange={openFacets}>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            aria-label={`Filter ${label}`}
            title={`Filter ${label}`}
            className="flex shrink-0 items-center gap-1 rounded px-1 py-0.5 transition-colors hover:bg-muted hover:text-foreground"
          />
        }
      >
        <ListFilterIcon className="size-3" />
        <span>{chosen.label}</span>
        {chips.length > 0 && <span className="rounded-full bg-primary/15 px-1 font-mono text-4xs leading-4 text-primary">{chips.length}</span>}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Show</DropdownMenuLabel>
          <DropdownMenuRadioGroup value={filter.state} onValueChange={(next) => choose({ state: next as ForgeFilter["state"] })}>
            {options.map((option) => (
              <DropdownMenuRadioItem key={option.id} value={option.id}>
                {option.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {kind === "issues" && <MilestoneMenu list={list} />}
        <AssigneeMenu list={list} />
        <LabelsMenu list={list} />
        {chips.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={clearFilters}>
              <XIcon />
              Clear filters
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

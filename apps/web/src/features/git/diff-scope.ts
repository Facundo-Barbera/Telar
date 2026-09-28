
import type { DiffBaseOption } from "@telar/engine-client";
import type { PanelTabParams } from "@/features/panel/index";

export type DiffScopeKind = "unstaged" | "branch" | "turn";

export type DiffTab = {
  kind: DiffScopeKind;
  base?: string;
  turn?: string;
  filter?: string;
};

export const DEFAULT_DIFF_TAB: DiffTab = { kind: "unstaged" };

const KIND_KEY = "scope";
const BASE_KEY = "base";
const TURN_KEY = "turn";
const FILTER_KEY = "filter";

function scopeKind(value: string | undefined): DiffScopeKind {
  return value === "branch" || value === "turn" ? value : "unstaged";
}

export function readDiffTab(params: PanelTabParams): DiffTab {
  const base = (params[BASE_KEY] ?? "").trim();
  const turn = (params[TURN_KEY] ?? "").trim();
  const filter = params[FILTER_KEY] ?? "";
  return {
    kind: scopeKind(params[KIND_KEY]),
    ...(base ? { base } : {}),
    ...(turn ? { turn } : {}),
    ...(filter.trim() ? { filter } : {}),
  };
}

export function diffTabParams(tab: DiffTab): PanelTabParams {
  return {
    ...(tab.kind === "unstaged" ? {} : { [KIND_KEY]: tab.kind }),
    ...(tab.base?.trim() ? { [BASE_KEY]: tab.base.trim() } : {}),
    ...(tab.turn?.trim() ? { [TURN_KEY]: tab.turn.trim() } : {}),
    ...(tab.filter?.trim() ? { [FILTER_KEY]: tab.filter } : {}),
  };
}

export function diffBaseFor(tab: DiffTab, anchor?: TurnAnchor): DiffBaseOption | undefined {
  if (tab.kind === "unstaged") return { base: null };
  if (tab.kind === "turn") {
    if (!anchor?.before || !anchor.after) return undefined;
    return { base: anchor.before, to: anchor.after };
  }
  return tab.base?.trim() ? { base: tab.base.trim() } : {};
}

export type TurnAnchor = { before?: string; after?: string; read?: "timeout" | "failed" };

export function scopesFor(hasSession: boolean): readonly DiffScopeKind[] {
  return hasSession ? ["unstaged", "branch", "turn"] : ["unstaged", "branch"];
}

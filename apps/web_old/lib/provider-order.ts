// How the Providers list is ORDERED. Pure — no React, no fetch — because the
// ordering is the part that is easy to get quietly wrong and impossible to
// eyeball: with five accounts across two providers, three health states and an
// on/off switch, "did the list actually sort the way the control says" is a
// question only a test can answer honestly.
//
// ONE RULE OUTRANKS THE MODE. A switched-off account is not a peer of a working
// one — it cannot run a session, so it does not compete for the reader's
// attention. When `disabledLast` is on (the default) it sinks below every
// enabled row no matter which mode is selected, and the mode then orders each
// group internally. That is why the enabled key is applied first and the mode
// comparator second, rather than the mode owning the whole comparison.

// What the comparator needs from an account. Deliberately structural rather
// than importing AccountWire: this module is about ORDER, and narrowing the
// input to the four fields order actually reads keeps it testable without
// building a whole wire record for every case.
export type OrderableAccount = {
  name: string;
  displayName?: string;
  provider?: "claude" | "codex";
  enabled?: boolean;
  isMain?: boolean;
  health?: { status?: string } | null;
};

export type ProviderSort = "provider" | "name" | "status";

export const PROVIDER_SORTS: readonly ProviderSort[] = ["provider", "name", "status"] as const;

export const PROVIDER_SORT_LABELS: Record<ProviderSort, string> = {
  provider: "Provider",
  name: "Name",
  status: "Status",
};

export const isProviderSort = (v: unknown): v is ProviderSort =>
  typeof v === "string" && (PROVIDER_SORTS as readonly string[]).includes(v);

// The label a row actually shows, which is what "sort by name" has to mean —
// sorting by the registry key would order the list by a string the user may
// never see (a row titled "Work" whose key is `cc-ozom` sorts under C).
const titleOf = (a: OrderableAccount): string => a.displayName?.trim() || a.name;

const isEnabled = (a: OrderableAccount): boolean => a.enabled !== false;

// PROBLEMS FIRST, and the ranking says why rather than encoding a mood:
// a row that needs a terminal command before it can do anything is the only
// row whose position is actionable, so it leads. "Unknown" follows — a keychain
// login Telar cannot prove either way, worth a glance but not a task. A healthy
// row is last because nothing about it needs the reader.
//
// The states are the ones statusDot() in provider-instances.tsx branches on;
// they are kept in step by hand because that function also folds in the
// PROVIDER's installed flag, which order deliberately ignores (a missing CLI is
// a property of the machine, and sorting by it would scatter one provider's
// accounts through the other's).
function healthRank(a: OrderableAccount): number {
  switch (a.health?.status) {
    case "never-logged-in":
    case "missing-config-dir":
      return 0;
    case "ok":
      return 2;
    default:
      return 1; // "unknown" — present but unproven
  }
}

// Claude before Codex. Not alphabetical by accident: Claude is the provider
// Telar detects on its own and the one multi-account works for, so its rows are
// the ones a reader is looking for.
const providerRank = (a: OrderableAccount): number => ((a.provider ?? "claude") === "claude" ? 0 : 1);

function byMode(a: OrderableAccount, b: OrderableAccount, sort: ProviderSort): number {
  if (sort === "name") return titleOf(a).localeCompare(titleOf(b));
  if (sort === "status") {
    const d = healthRank(a) - healthRank(b);
    if (d !== 0) return d;
    return titleOf(a).localeCompare(titleOf(b));
  }
  // "provider": the original grouping — provider, then the detected base login
  // ahead of the folders pointed at by hand, then the registry key.
  const p = providerRank(a) - providerRank(b);
  if (p !== 0) return p;
  if (Boolean(a.isMain) !== Boolean(b.isMain)) return a.isMain ? -1 : 1;
  return a.name.localeCompare(b.name);
}

export function compareAccounts(
  a: OrderableAccount,
  b: OrderableAccount,
  sort: ProviderSort,
  disabledLast: boolean,
): number {
  if (disabledLast && isEnabled(a) !== isEnabled(b)) return isEnabled(a) ? -1 : 1;
  return byMode(a, b, sort);
}

// Sorts a COPY — the caller's array is state and must not be mutated in place.
export function orderAccounts<T extends OrderableAccount>(
  accounts: readonly T[],
  sort: ProviderSort,
  disabledLast: boolean,
): T[] {
  return [...accounts].sort((a, b) => compareAccounts(a, b, sort, disabledLast));
}

// Where the disabled group starts, or -1 when there is no boundary to draw.
// Returns -1 when the flag is off, when nothing is disabled, and — the case
// worth naming — when EVERYTHING is disabled: a divider at index 0 would label
// the whole list rather than separate anything.
export function disabledBoundary(
  ordered: readonly OrderableAccount[],
  disabledLast: boolean,
): number {
  if (!disabledLast) return -1;
  const i = ordered.findIndex((a) => !isEnabled(a));
  return i > 0 ? i : -1;
}

import type { AccountProfile, ProviderId } from "@telar/core";

type AccountVisibility = Pick<AccountProfile, "enabled" | "provider"> & {
  runtimeRouted?: boolean;
  available?: boolean;
};

/** Accounts that can own a brand-new harness session. */
export function sessionAccounts<T extends AccountVisibility>(accounts: readonly T[]): T[] {
  return accounts.filter(
    (account) => account.enabled !== false && account.available !== false,
  );
}

/** Providers that have at least one account capable of starting a session. */
export function sessionProviders(accounts: readonly AccountVisibility[]): ProviderId[] {
  const present = new Set(sessionAccounts(accounts).map((account) => account.provider ?? "claude"));
  return (["claude", "codex"] as const).filter((provider) => present.has(provider));
}

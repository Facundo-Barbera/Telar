"use client";

import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { AccountProfile } from "@telar/core";
import { cachedJson } from "@/lib/client-json-cache";
import { sessionAccounts } from "@/lib/account-visibility";
import { refreshIncludes, TELAR_REFRESH_EVENT } from "@/lib/telar-refresh";

export type AccountClientProfile = AccountProfile & {
  runtimeRouted?: boolean;
  available?: boolean;
};
export type AccountsEnvelope = { accounts?: AccountClientProfile[]; default?: string };
type AccountsStore = {
  accounts: AccountClientProfile[];
  allAccounts: AccountClientProfile[];
  defaultAccount: string;
  reload: (force?: boolean) => Promise<void>;
};

const AccountsContext = createContext<AccountsStore | null>(null);

function useAccountStore(initial?: AccountsEnvelope, disabled = false): AccountsStore {
  const [allAccounts, setAllAccounts] = useState<AccountClientProfile[]>(initial?.accounts ?? []);
  const [defaultAccount, setDefaultAccount] = useState<string>(initial?.default ?? "personal");

  const reload = useCallback(async (force = true) => {
    if (disabled) return;
    try {
      const data = await cachedJson<AccountsEnvelope>("/api/accounts", {
        maxAgeMs: 60_000,
        force,
      });
      setAllAccounts(data.accounts ?? []);
      setDefaultAccount(data.default ?? "personal");
    } catch {
      // Best effort. The server seed remains usable if a refresh fails.
    }
  }, [disabled]);

  useEffect(() => {
    if (disabled || initial) return;
    queueMicrotask(() => void reload(false));
  }, [disabled, initial, reload]);

  return useMemo(
    () => ({
      accounts: sessionAccounts(allAccounts),
      allAccounts,
      defaultAccount,
      reload,
    }),
    [allAccounts, defaultAccount, reload],
  );
}

export function AccountsProvider({
  initial,
  children,
}: {
  initial: AccountsEnvelope;
  children: ReactNode;
}) {
  const store = useAccountStore(initial);

  useEffect(() => {
    const onRefresh = (event: Event) => {
      if (refreshIncludes(event, "accounts")) void store.reload();
    };
    window.addEventListener(TELAR_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(TELAR_REFRESH_EVENT, onRefresh);
  }, [store.reload]);

  return createElement(AccountsContext.Provider, { value: store }, children);
}

// Client-side mirror of the account registry, fetched from /api/accounts.
// `import type` is erased at build time, so pulling AccountProfile from the
// server-only @telar/core package here carries no runtime code.
//
// `accounts` EXCLUDES accounts switched off in settings — that switch means
// "keep this configured but don't offer it", so a picker built on this hook
// must not list it. `allAccounts` keeps the unfiltered list for surfaces that
// genuinely need it. The Providers settings surface does its own fetch, since
// it is the one place that must see the disabled ones.
export function useAccounts(initial?: AccountsEnvelope) {
  const context = useContext(AccountsContext);
  // Keep a standalone store for isolated component tests and embeds, but turn
  // off its fetch whenever the app-level provider is present. This preserves
  // hook ordering while ensuring the whole app shares one seeded registry.
  const standalone = useAccountStore(initial, Boolean(context));
  return context ?? standalone;
}

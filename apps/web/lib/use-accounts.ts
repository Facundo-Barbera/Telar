"use client";

import { useCallback, useEffect, useState } from "react";
import type { AccountProfile } from "@telar/core";

// Client-side mirror of the account registry, fetched from /api/accounts.
// `import type` is erased at build time, so pulling AccountProfile from the
// server-only @telar/core package here carries no runtime code.
//
// `accounts` EXCLUDES accounts switched off in settings — that switch means
// "keep this configured but don't offer it", so a picker built on this hook
// must not list it. `allAccounts` keeps the unfiltered list for surfaces that
// genuinely need it. The Providers settings surface does its own fetch, since
// it is the one place that must see the disabled ones.
export function useAccounts() {
  const [allAccounts, setAllAccounts] = useState<AccountProfile[]>([]);
  const [defaultAccount, setDefaultAccount] = useState<string>("personal");

  const reload = useCallback(async () => {
    try {
      const r = await fetch("/api/accounts");
      if (!r.ok) return;
      const d = await r.json();
      setAllAccounts(d.accounts ?? []);
      setDefaultAccount(d.default ?? "personal");
    } catch {
      // best-effort — an empty list just means the pickers fall back to defaults
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return {
    accounts: allAccounts.filter((a) => a.enabled !== false),
    allAccounts,
    defaultAccount,
    reload,
  };
}

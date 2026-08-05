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
  // HAS THE FETCH ANSWERED — which is not the same question as "are there any
  // accounts". A caller that needs to know whether a session's real provider is
  // knowable yet cannot tell an in-flight request from a registry whose every
  // account is switched off; both look like an empty list, and the difference
  // decides whether "claude" is a guess or the answer. Set on completion
  // whatever the outcome, including a failed request: after that point the list
  // is as good as it is going to get.
  const [loaded, setLoaded] = useState(false);

  const reload = useCallback(async () => {
    try {
      const r = await fetch("/api/accounts");
      if (!r.ok) return;
      const d = await r.json();
      setAllAccounts(d.accounts ?? []);
      setDefaultAccount(d.default ?? "personal");
    } catch {
      // best-effort — an empty list just means the pickers fall back to defaults
    } finally {
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return {
    accounts: allAccounts.filter((a) => a.enabled !== false),
    allAccounts,
    defaultAccount,
    loaded,
    reload,
  };
}

"use client";

import { useCallback, useEffect, useState } from "react";
import type { AccountProfile } from "@telar/core";

// Client-side mirror of the account registry, fetched from /api/accounts.
// `import type` is erased at build time, so pulling AccountProfile from the
// server-only @telar/core package here carries no runtime code.
export function useAccounts() {
  const [accounts, setAccounts] = useState<AccountProfile[]>([]);
  const [defaultAccount, setDefaultAccount] = useState<string>("personal");

  const reload = useCallback(async () => {
    try {
      const r = await fetch("/api/accounts");
      if (!r.ok) return;
      const d = await r.json();
      setAccounts(d.accounts ?? []);
      setDefaultAccount(d.default ?? "personal");
    } catch {
      // best-effort — an empty list just means the pickers fall back to defaults
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { accounts, defaultAccount, reload };
}

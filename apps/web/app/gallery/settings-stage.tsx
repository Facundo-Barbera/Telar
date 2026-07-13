"use client";

import { useEffect } from "react";
import type { GalleryAppEntry } from "@/lib/gallery-fixtures";
import { setActiveScene } from "@/lib/gallery-fixtures";
import { PageHeader } from "@/components/common/page-header";
import { AccountsSettings } from "@/components/settings/accounts-settings";

// Mirrored-wiring stage for the global settings surface. Mirrors the whole render
// body of app/settings/page.tsx:6-14 (PageHeader + AccountsSettings inside an
// h-dvh column) — a 6-line server page with NO @telar/core reads, so the only
// thing to replace is AccountsSettings' self-fetches (/api/accounts, /api/usage),
// which the active scene serves. AccountsSettings is the REAL client component.
export function SettingsStage({ entry }: { entry: GalleryAppEntry }) {
  // Set at render, never cleared on unmount — see AppViewStage for the ordering
  // rationale (the next stage's render wins over the old stage's cleanup).
  setActiveScene(entry.scene);
  useEffect(() => {
    setActiveScene(entry.scene);
  }, [entry.scene]);

  return (
    <div className="flex h-full flex-col">
      <PageHeader title="Settings" description="Accounts, providers, and plan limits." />
      <div className="flex-1 overflow-y-auto">
        <AccountsSettings />
      </div>
    </div>
  );
}

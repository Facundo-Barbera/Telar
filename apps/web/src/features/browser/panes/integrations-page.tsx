"use client";

import { BrowserLoginsSection } from "./browser-logins-section";
import { BrowserProfilesSection } from "./browser-profiles-section";

export function IntegrationsPage() {
  return (
    <>
      <BrowserProfilesSection />
      <BrowserLoginsSection />
    </>
  );
}

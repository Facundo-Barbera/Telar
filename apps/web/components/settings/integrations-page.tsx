"use client";

/**
 * INTEGRATIONS — the accounts and identities Telar itself signs in with.
 *
 * THE TWO GROUPS BELONG TOGETHER, and that is the whole reason this pane exists.
 * A remembered login is a standing authorization scoped to ONE browser profile
 * (see browser-logins-section.tsx); reading it while the profile it names lives on
 * a different screen meant holding a profile list in your head to understand the
 * grant in front of you. Profiles first, then what has been remembered in them.
 * Remembered logins' old pane ids under Agent tools keep answering (see settings-page.tsx).
 */

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

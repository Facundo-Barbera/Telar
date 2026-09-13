"use client";

/**
 * LINKS — where a link in a conversation opens.
 *
 * One switch. Off is the web's own behavior (system browser, new tab); on
 * keeps the reading in the cockpit: issues and pull requests the session
 * mentions open as right-panel tabs, and everything else opens in the
 * session's integrated browser — the tabs the agent can see and act on.
 *
 * Stored per browser (`lib/link-policy.ts`), because the desktop shell has a
 * native browser to open into and a phone does not; this is the one settings
 * row here that is honestly about THIS window.
 */

import { ExternalLinkIcon } from "lucide-react";
import { useLinkPolicy } from "@/lib/link-policy";
import { Switch } from "@/components/ui/switch";
import { Row, SettingsGroup, useRestoreDefaults } from "./settings-shell";

export function LinksSection() {
  const { openInSessionBrowser, setOpenInSessionBrowser } = useLinkPolicy();
  // Off is the web's own behaviour, which is what this row defaults to.
  useRestoreDefaults(() => setOpenInSessionBrowser(false));

  return (
    // The caption asked the question the row's own sentence answers, so it went
    // (#357): one of the two, never both.
    <SettingsGroup title="Links">
      <Row
        label="Open in the session's browser"
        icon={ExternalLinkIcon}
        hint={
          openInSessionBrowser
            ? "Issues and pull requests open in the right panel; other links become tabs the agent can see."
            : "Links open in your system browser."
        }
        {...(openInSessionBrowser ? { onRevert: () => setOpenInSessionBrowser(false) } : {})}
        control={
          <Switch
            checked={openInSessionBrowser}
            onCheckedChange={setOpenInSessionBrowser}
            aria-label="Open links in the session's browser"
          />
        }
      />
    </SettingsGroup>
  );
}

"use client";

import { ExternalLinkIcon } from "lucide-react";
import { useLinkPolicy } from "@/platform/link-policy";
import { Switch } from "@/ui/switch";
import { Row, SettingsGroup, useRestoreDefaults } from "./settings-shell";

export function LinksSection() {
  const { openInSessionBrowser, setOpenInSessionBrowser } = useLinkPolicy();
  useRestoreDefaults(() => setOpenInSessionBrowser(false));

  return (
    <SettingsGroup title="Links" scope="browser">
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

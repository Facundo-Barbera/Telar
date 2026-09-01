"use client";

/**
 * OPENING SETTINGS ON THE PANE THE URL NAMES.
 *
 * WHY THIS EXISTS: a sign-in leaves the app entirely. The user presses Sign in
 * on the MCP pane, the browser goes to a third party's consent screen, and it
 * comes back to `/settings` — which, without this, opens on Appearance. The
 * grant is stored, the flow worked, and the person is looking at a colour
 * scheme picker with no idea whether anything happened. The announcement is
 * worse than absent: it lives in the pane that never mounted, so its query
 * parameter stays in the URL and fires the next time that pane IS opened,
 * announcing a sign-in from an hour ago.
 *
 * Found by pressing the button, not by a test.
 *
 * READ IN A DEFERRED EFFECT rather than as an initial state, because this
 * component renders on the server first: seeding from `window.location` would
 * make the server say "appearance" and the client say "mcp" for the same
 * markup. One frame on the default pane is the honest cost of that.
 */
import { useEffect, useState } from "react";

export function useSectionFromUrl(fallback: string, allowed: readonly string[], aliases?: Readonly<Record<string, string>>): [string, (next: string) => void] {
  const [active, setActive] = useState(fallback);
  useEffect(() => {
    const task = window.setTimeout(() => {
      const raw = new URLSearchParams(window.location.search).get("section");
      // Aliases keep RETIRED ids working: `section=mcp` is baked into the OAuth
      // callback's redirect and into muscle memory, and panes that merged must
      // not turn those links into an empty shell.
      const named = raw ? (aliases?.[raw] ?? raw) : null;
      // Checked against the real list: a section that does not exist would
      // render an empty shell with nothing selected.
      if (named && allowed.includes(named)) setActive(named);
    }, 0);
    return () => window.clearTimeout(task);
    // `allowed` and `aliases` are module-level constants at every call site.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return [active, setActive];
}

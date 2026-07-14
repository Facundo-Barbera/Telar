// LANE: settings — OWNED by the settings redesign lane. Overwrites ONLY this
// file. Demo components live under apps/web/lib/demo-gallery/settings/**.
import type { DemoEntry } from "../registry";
import { GeneralSettingsDemo } from "../settings/general";
import { ProjectSettingsDemo } from "../settings/project";

export const settingsEntries: DemoEntry[] = [
  {
    id: "settings-general",
    title: "General settings — real defaults, sectioned",
    concern: "4",
    summary:
      "Today the top-level Settings page is only the accounts/usage list — no actual settings. This proposes the real ones: Auto Mode DEFAULT ON, default model + reasoning effort + parallel-thread budget, appearance (theme/density/accent), and a focused notifications set gated to the loom's human touch-points. Accounts and Usage are demoted to their own tabs. A fixed side-nav replaces the single scroll so every setting is one click, not a hunt.",
    Component: GeneralSettingsDemo,
  },
  {
    id: "settings-project",
    title: "Project settings — side-nav over the FACTS",
    concern: "4",
    summary:
      "The live project settings stack General → Gates → Guardrails → URLs → MCP → Permissions → Danger in one long max-w-3xl scroll. Here each project FACT becomes a side-nav section (General, Gates & commands, Servers, MCP, Guardrails & env, Danger zone) with a sticky header and Save affordance, so a broken gate or an expiring MCP token is reachable without scrolling past everything else. Interactive: edit gates, reveal env, arm the danger-zone confirm.",
    Component: ProjectSettingsDemo,
  },
];

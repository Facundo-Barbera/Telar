import { BlocksIcon, DownloadIcon, FolderKanbanIcon, GitPullRequestIcon, GlobeIcon, HardDriveIcon, InfoIcon, KeyboardIcon, MicIcon, PaletteIcon, PlugIcon, SlidersHorizontalIcon, SmartphoneIcon, WrenchIcon } from "lucide-react";
import type { PluginStatus } from "@telar/engine-client";
import type { SettingsSearchIndex } from "@/lib/settings-search";
import { pluginSettingsSearchEntries } from "@/lib/plugins/settings-form";
import type { SettingsSection } from "./settings-shell";
import { SETTINGS_SEARCH_INDEX, SETTINGS_SEARCH_PAGES } from "./settings-registry";

// The ids are routes: bookmarks and the OAuth callback (`section=mcp`) name them.
export const SECTIONS: SettingsSection[] = [
  { id: "general", label: "General", icon: SlidersHorizontalIcon, group: "Cockpit" },
  { id: "appearance", label: "Appearance", icon: PaletteIcon, group: "Cockpit", scope: "browser" },
  { id: "keybindings", label: "Keybindings", icon: KeyboardIcon, group: "Cockpit", scope: "browser" },
  { id: "integrations", label: "Browser", icon: GlobeIcon, group: "Cockpit" },
  { id: "dictation", label: "Dictation", icon: MicIcon, group: "Cockpit" },
  { id: "providers", label: "Providers", icon: PlugIcon, group: "Agents", scope: "mac" },
  { id: "tools", label: "Agent tools", icon: WrenchIcon, group: "Agents", scope: "mac" },
  { id: "plugins", label: "Plugins", icon: BlocksIcon, group: "Agents", scope: "mac" },
  { id: "projects", label: "Projects", icon: FolderKanbanIcon, group: "Projects", scope: "project" },
  { id: "remote", label: "Remote access", icon: SmartphoneIcon, group: "This Mac", scope: "mac" },
  { id: "storage", label: "Storage", icon: HardDriveIcon, group: "This Mac", scope: "mac" },
  { id: "about", label: "This build", icon: InfoIcon, group: "About", scope: "mac" },
  { id: "updates", label: "Updates", icon: DownloadIcon, group: "About", scope: "mac" },
  { id: "source-control", label: "Source control", icon: GitPullRequestIcon, group: "About", scope: "mac" },
];

export const SECTION_IDS = SECTIONS.map((section) => section.id);

/** Retired pane ids, still routed to the pane that took over their rows. */
export const SECTION_ALIASES: Record<string, string> = {
  sessions: "general",
  inbox: "general",
  textgen: "general",
  mcp: "tools",
  permissions: "tools",
  application: "about",
  settled: "general",
};

/** The static index plus every plugin's generated rows, on the Projects and Plugins panes. */
export function settingsSearchIndex(
  plugins: readonly PluginStatus[] | undefined,
  bespoke: (scope: "project" | "machine", pluginId: string) => boolean,
): SettingsSearchIndex {
  if (!plugins?.length) return SETTINGS_SEARCH_INDEX;
  const page = (id: string) => ({ id, label: SETTINGS_SEARCH_PAGES.find((entry) => entry.id === id)?.label ?? id });
  const generated = pluginSettingsSearchEntries(plugins, { project: page("projects"), machine: page("plugins") }, bespoke);
  return { entries: [...SETTINGS_SEARCH_INDEX.entries, ...generated] };
}

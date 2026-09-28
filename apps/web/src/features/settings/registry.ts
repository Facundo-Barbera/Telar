import { APP_PAGES } from "./app-pages";
import { PROJECT_PAGES } from "./project-pages";
import { indexSettings, type SettingsPageSpec } from "./search";

/** The panes in nav order; ids must match the shell's section ids. */
export const SETTINGS_SEARCH_PAGES: readonly SettingsPageSpec[] = [...APP_PAGES, ...PROJECT_PAGES];

export const SETTINGS_SEARCH_INDEX = indexSettings(SETTINGS_SEARCH_PAGES);

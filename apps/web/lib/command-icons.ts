/**
 * THE ONE PLACE A COMMAND'S ICON NAME BECOMES AN ICON (issue #479).
 *
 * The shared registry (`apps/desktop/command-keys.js`) carries `icon` as a
 * lucide NAME — "folder-open", not a component — because Electron's real main
 * process requires that table and nothing in it may import React. This file is
 * the other half: the map from those names to the glyphs, living on the web
 * side where React exists.
 *
 * WHY PER COMMAND AT ALL. The palette used to draw one glyph per GROUP: every
 * Conversation row wore a speech bubble, every Panel row a panel. That made the
 * list scannable by SECTION and not by ROW, which is the wrong unit for a
 * surface whose whole job is finding one verb among twenty-odd. The objection
 * the group icons were chosen over — "every command added later either picks a
 * glyph or looks broken beside the ones that had" — is answered by the fallback
 * below rather than by refusing to pick: a name this map does not know draws its
 * group's glyph, exactly as before, so the registry can grow without this file.
 *
 * THE MAP IS EXPLICIT, not lucide's dynamic index. The dynamic import pulls the
 * whole icon set into the bundle and resolves at runtime; a literal map is
 * tree-shaken to the two dozen glyphs actually named, and an unknown name is a
 * test failure rather than a network request.
 */

import {
  AArrowDownIcon,
  AArrowUpIcon,
  AppWindowIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  BlendIcon,
  BugIcon,
  FileCodeIcon,
  FileSearchIcon,
  FolderCogIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  GaugeIcon,
  GitCompareIcon,
  HashIcon,
  MaximizeIcon,
  MessageSquareIcon,
  MessageSquarePlusIcon,
  MessagesSquareIcon,
  PaletteIcon,
  PanelLeftIcon,
  PanelRightIcon,
  PinIcon,
  PuzzleIcon,
  RefreshCwIcon,
  SearchIcon,
  SendIcon,
  Settings2Icon,
  SettingsIcon,
  ShirtIcon,
  SigmaIcon,
  SquareIcon,
  SquarePlusIcon,
  SunMoonIcon,
  SwatchBookIcon,
  TableIcon,
  TextCursorIcon,
  TextSearchIcon,
  type LucideIcon,
} from "lucide-react";
import { COMMANDS, type CommandGroup, type CommandId } from "@/lib/commands";

/**
 * Every lucide name the registry (and the palette's own quick-settings rows)
 * may ask for. Keyed by the kebab-case name lucide's own catalogue uses, so the
 * string in the shared table reads as the icon a person would look up.
 */
export const COMMAND_ICONS: Record<string, LucideIcon> = {
  "a-arrow-down": AArrowDownIcon,
  "a-arrow-up": AArrowUpIcon,
  "app-window": AppWindowIcon,
  "arrow-left": ArrowLeftIcon,
  "arrow-right": ArrowRightIcon,
  blend: BlendIcon,
  bug: BugIcon,
  "file-code": FileCodeIcon,
  "file-search": FileSearchIcon,
  "folder-cog": FolderCogIcon,
  "folder-open": FolderOpenIcon,
  "folder-plus": FolderPlusIcon,
  gauge: GaugeIcon,
  "git-compare": GitCompareIcon,
  hash: HashIcon,
  maximize: MaximizeIcon,
  "message-square-plus": MessageSquarePlusIcon,
  "messages-square": MessagesSquareIcon,
  palette: PaletteIcon,
  "panel-left": PanelLeftIcon,
  "panel-right": PanelRightIcon,
  pin: PinIcon,
  puzzle: PuzzleIcon,
  "refresh-cw": RefreshCwIcon,
  search: SearchIcon,
  send: SendIcon,
  settings: SettingsIcon,
  "settings-2": Settings2Icon,
  shirt: ShirtIcon,
  sigma: SigmaIcon,
  square: SquareIcon,
  "square-plus": SquarePlusIcon,
  "sun-moon": SunMoonIcon,
  "swatch-book": SwatchBookIcon,
  table: TableIcon,
  "text-cursor": TextCursorIcon,
  "text-search": TextSearchIcon,
};

/**
 * THE FALLBACK, and the reason a per-command glyph costs nothing to add later.
 *
 * This is what the palette drew for EVERY row before #479 — the honest unit
 * when nothing more specific is known: "this is about the conversation", "this
 * is about the rail". It is now reached only by a command whose `icon` names
 * something this map has not got.
 */
export const GROUP_ICONS: Record<CommandGroup, LucideIcon> = {
  Conversation: MessageSquareIcon,
  Rail: PanelLeftIcon,
  Panel: PanelRightIcon,
  Application: SettingsIcon,
};

/** A lucide name as a glyph, or undefined when the map has never heard of it. */
export function iconByName(name: string | undefined): LucideIcon | undefined {
  return name ? COMMAND_ICONS[name] : undefined;
}

/**
 * The glyph one command's row wears: its own, else its group's.
 *
 * The registry is the answer to both questions — an id it does not know cannot
 * reach a palette row, and "Application" is the least wrong default for one
 * that somehow did.
 */
export function commandIcon(id: CommandId): LucideIcon {
  const command = COMMANDS.find((entry) => entry.id === id);
  return iconByName(command?.icon) ?? GROUP_ICONS[command?.group ?? "Application"];
}

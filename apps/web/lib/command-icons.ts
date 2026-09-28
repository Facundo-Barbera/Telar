/**
 * Maps the registry's lucide icon names to components. The registry can't import
 * React (Electron's main process loads it). An explicit map keeps the bundle
 * tree-shaken, unlike lucide's dynamic index.
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
  MicIcon,
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
  mic: MicIcon,
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

/** Fallback for a command whose `icon` names something this map lacks. */
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

/** The command's own glyph, else its group's. */
export function commandIcon(id: CommandId): LucideIcon {
  const command = COMMANDS.find((entry) => entry.id === id);
  return iconByName(command?.icon) ?? GROUP_ICONS[command?.group ?? "Application"];
}

/**
 * The ten glyphs a run configuration may wear, and the one it wears by default.
 *
 * A CLOSED SET, DRAWN FROM WHAT THE COCKPIT ALREADY SHIPS. The engine stores a
 * key, never an image and never a URL, so the masthead cannot be made to fetch
 * a remote asset by saving a configuration — and a stored key can never fail to
 * render, because the only keys that survive the schema are the ones in this
 * map.
 *
 * AN ABSENT ICON IS NOT A MISSING ONE. The default is resolved HERE rather than
 * written into the document at save time, so every configuration saved before
 * icons existed draws `play` without a migration, and changing the default
 * later rewrites nothing.
 *
 * ORDER IS THE PICKER'S ORDER, which is why `RUN_ICON_KEYS` is a list rather
 * than `Object.keys` of a map nobody promised to keep sorted: `play` first
 * because it is the default, then the things people actually launch.
 */
import {
  BugIcon,
  DatabaseIcon,
  FlaskConicalIcon,
  GlobeIcon,
  HammerIcon,
  PackageIcon,
  PlayIcon,
  RocketIcon,
  ServerIcon,
  TerminalIcon,
} from "lucide-react";
import { createElement, type ReactNode } from "react";
import { DEFAULT_RUN_ICON, type RunIcon } from "@telar/engine-client";

export { DEFAULT_RUN_ICON };
export type { RunIcon };

/** What each key draws. Typed loosely on purpose — the components differ only
 *  in their path data, and naming lucide's own icon type here would pin this
 *  module to an export it does not otherwise need. */
type IconComponent = (props: { className?: string; "aria-hidden"?: boolean }) => ReactNode;

const RUN_ICONS = {
  play: PlayIcon,
  server: ServerIcon,
  globe: GlobeIcon,
  terminal: TerminalIcon,
  flask: FlaskConicalIcon,
  database: DatabaseIcon,
  package: PackageIcon,
  bug: BugIcon,
  rocket: RocketIcon,
  hammer: HammerIcon,
} satisfies Record<RunIcon, IconComponent>;

/** The picker's order, default first. */
export const RUN_ICON_KEYS = [
  "play",
  "server",
  "globe",
  "terminal",
  "flask",
  "database",
  "package",
  "bug",
  "rocket",
  "hammer",
] as const satisfies readonly RunIcon[];

/** What a picker button is called, for the humans who navigate by name. */
export const RUN_ICON_LABELS: Record<RunIcon, string> = {
  play: "Play",
  server: "Server",
  globe: "Globe",
  terminal: "Terminal",
  flask: "Flask",
  database: "Database",
  package: "Package",
  bug: "Bug",
  rocket: "Rocket",
  hammer: "Hammer",
};

/**
 * The component for a stored key — `play` for an absent one, and for a value
 * that is not in the set at all.
 *
 * THE UNKNOWN CASE IS NOT DEAD CODE. The schema refuses an unknown key at the
 * door, but this map and that enum are two files: a key added to the protocol
 * and not to this list would otherwise render as `undefined` and crash the
 * masthead rather than draw the default.
 */
export function runIconComponent(icon: string | undefined): IconComponent {
  return RUN_ICONS[icon as RunIcon] ?? RUN_ICONS[DEFAULT_RUN_ICON];
}

/** The key to show as chosen in the picker. */
export function runIconKey(icon: string | undefined): RunIcon {
  return icon && icon in RUN_ICONS ? (icon as RunIcon) : DEFAULT_RUN_ICON;
}

/**
 * A configuration's glyph, drawn.
 *
 * `createElement` RATHER THAN JSX, AND NOT FOR STYLE. React's compiler rules
 * refuse a component-valued local rendered as `<Glyph />` — it cannot tell a
 * lookup in a frozen module map from a component defined mid-render, and the
 * second really would reset its state on every paint. Calling `createElement`
 * on the looked-up type says the same thing without the ambiguity, and keeps
 * the map in one file instead of a ten-arm switch in each caller's.
 */
export function RunGlyph({ icon, className }: { icon?: string; className?: string }): ReactNode {
  return createElement(runIconComponent(icon), { className, "aria-hidden": true });
}

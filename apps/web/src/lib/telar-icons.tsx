/**
 * ID → GLYPH, AND NOTHING ELSE — the one door to the identity icons, the way
 * `identityColorVar` below is the one door to the identity hues.
 *
 * THE MAP IS WRITTEN OUT, NOT COMPUTED. `lucide-react` exports ~1,600 icons;
 * reaching them through a dynamic index (`icons[toPascalCase(id)]`) defeats
 * tree-shaking and ships the whole library to every client. Forty named imports
 * ship forty glyphs. The list they mirror is `TELAR_ICONS` in engine-client, and
 * the test pins the two together so a new id cannot be added there without a
 * glyph arriving here.
 *
 * AN UNKNOWN ID IS A FALLBACK, NEVER A CRASH. A record written by a build that
 * knew an icon this one does not — a downgrade, a half-applied update — still
 * draws: `CircleIcon`, a quiet ring that reads as "no icon chosen" rather than as
 * a missing pixel. Nothing here throws.
 */
import {
  BookIcon,
  BotIcon,
  BoxIcon,
  BriefcaseIcon,
  Building2Icon,
  CameraIcon,
  CircleIcon,
  CloudIcon,
  CodeIcon,
  CompassIcon,
  CpuIcon,
  CreditCardIcon,
  DatabaseIcon,
  FeatherIcon,
  FilmIcon,
  FlameIcon,
  FlaskConicalIcon,
  GlobeIcon,
  GraduationCapIcon,
  HammerIcon,
  HeartIcon,
  HouseIcon,
  LayersIcon,
  LeafIcon,
  MapIcon,
  MoonIcon,
  MusicIcon,
  PaletteIcon,
  PenToolIcon,
  PuzzleIcon,
  RocketIcon,
  ServerIcon,
  ShieldIcon,
  ShoppingCartIcon,
  StarIcon,
  SunIcon,
  TerminalIcon,
  TreePineIcon,
  UserRoundIcon,
  UsersRoundIcon,
  WrenchIcon,
} from "lucide-react";
import { IDENTITY_COLORS, isTelarIcon, type IdentityColor, type TelarIcon } from "@telar/engine-client";
import { createElement, type ComponentType, type CSSProperties } from "react";

/** `shapeRendering` is in the contract because `IdentityIcon` passes it: these
 *  are 24-unit lucide glyphs drawn at 14–16px, where the default rasteriser
 *  snaps a 2-unit stroke onto the device grid and thickens one side of a ring
 *  against the other. Lucide spreads any SVG prop onto its `<svg>`, so naming
 *  it here is only about the type. */
type Glyph = ComponentType<{ className?: string; style?: CSSProperties; shapeRendering?: "geometricPrecision" }>;

const GLYPHS: Record<TelarIcon, Glyph> = {
  globe: GlobeIcon,
  briefcase: BriefcaseIcon,
  house: HouseIcon,
  "building-2": Building2Icon,
  "user-round": UserRoundIcon,
  "users-round": UsersRoundIcon,
  compass: CompassIcon,
  map: MapIcon,
  code: CodeIcon,
  terminal: TerminalIcon,
  database: DatabaseIcon,
  server: ServerIcon,
  cloud: CloudIcon,
  box: BoxIcon,
  layers: LayersIcon,
  cpu: CpuIcon,
  bot: BotIcon,
  wrench: WrenchIcon,
  hammer: HammerIcon,
  puzzle: PuzzleIcon,
  "pen-tool": PenToolIcon,
  palette: PaletteIcon,
  camera: CameraIcon,
  music: MusicIcon,
  film: FilmIcon,
  feather: FeatherIcon,
  "shopping-cart": ShoppingCartIcon,
  "credit-card": CreditCardIcon,
  book: BookIcon,
  "graduation-cap": GraduationCapIcon,
  "flask-conical": FlaskConicalIcon,
  leaf: LeafIcon,
  "tree-pine": TreePineIcon,
  sun: SunIcon,
  moon: MoonIcon,
  flame: FlameIcon,
  star: StarIcon,
  heart: HeartIcon,
  shield: ShieldIcon,
  rocket: RocketIcon,
};

/** The glyph nothing chose: a ring, so the slot keeps its size and reads as
 *  empty rather than broken. Exported because a picker needs to offer it. */
export const NO_ICON_GLYPH: Glyph = CircleIcon;

/** A stored id (or anything else) → the component that draws it. Total. */
export function telarIconGlyph(icon: string | undefined | null): Glyph {
  return isTelarIcon(icon) ? GLYPHS[icon] : NO_ICON_GLYPH;
}

/**
 * A stored colour token → the CSS variable it paints with, or `currentColor`
 * when nothing was chosen — an uncoloured identity inherits the surface's own
 * text colour rather than turning grey, because the glyph is still the thing
 * you are meant to read.
 */
export function identityColorVar(color: string | undefined | null): string {
  return color && (IDENTITY_COLORS as readonly string[]).includes(color) ? `var(--subject-${color})` : "currentColor";
}

/**
 * ONE IDENTITY, DRAWN — the glyph in its colour, and nothing else. Every surface
 * that shows a profile or a project uses this so the same record cannot be drawn
 * two ways.
 *
 * THE NAME IS THE CALLER'S JOB. This renders no accessible name of its own: an
 * icon standing in for a name needs that name on whatever wraps it (a button's
 * `aria-label`, a row's own text), and a glyph that announced its own id would
 * read "globe" where the person needs "Work".
 *
 * `createElement` RATHER THAN `<Glyph />` because the glyph is LOOKED UP, not
 * created: it is one of forty module constants, and writing it in a JSX tag
 * position reads to the linter (and to the next person) as a component minted per
 * render, which would reset state on every paint if these had any.
 */
export function IdentityIcon({
  icon,
  color,
  className,
}: {
  icon?: TelarIcon | string | null;
  color?: IdentityColor | string | null;
  className?: string;
}) {
  return createElement(telarIconGlyph(icon), {
    className,
    style: { color: identityColorVar(color) },
    shapeRendering: "geometricPrecision",
  });
}

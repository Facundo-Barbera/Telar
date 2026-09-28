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

export const NO_ICON_GLYPH: Glyph = CircleIcon;

export function telarIconGlyph(icon: string | undefined | null): Glyph {
  return isTelarIcon(icon) ? GLYPHS[icon] : NO_ICON_GLYPH;
}

export function identityColorVar(color: string | undefined | null): string {
  return color && (IDENTITY_COLORS as readonly string[]).includes(color) ? `var(--subject-${color})` : "currentColor";
}

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

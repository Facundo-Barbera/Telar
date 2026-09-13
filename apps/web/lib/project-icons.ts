/**
 * THE GLYPHS A PROJECT MAY BE MARKED WITH — a fixed set, named here (#364).
 *
 * WHY A SET AND NOT A FIELD. The row used to be a text input that took any
 * grapheme, which meant a project's mark was whatever emoji font the reader's OS
 * shipped: a different size, a different weight and a different colour from
 * every other glyph in the rail, sitting in the one place a list needs its marks
 * to agree. A chosen icon is drawn by the same library as the rest of the app,
 * so a marked project and an unmarked one still read as one list.
 *
 * WHY THE LIST LIVES IN THE APP AND NOT THE PROTOCOL. Which glyphs can be drawn
 * is a property of this cockpit's icon library, not of the registry — an engine
 * that enforced last year's list would refuse a name a newer app renders
 * perfectly. `Project.iconName` checks the SHAPE of the name; this file is what
 * it MEANS, and an unknown name falls back to the discovered icon rather than to
 * a missing-glyph box.
 *
 * THE ORDER IS THE PICKER'S ORDER, grouped by the kind of thing a project is —
 * code, writing, data, infrastructure, then the plain shapes for a project that
 * is none of those. Nothing is alphabetical: a reader scanning for "the flask
 * one" finds it beside the other lab glyphs, not between `file` and `folder`.
 */

import type { LucideIcon } from "lucide-react";
import {
  ActivityIcon,
  AtomIcon,
  BeakerIcon,
  BinaryIcon,
  BookOpenIcon,
  BotIcon,
  BoxIcon,
  BrainIcon,
  BriefcaseIcon,
  BugIcon,
  CalendarIcon,
  ChartNoAxesColumnIcon,
  CircleIcon,
  CloudIcon,
  CodeIcon,
  CompassIcon,
  CpuIcon,
  DatabaseIcon,
  FeatherIcon,
  FileTextIcon,
  FlameIcon,
  FlaskConicalIcon,
  GamepadIcon,
  GlobeIcon,
  GraduationCapIcon,
  HammerIcon,
  HeartIcon,
  HouseIcon,
  ImageIcon,
  LayersIcon,
  LeafIcon,
  LibraryIcon,
  MusicIcon,
  PaletteIcon,
  PuzzleIcon,
  RocketIcon,
  ServerIcon,
  ShoppingCartIcon,
  SigmaIcon,
  SparklesIcon,
  SquareIcon,
  TerminalIcon,
  TriangleIcon,
  WrenchIcon,
  ZapIcon,
} from "lucide-react";

export type ProjectIcon = { id: string; label: string; Glyph: LucideIcon };

/** The offered set, in picker order. Ids are stable: one is stored on a record. */
export const PROJECT_ICONS: readonly ProjectIcon[] = [
  // Code
  { id: "code", label: "Code", Glyph: CodeIcon },
  { id: "terminal", label: "Terminal", Glyph: TerminalIcon },
  { id: "binary", label: "Binary", Glyph: BinaryIcon },
  { id: "bug", label: "Bug", Glyph: BugIcon },
  { id: "puzzle", label: "Puzzle", Glyph: PuzzleIcon },
  { id: "wrench", label: "Wrench", Glyph: WrenchIcon },
  { id: "hammer", label: "Hammer", Glyph: HammerIcon },
  { id: "layers", label: "Layers", Glyph: LayersIcon },
  { id: "box", label: "Box", Glyph: BoxIcon },
  // Data and research
  { id: "flask", label: "Flask", Glyph: FlaskConicalIcon },
  { id: "beaker", label: "Beaker", Glyph: BeakerIcon },
  { id: "atom", label: "Atom", Glyph: AtomIcon },
  { id: "sigma", label: "Sigma", Glyph: SigmaIcon },
  { id: "chart", label: "Chart", Glyph: ChartNoAxesColumnIcon },
  { id: "activity", label: "Activity", Glyph: ActivityIcon },
  { id: "database", label: "Database", Glyph: DatabaseIcon },
  { id: "brain", label: "Brain", Glyph: BrainIcon },
  { id: "bot", label: "Bot", Glyph: BotIcon },
  // Infrastructure
  { id: "server", label: "Server", Glyph: ServerIcon },
  { id: "cpu", label: "Chip", Glyph: CpuIcon },
  { id: "cloud", label: "Cloud", Glyph: CloudIcon },
  { id: "globe", label: "Globe", Glyph: GlobeIcon },
  { id: "zap", label: "Bolt", Glyph: ZapIcon },
  { id: "rocket", label: "Rocket", Glyph: RocketIcon },
  // Writing and study
  { id: "file-text", label: "Document", Glyph: FileTextIcon },
  { id: "book", label: "Book", Glyph: BookOpenIcon },
  { id: "library", label: "Library", Glyph: LibraryIcon },
  { id: "feather", label: "Feather", Glyph: FeatherIcon },
  { id: "graduation-cap", label: "Study", Glyph: GraduationCapIcon },
  { id: "calendar", label: "Calendar", Glyph: CalendarIcon },
  // Making and life
  { id: "palette", label: "Palette", Glyph: PaletteIcon },
  { id: "image", label: "Image", Glyph: ImageIcon },
  { id: "music", label: "Music", Glyph: MusicIcon },
  { id: "gamepad", label: "Game", Glyph: GamepadIcon },
  { id: "briefcase", label: "Work", Glyph: BriefcaseIcon },
  { id: "cart", label: "Shop", Glyph: ShoppingCartIcon },
  { id: "house", label: "Home", Glyph: HouseIcon },
  { id: "leaf", label: "Leaf", Glyph: LeafIcon },
  { id: "heart", label: "Heart", Glyph: HeartIcon },
  { id: "compass", label: "Compass", Glyph: CompassIcon },
  // Plain marks, for a project that is none of the above
  { id: "sparkles", label: "Sparkles", Glyph: SparklesIcon },
  { id: "flame", label: "Flame", Glyph: FlameIcon },
  { id: "circle", label: "Circle", Glyph: CircleIcon },
  { id: "square", label: "Square", Glyph: SquareIcon },
  { id: "triangle", label: "Triangle", Glyph: TriangleIcon },
];

const BY_ID = new Map(PROJECT_ICONS.map((icon) => [icon.id, icon]));

/**
 * The glyph a stored name means, or `undefined` when this build does not know
 * the name — which is not an error: the record may have been written by a newer
 * cockpit with a bigger set, and falling through to the checkout's own icon is a
 * better answer than a box with a question mark in it.
 */
export function projectGlyph(id: string | undefined): ProjectIcon | undefined {
  return id ? BY_ID.get(id) : undefined;
}

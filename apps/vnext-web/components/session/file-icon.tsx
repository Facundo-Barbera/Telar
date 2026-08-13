/**
 * THE GLYPH FOR A FILE, AND ITS COLOUR.
 *
 * `lib/file-kinds.ts` decides WHAT a file is; this decides what that looks like.
 * The split keeps the table testable as data and keeps the icon set in one place
 * — the alternative was a lookup returning React components from a lib module,
 * which drags 6,000 lucide icons into a data test.
 *
 * SHAPE SAYS THE FAMILY, COLOUR SAYS THE LANGUAGE. Nineteen glyphs cover every
 * row, so a tree reads as a tree rather than as a sticker album; the tint is what
 * tells `.ts` from `.py` at a glance. Same division t3 code's browser makes, and
 * the reason its trees are scannable at 11px.
 */
import {
  BinaryIcon,
  BookTextIcon,
  BracesIcon,
  ContainerIcon,
  DatabaseIcon,
  FileArchiveIcon,
  FileAudioIcon,
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  FileLockIcon,
  FileTerminalIcon,
  FileTextIcon,
  FileVideoIcon,
  GitBranchIcon,
  PackageIcon,
  PaletteIcon,
  SettingsIcon,
  TableIcon,
} from "lucide-react";
import { fileKind, type FileGlyph } from "@/lib/file-kinds";
import { cn } from "@/lib/utils";

const GLYPHS: Record<FileGlyph, typeof FileIcon> = {
  code: FileCodeIcon,
  braces: BracesIcon,
  config: SettingsIcon,
  text: FileTextIcon,
  doc: BookTextIcon,
  image: FileImageIcon,
  audio: FileAudioIcon,
  video: FileVideoIcon,
  archive: FileArchiveIcon,
  lock: FileLockIcon,
  terminal: FileTerminalIcon,
  database: DatabaseIcon,
  style: PaletteIcon,
  package: PackageIcon,
  container: ContainerIcon,
  git: GitBranchIcon,
  binary: BinaryIcon,
  table: TableIcon,
  plain: FileIcon,
};

/**
 * A file's icon, tinted by what it is.
 *
 * `className` wins over the tint on purpose: a row that needs to override the
 * colour — a deleted file, a dimmed closed tab — should be able to, and putting
 * the kind's tint first in `cn` is what lets Tailwind's later class take it.
 */
export function FileKindIcon({ path, className }: { path: string; className?: string }) {
  const kind = fileKind(path);
  const Glyph = GLYPHS[kind.glyph];
  return <Glyph aria-hidden className={cn("shrink-0", kind.tint, className)} />;
}

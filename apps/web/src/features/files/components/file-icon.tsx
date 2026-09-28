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
import { fileKind, type FileGlyph } from "../file-kinds";
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

export function FileKindIcon({ path, className }: { path: string; className?: string }) {
  const kind = fileKind(path);
  const Glyph = GLYPHS[kind.glyph];
  return <Glyph aria-hidden className={cn("shrink-0", kind.tint, className)} />;
}

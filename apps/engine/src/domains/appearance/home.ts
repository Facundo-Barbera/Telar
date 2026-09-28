import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atomicWrite, atomicWriteText } from "../../platform/fs/atomic";

type AppearanceHomePaths = {
  root: string;
  settings: string;
  themes: string;
  looks: string;
  images: string;
  readme: string;
};

const AGENTS_MD = `# This is a Telar instance's own state

You are working inside Telar's state directory. Everything here decides how
this Telar behaves and looks. Changes take effect in the running app — treat
it as a live system, not a scratch checkout.

## Appearance

\`appearance/\` is read by the app and merged into the open window. Its README
describes the schema; read it before writing there.

    appearance/settings.json      accent, fonts, sizes, translucency, scheme
    appearance/themes/<id>.json   a palette: two halves, sixteen tokens each
    appearance/looks/<id>.json    a whole appearance: theme + backdrop + type
    appearance/images/<id>.<ext>  pictures, referenced by looks

Write valid JSON and it appears in Settings → Appearance. A malformed file is
skipped and reported rather than breaking anything, so a bad edit is safe.

## The rest

    projects.json             registered projects
    sessions/                 every session's record and journal
    mcp-servers.json          tool servers offered to sessions
    provider-instances.json   configured provider logins
    text-generation.json      which model writes titles and one-shot answers

\`provider-secrets.json\` holds credentials. There is no reason to read it.

## Working here

Prefer editing one file at a time and telling the person what changed — this
is their machine's configuration, and a large silent rewrite is hard to undo.
`;

const CURRENT_README = `# Telar — appearance

Everything that decides how Telar looks. Files here are the record; the app
keeps a copy in the browser for the pre-paint frame and refreshes it from here.

    settings.json      one object: accent, fonts, sizes, translucency, scheme
    themes/<id>.json   a palette: { id, label, light: {…}, dark: {…} }
    looks/<id>.json    a whole appearance: theme + backdrop + accent + type
    images/<id>.<ext>  backdrop and scene pictures, referenced by looks

## Themes

A theme is two halves. Each half sets the same sixteen tokens; every value is
a CSS colour. A half may omit tokens, and the missing ones fall back to
Telar's own palette.

    background  foreground  card  card-foreground  popover  popover-foreground
    secondary  secondary-foreground  muted  muted-foreground  accent
    accent-foreground  border  input  sidebar  sidebar-accent

## Looks

A look embeds its theme's two halves outright rather than naming a theme, so
it stays whole when it travels to another machine. Its backdrop is one of
\`none\`, \`gradient\`, \`custom-gradient\`, \`image\` or \`scene\`; an image backdrop
names a file in images/.

## Editing by hand

Write valid JSON and the app will pick it up. A malformed file is skipped, not
fatal — it is reported rather than crashing anything. Ids are letters, digits,
underscores and hyphens.
`;

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const IMAGE_NAME = /^[A-Za-z0-9_-]{1,64}\.(png|jpg|gif|webp)$/;

export function isAppearanceId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

export function appearanceHomePaths(stateRoot: string): AppearanceHomePaths {
  const root = path.join(stateRoot, "appearance");
  return {
    root,
    settings: path.join(root, "settings.json"),
    themes: path.join(root, "themes"),
    looks: path.join(root, "looks"),
    images: path.join(root, "images"),
    readme: path.join(root, "README.md"),
  };
}

function writeIfChanged(file: string, content: string): void {
  try {
    if (fs.readFileSync(file, "utf8") === content) return;
  } catch {}
  try {
    fs.writeFileSync(file, content, { mode: 0o600 });
  } catch {}
}

export function ensureAppearanceHome(stateRoot: string): AppearanceHomePaths {
  const paths = appearanceHomePaths(stateRoot);
  for (const dir of [paths.root, paths.themes, paths.looks, paths.images]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  writeIfChanged(paths.readme, CURRENT_README);
  writeIfChanged(path.join(stateRoot, "AGENTS.md"), AGENTS_MD);
  return paths;
}

type DirectoryRead = { entries: Record<string, unknown>[]; skipped: { file: string; reason: string }[] };

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Only "an object" is checked here; the token-level parse lives in @telar/engine-client. The filename wins over an inner `id`.
function readEntries(stateRoot: string, kind: "themes" | "looks"): DirectoryRead {
  const dir = appearanceHomePaths(stateRoot)[kind];
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return { entries: [], skipped: [] };
  }
  const entries: Record<string, unknown>[] = [];
  const skipped: { file: string; reason: string }[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".json")) continue;
    const id = name.slice(0, -".json".length);
    if (!isAppearanceId(id)) {
      skipped.push({ file: name, reason: "the filename is not a valid id" });
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
    } catch {
      skipped.push({ file: name, reason: "not valid JSON" });
      continue;
    }
    if (!isObject(parsed)) {
      skipped.push({ file: name, reason: "not the shape this file should hold" });
      continue;
    }
    entries.push({ ...parsed, id });
  }
  return { entries, skipped };
}

export function readThemes(stateRoot: string): DirectoryRead {
  return readEntries(stateRoot, "themes");
}

export function readLooks(stateRoot: string): DirectoryRead {
  return readEntries(stateRoot, "looks");
}

export function writeTheme(stateRoot: string, id: string, theme: Record<string, unknown>): void {
  atomicWrite(path.join(ensureAppearanceHome(stateRoot).themes, `${id}.json`), { ...theme, id });
}

export function writeLook(stateRoot: string, id: string, look: Record<string, unknown>): void {
  atomicWrite(path.join(ensureAppearanceHome(stateRoot).looks, `${id}.json`), { ...look, id });
}

export function removeEntry(stateRoot: string, kind: "themes" | "looks", id: string): void {
  try {
    fs.rmSync(path.join(appearanceHomePaths(stateRoot)[kind], `${id}.json`), { force: true });
  } catch {}
}

export function readSettings(stateRoot: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(appearanceHomePaths(stateRoot).settings, "utf8"));
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function writeSettings(stateRoot: string, settings: Record<string, unknown>): void {
  atomicWrite(ensureAppearanceHome(stateRoot).settings, settings);
}

export function imageExtension(bytes: Uint8Array): string | undefined {
  const starts = (...signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "png";
  if (starts(0xff, 0xd8, 0xff)) return "jpg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "gif";
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "webp";
  return undefined;
}

/** Stored under a content hash; returns the name a look references. */
export function putImage(stateRoot: string, bytes: Uint8Array): string | undefined {
  const extension = imageExtension(bytes);
  if (extension === undefined) return undefined;
  const paths = ensureAppearanceHome(stateRoot);
  const digest = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const name = `${digest}.${extension}`;
  const file = path.join(paths.images, name);
  if (!fs.existsSync(file)) atomicWriteText(file, bytes);
  return name;
}

// `name` comes from the caller; IMAGE_NAME is what keeps it inside images/.
export function readImage(stateRoot: string, name: string): Uint8Array | undefined {
  if (!IMAGE_NAME.test(name)) return undefined;
  try {
    return fs.readFileSync(path.join(appearanceHomePaths(stateRoot).images, name));
  } catch {
    return undefined;
  }
}

export function listImages(stateRoot: string): string[] {
  try {
    return fs
      .readdirSync(appearanceHomePaths(stateRoot).images)
      .filter((name) => IMAGE_NAME.test(name))
      .sort();
  } catch {
    return [];
  }
}

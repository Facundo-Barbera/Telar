/**
 * THE APPEARANCE HOME — a place on disk for the things that decide how Telar
 * looks, so that something other than a browser tab can put them there.
 *
 * WHY THIS DID NOT EXIST. Every other kind of settings the engine owns is
 * already a file: projects.json, mcp-servers.json, provider-instances.json,
 * text-generation.json. Appearance was the one exception, and not by oversight
 * — APPEARANCE_INIT_SCRIPT has to paint the right colours synchronously before
 * the first frame, so the values had to be readable without a fetch, which
 * means localStorage. Themes, Looks and even backdrop PHOTOGRAPHS therefore
 * lived in the browser as base64 strings, competing for one origin's ~5MB.
 *
 * That was survivable while a human with a colour picker was the only author.
 * It stops being survivable the moment an agent is one, because an agent has a
 * filesystem and no browser: it can write `themes/dusk.json` all day and a
 * localStorage-only cockpit will never see it.
 *
 * SO THE FILES BECOME THE RECORD AND THE BROWSER BECOMES A CACHE. The
 * pre-paint constraint is unchanged and still met — the cockpit keeps its
 * localStorage copy for the synchronous first frame — but the copy is now
 * downstream of something both a person and an agent can write.
 *
 * IMAGES BECOME FILES, which is the other half of the win. A backdrop
 * photograph was compressed to fit a 3.5MB budget inside a 5MB origin (see the
 * ladder in apps/web/lib/image-backdrop.ts); as a file on disk it is just an
 * image, and the ceiling goes away.
 *
 * EVERY READ IS TOTAL. This is a directory a person and an agent both write
 * into by hand, so half-written JSON, a stray editor swapfile and a theme with
 * a missing half are all NORMAL, not exceptional. A bad file is skipped and
 * named in `skipped`; nothing here throws because of one.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { atomicWrite } from "./atomic";

export type AppearanceHomePaths = {
  root: string;
  settings: string;
  themes: string;
  looks: string;
  images: string;
  readme: string;
};

/**
 * WHAT EVERY AGENT IN THIS DIRECTORY READS FIRST.
 *
 * A brief handed to one session at creation time is knowledge that one session
 * has. `AGENTS.md` at the working directory is knowledge the PLACE has — every
 * CLI agent Telar drives reads it on entry, so a session started from the
 * settings button, from the sidebar, or by hand next Tuesday is equally aware.
 *
 * It sits at the state root rather than inside appearance/ because the state
 * root is the working directory, and because appearance is not the only thing
 * here worth explaining.
 */
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

/** Written beside the appearance home, so a session in this directory knows
 *  what the directory is. Kept honest the same way the README is. */
export function ensureAgentsFile(stateRoot: string): void {
  const file = path.join(stateRoot, "AGENTS.md");
  let existing: string | undefined;
  try {
    existing = fs.readFileSync(file, "utf8");
  } catch {
    // Absent or unreadable — about to be written either way.
  }
  if (existing === AGENTS_MD) return;
  try {
    fs.writeFileSync(file, AGENTS_MD, { mode: 0o600 });
  } catch {
    // A directory whose map cannot be written still works.
  }
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

/**
 * THE MAP, WRITTEN INTO THE PLACE IT DESCRIBES.
 *
 * An agent told once, in a system prompt, where the assets go will be told
 * again by every future maintainer of that prompt. A README in the directory
 * is discovered by anything that lists it — the agent, a person wondering what
 * this folder is, and the next person to change the schema, who now has the
 * documentation open in the same diff as the code.
 *
 * Rewritten whenever it drifts from CURRENT_README so a stale map cannot
 * outlive the shape it describes; a reader's own additions below the marker
 * are not preserved, because a map that is partly wrong is worse than one that
 * is replaced.
 */
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

export function isAppearanceId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

/** Create the home if it is absent, and keep the README honest. Cheap enough
 *  to call on every read: three mkdirs that no-op, and one file compare. */
export function ensureAppearanceHome(stateRoot: string): AppearanceHomePaths {
  const paths = appearanceHomePaths(stateRoot);
  for (const dir of [paths.root, paths.themes, paths.looks, paths.images]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  let existing: string | undefined;
  try {
    existing = fs.readFileSync(paths.readme, "utf8");
  } catch {
    // Absent or unreadable — either way it is about to be written.
  }
  if (existing !== CURRENT_README) {
    try {
      fs.writeFileSync(paths.readme, CURRENT_README, { mode: 0o600 });
    } catch {
      // A home whose map cannot be written still works; the map is a courtesy.
    }
  }
  ensureAgentsFile(stateRoot);
  return paths;
}

/** What a directory read found, and what it could not read. The failures are
 *  RETURNED rather than thrown or swallowed: a person editing by hand needs to
 *  be told which file is broken, and a broken file must not hide the good ones. */
export type DirectoryRead<T> = { entries: T[]; skipped: { file: string; reason: string }[] };

function readJsonDirectory(dir: string, keep: (value: unknown, id: string) => unknown | undefined): DirectoryRead<Record<string, unknown>> {
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
    const kept = keep(parsed, id);
    if (kept === undefined) {
      skipped.push({ file: name, reason: "not the shape this file should hold" });
      continue;
    }
    entries.push(kept as Record<string, unknown>);
  }
  return { entries, skipped };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Themes and looks are validated only as far as THIS process can justify: an
 * object, with an id that matches its filename. The full token-by-token parse
 * lives in @telar/engine-client and runs in the reader that will paint with
 * it — duplicating it here would put two definitions of "a valid theme" in the
 * tree, free to disagree, and the engine does not paint anything.
 *
 * THE FILENAME WINS OVER AN `id` INSIDE. Renaming a file is how a person moves
 * an entry, and a stale id in the body should not undo that.
 */
export function readThemes(stateRoot: string): DirectoryRead<Record<string, unknown>> {
  const paths = appearanceHomePaths(stateRoot);
  return readJsonDirectory(paths.themes, (value, id) => (isObject(value) ? { ...value, id } : undefined));
}

export function readLooks(stateRoot: string): DirectoryRead<Record<string, unknown>> {
  const paths = appearanceHomePaths(stateRoot);
  return readJsonDirectory(paths.looks, (value, id) => (isObject(value) ? { ...value, id } : undefined));
}

export function writeTheme(stateRoot: string, id: string, theme: Record<string, unknown>): void {
  const paths = ensureAppearanceHome(stateRoot);
  atomicWrite(path.join(paths.themes, `${id}.json`), { ...theme, id });
}

export function writeLook(stateRoot: string, id: string, look: Record<string, unknown>): void {
  const paths = ensureAppearanceHome(stateRoot);
  atomicWrite(path.join(paths.looks, `${id}.json`), { ...look, id });
}

/** Idempotent, like every other delete in this engine: removing something that
 *  is already gone is the state the caller asked for. */
export function removeEntry(stateRoot: string, kind: "themes" | "looks", id: string): void {
  const paths = appearanceHomePaths(stateRoot);
  try {
    fs.rmSync(path.join(paths[kind], `${id}.json`), { force: true });
  } catch {
    // A file we cannot delete is an entry that stays; nothing here is worth a throw.
  }
}

export function readSettings(stateRoot: string): Record<string, unknown> | undefined {
  const paths = appearanceHomePaths(stateRoot);
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(paths.settings, "utf8"));
    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function writeSettings(stateRoot: string, settings: Record<string, unknown>): void {
  const paths = ensureAppearanceHome(stateRoot);
  atomicWrite(paths.settings, settings);
}

/**
 * THE FORMAT IS SNIFFED, NOT TRUSTED. This directory is written into by hand
 * and by an agent, so a caller's claimed extension is a suggestion. The magic
 * bytes are the fact — and a file that is not an image at all is refused here
 * rather than becoming a broken backdrop later.
 */
export function imageExtension(bytes: Uint8Array): string | undefined {
  const starts = (...signature: number[]) => signature.every((byte, index) => bytes[index] === byte);
  if (starts(0x89, 0x50, 0x4e, 0x47)) return "png";
  if (starts(0xff, 0xd8, 0xff)) return "jpg";
  if (starts(0x47, 0x49, 0x46, 0x38)) return "gif";
  // RIFF....WEBP
  if (starts(0x52, 0x49, 0x46, 0x46) && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "webp";
  return undefined;
}

/**
 * Stored under a CONTENT HASH, so the same picture dropped twice is one file
 * and a look that references it cannot be broken by an unrelated re-upload.
 * Returns the id (hash + extension) a look should reference.
 */
export function putImage(stateRoot: string, bytes: Uint8Array): string | undefined {
  const extension = imageExtension(bytes);
  if (extension === undefined) return undefined;
  const paths = ensureAppearanceHome(stateRoot);
  const digest = crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 16);
  const name = `${digest}.${extension}`;
  const file = path.join(paths.images, name);
  if (!fs.existsSync(file)) {
    const temporary = `${file}.tmp-${process.pid}-${crypto.randomUUID()}`;
    try {
      fs.writeFileSync(temporary, bytes, { mode: 0o600 });
      fs.renameSync(temporary, file);
    } finally {
      try {
        fs.unlinkSync(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  return name;
}

/**
 * A stored image's bytes. The name is checked against the same id rule plus an
 * extension, which is what keeps `../../secrets` out — this reads a path built
 * from a caller-supplied string, so the check is the security boundary rather
 * than a tidiness rule.
 */
export function readImage(stateRoot: string, name: string): Uint8Array | undefined {
  const match = /^([A-Za-z0-9_-]{1,64})\.(png|jpg|gif|webp)$/.exec(name);
  if (!match) return undefined;
  const paths = appearanceHomePaths(stateRoot);
  try {
    return fs.readFileSync(path.join(paths.images, name));
  } catch {
    return undefined;
  }
}

export function listImages(stateRoot: string): string[] {
  const paths = appearanceHomePaths(stateRoot);
  try {
    return fs
      .readdirSync(paths.images)
      .filter((name) => /^[A-Za-z0-9_-]{1,64}\.(png|jpg|gif|webp)$/.test(name))
      .sort();
  } catch {
    return [];
  }
}

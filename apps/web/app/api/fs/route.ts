import { homedir } from "node:os";
import { join, resolve, dirname, basename, isAbsolute } from "node:path";
import { readdirSync, existsSync, statSync } from "node:fs";

/**
 * The PHONE's folder picker. `/api/browse` opens a native dialog ON THE MAC,
 * which from a phone is a window nobody is looking at — a remote client needs
 * the listing itself. Directories only, dotfolders skipped, `.git` badged so
 * repositories stand out in the drill-down.
 *
 * TRUST: behind the pairing gate like every `/api` route, and it discloses
 * nothing a paired device could not already reach — registerProject accepts
 * any root, and a registered project reads its whole tree via
 * `/api/projects/:id/files`. The gate is the boundary; this route just makes
 * the path TYPEABLE-WITHOUT-A-KEYBOARD.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_ENTRIES = 250;

export async function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get("path") ?? homedir();
  if (!isAbsolute(raw)) {
    return Response.json(
      { error: { code: "invalid_request", message: "path must be absolute" } },
      { status: 400 },
    );
  }
  const path = resolve(raw);
  let stat;
  try {
    stat = statSync(path);
  } catch {
    return Response.json(
      { error: { code: "not_found", message: "That folder does not exist." } },
      { status: 404 },
    );
  }
  if (!stat.isDirectory()) {
    return Response.json(
      { error: { code: "invalid_request", message: "Not a folder." } },
      { status: 400 },
    );
  }
  let names: Array<{ name: string; isDirectory: () => boolean }>;
  try {
    names = readdirSync(path, { withFileTypes: true });
  } catch {
    return Response.json(
      { error: { code: "invalid_request", message: "That folder is not readable." } },
      { status: 400 },
    );
  }
  const dirs = names
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    .slice(0, MAX_ENTRIES)
    .map((name) => {
      const full = join(path, name);
      let git = false;
      try {
        git = existsSync(join(full, ".git"));
      } catch {
        // Unreadable child: list it, just without the badge.
      }
      return { name, path: full, git };
    });
  return Response.json({
    path,
    name: basename(path) || path,
    parent: dirname(path) === path ? null : dirname(path),
    home: homedir(),
    dirs,
  });
}

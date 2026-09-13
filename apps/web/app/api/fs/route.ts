import { isDirectoryFailure, listDirectories } from "@/lib/fs-dirs";

/**
 * BROWSING FOR A FOLDER — for the phone, and now for the palette too.
 *
 * WHY IT EXISTS AT ALL. `/api/browse` opens a native dialog ON THE MAC, which
 * from a phone is a window nobody is looking at, and in the palette is a sheet
 * that covers the thing you were half-way through. A remote client — and an
 * in-app browser — needs the listing itself. Directories only, `.git` badged so
 * repositories stand out in the drill-down.
 *
 * TWO CALLERS NOW, ONE ROUTE. The phone's `AddProjectView` has drilled through
 * this for a while; the palette's `DirectoryBrowser` is the second. It grew
 * three things for the second caller — `~` expands, `?hidden=1` shows
 * dotfolders, and a path outside this account's home or a mounted volume is
 * REFUSED with a sentence instead of listed — and the rules moved to
 * `lib/fs-dirs.ts` where they can be tested. The response shape is the phone's,
 * added to and not changed: `dirs`/`name`/`git` are what Swift decodes, and
 * `hidden`/`truncated` are new keys a `Decodable` ignores.
 *
 * IT IS STILL THIS PROCESS'S OWN FILESYSTEM, deliberately, and that is what
 * makes a paired Mac work: `/api/hosts/:id/fs` forwards to THAT cockpit, whose
 * Next process lists ITS disk. An engine route would have been a second path to
 * the same answer.
 *
 * TRUST: behind the pairing gate like every `/api` route, and it discloses
 * nothing a paired device could not already reach — `registerProject` accepts
 * any root, and a registered project reads its whole tree via
 * `/api/projects/:id/files`. The gate is the boundary; this route makes the path
 * TYPEABLE-WITHOUT-A-KEYBOARD, and its root check keeps a folder picker out of
 * `/private/var` rather than standing in for that gate.
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  const listed = listDirectories({
    // Absent means home, which is where both browsers start.
    path: query.get("path"),
    hidden: query.get("hidden") === "1",
  });
  if (isDirectoryFailure(listed)) {
    return Response.json({ error: listed }, { status: listed.code === "not_found" ? 404 : 400 });
  }
  return Response.json(listed);
}

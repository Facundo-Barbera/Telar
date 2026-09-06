import fs from "node:fs";
import path from "node:path";

/**
 * WHICH TELAR THIS IS: the name this build wears, the stream it follows, and
 * the icon it draws. Read off the packaging artefacts this process can already
 * see — no engine call, no daemon import, no network.
 *
 * It exists because two paired instances are otherwise indistinguishable from a
 * phone: a nightly and a release both answer `/api/about` with the same version
 * and both draw the same blue loom. The SHELL already solves this for itself —
 * `windowTitle()` writes "Telar Dev" into the title bar and
 * `developmentIconPath()` swaps in the amber icon (apps/desktop/main.js) — but
 * a remote client sees neither a title bar nor a dock, so the same two facts
 * have to travel over the wire.
 *
 * `env` and `cwd` are INJECTABLE, the way `engineRootFromWebEnv` takes its env:
 * the tests stand up a layout on disk rather than asserting against whichever
 * directory the runner happened to start in.
 */

/**
 * `beta` is deliberately absent. To a remote client the question is "is this a
 * throwaway checkout, a stream that reinstalls itself, or a build somebody cut"
 * — and a beta is a build somebody cut. A fourth value would be one more case
 * every client has to handle in order to say something no client acts on.
 */
export type Channel = "stable" | "dev" | "nightly";

export type BuildIdentity = {
  appName: string;
  channel: Channel;
  /** Absent when no layout on this machine has an icon to serve, which is what
   *  keeps `/api/about` from advertising a URL that 404s. */
  icon?: { path: string; key: string };
};

const DEFAULT_APP_NAME = "Telar";

/**
 * What `scripts/build-desktop.sh` and `scripts/package-desktop.sh` stamp into
 * the standalone tree at package time. Its PRESENCE is the honest test for
 * "this is a packaged build" — the file is written by the packaging script and
 * only ever lands beside a standalone server.
 */
type BuildStamp = { shortSha?: string; channel?: string };

function readBuildStamp(cwd: string): BuildStamp | undefined {
  // server.js chdir's to <standalone>/apps/web; the stamp sits at the root of
  // the tree electron-builder copies. ONE candidate on purpose — the dev-repo
  // path (.next-desktop/standalone/build-info.json) holds whatever the last
  // local packaging run produced, and a dev server is not that build.
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(cwd, "..", "..", "build-info.json"), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as BuildStamp) : undefined;
  } catch {
    // Absent, malformed, unreadable — all mean the same thing here.
    return undefined;
  }
}

/**
 * The shell's `productName`: the field that names the .app bundle AND the
 * userData directory (apps/desktop/package.json). Readable from a checkout,
 * where the two apps are siblings. Inside a packaged build it lives in
 * app.asar, which a forked Node server cannot open — and "Telar" is the answer
 * it would have given anyway.
 */
function productName(cwd: string): string | undefined {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "..", "desktop", "package.json"), "utf8")) as {
      productName?: string;
      build?: { productName?: string };
    };
    const name = pkg.build?.productName ?? pkg.productName;
    return typeof name === "string" && name.trim() ? name.trim() : undefined;
  } catch {
    return undefined;
  }
}

function resolveChannel(stamp: BuildStamp | undefined): Channel {
  // `--channel nightly` is the flag that picks the version's prerelease tag and
  // the update feed it publishes to (scripts/build-desktop.sh, which delegates
  // the version scheme to scripts/set-desktop-version.mjs). That flag is the
  // only place this answer can honestly come from — a port number or an install
  // path would just be a guess wearing a type.
  if (stamp?.channel?.trim() === "nightly") return "nightly";
  // `package-desktop.sh --dev` stamps this: a packaged build that is still a
  // throwaway checkout, and says so to a phone the same way the shell's title
  // bar does. A plain working-tree package stamps "local" and stays "stable" —
  // it is the build somebody cut, on their own machine.
  if (stamp?.channel?.trim() === "dev") return "dev";
  // Stamped but not a nightly: a build somebody cut, `beta` included.
  if (stamp) return "stable";
  // No stamp at all: this server was started from a checkout, which is exactly
  // the condition the shell calls "Telar Dev".
  return "dev";
}

/**
 * The channel's own icon first, then the default — the same order
 * `developmentIconPath()` walks in the shell. A build with no icon of its own
 * wears the plain one rather than none.
 */
function iconNames(channel: Channel): string[] {
  return channel === "stable" ? ["icon.png"] : [`icon-${channel}.png`, "icon.png"];
}

function iconDirs(cwd: string): string[] {
  return [
    // PACKAGED: electron-builder copies the shell's PNGs to <Resources>/branding
    // (apps/desktop/package.json → build.extraResources), three hops above the
    // standalone server's own directory.
    path.join(cwd, "..", "..", "..", "branding"),
    // DEV REPO: `next dev` runs in apps/web, one hop from the shell's build dir.
    path.join(cwd, "..", "desktop", "build"),
  ];
}

function resolveIcon(cwd: string, channel: Channel): BuildIdentity["icon"] {
  for (const dir of iconDirs(cwd)) {
    for (const name of iconNames(channel)) {
      const file = path.join(dir, name);
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile()) continue;
        // WHAT MAKES THE IMMUTABLE CACHE HONEST — the same bargain project icons
        // strike (lib/project-avatar.ts): a key that moves when the bytes do, so
        // a rebuilt instance gets a new URL instead of a year-stale image. Size
        // and mtime rather than a digest, because /api/about must not read a
        // megabyte off disk to answer a question about a name.
        return { path: file, key: `${stat.size.toString(36)}-${Math.trunc(stat.mtimeMs).toString(36)}` };
      } catch {
        // Missing or unreadable — try the next name, then the next layout.
      }
    }
  }
  return undefined;
}

/**
 * THE DIRECTORY THE WEB SERVER RUNS IN — what every layout above is measured
 * from: `apps/web` in a checkout, `<standalone>/apps/web` when packaged.
 *
 * It was taken to BE the process cwd, which holds for `next dev` and for the
 * standalone `server.js` (which chdir's there) and fails for anything started
 * at the repository root. There `../desktop` resolves OUTSIDE the repository
 * altogether, so the name and the icon silently fell back to their defaults —
 * caught by the route tests, which pass from `apps/web` and fail from the root.
 *
 * One probe, not a walk: the repo root is the only other place anything starts
 * from, and a layout that has neither `apps/web/package.json` nor the siblings
 * this file wants is not a layout it can read anyway.
 */
function webRoot(cwd: string): string {
  const nested = path.join(cwd, "apps", "web");
  try {
    if (fs.statSync(path.join(nested, "package.json")).isFile()) return nested;
  } catch {
    // Not a repository root, so `cwd` is the web root itself — or nothing is,
    // and every lookup below falls into its own default, which is the honest
    // answer for a layout this cannot read.
  }
  return cwd;
}

export function buildIdentity(
  env: { TELAR_APP_NAME?: string } = process.env as { TELAR_APP_NAME?: string },
  cwd: string = process.cwd(),
): BuildIdentity {
  const root = webRoot(cwd);
  const channel = resolveChannel(readBuildStamp(root));
  const icon = resolveIcon(root, channel);
  // An explicit name wins outright: it is how somebody running two checkouts at
  // once tells them apart, and no derived name can second-guess that.
  const override = env.TELAR_APP_NAME?.trim();
  if (override) return { appName: override, channel, icon };
  // Only DERIVED names take the channel suffix, and "Telar Dev" is not invented
  // here — it is the string the shell has always put in the title bar, said to
  // a client that cannot see one.
  const suffix = channel === "dev" ? " Dev" : channel === "nightly" ? " Nightly" : "";
  return { appName: `${productName(root) ?? DEFAULT_APP_NAME}${suffix}`, channel, icon };
}

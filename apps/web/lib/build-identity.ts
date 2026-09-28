import fs from "node:fs";
import path from "node:path";

export type Channel = "stable" | "dev" | "nightly";

export type BuildIdentity = {
  appName: string;
  channel: Channel;
  /** Absent when no layout has an icon, so `/api/about` never advertises a 404. */
  icon?: { path: string; key: string };
};

const DEFAULT_APP_NAME = "Telar";

/** Stamped by the packaging scripts; its presence means a packaged build. */
type BuildStamp = { shortSha?: string; channel?: string };

function readBuildStamp(cwd: string): BuildStamp | undefined {
  // server.js chdirs to <standalone>/apps/web; the stamp sits at the tree root.
  // Only one candidate: the dev-repo stamp describes a past packaging run, not this server.
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(cwd, "..", "..", "build-info.json"), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as BuildStamp) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The shell's `productName`, readable only from a checkout: in a packaged build it
 * lives in app.asar, which a forked Node server cannot open.
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
  if (stamp?.channel?.trim() === "nightly") return "nightly";
  // `package-desktop.sh --dev` stamps this; a plain working-tree package stamps "local".
  if (stamp?.channel?.trim() === "dev") return "dev";
  if (stamp) return "stable";
  return "dev";
}

/** The channel's own icon first, then the default, like `developmentIconPath()` in the shell. */
function iconNames(channel: Channel): string[] {
  return channel === "stable" ? ["icon.png"] : [`icon-${channel}.png`, "icon.png"];
}

function iconDirs(cwd: string): string[] {
  return [
    // Packaged: electron-builder copies the shell's PNGs to <Resources>/branding.
    path.join(cwd, "..", "..", "..", "branding"),
    // Dev repo: `next dev` runs in apps/web.
    path.join(cwd, "..", "desktop", "assets"),
  ];
}

function resolveIcon(cwd: string, channel: Channel): BuildIdentity["icon"] {
  for (const dir of iconDirs(cwd)) {
    for (const name of iconNames(channel)) {
      const file = path.join(dir, name);
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile()) continue;
        // Key moves with the bytes so the immutable cache stays honest; size and
        // mtime rather than a digest to avoid reading the file.
        return { path: file, key: `${stat.size.toString(36)}-${Math.trunc(stat.mtimeMs).toString(36)}` };
      } catch {
        // Missing or unreadable: try the next candidate.
      }
    }
  }
  return undefined;
}

/**
 * `apps/web` in a checkout, `<standalone>/apps/web` when packaged. Probes for
 * a process started at the repository root, where `../desktop` would miss.
 */
function webRoot(cwd: string): string {
  const nested = path.join(cwd, "apps", "web");
  try {
    if (fs.statSync(path.join(nested, "package.json")).isFile()) return nested;
  } catch {
    // Not a repository root, so `cwd` is the web root itself.
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
  const override = env.TELAR_APP_NAME?.trim();
  if (override) return { appName: override, channel, icon };
  const suffix = channel === "dev" ? " Dev" : channel === "nightly" ? " Nightly" : "";
  return { appName: `${productName(root) ?? DEFAULT_APP_NAME}${suffix}`, channel, icon };
}

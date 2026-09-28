import fs from "node:fs";
import path from "node:path";
import type { BuildChannel as Channel } from "@telar/engine-client";

export type BuildIdentity = {
  appName: string;
  channel: Channel;
  icon?: { path: string; key: string };
};

const DEFAULT_APP_NAME = "Telar";

type BuildStamp = { shortSha?: string; channel?: string };

function readBuildStamp(cwd: string): BuildStamp | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(cwd, "..", "..", "build-info.json"), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as BuildStamp) : undefined;
  } catch {
    return undefined;
  }
}

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
  if (stamp?.channel?.trim() === "dev") return "dev";
  if (stamp) return "stable";
  return "dev";
}

function iconNames(channel: Channel): string[] {
  return channel === "stable" ? ["icon.png"] : [`icon-${channel}.png`, "icon.png"];
}

function iconDirs(cwd: string): string[] {
  return [
    path.join(cwd, "..", "..", "..", "branding"),
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
        return { path: file, key: `${stat.size.toString(36)}-${Math.trunc(stat.mtimeMs).toString(36)}` };
      } catch {
      }
    }
  }
  return undefined;
}

export function locateWebRoot(from: string = process.cwd()): string {
  for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
    for (const candidate of [path.join(dir, "standalone", "apps", "web"), path.join(dir, "apps", "web")]) {
      if (fs.existsSync(candidate)) return candidate;
    }
    if (path.dirname(dir) === dir) return from;
  }
}

export function buildIdentity(
  env: { TELAR_APP_NAME?: string } = process.env as { TELAR_APP_NAME?: string },
  root: string = locateWebRoot(),
): BuildIdentity {
  const channel = resolveChannel(readBuildStamp(root));
  const icon = resolveIcon(root, channel);
  const override = env.TELAR_APP_NAME?.trim();
  if (override) return { appName: override, channel, icon };
  const suffix = channel === "dev" ? " Dev" : channel === "nightly" ? " Nightly" : "";
  return { appName: `${productName(root) ?? DEFAULT_APP_NAME}${suffix}`, channel, icon };
}

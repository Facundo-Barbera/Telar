// @ts-expect-error bun:test has no types in this app's tsconfig
import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GET as aboutGet } from "@/app/api/about/route";
import { GET as iconGet } from "@/app/api/about/icon/route";
import { buildIdentity } from "./build-identity";

const roots: string[] = [];
const savedCwd = process.cwd();

afterEach(() => {
  // The route handlers read the REAL `process.cwd()`, so a test that moves it
  // has to put it back or every later test file inherits a temp directory.
  process.chdir(savedCwd);
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/**
 * A layout on disk, because that is all `buildIdentity` reads.
 *
 * `web` stands in for the directory the server runs from — `apps/web` under
 * `next dev`, `<standalone>/apps/web` in a packaged app — and the siblings are
 * placed exactly where each of those two layouts puts them.
 */
function layout(options: { icons?: string[]; productName?: string } = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-build-identity-"));
  roots.push(root);
  const web = path.join(root, "web");
  fs.mkdirSync(web, { recursive: true });
  if (options.icons?.length) {
    const build = path.join(root, "desktop", "build");
    fs.mkdirSync(build, { recursive: true });
    for (const icon of options.icons) fs.writeFileSync(path.join(build, icon), pngBytes(icon));
  }
  if (options.productName) {
    fs.mkdirSync(path.join(root, "desktop"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "desktop", "package.json"),
      JSON.stringify({ name: "telar-desktop", productName: options.productName }),
    );
  }
  return web;
}

/** A stamped layout's server directory: <root>/standalone/apps/web. */
function packagedWeb(stamp: Record<string, unknown>, icons: string[] = []): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-build-identity-"));
  roots.push(root);
  const web = path.join(root, "standalone", "apps", "web");
  fs.mkdirSync(web, { recursive: true });
  fs.writeFileSync(path.join(root, "standalone", "build-info.json"), JSON.stringify(stamp));
  if (icons.length) {
    const branding = path.join(root, "branding");
    fs.mkdirSync(branding, { recursive: true });
    for (const icon of icons) fs.writeFileSync(path.join(branding, icon), pngBytes(icon));
  }
  return web;
}

/** Just enough of a PNG that the magic number is real and the files differ. */
function pngBytes(name: string): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Buffer.from(name, "utf8")]);
}

describe("build identity", () => {
  test("an unstamped checkout is the build the shell calls Telar Dev", () => {
    const identity = buildIdentity({}, layout({ icons: ["icon-dev.png", "icon.png"], productName: "Telar" }));
    expect(identity.channel).toBe("dev");
    expect(identity.appName).toBe("Telar Dev");
    // The AMBER icon, for the same reason the dock gets it: a dev shell wearing
    // the release icon is the thing this whole route exists to prevent.
    expect(path.basename(identity.icon!.path)).toBe("icon-dev.png");
  });

  test("the channel comes from the packaging stamp, and only from it", () => {
    expect(buildIdentity({}, packagedWeb({ shortSha: "abc1234", channel: "nightly" })).channel).toBe("nightly");
    expect(buildIdentity({}, packagedWeb({ shortSha: "abc1234", channel: "nightly" })).appName).toBe("Telar Nightly");
    // A stamped build with no channel flag is a build somebody cut…
    expect(buildIdentity({}, packagedWeb({ shortSha: "abc1234", channel: "" })).channel).toBe("stable");
    expect(buildIdentity({}, packagedWeb({ shortSha: "abc1234" })).appName).toBe("Telar");
    // …and so is a beta, which has no seat of its own in the wire type.
    expect(buildIdentity({}, packagedWeb({ channel: "beta" })).channel).toBe("stable");
  });

  test("a --dev package is stamped dev and named Telar Dev; a plain local package is not", () => {
    // What `package-desktop.sh --dev` writes: packaged, yet a checkout — the
    // phone must see the same name and amber icon the title bar shows.
    const dev = buildIdentity({}, packagedWeb({ shortSha: "abc1234", channel: "dev" }));
    expect(dev.channel).toBe("dev");
    expect(dev.appName).toBe("Telar Dev");
    // A plain working-tree package stamps "local" and reads as a cut build.
    const local = buildIdentity({}, packagedWeb({ shortSha: "abc1234", channel: "local" }));
    expect(local.channel).toBe("stable");
    expect(local.appName).toBe("Telar");
  });

  test("a malformed or absent stamp reads as a checkout rather than throwing", () => {
    const web = packagedWeb({ channel: "nightly" });
    fs.writeFileSync(path.join(web, "..", "..", "build-info.json"), "{ not json");
    expect(buildIdentity({}, web).channel).toBe("dev");
    expect(buildIdentity({}, path.join(os.tmpdir(), "telar-nonexistent-layout")).channel).toBe("dev");
  });

  test("a build with no icon of its own falls back to the default one", () => {
    // Only the plain icon on disk, on a channel that would have preferred its
    // own — the packaged case, where no icon-nightly.png has ever existed.
    const identity = buildIdentity({}, packagedWeb({ channel: "nightly" }, ["icon.png"]));
    expect(path.basename(identity.icon!.path)).toBe("icon.png");
  });

  test("no icon anywhere means no icon claimed", () => {
    expect(buildIdentity({}, layout()).icon).toBeUndefined();
  });

  test("the icon key moves when the bytes do, which is what the immutable cache rests on", () => {
    const web = layout({ icons: ["icon.png"] });
    const first = buildIdentity({}, web).icon!.key;
    const file = path.join(web, "..", "desktop", "build", "icon.png");
    fs.writeFileSync(file, pngBytes("a rather longer icon than before"));
    expect(buildIdentity({}, web).icon!.key).not.toBe(first);
  });

  test("productName names the app, and TELAR_APP_NAME overrides it outright", () => {
    const web = layout({ productName: "Telar Fork" });
    expect(buildIdentity({}, web).appName).toBe("Telar Fork Dev");
    // No suffix on an explicit name: somebody who typed it meant it.
    expect(buildIdentity({ TELAR_APP_NAME: "  Downstairs Mac  " }, web).appName).toBe("Downstairs Mac");
    expect(buildIdentity({ TELAR_APP_NAME: "   " }, web).appName).toBe("Telar Fork Dev");
  });
});

describe("about routes", () => {
  test("about carries the identity beside the version, with no engine in reach", async () => {
    const body = (await (await aboutGet()).json()) as {
      appVersion: string;
      appName: string;
      channel: string;
      iconUrl?: string;
    };
    expect(typeof body.appVersion).toBe("string");
    // This suite runs from a checkout, so the route must report the same thing
    // the shell's title bar would.
    expect(body.channel).toBe("dev");
    expect(body.appName).toBe("Telar Dev");
    expect(body.iconUrl).toMatch(/^\/api\/about\/icon\?v=/);
  });

  test("the icon route answers PNG bytes under an immutable cache", async () => {
    const response = iconGet();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
  });

  test("the icon route serves the DEFAULT icon when this build has no custom one", async () => {
    // A layout with only the plain icon, entered the way the packaged server
    // enters its own: by chdir'ing to the directory it will read from.
    process.chdir(layout({ icons: ["icon.png"] }));
    const response = iconGet();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(new TextDecoder().decode(await response.arrayBuffer())).toContain("icon.png");
  });

  test("no icon on this layout is a 404, and about stops advertising one", async () => {
    process.chdir(layout());
    expect(iconGet().status).toBe(404);
    const body = (await (await aboutGet()).json()) as { iconUrl?: string; appName: string };
    expect(body.iconUrl).toBeUndefined();
    expect(body.appName).toBe("Telar Dev");
  });
});

test("the layout is found from the repository root, not only from apps/web", () => {
  // What broke: every path was a fixed hop count from the process cwd, so a
  // runner starting at the root resolved `../desktop` outside the repository
  // and fell back to the defaults. Both entry points must agree.
  // The runner may start in either place, so find the root rather than assume.
  const repoRoot = fs.existsSync(path.join(savedCwd, "apps", "web", "package.json")) ? savedCwd : path.resolve(savedCwd, "..", "..");
  const fromWeb = buildIdentity({}, path.join(repoRoot, "apps", "web"));
  const fromRoot = buildIdentity({}, repoRoot);
  expect(fromRoot.appName).toBe(fromWeb.appName);
  expect(fromRoot.channel).toBe(fromWeb.channel);
  expect(fromRoot.icon?.path).toBe(fromWeb.icon?.path);
});

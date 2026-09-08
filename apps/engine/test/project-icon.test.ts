/**
 * The icon finder is a CANDIDATE LIST over somebody's working tree, and every
 * judgement in it is a refusal: not an image, empty file, oversized file,
 * symlink escaping the checkout. What it accepts, the daemon serves to any
 * client — so the refusals are the security surface.
 *
 * The fixtures are REAL HEADERS, not the string "png-bytes" the first cut of
 * these tests used, because the finder now sniffs. That change is the point of
 * several tests below: a file's NAME is a claim about its type and its BYTES
 * are the fact, and the daemon declares a content type from this answer.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { candidatesForHref, confirmProjectIcon, confirmProjectIconSync, extractIconHref, findProjectIcon, findProjectIconAsync, readProjectIconBytes } from "../src/project-icon";

const roots: string[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-icon-"));
  roots.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

/* --- fixtures: the smallest bytes each format is recognised by --- */
const png = (tail = "one"): Buffer => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(tail)]);
const ico = (tail = "one"): Buffer => Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0x00]), Buffer.from(tail)]);
const svg = (tail = ""): Buffer => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">${tail}</svg>`);

const put = (base: string, relative: string, bytes: string | Buffer = png()): string => {
  const target = path.join(base, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return target;
};

/* ------------------------------------------------------------------ *
 * Priority
 * ------------------------------------------------------------------ */

test("an explicit .telar icon beats every convention below it", () => {
  const project = root();
  put(project, "favicon.ico", ico());
  put(project, ".telar/icon.png", png());
  const icon = findProjectIcon(project)!;
  expect(icon.path.endsWith(path.join(".telar", "icon.png"))).toBe(true);
  expect(icon.contentType).toBe("image/png");
});

test("a Next-style public favicon is found; a project with nothing answers undefined", () => {
  const project = root();
  expect(findProjectIcon(project)).toBeUndefined();
  put(project, "public/favicon.ico", ico());
  expect(findProjectIcon(project)?.contentType).toBe("image/x-icon");
});

test("a well-known path outranks an href a source file declares", () => {
  // Both are real answers; the conventional location is the more reliable one,
  // and a stated order is what stops the answer depending on directory reads.
  const project = root();
  put(project, "public/favicon.svg", svg());
  put(project, "public/declared.png", png());
  put(project, "index.html", `<link rel="icon" href="/declared.png">`);
  expect(findProjectIcon(project)!.path.endsWith(path.join("public", "favicon.svg"))).toBe(true);
});

test("the root's own layouts outrank a monorepo child's", () => {
  const project = root();
  put(project, "apps/web/public/favicon.ico", ico());
  put(project, "assets/icon.png", png());
  expect(findProjectIcon(project)!.path.endsWith(path.join("assets", "icon.png"))).toBe(true);
});

/* ------------------------------------------------------------------ *
 * Layouts the old candidate list could not reach
 * ------------------------------------------------------------------ */

test("a Vite app is found through the href its index.html declares", () => {
  // THE MISS THIS STAGE EXISTS FOR. A plain `bun create vite` app keeps its
  // icon at `public/vite.svg` — a name no candidate list would ever guess, and
  // the only thing that points at it is the <link> in index.html.
  const project = root();
  put(project, "public/vite.svg", svg());
  put(project, "index.html", `<!doctype html><html><head>\n<link rel="icon" type="image/svg+xml" href="/vite.svg" />\n<title>app</title>\n</head></html>`);
  const icon = findProjectIcon(project)!;
  expect(icon.path.endsWith(path.join("public", "vite.svg"))).toBe(true);
  expect(icon.contentType).toBe("image/svg+xml");
});

test("an href with no leading slash resolves beside the source file too", () => {
  const project = root();
  put(project, "brand/mark.png", png());
  put(project, "index.html", `<link rel="shortcut icon" href="brand/mark.png?v=3">`);
  expect(findProjectIcon(project)!.path.endsWith(path.join("brand", "mark.png"))).toBe(true);
});

test("a router root file declaring icon metadata is read as well as HTML", () => {
  const project = root();
  put(project, "public/mark.png", png());
  put(project, "src/routes/__root.tsx", `export const Route = createRootRoute({ head: () => ({ links: [{ rel: "icon", href: "/mark.png" }] }) })`);
  expect(findProjectIcon(project)!.path.endsWith(path.join("public", "mark.png"))).toBe(true);
});

test("a monorepo with no app at its root answers from its children, alphabetically", () => {
  // Telar's own repository is this shape: apps/ and packages/, nothing at the
  // top. Every stage above this one finds nothing at all.
  const project = root();
  put(project, "apps/web/public/favicon.ico", ico());
  put(project, "apps/api/public/favicon.ico", ico());
  const icon = findProjectIcon(project)!;
  expect(icon.path.includes(path.join("apps", "api"))).toBe(true);
  // Deterministic: the same checkout answers the same on every machine, which
  // is why children are sorted rather than taken in readdir order.
  expect(findProjectIcon(project)!.path).toBe(icon.path);
});

test("packages/ is searched when apps/ has nothing", () => {
  const project = root();
  put(project, "apps/api/README.md", "no icon here");
  put(project, "packages/ui/assets/icon.svg", svg());
  expect(findProjectIcon(project)!.path.includes(path.join("packages", "ui"))).toBe(true);
});

/* ------------------------------------------------------------------ *
 * Refusals
 * ------------------------------------------------------------------ */

test("empty and oversized files are refused, so the fallback avatar wins instead", () => {
  const project = root();
  put(project, "icon.png", "");
  expect(findProjectIcon(project)).toBeUndefined();
  put(project, "icon.png", Buffer.concat([png(), Buffer.alloc(1024 * 1024)]));
  expect(findProjectIcon(project)).toBeUndefined();
});

test("a file that is not an image is refused, and the next candidate wins", () => {
  // A `favicon.ico` that is really the HTML of a proxy's error page is a real
  // thing to find in a checkout. Serving it as image/x-icon hands the browser
  // a broken image and the fallback avatar never gets its chance.
  const project = root();
  put(project, "favicon.ico", "<!doctype html><title>404 Not Found</title>");
  put(project, "assets/icon.png", png());
  expect(findProjectIcon(project)!.path.endsWith(path.join("assets", "icon.png"))).toBe(true);
});

test("the content type comes from the BYTES, not from the candidate's name", () => {
  const project = root();
  put(project, "icon.svg", png()); // a PNG somebody named .svg
  expect(findProjectIcon(project)!.contentType).toBe("image/png");
});

test("a declared href pointing outside the checkout, or off the machine, is dropped", () => {
  const project = root();
  put(project, "public/real.png", png());
  put(project, "index.html", `<link rel="icon" href="https://cdn.example.com/logo.png">`);
  expect(findProjectIcon(project)).toBeUndefined();
  expect(candidatesForHref("../../etc/hosts.png")).toEqual([]);
  expect(candidatesForHref("data:image/png;base64,AAAA")).toEqual([]);
  expect(candidatesForHref("/mark.png")).toEqual([path.join("public", "mark.png"), "mark.png"]);
});

test("a symlink escaping the checkout is refused, not followed", () => {
  // The route serves these bytes to any client; a project must not be able to
  // publish an arbitrary file by symlinking favicon.ico at it.
  const project = root();
  const outside = put(root(), "secret.png", png("outside"));
  fs.symlinkSync(outside, path.join(project, "icon.png"));
  expect(findProjectIcon(project)).toBeUndefined();
  // A symlink WITHIN the checkout is fine — that is just how some repos lay
  // out their assets.
  put(project, "assets/real.png", png("inside"));
  fs.symlinkSync(path.join(project, "assets/real.png"), path.join(project, "icon.svg"));
  const icon = findProjectIcon(project)!;
  expect(icon).toBeDefined();
  // …and it is served as what it IS. The old finder took the type from the
  // candidate NAME and would have declared this PNG an SVG.
  expect(icon.contentType).toBe("image/png");
});

test("a checkout that is not there at all answers undefined rather than throwing", () => {
  expect(findProjectIcon(path.join(root(), "gone"))).toBeUndefined();
});

/* ------------------------------------------------------------------ *
 * Change detection
 * ------------------------------------------------------------------ */

test("the etag changes when the file does — that is what makes immutable caching honest", () => {
  const project = root();
  const target = put(project, "icon.png", png("one"));
  const first = findProjectIcon(project)!.etag;
  // A different size is a different file; mtime alone can collide within a tick.
  fs.writeFileSync(target, png("two-longer"));
  expect(findProjectIcon(project)!.etag).not.toBe(first);
});

test("confirming a known icon re-derives its etag, and reports a vanished one", async () => {
  // This is the one `stat` a cache hit costs, and the reason a replaced icon
  // shows up on the next poll instead of at the end of a TTL.
  const project = root();
  const target = put(project, "icon.png", png("one"));
  const icon = findProjectIcon(project)!;
  expect(await confirmProjectIcon(icon)).toEqual(icon);
  fs.writeFileSync(target, png("two-longer"));
  const changed = await confirmProjectIcon(icon);
  expect(changed!.path).toBe(icon.path);
  expect(changed!.etag).not.toBe(icon.etag);
  fs.rmSync(target);
  expect(await confirmProjectIcon(icon)).toBeUndefined();
});

/* ------------------------------------------------------------------ *
 * The two drivers must not be able to disagree
 * ------------------------------------------------------------------ */

test("the async finder gives the same answer as the sync one, on every layout above", async () => {
  const layouts: Array<(base: string) => void> = [
    (base) => put(base, "public/favicon.ico", ico()),
    (base) => {
      put(base, ".telar/icon.svg", svg());
      put(base, "favicon.ico", ico());
    },
    (base) => {
      put(base, "public/vite.svg", svg());
      put(base, "index.html", `<link rel="icon" href="/vite.svg">`);
    },
    (base) => put(base, "apps/web/public/icon.png", png()),
    (base) => put(base, "favicon.ico", "not an image at all"),
  ];
  for (const layout of layouts) {
    const project = root();
    layout(project);
    expect(await findProjectIconAsync(project)).toEqual(findProjectIcon(project));
  }
});

/* ------------------------------------------------------------------ *
 * The href parser, on its own
 * ------------------------------------------------------------------ */

test("the href parser reads both forms and ignores a rel without an href", () => {
  expect(extractIconHref(`<link rel="icon" href="/a.png">`)).toBe("/a.png");
  expect(extractIconHref(`<link href="/b.svg" rel="icon">`)).toBe("/b.svg");
  expect(extractIconHref(`<link rel="stylesheet" href="/c.css">`)).toBeNull();
  // A run holding `rel` but no href falls through to the next one rather than
  // ending the search.
  expect(extractIconHref(`links: [{ rel: "icon" }, { rel: "icon", href: "/d.png" }]`)).toBe("/d.png");
  expect(extractIconHref("nothing here")).toBeNull();
});

/* ------------------------------------------------------------------ *
 * A cached answer is a memory, not a standing guarantee
 *
 * Everything a stored ProjectIcon asserts was true when it was resolved.
 * Confirmation and serving both re-establish it, because between those two
 * moments the file is somebody's working tree and can become anything.
 * ------------------------------------------------------------------ */

test("a cached PNG replaced by an SVG is re-typed, not served under the old type", async () => {
  const project = root();
  const target = put(project, "icon.png", png("one"));
  const icon = findProjectIcon(project)!;
  expect(icon.contentType).toBe("image/png");
  fs.writeFileSync(target, svg("<rect/>"));
  const confirmed = (await confirmProjectIcon(icon))!;
  expect(confirmed.contentType).toBe("image/svg+xml");
  expect(confirmed.etag).not.toBe(icon.etag);
  expect(confirmProjectIconSync(icon)!.contentType).toBe("image/svg+xml");
});

test("a cached icon replaced by something that is not an image is refused", async () => {
  const project = root();
  const target = put(project, "icon.png", png("one"));
  const icon = findProjectIcon(project)!;
  fs.writeFileSync(target, "<!doctype html><title>whoops</title>");
  expect(await confirmProjectIcon(icon)).toBeUndefined();
  expect(confirmProjectIconSync(icon)).toBeUndefined();
  expect(await readProjectIconBytes(icon)).toBeUndefined();
});

test("a cached icon replaced by a symlink out of the checkout is refused, not followed", async () => {
  // The confinement check ran once, when the file was found. Without redoing
  // it, swapping that file for a link to /etc/hosts publishes /etc/hosts —
  // the record still says "this path was inside the checkout".
  const project = root();
  const outside = put(root(), "secret.png", png("outside-bytes"));
  const target = put(project, "icon.png", png("inside"));
  const icon = findProjectIcon(project)!;
  expect((await readProjectIconBytes(icon))!.bytes.toString()).toContain("inside");
  fs.rmSync(target);
  fs.symlinkSync(outside, target);
  expect(await confirmProjectIcon(icon)).toBeUndefined();
  expect(confirmProjectIconSync(icon)).toBeUndefined();
  expect(await readProjectIconBytes(icon)).toBeUndefined();
});

test("serving re-checks the size bound against the file being read", async () => {
  const project = root();
  const target = put(project, "icon.png", png("small"));
  const icon = findProjectIcon(project)!;
  expect(await readProjectIconBytes(icon)).toBeDefined();
  // Grown past the bound since it was resolved: refused rather than truncated
  // into bytes the etag does not describe.
  fs.writeFileSync(target, Buffer.concat([png(), Buffer.alloc(1024 * 1024)]));
  expect(await readProjectIconBytes(icon)).toBeUndefined();
});

test("serving a deleted icon answers undefined, which the route turns into a 404", async () => {
  const project = root();
  const target = put(project, "icon.png", png());
  const icon = findProjectIcon(project)!;
  fs.rmSync(target);
  expect(await readProjectIconBytes(icon)).toBeUndefined();
});

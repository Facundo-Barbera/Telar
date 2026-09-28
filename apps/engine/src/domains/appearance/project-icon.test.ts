import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { candidatesForHref, confirmProjectIcon, extractIconHref, findProjectIconAsync, readProjectIconBytes } from "./project-icon";

const roots: string[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-icon-"));
  roots.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const png = (tail = "one"): Buffer => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from(tail)]);
const ico = (tail = "one"): Buffer => Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0x00]), Buffer.from(tail)]);
const svg = (tail = ""): Buffer => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1">${tail}</svg>`);

const put = (base: string, relative: string, bytes: string | Buffer = png()): string => {
  const target = path.join(base, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return target;
};

test("an explicit .telar icon beats every convention below it", async () => {
  const project = root();
  put(project, "favicon.ico", ico());
  put(project, ".telar/icon.png", png());
  const icon = (await findProjectIconAsync(project))!;
  expect(icon.path.endsWith(path.join(".telar", "icon.png"))).toBe(true);
  expect(icon.contentType).toBe("image/png");
});

test("a Next-style public favicon is found; a project with nothing answers undefined", async () => {
  const project = root();
  expect((await findProjectIconAsync(project))).toBeUndefined();
  put(project, "public/favicon.ico", ico());
  expect((await findProjectIconAsync(project))?.contentType).toBe("image/x-icon");
});

test("a well-known path outranks an href a source file declares", async () => {
  const project = root();
  put(project, "public/favicon.svg", svg());
  put(project, "public/declared.png", png());
  put(project, "index.html", `<link rel="icon" href="/declared.png">`);
  expect((await findProjectIconAsync(project))!.path.endsWith(path.join("public", "favicon.svg"))).toBe(true);
});

test("the root's own layouts outrank a monorepo child's", async () => {
  const project = root();
  put(project, "apps/web/public/favicon.ico", ico());
  put(project, "assets/icon.png", png());
  expect((await findProjectIconAsync(project))!.path.endsWith(path.join("assets", "icon.png"))).toBe(true);
});

test("a Vite app is found through the href its index.html declares", async () => {
  const project = root();
  put(project, "public/vite.svg", svg());
  put(project, "index.html", `<!doctype html><html><head>\n<link rel="icon" type="image/svg+xml" href="/vite.svg" />\n<title>app</title>\n</head></html>`);
  const icon = (await findProjectIconAsync(project))!;
  expect(icon.path.endsWith(path.join("public", "vite.svg"))).toBe(true);
  expect(icon.contentType).toBe("image/svg+xml");
});

test("an href with no leading slash resolves beside the source file too", async () => {
  const project = root();
  put(project, "brand/mark.png", png());
  put(project, "index.html", `<link rel="shortcut icon" href="brand/mark.png?v=3">`);
  expect((await findProjectIconAsync(project))!.path.endsWith(path.join("brand", "mark.png"))).toBe(true);
});

test("a router root file declaring icon metadata is read as well as HTML", async () => {
  const project = root();
  put(project, "public/mark.png", png());
  put(project, "src/routes/__root.tsx", `export const Route = createRootRoute({ head: () => ({ links: [{ rel: "icon", href: "/mark.png" }] }) })`);
  expect((await findProjectIconAsync(project))!.path.endsWith(path.join("public", "mark.png"))).toBe(true);
});

test("a monorepo with no app at its root answers from its children, alphabetically", async () => {
  const project = root();
  put(project, "apps/web/public/favicon.ico", ico());
  put(project, "apps/api/public/favicon.ico", ico());
  const icon = (await findProjectIconAsync(project))!;
  expect(icon.path.includes(path.join("apps", "api"))).toBe(true);
  expect((await findProjectIconAsync(project))!.path).toBe(icon.path);
});

test("packages/ is searched when apps/ has nothing", async () => {
  const project = root();
  put(project, "apps/api/README.md", "no icon here");
  put(project, "packages/ui/assets/icon.svg", svg());
  expect((await findProjectIconAsync(project))!.path.includes(path.join("packages", "ui"))).toBe(true);
});

test("empty and oversized files are refused, so the fallback avatar wins instead", async () => {
  const project = root();
  put(project, "icon.png", "");
  expect((await findProjectIconAsync(project))).toBeUndefined();
  put(project, "icon.png", Buffer.concat([png(), Buffer.alloc(1024 * 1024)]));
  expect((await findProjectIconAsync(project))).toBeUndefined();
});

test("a file that is not an image is refused, and the next candidate wins", async () => {
  const project = root();
  put(project, "favicon.ico", "<!doctype html><title>404 Not Found</title>");
  put(project, "assets/icon.png", png());
  expect((await findProjectIconAsync(project))!.path.endsWith(path.join("assets", "icon.png"))).toBe(true);
});

test("the content type comes from the BYTES, not from the candidate's name", async () => {
  const project = root();
  put(project, "icon.svg", png()); // a PNG somebody named .svg
  expect((await findProjectIconAsync(project))!.contentType).toBe("image/png");
});

test("a declared href pointing outside the checkout, or off the machine, is dropped", async () => {
  const project = root();
  put(project, "public/real.png", png());
  put(project, "index.html", `<link rel="icon" href="https://cdn.example.com/logo.png">`);
  expect((await findProjectIconAsync(project))).toBeUndefined();
  expect(candidatesForHref("../../etc/hosts.png")).toEqual([]);
  expect(candidatesForHref("data:image/png;base64,AAAA")).toEqual([]);
  expect(candidatesForHref("/mark.png")).toEqual([path.join("public", "mark.png"), "mark.png"]);
});

test("a symlink escaping the checkout is refused, not followed", async () => {
  const project = root();
  const outside = put(root(), "secret.png", png("outside"));
  fs.symlinkSync(outside, path.join(project, "icon.png"));
  expect((await findProjectIconAsync(project))).toBeUndefined();
  put(project, "assets/real.png", png("inside"));
  fs.symlinkSync(path.join(project, "assets/real.png"), path.join(project, "icon.svg"));
  const icon = (await findProjectIconAsync(project))!;
  expect(icon).toBeDefined();
  expect(icon.contentType).toBe("image/png");
});

test("a checkout that is not there at all answers undefined rather than throwing", async () => {
  expect(await findProjectIconAsync(path.join(root(), "gone"))).toBeUndefined();
});

test("the etag changes when the file does — that is what makes immutable caching honest", async () => {
  const project = root();
  const target = put(project, "icon.png", png("one"));
  const first = (await findProjectIconAsync(project))!.etag;
  fs.writeFileSync(target, png("two-longer"));
  expect((await findProjectIconAsync(project))!.etag).not.toBe(first);
});

test("confirming a known icon re-derives its etag, and reports a vanished one", async () => {
  const project = root();
  const target = put(project, "icon.png", png("one"));
  const icon = (await findProjectIconAsync(project))!;
  expect(await confirmProjectIcon(icon)).toEqual(icon);
  fs.writeFileSync(target, png("two-longer"));
  const changed = await confirmProjectIcon(icon);
  expect(changed!.path).toBe(icon.path);
  expect(changed!.etag).not.toBe(icon.etag);
  fs.rmSync(target);
  expect(await confirmProjectIcon(icon)).toBeUndefined();
});

test("the href parser reads both forms and ignores a rel without an href", async () => {
  expect(extractIconHref(`<link rel="icon" href="/a.png">`)).toBe("/a.png");
  expect(extractIconHref(`<link href="/b.svg" rel="icon">`)).toBe("/b.svg");
  expect(extractIconHref(`<link rel="stylesheet" href="/c.css">`)).toBeNull();
  expect(extractIconHref(`links: [{ rel: "icon" }, { rel: "icon", href: "/d.png" }]`)).toBe("/d.png");
  expect(extractIconHref("nothing here")).toBeNull();
});

test("a cached PNG replaced by an SVG is re-typed, not served under the old type", async () => {
  const project = root();
  const target = put(project, "icon.png", png("one"));
  const icon = (await findProjectIconAsync(project))!;
  expect(icon.contentType).toBe("image/png");
  fs.writeFileSync(target, svg("<rect/>"));
  const confirmed = (await confirmProjectIcon(icon))!;
  expect(confirmed.contentType).toBe("image/svg+xml");
  expect(confirmed.etag).not.toBe(icon.etag);
});

test("a cached icon replaced by something that is not an image is refused", async () => {
  const project = root();
  const target = put(project, "icon.png", png("one"));
  const icon = (await findProjectIconAsync(project))!;
  fs.writeFileSync(target, "<!doctype html><title>whoops</title>");
  expect(await confirmProjectIcon(icon)).toBeUndefined();
  expect(await readProjectIconBytes(icon)).toBeUndefined();
});

test("a cached icon replaced by a symlink out of the checkout is refused, not followed", async () => {
  const project = root();
  const outside = put(root(), "secret.png", png("outside-bytes"));
  const target = put(project, "icon.png", png("inside"));
  const icon = (await findProjectIconAsync(project))!;
  expect((await readProjectIconBytes(icon))!.bytes.toString()).toContain("inside");
  fs.rmSync(target);
  fs.symlinkSync(outside, target);
  expect(await confirmProjectIcon(icon)).toBeUndefined();
  expect(await readProjectIconBytes(icon)).toBeUndefined();
});

test("serving re-checks the size bound against the file being read", async () => {
  const project = root();
  const target = put(project, "icon.png", png("small"));
  const icon = (await findProjectIconAsync(project))!;
  expect(await readProjectIconBytes(icon)).toBeDefined();
  fs.writeFileSync(target, Buffer.concat([png(), Buffer.alloc(1024 * 1024)]));
  expect(await readProjectIconBytes(icon)).toBeUndefined();
});

test("serving a deleted icon answers undefined, which the route turns into a 404", async () => {
  const project = root();
  const target = put(project, "icon.png", png());
  const icon = (await findProjectIconAsync(project))!;
  fs.rmSync(target);
  expect(await readProjectIconBytes(icon)).toBeUndefined();
});

async function racing<T>(name: "realpath" | "open", during: () => void, body: () => Promise<T>): Promise<T> {
  const original = fs.promises[name] as (...args: never[]) => Promise<unknown>;
  let fired = false;
  (fs.promises as Record<string, unknown>)[name] = async (...args: never[]) => {
    const answer = await original(...args);
    if (!fired) {
      fired = true;
      during();
    }
    return answer;
  };
  try {
    return await body();
  } finally {
    (fs.promises as Record<string, unknown>)[name] = original;
  }
}

async function racingOnRead<T>(during: () => void, body: () => Promise<T>): Promise<T> {
  const open = fs.promises.open;
  let fired = false;
  (fs.promises as Record<string, unknown>).open = async (...args: never[]) => {
    const handle = (await (open as (...a: never[]) => Promise<fs.promises.FileHandle>)(...args)) as fs.promises.FileHandle;
    const read = handle.read.bind(handle);
    (handle as unknown as Record<string, unknown>).read = (...readArgs: never[]) => {
      if (!fired) {
        fired = true;
        during();
      }
      return (read as (...a: never[]) => unknown)(...readArgs);
    };
    return handle;
  };
  try {
    return await body();
  } finally {
    (fs.promises as Record<string, unknown>).open = open;
  }
}

test("a symlink swapped in AFTER the path check but BEFORE the open is refused", async () => {
  const project = root();
  const outside = put(root(), "secret.png", png("outside-bytes"));
  const target = put(project, "icon.png", png("inside-bytes"));
  const icon = (await findProjectIconAsync(project))!;

  const served = await racing("realpath", () => {
    fs.rmSync(target);
    fs.symlinkSync(outside, target);
  }, () => readProjectIconBytes(icon));

  expect(served).toBeUndefined();
  fs.rmSync(target);
  fs.writeFileSync(target, png("inside-bytes"));
  const confirmed = await racing("realpath", () => {
    fs.rmSync(target);
    fs.symlinkSync(outside, target);
  }, () => confirmProjectIcon(icon));
  expect(confirmed).toBeUndefined();
});

test("a file that GROWS past the cap after it was measured is refused, not truncated", async () => {
  const project = root();
  const target = put(project, "icon.png", png("small"));
  const icon = (await findProjectIconAsync(project))!;

  const served = await racingOnRead(() => {
    fs.writeFileSync(target, Buffer.concat([png("grown"), Buffer.alloc(1024 * 1024)]));
  }, () => readProjectIconBytes(icon));

  expect(served).toBeUndefined();
});

test("a file rewritten WHILE it is being read is refused rather than served half-and-half", async () => {
  const project = root();
  const target = put(project, "icon.png", png("the-original-contents"));
  const icon = (await findProjectIconAsync(project))!;

  const served = await racingOnRead(() => {
    fs.writeFileSync(target, png("a-completely-different-and-longer-body"));
  }, () => readProjectIconBytes(icon));

  expect(served).toBeUndefined();
  const calm = (await readProjectIconBytes(icon))!;
  expect(calm.bytes.toString()).toContain("a-completely-different-and-longer-body");
  expect(calm.contentType).toBe("image/png");
});

test("a short read is completed rather than truncated", async () => {
  const project = root();
  const body = Buffer.concat([png("head"), Buffer.alloc(300 * 1024, 0x7a)]);
  put(project, "icon.png", body);
  const icon = (await findProjectIconAsync(project))!;
  const served = (await readProjectIconBytes(icon))!;
  expect(served.bytes.byteLength).toBe(body.byteLength);
  expect(served.bytes.equals(body)).toBe(true);
  expect(served.etag).toBe(icon.etag);
});

test("a file exactly at the cap is served; one byte more is refused", async () => {
  const project = root();
  const atCap = Buffer.concat([png(""), Buffer.alloc(1024 * 1024 - 8, 0x7a)]);
  expect(atCap.byteLength).toBe(1024 * 1024);
  const target = put(project, "icon.png", atCap);
  const icon = (await findProjectIconAsync(project))!;
  expect((await readProjectIconBytes(icon))!.bytes.byteLength).toBe(1024 * 1024);
  fs.writeFileSync(target, Buffer.concat([atCap, Buffer.from([0x7a])]));
  expect(await readProjectIconBytes(icon)).toBeUndefined();
});

test("a PARENT DIRECTORY swapped for an external symlink in the same window is refused", async () => {
  const project = root();
  const elsewhere = root();
  put(project, "assets/icon.png", png("inside-bytes"));
  put(elsewhere, "assets/icon.png", png("outside-bytes"));
  const icon = (await findProjectIconAsync(project))!;
  expect(icon.path.includes(path.join("assets", "icon.png"))).toBe(true);

  const swapParent = () => {
    fs.rmSync(path.join(project, "assets"), { recursive: true, force: true });
    fs.symlinkSync(path.join(elsewhere, "assets"), path.join(project, "assets"));
  };

  const served = await racing("realpath", swapParent, () => readProjectIconBytes(icon));
  expect(served).toBeUndefined();

  fs.rmSync(path.join(project, "assets"));
  put(project, "assets/icon.png", png("inside-bytes"));
  const confirmed = await racing("realpath", swapParent, () => confirmProjectIcon(icon));
  expect(confirmed).toBeUndefined();
});

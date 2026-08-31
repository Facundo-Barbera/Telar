/**
 * The icon finder is a CANDIDATE LIST over somebody's working tree, and every
 * judgement in it is a refusal: wrong extension, empty file, oversized file,
 * symlink escaping the checkout. What it accepts, the daemon serves to any
 * client — so the refusals are the security surface.
 */
import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { findProjectIcon } from "../src/project-icon";

const roots: string[] = [];
const root = (): string => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "telar-icon-"));
  roots.push(directory);
  return directory;
};
afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

const put = (base: string, relative: string, bytes: string | Buffer = "png-bytes"): string => {
  const target = path.join(base, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, bytes);
  return target;
};

test("an explicit .telar icon beats every convention below it", () => {
  const project = root();
  put(project, "favicon.ico");
  put(project, ".telar/icon.png");
  const icon = findProjectIcon(project)!;
  expect(icon.path.endsWith(path.join(".telar", "icon.png"))).toBe(true);
  expect(icon.contentType).toBe("image/png");
});

test("a Next-style public favicon is found; a project with nothing answers undefined", () => {
  const project = root();
  expect(findProjectIcon(project)).toBeUndefined();
  put(project, "public/favicon.ico");
  expect(findProjectIcon(project)?.contentType).toBe("image/x-icon");
});

test("the etag changes when the file does — that is what makes immutable caching honest", () => {
  const project = root();
  const target = put(project, "icon.png", "one");
  const first = findProjectIcon(project)!.etag;
  // A different size is a different file; mtime alone can collide within a tick.
  fs.writeFileSync(target, "two-longer");
  expect(findProjectIcon(project)!.etag).not.toBe(first);
});

test("empty and oversized files are refused, so the fallback avatar wins instead", () => {
  const project = root();
  put(project, "icon.png", "");
  expect(findProjectIcon(project)).toBeUndefined();
  put(project, "icon.png", Buffer.alloc(1024 * 1024 + 1));
  expect(findProjectIcon(project)).toBeUndefined();
});

test("a symlink escaping the checkout is refused, not followed", () => {
  // The route serves these bytes to any client; a project must not be able to
  // publish an arbitrary file by symlinking favicon.ico at it.
  const project = root();
  const outside = put(root(), "secret.png", "outside-bytes");
  fs.symlinkSync(outside, path.join(project, "icon.png"));
  expect(findProjectIcon(project)).toBeUndefined();
  // A symlink WITHIN the checkout is fine — that is just how some repos lay
  // out their assets.
  put(project, "assets/real.png", "inside-bytes");
  fs.symlinkSync(path.join(project, "assets/real.png"), path.join(project, "icon.svg"));
  // icon.svg -> a .png file: the content type comes from the CANDIDATE name,
  // so this is served as svg — acceptable, the browser falls back. The inside
  // link itself is accepted:
  expect(findProjectIcon(project)).toBeDefined();
});

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "bun:test";
import { readFenced, readFencedAsync, readFencedBytes, writeFenced } from "./fenced";

const roots: string[] = [];
function scratch(): string {
  const root = mkdtempSync(path.join(tmpdir(), "telar-fenced-"));
  roots.push(root);
  mkdirSync(path.join(root, "workspace", "dir"), { recursive: true });
  writeFileSync(path.join(root, "workspace", "a.txt"), "hello");
  writeFileSync(path.join(root, "secret.txt"), "outside");
  return path.join(root, "workspace");
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

test("a read inside the root answers, and every escape is refused before the disk is touched", async () => {
  const root = scratch();
  expect(readFenced(root, "a.txt", "project")).toMatchObject({ text: "hello" });
  expect(await readFencedAsync(root, "./dir/../a.txt", "project")).toMatchObject({ text: "hello" });
  expect((await readFencedBytes(root, "a.txt", "project")).data.toString()).toBe("hello");
  expect(() => readFenced(root, "../secret.txt", "project")).toThrow("that path is outside the project");
  await expect(readFencedAsync(root, "../secret.txt", "session workspace")).rejects.toThrow("outside the session workspace");
  await expect(readFencedBytes(root, "../secret.txt", "project")).rejects.toThrow("outside the project");
  expect(() => readFenced(root, "../workspace-sibling/x", "project")).toThrow("outside the project");
  expect(() => writeFenced(root, "../secret.txt", "x", "hash", "project")).toThrow("outside the project");
  expect(readFileSync(path.join(root, "..", "secret.txt"), "utf8")).toBe("outside");
});

test("a read names what is wrong: nothing there, a directory, or no path at all", async () => {
  const root = scratch();
  expect(() => readFenced(root, "missing.txt", "project")).toThrow("no such file in this workspace");
  await expect(readFencedAsync(root, "missing.txt", "project")).rejects.toThrow("no such file in this workspace");
  expect(() => readFenced(root, "dir", "project")).toThrow("that path is a directory");
  await expect(readFencedBytes(root, "dir", "project")).rejects.toThrow("that path is a directory");
  expect(() => readFenced(root, "  ", "project")).toThrow("a file path is required");
});

test("a write needs the hash it expects, and a missing file is a refusal rather than an error", () => {
  const root = scratch();
  expect(() => writeFenced(root, "a.txt", "x", " ", "project")).toThrow("a write must carry the hash");
  expect(() => writeFenced(root, "a.txt", "xxxx", "hash", "project", 3)).toThrow("too large to save");
  expect(writeFenced(root, "missing.txt", "x", "hash", "project")).toMatchObject({ written: false, refusal: "not_found" });
  expect(writeFenced(root, "a.txt", "x", "stale", "project")).toMatchObject({ written: false, refusal: "conflict" });
});

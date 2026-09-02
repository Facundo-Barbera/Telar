import { afterEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  appearanceHomePaths,
  ensureAppearanceHome,
  imageExtension,
  listImages,
  putImage,
  readImage,
  readLooks,
  readSettings,
  readThemes,
  removeEntry,
  writeLook,
  writeSettings,
  writeTheme,
} from "../src/appearance-home";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "telar-appearance-home-"));
  roots.push(root);
  return root;
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe("the appearance home", () => {
  test("creates its directories and leaves a map of itself", () => {
    const root = home();
    const paths = ensureAppearanceHome(root);
    for (const dir of [paths.themes, paths.looks, paths.images]) {
      expect(fs.statSync(dir).isDirectory()).toBe(true);
    }
    const readme = fs.readFileSync(paths.readme, "utf8");
    // The map's whole job is telling a hand — or an agent — where things go.
    expect(readme).toContain("themes/<id>.json");
    expect(readme).toContain("images/<id>.<ext>");
  });

  test("a stale map is rewritten rather than left to mislead", () => {
    const root = home();
    const paths = ensureAppearanceHome(root);
    fs.writeFileSync(paths.readme, "# something someone edited\n");
    ensureAppearanceHome(root);
    expect(fs.readFileSync(paths.readme, "utf8")).toContain("themes/<id>.json");
  });

  test("round-trips a theme and a look, and the filename is the id", () => {
    const root = home();
    writeTheme(root, "dusk", { label: "Dusk", light: { background: "#fff" }, dark: { background: "#000" } });
    writeLook(root, "evening", { label: "Evening", backdrop: { kind: "none" } });

    expect(readThemes(root).entries).toEqual([{ id: "dusk", label: "Dusk", light: { background: "#fff" }, dark: { background: "#000" } }]);
    expect(readLooks(root).entries).toEqual([{ id: "evening", label: "Evening", backdrop: { kind: "none" } }]);
  });

  test("renaming the file renames the entry, even against a stale id inside", () => {
    const root = home();
    const paths = ensureAppearanceHome(root);
    fs.writeFileSync(path.join(paths.themes, "renamed.json"), JSON.stringify({ id: "the-old-name", label: "Dusk" }));
    expect(readThemes(root).entries[0]?.id).toBe("renamed");
  });

  test("a broken file is reported and does not hide the good ones", () => {
    const root = home();
    const paths = ensureAppearanceHome(root);
    writeTheme(root, "good", { label: "Good" });
    fs.writeFileSync(path.join(paths.themes, "broken.json"), "{ not json");
    fs.writeFileSync(path.join(paths.themes, "wrong-shape.json"), JSON.stringify([1, 2, 3]));
    // An editor swapfile, which is exactly what a hand-edited directory grows.
    fs.writeFileSync(path.join(paths.themes, ".dusk.json.swp"), "binary junk");

    const read = readThemes(root);
    expect(read.entries.map((entry) => entry.id)).toEqual(["good"]);
    expect(read.skipped.map((entry) => entry.file).sort()).toEqual(["broken.json", "wrong-shape.json"]);
    expect(read.skipped.find((entry) => entry.file === "broken.json")?.reason).toBe("not valid JSON");
  });

  test("reading an absent home is empty rather than an error", () => {
    const root = home();
    expect(readThemes(root)).toEqual({ entries: [], skipped: [] });
    expect(readLooks(root)).toEqual({ entries: [], skipped: [] });
    expect(readSettings(root)).toBeUndefined();
    expect(listImages(root)).toEqual([]);
  });

  test("settings round-trip, and a malformed file reads as absent", () => {
    const root = home();
    writeSettings(root, { accent: "sea", fontSize: 15 });
    expect(readSettings(root)).toEqual({ accent: "sea", fontSize: 15 });

    fs.writeFileSync(appearanceHomePaths(root).settings, "[]");
    expect(readSettings(root)).toBeUndefined();
  });

  test("deleting is idempotent", () => {
    const root = home();
    writeTheme(root, "dusk", { label: "Dusk" });
    removeEntry(root, "themes", "dusk");
    removeEntry(root, "themes", "dusk");
    expect(readThemes(root).entries).toEqual([]);
  });

  test("an image is stored under its content hash, so the same picture is one file", () => {
    const root = home();
    const first = putImage(root, PNG);
    const second = putImage(root, PNG);
    expect(first).toBe(second!);
    expect(first!.endsWith(".png")).toBe(true);
    expect(listImages(root)).toEqual([first!]);
    expect(readImage(root, first!)).toEqual(PNG);
  });

  test("the format is sniffed, and a non-image is refused", () => {
    expect(imageExtension(PNG)).toBe("png");
    expect(imageExtension(new Uint8Array([0xff, 0xd8, 0xff, 0x00]))).toBe("jpg");
    expect(imageExtension(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBe("gif");
    expect(imageExtension(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe("webp");
    // A shell script named .png is still a shell script.
    expect(imageExtension(new Uint8Array([0x23, 0x21, 0x2f, 0x62]))).toBeUndefined();
    expect(putImage(home(), new Uint8Array([0x23, 0x21]))).toBeUndefined();
  });

  test("an image name cannot climb out of the images directory", () => {
    const root = home();
    const paths = ensureAppearanceHome(root);
    // Where `../secret.png` from images/ would actually land, so the decoy is
    // reachable if the guard is absent and unreachable if it is not.
    fs.writeFileSync(path.join(paths.root, "secret.png"), PNG);
    // The path is built from a caller-supplied string, so this check IS the
    // boundary rather than a tidiness rule.
    expect(readImage(root, "../secret.png")).toBeUndefined();
    expect(readImage(root, "../../etc/passwd")).toBeUndefined();
    expect(readImage(root, "nope.exe")).toBeUndefined();
    expect(fs.existsSync(path.join(paths.images, "..", "secret.png"))).toBe(true);
    // And it is genuinely readable by a path that does not go through the guard.
    expect(fs.readFileSync(path.join(paths.root, "secret.png"))).toEqual(Buffer.from(PNG));
  });
});

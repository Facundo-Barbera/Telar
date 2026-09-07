/**
 * What a file is, from its name.
 *
 * The rules worth pinning are the ones a plain extension split gets wrong:
 * dotfiles, exact filenames that outrank their extension, and the difference
 * between "no language" and "not text at all" — which the viewer renders as two
 * different screens.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import { fileExtension, fileKind } from "./file-kinds";

describe("fileExtension", () => {
  test("a leading dot is a NAME, not an extension", () => {
    // `.gitignore` treated as extension `gitignore` is how a dotfile ends up
    // labelled as a language nobody has.
    expect(fileExtension(".gitignore")).toBe("");
    expect(fileExtension(".env")).toBe("");
    // But a dotfile WITH a real extension still has one.
    expect(fileExtension(".env.example")).toBe("example");
    expect(fileExtension("a/b/c.test.ts")).toBe("ts");
    expect(fileExtension("Makefile")).toBe("");
    expect(fileExtension("archive.TAR.GZ")).toBe("gz");
  });
});

describe("fileKind", () => {
  test("an exact name beats its extension", () => {
    // `package.json` is not "a JSON file" to anybody working in a repository.
    expect(fileKind("package.json").label).toBe("npm manifest");
    expect(fileKind("apps/web/tsconfig.json").label).toBe("TypeScript config");
    expect(fileKind("src/thing.json").label).toBe("JSON");
    // Case-insensitive, because a repository has both README.md and readme.md.
    expect(fileKind("README.md").label).toBe("README");
    expect(fileKind("docs/notes.md").label).toBe("Markdown");
  });

  test("the name lookup only matches the BASENAME", () => {
    // A directory called `license` must not make every file under it a licence.
    expect(fileKind("license/notes.txt").label).toBe("plain text");
    expect(fileKind("vendor/package.json").label).toBe("npm manifest");
  });

  test("a language carries a shiki id and bytes carry none", () => {
    expect(fileKind("a.ts").lang).toBe("typescript");
    expect(fileKind("a.rs").lang).toBe("rust");
    // Not text: `lang` absent AND `binary` set, which the viewer needs as two
    // separate facts — one stops it highlighting, the other stops it reading.
    expect(fileKind("logo.png")).toMatchObject({ label: "PNG image", binary: true });
    expect(fileKind("logo.png").lang).toBeUndefined();
    // An SVG is both an image and XML, and the useful half is that it is text.
    expect(fileKind("icon.svg")).toMatchObject({ label: "SVG image", lang: "xml" });
    expect(fileKind("icon.svg").binary).toBeUndefined();
  });

  test("an unknown extension is a file, not a guess", () => {
    const unknown = fileKind("mystery.qqq");
    expect(unknown.label).toBe("file");
    expect(unknown.lang).toBeUndefined();
    expect(unknown.binary).toBeUndefined();
  });

  test("every kind carries a tint and a glyph, so no row can render blank", () => {
    for (const path of ["a.ts", "a.py", "package.json", ".gitignore", "logo.png", "mystery.qqq", "Dockerfile"]) {
      const kind = fileKind(path);
      expect(kind.tint.length, path).toBeGreaterThan(0);
      expect(kind.glyph.length, path).toBeGreaterThan(0);
      expect(kind.label.length, path).toBeGreaterThan(0);
    }
  });

  test("every tint is a token, so a theme can move it", () => {
    // These were `text-sky-600 dark:text-sky-400` pairs — a fixed sRGB value
    // that no theme can reach, spelled twice because one ramp step cannot
    // serve both canvases. `--tint-*` flips with the scheme by itself, so the
    // `dark:` half is not merely unnecessary here: its absence is the point.
    for (const path of ["a.ts", "a.py", "a.rs", "package.json", "a.css"]) {
      expect(fileKind(path).tint, path).toMatch(/^text-tint-[a-z]+$/);
    }
    expect(fileKind("mystery.qqq").tint).toBe("text-muted-foreground");
  });
});

describe("media kinds", () => {
  test("renderable bytes name their media element; opaque bytes name none", () => {
    expect(fileKind("shot.png").media).toBe("image");
    expect(fileKind("clip.mp4").media).toBe("video");
    expect(fileKind("voice.mp3").media).toBe("audio");
    expect(fileKind("paper.pdf").media).toBe("pdf");
    // A font is bytes with no viewer — the named empty state, not a broken tag.
    expect(fileKind("font.woff2").media).toBeUndefined();
    expect(fileKind("lib.wasm").media).toBeUndefined();
  });

  test("the pdf kind also names the pdf viewer, ungated by data science", () => {
    // `viewer: "pdf"` is the seam other features (compiled LaTeX output)
    // route through — panelTabForPath reads it without a dataScience gate.
    expect(fileKind("out/main.pdf").viewer).toBe("pdf");
    expect(fileKind("data.csv").viewer).toBe("table");
    expect(fileKind("notes.md").viewer).toBeUndefined();
  });
});

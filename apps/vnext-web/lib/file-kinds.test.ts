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

  test("tints name a colour for BOTH themes, or the panel's own token", () => {
    // A single 400-level colour is washed out on the light canvas and a 600 is
    // muddy on dark, so every palette tint has to carry both halves. The one
    // exception is the default, which is a semantic token and themes itself.
    for (const path of ["a.ts", "a.py", "a.rs", "package.json", "a.css"]) {
      expect(fileKind(path).tint, path).toContain("dark:");
    }
    expect(fileKind("mystery.qqq").tint).toBe("text-muted-foreground");
  });
});

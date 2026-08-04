// The Codex `turn/start` input array, checked against THE APP-SERVER'S OWN
// SCHEMA rather than against someone's reading of it.
//
// WHY THIS EXISTS. `turnInput` hand-builds protocol objects — `localImage`,
// `mention` — as untyped `Record<string, unknown>`, because the app-server's
// types are not published as a package we depend on. So nothing in tsc can tell
// us that a field was renamed, that a variant gained a required property, or
// that our `mention` is a shape this Codex version no longer accepts. The
// failure mode is silent and remote: a turn goes out, the harness rejects or
// ignores the item, and the model simply never sees the file the human
// attached.
//
// The schema is generated from the INSTALLED binary (`codex app-server
// generate-json-schema`), so this tracks whatever version is actually on the
// machine. It SKIPS when codex is absent rather than failing — not every
// checkout has it, and a red test for "you don't have Codex installed" is a test
// people learn to ignore.
//
// bun provides "bun:test" at runtime; @types/bun isn't a dependency of this Next
// app, so the web tsconfig (which includes **/*.ts) can't resolve it.
// @ts-expect-error no @types/bun in this workspace
import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { turnInput } from "./codex-app-server";

type Variant = {
  title?: string;
  required?: string[];
  properties?: Record<string, { enum?: string[] }>;
};

/** Generate the protocol schema from the installed binary, or null if absent. */
function userInputVariants(): Variant[] | null {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "telar-codex-schema-"));
  try {
    execFileSync(process.env.CODEX_BIN ?? "codex", ["app-server", "generate-json-schema", "--out", out], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 60_000,
    });
    const schema = JSON.parse(
      fs.readFileSync(path.join(out, "v2", "TurnStartParams.json"), "utf8"),
    );
    const defs = schema.$defs ?? schema.definitions ?? {};
    return (defs.UserInput?.oneOf as Variant[]) ?? null;
  } catch {
    return null; // no codex on PATH, or the subcommand moved
  } finally {
    fs.rmSync(out, { force: true, recursive: true });
  }
}

const VARIANTS = userInputVariants();

/** The variant whose `type` enum matches this item, if any. */
const variantFor = (item: Record<string, unknown>, variants: Variant[]): Variant | undefined =>
  variants.find((v) => v.properties?.type?.enum?.includes(item.type as string));

describe("the Codex turn/start input array matches the app-server protocol", () => {
  const ATTACHMENTS = [
    { name: "shot.png", mediaType: "image/png", path: "/tmp/a/blob" },
    { name: "notes.md", mediaType: "text/markdown", path: "/tmp/b/blob" },
  ];
  const MENTIONS = [{ name: "route.ts", path: "app/api/chat/route.ts" }];

  test("a turn with no attachments is byte-identical to the original single text item", () => {
    // The regression that would be easiest to ship and hardest to notice: every
    // ordinary turn on this provider goes through the same builder.
    expect(turnInput("hello")).toEqual([
      { type: "text", text: "hello", text_elements: [] },
    ]);
  });

  test("images become localImage and other files become mention", () => {
    const input = turnInput("look", ATTACHMENTS, MENTIONS);
    expect(input.map((i) => i.type)).toEqual(["text", "localImage", "mention", "mention"]);
    // The text item stays FIRST — the prompt is what the turn is about.
    expect(input[0]).toMatchObject({ type: "text", text: "look" });
    expect(input[1]).toEqual({ type: "localImage", path: "/tmp/a/blob" });
    expect(input[3]).toEqual({
      type: "mention",
      name: "route.ts",
      path: "app/api/chat/route.ts",
    });
  });

  test.skipIf(!VARIANTS)("every item validates against the generated schema", () => {
    const variants = VARIANTS!;
    for (const item of turnInput("look", ATTACHMENTS, MENTIONS)) {
      const variant = variantFor(item, variants);
      // A `type` no variant claims means we are sending an item this Codex
      // version has never heard of.
      expect({ type: item.type, matched: Boolean(variant) }).toEqual({
        type: item.type,
        matched: true,
      });

      // Every field the variant REQUIRES is present…
      for (const field of variant!.required ?? []) {
        expect({ variant: variant!.title, field, present: field in item }).toEqual({
          variant: variant!.title,
          field,
          present: true,
        });
      }
      // …and every field we send is one the variant DECLARES. This is the half
      // that catches a rename: a stale `path` beside a new `uri` would satisfy
      // "required present" on its own only if the rename were additive.
      for (const field of Object.keys(item)) {
        expect({ variant: variant!.title, field, declared: field in (variant!.properties ?? {}) })
          .toEqual({ variant: variant!.title, field, declared: true });
      }
    }
  });

  test.skipIf(!VARIANTS)("the schema still carries the two variants this adapter depends on", () => {
    // Anti-vacuity for the check above: if `localImage`/`mention` ever vanish
    // from the protocol, `variantFor` would start returning undefined and the
    // test above would fail — but if the SCHEMA SHAPE changed instead (a
    // different $defs layout, say), `VARIANTS` would be null and everything
    // would silently skip. This asserts we really did read a schema.
    const titles = VARIANTS!.map((v) => v.title);
    expect(titles).toContain("LocalImageUserInput");
    expect(titles).toContain("MentionUserInput");
  });
});

// AD-13, PROVEN: kind ids carry their owning module and cannot collide.
//
// Every rejection below is paired with its POSITIVE CONTROL — the same shape,
// made valid, registering cleanly. A guard that rejects everything is not a
// guard, and a test that only ever asserts `toThrow` cannot tell the two apart.
//
// This file also carries AC2's COMPILE-TIME claim. `apps/web/tsconfig.json` has
// NO test exclusion (measured), so `bunx tsc --noEmit` in this workspace really
// does check the `@ts-expect-error` below — and it is written on a TYPE
// ANNOTATION, never above a call. That distinction is not pedantry: story 2.2
// shipped a `@ts-expect-error` above a CALL, the directive meant nothing to the
// runtime, the call ran, and it reached the operator's real loom store.

// @ts-expect-error no @types/bun in this workspace
import { describe, expect, test } from "bun:test";
import type { ConversationProps } from "./conversation";
import {
  MODULE_NAMESPACES,
  createItemKindRegistry,
  type ItemKind,
  type ItemKindRegistry,
} from "./registry";

const kind = (id: string): ItemKind<never> =>
  ({ id, render: () => null }) as unknown as ItemKind<never>;

describe("createItemKindRegistry — the five rejections, each with its positive control", () => {
  test("(1) an UNNAMESPACED id is rejected; a namespaced one registers", () => {
    expect(() => createItemKindRegistry([kind("text")])).toThrow(/carries no module namespace/);
    expect(() => createItemKindRegistry([kind("text")])).toThrow(/"text"/);
    // the control
    expect(createItemKindRegistry([kind("ultra:run-anchor")]).ids()).toEqual(["ultra:run-anchor"]);
  });

  test("(2) MORE THAN ONE colon is rejected; exactly one is fine", () => {
    expect(() => createItemKindRegistry([kind("loom:gate:card")])).toThrow(/colons; exactly one/);
    expect(createItemKindRegistry([kind("loom:gate-card")]).ids()).toEqual(["loom:gate-card"]);
  });

  test("(3) an EMPTY segment is rejected on either side; both-named is fine", () => {
    expect(() => createItemKindRegistry([kind(":card")])).toThrow(/empty module segment/);
    expect(() => createItemKindRegistry([kind("loom:")])).toThrow(/empty name segment/);
    expect(createItemKindRegistry([kind("workspace:receipt")]).ids()).toEqual([
      "workspace:receipt",
    ]);
  });

  test("(4) an UNDECLARED module is rejected — a typo cannot open a second namespace", () => {
    // `looms:` is one keystroke from `loom:` and would otherwise register a
    // second, near-identical namespace that nothing would ever flag.
    expect(() => createItemKindRegistry([kind("looms:gate-card")])).toThrow(
      /not in\s+the declared vocabulary/,
    );
    expect(() => createItemKindRegistry([kind("looms:gate-card")])).toThrow(/looms/);
    expect(createItemKindRegistry([kind("loom:gate-card")]).ids()).toEqual(["loom:gate-card"]);
  });

  test("(5) a DUPLICATE id is rejected; two distinct ids in one registry are fine", () => {
    expect(() =>
      createItemKindRegistry([kind("loom:gate-card"), kind("loom:gate-card")]),
    ).toThrow(/registered twice/);
    expect(
      createItemKindRegistry([kind("loom:gate-card"), kind("loom:thread-row")]).ids(),
    ).toEqual(["loom:gate-card", "loom:thread-row"]);
  });

  test("every declared namespace really is accepted — the vocabulary is not decorative", () => {
    // Re-derived from the exported const rather than restated as a literal. A
    // restated list is a COPY of a measurement, and a copy goes stale in silence
    // (story 2.1's `allow: []` survived authoring, review and a commit that way).
    for (const ns of MODULE_NAMESPACES) {
      expect(createItemKindRegistry([kind(`${ns}:probe`)]).ids()).toEqual([`${ns}:probe`]);
    }
    expect(MODULE_NAMESPACES.length).toBeGreaterThanOrEqual(5);
  });

  test("every rejection message names the offending id AND the rule it broke", () => {
    // The reader will be a Track D/E/F author who has never opened registry.ts.
    for (const bad of ["text", "loom:gate:card", ":card", "loom:", "looms:gate-card"]) {
      let message = "";
      try {
        createItemKindRegistry([kind(bad)]);
      } catch (err) {
        message = String(err);
      }
      expect(message).toContain(bad);
      expect(message).toContain("createItemKindRegistry");
      expect(message).toContain("CONSEQUENCE");
      expect(message).toContain("NEXT STEP");
    }
  });
});

describe("the registry itself", () => {
  test("get() returns the RENDERER, so the shell's dispatch is one call", () => {
    const render = () => null;
    const reg = createItemKindRegistry([{ id: "loom:gate-card", render } as ItemKind<never>]);
    expect(reg.get("loom:gate-card")).toBe(render);
  });

  test("an UNKNOWN kind returns undefined and NEVER throws — AD-8's tombstone", () => {
    // A transcript containing one unregistered item must still render the other
    // nine. This is the whole reason `get` is not allowed to be strict.
    const reg = createItemKindRegistry([kind("loom:gate-card")]);
    expect(() => reg.get("ultra:run-anchor")).not.toThrow();
    expect(reg.get("ultra:run-anchor")).toBeUndefined();
    expect(reg.get("")).toBeUndefined();
    expect(reg.get("not-even-namespaced")).toBeUndefined();
  });

  test("ids() preserves registration order, and an empty registry is legal", () => {
    expect(createItemKindRegistry([]).ids()).toEqual([]);
    expect(
      createItemKindRegistry([kind("ultra:a"), kind("loom:b"), kind("workspace:c")]).ids(),
    ).toEqual(["ultra:a", "loom:b", "workspace:c"]);
  });

  test("two registries are INDEPENDENT — the registry is a prop, not a singleton", () => {
    // project-context.md forbids a global client store, and a module-level
    // registry would also make two surfaces on one page share a registration
    // list — the exact collision AD-13 exists to prevent.
    const a = createItemKindRegistry([kind("ultra:run-anchor")]);
    const b = createItemKindRegistry([kind("loom:gate-card")]);
    expect(a.get("loom:gate-card")).toBeUndefined();
    expect(b.get("ultra:run-anchor")).toBeUndefined();
  });
});

describe("AC2 — the shell exposes exactly four slots, checked by the compiler", () => {
  const KINDS: ItemKindRegistry = { get: () => undefined, ids: () => [] };

  test("a valid four-slot configuration typechecks (the positive control)", () => {
    const ok: ConversationProps = {
      items: [],
      kinds: KINDS,
      composer: null,
      rail: null,
      header: null,
      live: false,
      empty: null,
      trailing: null,
      className: "x",
    };
    expect(ok.items).toEqual([]);
  });

  test("an UNKNOWN slot name does not typecheck", () => {
    // A TYPE ANNOTATION, deliberately — not a call. `@ts-expect-error` is a
    // comment to the compiler and nothing at all to the runtime, so a directive
    // above a call still calls. Nothing on the next four lines executes any
    // production code, which is what makes the claim safe as well as checked.
    // @ts-expect-error `sidebar` is not a slot — the four are items+kinds, composer, rail, header.
    const unknownSlot: ConversationProps = { items: [], kinds: KINDS, sidebar: null };
    expect(unknownSlot.items).toEqual([]);
  });

  test("the transcript slot is a PAIR — items alone does not typecheck", () => {
    // @ts-expect-error `kinds` is required: a transcript with no registry cannot render anything.
    const noRegistry: ConversationProps = { items: [] };
    expect(noRegistry.items).toEqual([]);
  });
});

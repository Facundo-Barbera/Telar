// The provider option seam, and the one claim that makes it worth having: the
// composer's "may I offer this?" and the chat route's "will I accept this?" are
// now literally the same predicate. Two hand-kept Sets used to stand behind a
// `provider === "codex" ?` in app/api/chat/route.ts, so a level added to one
// provider's list could be offered by a menu the route then 400'd. There is one
// list now, and these tests are what stop a second one growing back.
//
// No DOM, no disk, no core import. bun provides "bun:test" at runtime;
// @types/bun isn't a dependency of this Next app, so the web tsconfig can't
// resolve it — suppress just the import, exactly as spend-readout.test.ts does.
// @ts-expect-error no @types/bun in this workspace
import { describe, expect, test } from "bun:test";
import { CODEX_EFFORT_OPTIONS, EFFORT_OPTIONS } from "./models";
import {
  EFFORT_UNSET,
  groupAccepts,
  groupDefault,
  providerOptionGroup,
  providerOptionGroups,
} from "./provider-options";

const PROVIDERS = ["claude", "codex"] as const;

describe("providerOptionGroup — one knob, asked by name", () => {
  test("both providers publish an effort group", () => {
    for (const p of PROVIDERS) expect(providerOptionGroup(p, "effort")).toBeDefined();
  });

  // Undefined has to be a real answer rather than an accident, because the
  // route reads it as "reject everything under that name". A group that
  // silently resolved to some other provider's would validate a value this
  // harness cannot honour.
  test("an unpublished id is undefined, not somebody else's group", () => {
    for (const p of PROVIDERS) expect(providerOptionGroup(p, "serviceTier")).toBeUndefined();
  });

  test("what it returns is the same object providerOptionGroups lists", () => {
    for (const p of PROVIDERS) {
      const g = providerOptionGroup(p, "effort");
      expect(providerOptionGroups(p)).toContain(g!);
    }
  });
});

describe("the published effort vocabulary is what each harness actually has", () => {
  // The reason this matters: Claude has "max" and Codex does not; Codex has
  // "minimal" and Claude does not. When the route validated against its own
  // copies, the two could drift silently.
  test("Claude publishes exactly the SDK's levels, plus the unset sentinel", () => {
    const g = providerOptionGroup("claude", "effort")!;
    expect(g.values.map((v) => v.value)).toEqual([EFFORT_UNSET, ...EFFORT_OPTIONS.map((e) => e.id)]);
  });

  test("Codex publishes exactly its own levels, plus the unset sentinel", () => {
    const g = providerOptionGroup("codex", "effort")!;
    expect(g.values.map((v) => v.value)).toEqual([
      EFFORT_UNSET,
      ...CODEX_EFFORT_OPTIONS.map((e) => e.id),
    ]);
  });

  test("a level one provider has and the other does not is rejected by the other", () => {
    const claude = providerOptionGroup("claude", "effort")!;
    const codex = providerOptionGroup("codex", "effort")!;
    expect(groupAccepts(claude, "max")).toBe(true);
    expect(groupAccepts(codex, "max")).toBe(false);
    expect(groupAccepts(codex, "minimal")).toBe(true);
    expect(groupAccepts(claude, "minimal")).toBe(false);
  });

  test("nonsense is rejected by both", () => {
    for (const p of PROVIDERS) {
      expect(groupAccepts(providerOptionGroup(p, "effort")!, "turbo")).toBe(false);
    }
  });
});

describe("the unset sentinel", () => {
  // The route spends this value rather than forwarding it — `effort ? {…} : {}`
  // downstream would hand the SDK the literal string "default". It is only safe
  // to spend because it is every group's declared default, so omitting the
  // field and sending the sentinel mean the same thing.
  test("EFFORT_UNSET is the default of every published effort group", () => {
    for (const p of PROVIDERS) {
      expect(groupDefault(providerOptionGroup(p, "effort")!)).toBe(EFFORT_UNSET);
    }
  });

  test("and it is accepted, so the route's 400 does not fire on it", () => {
    for (const p of PROVIDERS) {
      expect(groupAccepts(providerOptionGroup(p, "effort")!, EFFORT_UNSET)).toBe(true);
    }
  });
});

describe("every group is well-formed, whatever it is", () => {
  // groupDefault falls back to index 0 when nobody claims the default, which
  // makes reordering a group's values a silent change to what a new session
  // starts at — the exact failure its own comment warns about. Assert the claim
  // over the whole published space so a future group cannot forget.
  test("exactly one value per group is marked default", () => {
    for (const p of PROVIDERS) {
      for (const g of providerOptionGroups(p)) {
        expect(g.values.filter((v) => v.isDefault).length, `${p}/${g.id}`).toBe(1);
      }
    }
  });

  test("no group publishes a value twice", () => {
    for (const p of PROVIDERS) {
      for (const g of providerOptionGroups(p)) {
        const ids = g.values.map((v) => v.value);
        expect(new Set(ids).size, `${p}/${g.id}`).toBe(ids.length);
      }
    }
  });

  test("no provider publishes two groups under one id", () => {
    for (const p of PROVIDERS) {
      const ids = providerOptionGroups(p).map((g) => g.id);
      expect(new Set(ids).size, p).toBe(ids.length);
    }
  });
});

// GALLERY (delete with /demo-gallery) — the anti-drift proof for the
// conversation lane. Every fixture item is resolved against the REAL item-kind
// registry built from the REAL built-ins, and every configuration the six
// hand-rebuilt lanes need is asserted present, distinct and registered. If a
// fixture ever drifts from the production contract, this fails.
//
// This is the FIRST test under lib/demo-gallery/**, which had zero coverage
// before story 3.1 — and it is AC7's only runtime proof, so it is not optional.
//
// HONEST GAP: there is no DOM harness in this repository (no *.test.tsx, no
// testing-library, no happy-dom, no jsdom — measured) and story 3.1 forbids
// introducing one. So nothing here proves the lane RENDERS. What it proves is
// everything decided before a single element exists: that every kind a fixture
// names resolves, that the one kind that must NOT resolve genuinely does not,
// that the six configurations are all present and distinct, and that they are
// really wired into the catalog rather than merely written.

// @ts-expect-error no @types/bun in this workspace
import { describe, expect, test } from "bun:test";
import { BUILTIN_KINDS, CONVERSATION_KINDS, createItemKindRegistry } from "@/components/conversation";
import { allEntries, demoGroups, getDemoEntry, GROUP_DEFS } from "../registry";
import { conversationEntries } from "../entries/conversation";
import { GALLERY_KINDS, READ_ONLY_CONFIG, laneItems } from "./shell";
import {
  CONVERSATION_CONFIGS,
  CONVERSATION_FIXTURES,
  UNREGISTERED_KIND,
  flattenItems,
} from "./fixtures";

// THE REGISTRY THE LANE ACTUALLY RENDERS WITH, not a second one built here to
// the same recipe. A copy would keep passing while the lane rendered tombstones:
// the guard has to read the same value as the thing it guards (story 3.1's
// maxim 3). The recipe is still asserted, one test below, so the lane cannot
// quietly stop being built from the real built-ins either.
const KINDS = GALLERY_KINDS;

describe("every fixture item resolves in the REAL registry", () => {
  for (const config of CONVERSATION_CONFIGS) {
    test(`${config}`, () => {
      const items = flattenItems(CONVERSATION_FIXTURES[config]);
      // Anti-vacuity: an empty fixture would satisfy "every item resolves".
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        if (item.kind === UNREGISTERED_KIND) continue; // configuration 6, on purpose
        expect(typeof KINDS.get(item.kind)).toBe("function");
      }
    });
  }

  test("the tombstone kind is genuinely NOT registered — the demo is not a mock", () => {
    // If someone registers ultra:run-anchor here, configuration 6 stops showing
    // AD-8's degradation and starts showing an ordinary item, silently.
    expect(KINDS.get(UNREGISTERED_KIND)).toBeUndefined();
    // …and it IS a well-formed id, so the tombstone is about REGISTRATION, not
    // about a malformed kind the factory would have rejected outright.
    expect(() => createItemKindRegistry([{ id: UNREGISTERED_KIND, render: () => null }])).not.toThrow();
  });

  test("exactly one configuration carries the unregistered kind", () => {
    const carriers = CONVERSATION_CONFIGS.filter((c) =>
      flattenItems(CONVERSATION_FIXTURES[c]).some((i) => i.kind === UNREGISTERED_KIND),
    );
    expect(carriers).toEqual(["conversation-empty-and-tombstone"]);
  });
});

describe("the six configurations", () => {
  test("there are six, they are distinct, and each has fixtures", () => {
    expect(CONVERSATION_CONFIGS.length).toBe(6);
    expect(new Set(CONVERSATION_CONFIGS).size).toBe(6);
    for (const config of CONVERSATION_CONFIGS) {
      expect(CONVERSATION_FIXTURES[config].length).toBeGreaterThan(0);
    }
  });

  test("item keys are unique within each configuration", () => {
    // A duplicate key is a React identity bug that no type can catch, and the
    // shell's per-item disclosure state is scoped BY that key — two items
    // sharing one would share their open/closed state too.
    for (const config of CONVERSATION_CONFIGS) {
      const keys = flattenItems(CONVERSATION_FIXTURES[config]).map((i) => i.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  test("the configurations really differ — no two carry the same transcript", () => {
    const shapes = CONVERSATION_CONFIGS.map((c) =>
      JSON.stringify(flattenItems(CONVERSATION_FIXTURES[c]).map((i) => [i.kind, i.key])),
    );
    expect(new Set(shapes).size).toBe(6);
  });

  test("the read-only configuration omits every resolve callback — through the LANE's own decision", () => {
    // This is AC4's visible proof, so it has to be true rather than intended:
    // the same items minus one callback must render as a non-interactive
    // transcript. Note what is called here — `laneItems`, the function the lane
    // itself uses — rather than the fixture constant. Asserting that a literal
    // fixture lacks a function is near-tautological and would pass on a
    // transcript with no approval cards at all; what decides read-only-ness is
    // the branch below, and it is what is exercised.
    const noop = () => {};
    const readOnly = flattenItems([...laneItems(READ_ONLY_CONFIG, {}, noop)]);
    const permissions = readOnly.filter((i) => i.kind === CONVERSATION_KINDS.permission);
    // ANTI-VACUITY: there IS something to withhold a callback from.
    expect(permissions.length).toBeGreaterThan(0);
    for (const item of readOnly) {
      const payload = item.payload as { onRespond?: unknown };
      expect(payload?.onRespond).toBeUndefined();
    }

    // …AND THE DISCRIMINATOR, which is the half that was missing: the very same
    // items, taken through any other configuration, DO carry the callback. So
    // the read-only lane is non-interactive because the lane withholds it, not
    // because the fixtures were inert to begin with.
    const interactive = flattenItems([...laneItems("conversation-full", {}, noop)]).filter(
      (i) => i.kind === CONVERSATION_KINDS.permission,
    );
    expect(interactive.length).toBeGreaterThan(0);
    for (const item of interactive) {
      expect(typeof (item.payload as { onRespond?: unknown }).onRespond).toBe("function");
    }
  });

  test("the lane's registry IS the real built-in set — the recipe, still asserted", () => {
    // KINDS is the lane's own registry now, so this is what stops that from
    // meaning less than it did: it must still be exactly the built-ins, with
    // the tombstone kind still absent.
    const recipe = createItemKindRegistry([...BUILTIN_KINDS]);
    expect(KINDS.ids()).toEqual(recipe.ids());
    expect(KINDS.get(UNREGISTERED_KIND)).toBeUndefined();
  });

  test("between them, the configurations exercise EVERY built-in kind", () => {
    const seen = new Set(
      CONVERSATION_CONFIGS.flatMap((c) =>
        flattenItems(CONVERSATION_FIXTURES[c]).map((i) => i.kind),
      ),
    );
    for (const id of KINDS.ids()) expect(seen.has(id)).toBe(true);
    // SEVEN since the live status row joined the built-ins. The count is pinned
    // so an eighth kind cannot arrive without a fixture exercising it — which is
    // the whole point of this test and why the number is edited, not derived.
    expect(KINDS.ids().length).toBe(7);
  });
});

describe("the lane is wired into the catalog", () => {
  test("one entry per configuration, ids matching, all in allEntries", () => {
    expect(conversationEntries.map((e) => e.id).sort()).toEqual([...CONVERSATION_CONFIGS].sort());
    for (const entry of conversationEntries) {
      expect(getDemoEntry(entry.id)).toBe(entry);
      expect(allEntries).toContain(entry);
    }
  });

  test("entry ids stay unique across the WHOLE catalog", () => {
    const ids = allEntries.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every entry declares the ux-conversation concern and lands in its group", () => {
    for (const entry of conversationEntries) expect(entry.concern).toBe("ux-conversation");
    expect(GROUP_DEFS.some((g) => g.key === "ux-conversation")).toBe(true);
    const group = demoGroups().find((g) => g.key === "ux-conversation");
    expect(group).toBeDefined();
    expect(group!.entries.map((e) => e.id).sort()).toEqual([...CONVERSATION_CONFIGS].sort());
    // …and nothing else leaked into it.
    expect(group!.entries.length).toBe(6);
  });

  test("every entry carries a real title, variant and summary", () => {
    for (const entry of conversationEntries) {
      expect(entry.title.length).toBeGreaterThan(0);
      expect((entry.variant ?? "").length).toBeGreaterThan(0);
      expect(entry.summary.length).toBeGreaterThan(80);
      expect(typeof entry.Component).toBe("function");
    }
  });
});

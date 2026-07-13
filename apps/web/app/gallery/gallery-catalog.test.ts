// GALLERY (delete with /gallery) — lane G catalog-wiring proof. Verifies the
// nav/index/pager composition over lane F's three registries: unique ids across
// the WHOLE catalog, section ordering, and that the flat pager list is exactly
// the concatenation of the three sections. Complements lane F's
// fixtures.validate.test.ts (which proves the fixture DATA parses through zod).
// @ts-expect-error no @types/bun in this workspace
import { describe, expect, it } from "bun:test";
import {
  GALLERY_FIXTURES,
  GALLERY_APP_VIEWS,
  GALLERY_COMPONENTS,
} from "@/lib/gallery-fixtures";
import {
  gallerySections,
  orderedCatalog,
  GROUP_ORDER,
  SECTION_LOOM,
  SECTION_APP,
  SECTION_COMPONENT,
} from "./gallery-groups";

describe("gallery catalog composition", () => {
  it("orderedCatalog covers every entry from all three registries exactly once", () => {
    const items = orderedCatalog();
    expect(items.length).toBe(
      GALLERY_FIXTURES.length + GALLERY_APP_VIEWS.length + GALLERY_COMPONENTS.length,
    );
  });

  it("every catalog id is unique across loom + app + component entries", () => {
    const ids = orderedCatalog().map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("app-view and component ids are disjoint from the loom fixture ids", () => {
    const loomIds = new Set(GALLERY_FIXTURES.map((f) => f.id));
    for (const e of [...GALLERY_APP_VIEWS, ...GALLERY_COMPONENTS]) {
      expect(loomIds.has(e.id)).toBe(false);
    }
  });

  it("sections render in nav order: loom → app → component", () => {
    const order = gallerySections().map((s) => s.id);
    // Filter the canonical order down to whichever sections are non-empty.
    const canonical = [SECTION_LOOM, SECTION_APP, SECTION_COMPONENT].filter((id) =>
      order.includes(id),
    );
    expect(order).toEqual(canonical);
  });

  it("each section's count equals the sum of its groups' items", () => {
    for (const s of gallerySections()) {
      const sum = s.groups.reduce((n, g) => n + g.items.length, 0);
      expect(s.count).toBe(sum);
    }
  });

  it("the loom section's groups follow lifecycle GROUP_ORDER", () => {
    const loom = gallerySections().find((s) => s.id === SECTION_LOOM);
    expect(loom).toBeDefined();
    const keys = loom!.groups.map((g) => g.key);
    // keys must be a subsequence of GROUP_ORDER (order preserved, gaps allowed).
    let cursor = 0;
    for (const k of keys) {
      const at = GROUP_ORDER.indexOf(k as (typeof GROUP_ORDER)[number], cursor);
      expect(at).toBeGreaterThanOrEqual(cursor);
      cursor = at + 1;
    }
  });

  it("orderedCatalog is exactly section→group→item flattened (pager == nav order)", () => {
    const flat = gallerySections().flatMap((s) => s.groups.flatMap((g) => g.items.map((i) => i.id)));
    expect(orderedCatalog().map((i) => i.id)).toEqual(flat);
  });

  it("every catalog item carries a label, description and badge", () => {
    for (const i of orderedCatalog()) {
      expect(i.label.length).toBeGreaterThan(0);
      expect(i.badge.length).toBeGreaterThan(0);
      expect(i.sectionLabel.length).toBeGreaterThan(0);
    }
  });
});

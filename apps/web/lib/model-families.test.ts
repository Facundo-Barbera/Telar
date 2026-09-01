/**
 * Folding a catalogue into models-with-windows.
 *
 * PINNED AGAINST THE REAL FIVE ROWS the installed Claude Code answered with on
 * this machine, because every judgement here is about the shape of somebody
 * else's list: that `sonnet` and `sonnet[1m]` are one model, that Opus has no
 * standard row at all, and that a display name can carry a window in it.
 */
// @ts-expect-error bun:test has no types in this app's tsconfig
import { describe, expect, test } from "bun:test";
import type { ProviderModel } from "@telar/engine-client";
import {
  contextWindowOf,
  familyKey,
  familyOf,
  groupFamilies,
  pickInFamily,
  rowFor,
  rowOf,
  stripWindow,
  windowSuffix,
  windowsOf,
} from "./model-families";
import { splitGenerations } from "./model-generations";
import { keepStarredVisible } from "./model-favorites";

const model = (id: string, extra: Partial<ProviderModel> = {}): ProviderModel => ({
  id,
  label: id,
  isDefault: false,
  hidden: false,
  efforts: [],
  fastMode: false,
  ...extra,
});

/** `GET /api/models?driver=claude`, verbatim. */
const CLAUDE: ProviderModel[] = [
  model("opus[1m]", {
    label: "Opus (1M context)",
    isDefault: true,
    efforts: ["low", "medium", "high", "xhigh", "max"],
    resolves: "claude-opus-5[1m]",
    fastMode: true,
  }),
  model("claude-fable-5[1m]", {
    label: "Fable",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    resolves: "claude-fable-5[1m]",
  }),
  model("sonnet", { label: "Sonnet", efforts: ["low", "medium", "high", "xhigh", "max"], resolves: "claude-sonnet-5" }),
  model("sonnet[1m]", {
    label: "Sonnet 5 (1M context)",
    efforts: ["low", "medium", "high", "xhigh", "max"],
    resolves: "claude-sonnet-5[1m]",
  }),
  model("haiku", { label: "Haiku", resolves: "claude-haiku-4-5-20251001" }),
];

describe("familyKey", () => {
  test("the window and the dated build come off the RESOLVED id", () => {
    // The literal ids `sonnet` and `sonnet[1m]` share no prefix worth reading;
    // what makes them one model is that they resolve into the same family.
    expect(familyKey(CLAUDE[2]!)).toBe("claude-sonnet-5");
    expect(familyKey(CLAUDE[3]!)).toBe("claude-sonnet-5");
    expect(familyKey(CLAUDE[4]!)).toBe("claude-haiku-4-5");
  });

  test("a model with no alias is its own family", () => {
    // Every Codex row. Nothing to strip, nothing to resolve.
    expect(familyKey(model("gpt-5.6-sol"))).toBe("gpt-5.6-sol");
  });

  test("a point release is its OWN family, not a build of the last one", () => {
    // Fable 5.1: `-5-1` is a version, not an 8-digit dated build — the strip
    // must not eat it, or 5.1 and 5 fold into one row and the picker can't
    // say which you'd run.
    expect(familyKey(model("claude-fable-5-1[1m]", { resolves: "claude-fable-5-1[1m]" }))).toBe("claude-fable-5-1");
    expect(familyKey(model("claude-fable-5[1m]", { resolves: "claude-fable-5[1m]" }))).toBe("claude-fable-5");
  });
});

describe("a new point release arrives (Fable 5.1)", () => {
  const withFable51 = [
    ...CLAUDE,
    model("claude-fable-5-1[1m]", {
      label: "Fable",
      efforts: ["low", "medium", "high", "xhigh", "max"],
      resolves: "claude-fable-5-1[1m]",
    }),
  ];

  test("it lists beside Fable 5 with its own versioned label, filed as current", () => {
    const families = groupFamilies(withFable51);
    const labels = new Map(families.map((family) => [family.id, family.label]));
    expect(labels.get("claude-fable-5")).toBe("Fable 5");
    expect(labels.get("claude-fable-5-1")).toBe("Fable 5.1");
    const { current, legacy } = splitGenerations(families);
    expect(current.map((family) => family.id)).toContain("claude-fable-5-1");
    expect(legacy.map((family) => family.id)).not.toContain("claude-fable-5-1");
  });
});

describe("contextWindowOf", () => {
  test("`[1m]` and nothing else", () => {
    expect(contextWindowOf(CLAUDE[0]!)).toBe("long");
    expect(contextWindowOf(CLAUDE[2]!)).toBe("standard");
    // The alias hides the suffix; what it resolves to does not.
    expect(contextWindowOf(model("some-alias", { resolves: "claude-sonnet-5[1m]" }))).toBe("long");
    expect(contextWindowOf(model("gpt-5.6-sol"))).toBe("standard");
  });
});

describe("stripWindow", () => {
  test("a window written into a name comes out of it", () => {
    expect(stripWindow("Opus (1M context)")).toBe("Opus");
    expect(stripWindow("Sonnet 5 (1M context)")).toBe("Sonnet 5");
    // Anything else in brackets is part of the name and stays.
    expect(stripWindow("Sonnet")).toBe("Sonnet");
    expect(stripWindow("GPT-5.6 (Sol)")).toBe("GPT-5.6 (Sol)");
  });
});

describe("groupFamilies", () => {
  test("five rows are four models, in catalogue order", () => {
    const families = groupFamilies(CLAUDE);
    expect(families.map((family) => family.id)).toEqual([
      "claude-opus-5",
      "claude-fable-5",
      "claude-sonnet-5",
      "claude-haiku-4-5",
    ]);
  });

  test("the name comes from the standard row where there is one, loses the window, and GAINS its version", () => {
    const families = groupFamilies(CLAUDE);
    // Claude publishes bare names; the version comes back from the family key
    // (the resolved wire id), dashes read as dots. Three bare names across
    // generations could not say WHICH Sonnet you were choosing.
    expect(families[2]!.label).toBe("Sonnet 5");
    // Opus has only the long row, so its label is that one, minus the window.
    expect(families[0]!.label).toBe("Opus 5");
    expect(families[1]!.label).toBe("Fable 5");
  });

  test("a family is default if any of its windows is", () => {
    expect(groupFamilies(CLAUDE)[0]!.isDefault).toBe(true);
    expect(groupFamilies(CLAUDE)[2]!.isDefault).toBe(false);
  });

  test("one visible window is enough to list the model", () => {
    // `hidden` is per row and means "do not show this"; it takes every row to
    // hide the model itself.
    const half = groupFamilies([
      model("sonnet", { resolves: "claude-sonnet-5", hidden: true }),
      model("sonnet[1m]", { resolves: "claude-sonnet-5[1m]" }),
    ]);
    expect(half).toHaveLength(1);
    expect(half[0]!.hidden).toBe(false);
    expect(groupFamilies([model("secret", { hidden: true })])[0]!.hidden).toBe(true);
  });
});

describe("windows", () => {
  test("what each model actually comes in", () => {
    const families = groupFamilies(CLAUDE);
    expect(windowsOf(families[2])).toEqual(["standard", "long"]);
    // Opus is 1M-only today and Haiku standard-only: neither offers a choice,
    // which is the whole reason this is read off the catalogue.
    expect(windowsOf(families[0])).toEqual(["long"]);
    expect(windowsOf(families[3])).toEqual(["standard"]);
    expect(windowsOf(undefined)).toEqual([]);
  });

  test("picking a window picks the provider's own model id", () => {
    const sonnet = groupFamilies(CLAUDE)[2]!;
    expect(rowFor(sonnet, "standard")?.id).toBe("sonnet");
    expect(rowFor(sonnet, "long")?.id).toBe("sonnet[1m]");
  });

  test("only the long window is printed on the pill", () => {
    expect(windowSuffix("long")).toBe("1M");
    // "Standard" on every pill forever is a word that never tells anybody
    // anything; absence reads as standard, the way it does for fast mode.
    expect(windowSuffix("standard")).toBeUndefined();
  });
});

describe("pickInFamily", () => {
  test("the window you are on comes with you", () => {
    const families = groupFamilies(CLAUDE);
    // Opus is 1M-only, so everyone starts long. Switching to Sonnet must not
    // quietly shorten the context you chose.
    expect(pickInFamily(families[2]!, "long").id).toBe("sonnet[1m]");
    expect(pickInFamily(families[2]!, "standard").id).toBe("sonnet");
  });

  test("a family without that window falls back rather than failing", () => {
    const families = groupFamilies(CLAUDE);
    // Haiku has no long row: standard is what runs, and the pill says so.
    expect(pickInFamily(families[3]!, "long").id).toBe("haiku");
    // Opus has no standard row.
    expect(pickInFamily(families[0]!, "standard").id).toBe("opus[1m]");
  });
});

describe("rowOf and familyOf", () => {
  test("a stored wire id finds the alias that covers it", () => {
    // Another client — or an older record — stores `claude-sonnet-5` where this
    // cockpit stores `sonnet`. They are the same model, and the row is where the
    // efforts, the fast-mode flag and the window all live.
    expect(rowOf(CLAUDE, "claude-sonnet-5")?.id).toBe("sonnet");
    expect(rowOf(CLAUDE, "sonnet[1m]")?.id).toBe("sonnet[1m]");
    expect(rowOf(CLAUDE, "claude-3-opus")).toBeUndefined();
    expect(rowOf(CLAUDE, undefined)).toBeUndefined();
  });

  test("the efforts a menu offers are that row's own", () => {
    expect(rowOf(CLAUDE, "claude-sonnet-5")?.efforts).toEqual(["low", "medium", "high", "xhigh", "max"]);
    // Haiku supports none. A menu that offered it three would fail the turn.
    expect(rowOf(CLAUDE, "haiku")?.efforts).toEqual([]);
  });

  test("a family is found through either spelling", () => {
    const families = groupFamilies(CLAUDE);
    expect(familyOf(families, "sonnet[1m]")?.label).toBe("Sonnet 5");
    expect(familyOf(families, "claude-sonnet-5")?.label).toBe("Sonnet 5");
    expect(familyOf(families, "gpt-5.6-sol")).toBeUndefined();
    expect(familyOf(families, undefined)).toBeUndefined();
  });
});

describe("what the fold does to the generation split", () => {
  test("the long-context Sonnet stops being filed as version 1", () => {
    // `modelVersion("sonnet[1m]")` finds the 1 in `[1m]`, so splitting raw rows
    // put the 1M Sonnet under "Legacy models". Its family id is
    // `claude-sonnet-5`, which reports 5, which is what it is.
    const split = splitGenerations(groupFamilies(CLAUDE));
    expect(split.current.map((family) => family.id)).toEqual(["claude-opus-5", "claude-fable-5", "claude-sonnet-5"]);
    // And Haiku 4.5 is a generation behind the 5 default, which is what the fold
    // finally made legible: its id said nothing, its resolved id says 4-5.
    expect(split.legacy.map((family) => family.id)).toEqual(["claude-haiku-4-5"]);
  });

  test("a starred model is never folded away", () => {
    const split = keepStarredVisible(splitGenerations(groupFamilies(CLAUDE)), new Set(["claude-haiku-4-5"]));
    expect(split.current.map((family) => family.id)).toContain("claude-haiku-4-5");
    expect(split.legacy).toEqual([]);
  });
});

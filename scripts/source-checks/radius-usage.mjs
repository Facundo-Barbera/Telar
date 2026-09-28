import { filesUnder, read } from "./files.mjs";

/** How often the cockpit reaches for a radius utility, tests excluded. */
export function radiusUses(utility, sources) {
  const pattern = new RegExp(`(?<![\\w-])${utility}(?![\\w-])`, "g");
  return sources.reduce((total, source) => total + (source.match(pattern) ?? []).length, 0);
}

export const radiusUsageCheck = {
  name: "card-radius-is-the-common-one",
  protects: "the radius doctrine's card rung (rounded-xl) stays the one most cards are drawn at",
  run() {
    const sources = filesUnder("apps/web/src", /\.tsx?$/).map(read);
    const card = radiusUses("rounded-xl", sources);
    const larger = radiusUses("rounded-2xl", sources);
    return card > larger ? [] : [`rounded-2xl (${larger}) now outnumbers rounded-xl (${card}); the doctrine in globals.css names the wrong card rung.`];
  },
};

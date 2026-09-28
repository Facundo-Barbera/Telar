import { commentRatchet } from "../comment-ratchet.mjs";
import { sizeLimits } from "../size-limits.mjs";
import { contextMenusCheck } from "./context-menus.mjs";
import { dropdownLabelsCheck } from "./dropdown-labels.mjs";
import { ROOT } from "./files.mjs";
import { invisibleCharactersCheck } from "./invisible-characters.mjs";
import { nativeViewMenusCheck } from "./native-view-menus.mjs";
import { radiusUsageCheck } from "./radius-usage.mjs";
import { settingsHintsCheck } from "./settings-hints.mjs";
import { settingsSearchCheck } from "./settings-search.mjs";
import { stockShadowsCheck } from "./stock-shadows.mjs";
import { titlebarBandCheck } from "./titlebar-band.mjs";
import { webStylePipelineCheck } from "./web-style-pipeline.mjs";

/** Checks kept out of source-invariants.mjs, run after its own; each is `{ name, protects, run() → failures }`. */
export const SOURCE_CHECKS = [
  invisibleCharactersCheck,
  dropdownLabelsCheck,
  nativeViewMenusCheck,
  contextMenusCheck,
  settingsHintsCheck,
  settingsSearchCheck,
  stockShadowsCheck,
  radiusUsageCheck,
  titlebarBandCheck,
  webStylePipelineCheck,
  {
    name: "comment-ratchet",
    protects: "no change raises a workspace's comment-line count over its merge base, and no change adds a comment over 6 lines",
    run: () => commentRatchet(ROOT),
  },
  {
    name: "size-limits",
    protects: "no source file over 800 lines and no function over 150, except the files listed in ALLOWED — which must leave the list once they fit",
    run: () => sizeLimits(ROOT),
  },
];

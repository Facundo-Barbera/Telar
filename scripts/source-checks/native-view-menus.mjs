import { filesUnder, read } from "./files.mjs";

// The ui/ overlay roots take the native browser view down while open; a feature on the raw primitive would draw behind it.
const RAW_OVERLAY = /from\s+["']@base-ui\/react\/(dialog|popover|menu|context-menu|select)["']/;

/** The raw overlay primitive a file imports, if any. */
export function rawOverlayImport(source) {
  return source.match(RAW_OVERLAY)?.[1];
}

export const nativeViewMenusCheck = {
  name: "overlays-hide-the-native-view",
  protects: "every dialog, sheet, popover, menu and select is drawn through @/ui, whose roots take the native browser view down while open",
  run() {
    const files = filesUnder("apps/web/src", /\.tsx?$/).filter((file) => !file.startsWith("apps/web/src/ui/"));
    return files.flatMap((file) => {
      const raw = rawOverlayImport(read(file));
      return raw ? [`${file}: imports @base-ui/react/${raw} directly; use the @/ui primitive`] : [];
    });
  },
};

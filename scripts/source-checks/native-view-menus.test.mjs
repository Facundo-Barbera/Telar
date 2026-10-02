import { expect, test } from "bun:test";
import { rawOverlayImport } from "./native-view-menus.mjs";

test("the shared primitive passes; a raw overlay primitive is caught", () => {
  expect(rawOverlayImport('import { Popover } from "@/ui/popover";')).toBeUndefined();
  expect(rawOverlayImport('import { Tooltip } from "@base-ui/react/tooltip";')).toBeUndefined();
  expect(rawOverlayImport('import { Menu } from "@base-ui/react/menu";')).toBe("menu");
  expect(rawOverlayImport('import { Dialog } from "@base-ui/react/dialog";')).toBe("dialog");
});

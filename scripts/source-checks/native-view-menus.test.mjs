import { expect, test } from "bun:test";
import { unguardedMenus } from "./native-view-menus.mjs";

test("a guarded menu passes; an unguarded or uncontrolled one is caught; menu parts are not roots", () => {
  const guarded = `useNativeViewOverlay(openOverlay !== null);\n<Popover open={openOverlay === "profile"} onOpenChange={(open) => (open ? x() : y())}>`;
  expect(unguardedMenus(guarded)).toEqual([]);
  expect(unguardedMenus(`useNativeViewOverlay(chooserOpen);\n<DropdownMenu open={otherOpen}>`)).toEqual(["DropdownMenu:2"]);
  expect(unguardedMenus(`useNativeViewOverlay(chooserOpen);\n<DropdownMenu>`)).toEqual(["DropdownMenu:2"]);
  expect(unguardedMenus(`<PopoverTrigger /><DropdownMenuItem />`)).toEqual([]);
});

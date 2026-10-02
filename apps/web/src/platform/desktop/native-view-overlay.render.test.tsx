import { describe, expect, test } from "bun:test";
import { act, useState, type ReactNode } from "react";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "@/ui/context-menu";
import { Dialog, DialogContent, DialogTitle } from "@/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/ui/select";
import { Sheet, SheetContent, SheetTitle } from "@/ui/sheet";
import { flush, installTestDom, mount, press } from "@/test/dom";
import { nativeViewOverlayHidden, onNativeViewOverlay } from "./native-view-overlay";

installTestDom();

type Overlay = (open: boolean, onOpenChange: (open: boolean) => void) => ReactNode;

const OVERLAYS: Record<string, Overlay> = {
  dialog: (open, onOpenChange) => (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogTitle>Restart to update?</DialogTitle>
      </DialogContent>
    </Dialog>
  ),
  sheet: (open, onOpenChange) => (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent>
        <SheetTitle>Sheet</SheetTitle>
      </SheetContent>
    </Sheet>
  ),
  popover: (open, onOpenChange) => (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger>Open</PopoverTrigger>
      <PopoverContent>Popover</PopoverContent>
    </Popover>
  ),
  "dropdown menu": (open, onOpenChange) => (
    <DropdownMenu open={open} onOpenChange={onOpenChange}>
      <DropdownMenuTrigger>Open</DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuItem>Item</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  ),
  "context menu": (open, onOpenChange) => (
    <ContextMenu open={open} onOpenChange={onOpenChange}>
      <ContextMenuTrigger>Target</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem>Item</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  ),
  select: (open, onOpenChange) => (
    <Select open={open} onOpenChange={onOpenChange} defaultValue="a">
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="a">A</SelectItem>
      </SelectContent>
    </Select>
  ),
};

function Harness({ overlays, setters }: { overlays: Overlay[]; setters: ((open: boolean) => void)[] }) {
  return overlays.map((overlay, index) => <Slot key={index} overlay={overlay} expose={(set) => (setters[index] = set)} />);
}

function Slot({ overlay, expose }: { overlay: Overlay; expose: (set: (open: boolean) => void) => void }) {
  const [open, setOpen] = useState(false);
  expose(setOpen);
  return overlay(open, setOpen);
}

async function harness(...overlays: Overlay[]) {
  const setters: ((open: boolean) => void)[] = [];
  const { unmount } = await mount(<Harness overlays={overlays} setters={setters} />);
  const toggle = async (index: number, open: boolean) => {
    await act(async () => setters[index]!(open));
    await flush(() => nativeViewOverlayHidden() === open);
  };
  return Object.assign(toggle, { unmount });
}

describe("an overlay takes the native browser view down while it is open", () => {
  for (const [name, overlay] of Object.entries(OVERLAYS)) {
    test(`${name}: opening hides the view and closing shows it again`, async () => {
      const seen: boolean[] = [];
      const unsubscribe = onNativeViewOverlay((hidden) => seen.push(hidden));
      const toggle = await harness(overlay);
      expect(nativeViewOverlayHidden()).toBe(false);
      await toggle(0, true);
      expect(nativeViewOverlayHidden()).toBe(true);
      await toggle(0, false);
      expect(nativeViewOverlayHidden()).toBe(false);
      expect(seen).toEqual([false, true, false]);
      unsubscribe();
    });
  }

  test("a menu over a dialog keeps the view down until both have closed", async () => {
    const toggle = await harness(OVERLAYS.dialog!, OVERLAYS["dropdown menu"]!);
    await toggle(0, true);
    await toggle(1, true);
    await toggle(0, false);
    await flush();
    expect(nativeViewOverlayHidden()).toBe(true);
    await toggle(1, false);
    expect(nativeViewOverlayHidden()).toBe(false);
  });

  test("an uncontrolled menu claims from its own open state", async () => {
    await mount(
      <DropdownMenu>
        <DropdownMenuTrigger>Open</DropdownMenuTrigger>
        <DropdownMenuContent>
          <DropdownMenuItem>Item</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    const trigger = document.querySelector("button")!;
    await press(trigger);
    expect(nativeViewOverlayHidden()).toBe(true);
    await press(trigger);
    expect(nativeViewOverlayHidden()).toBe(false);
  });

  test("unmounting an open overlay shows the view again", async () => {
    const toggle = await harness(OVERLAYS.popover!);
    await toggle(0, true);
    expect(nativeViewOverlayHidden()).toBe(true);
    toggle.unmount();
    expect(nativeViewOverlayHidden()).toBe(false);
  });
});

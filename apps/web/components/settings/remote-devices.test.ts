// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * PAIRED DEVICES ARE A TABLE WITH ITS OWN SCROLL (#365).
 *
 * The defect was a pane whose LENGTH was a property of how many phones somebody
 * had ever paired: one `Row` per device, each with a four-fact sentence under
 * its name, so the settings below — Other Macs, the Danger group — moved down
 * the page every time one more paired. What is pinned here is the shape that
 * fixes it, and the two facts that had to survive the move: a device can still
 * be renamed in place, and the row still says where it actually connected from.
 *
 * Read from source rather than rendered: the section fetches `/api/remote` on
 * mount, so a static render is an empty pane with no devices in it at all.
 */
const source = readFileSync(new URL("./remote-section.tsx", import.meta.url), "utf8");

test("the list is a table, capped in height, scrolling on its own", () => {
  expect(source).toContain('<div className="-mx-4 max-h-80 overflow-y-auto">');
  expect(source).toContain("<table");
  // The cap is in PIXELS, not rows: a row's height depends on whether its
  // device declared a client and a machine, so no row count holds for both.
  expect(source).toContain("max-h-80");
});

test("the four columns the list is actually read for", () => {
  for (const column of ["Device", "Kind", "Last seen", "Actions"]) {
    expect(source).toContain(`font-normal">${column}</th>`);
  }
  // Sticky: a scrolled list whose headings have gone is four columns of values
  // with nothing saying which is which.
  expect(source).toContain('className="sticky top-0 z-10 bg-card"');
});

test("a device that has never come back says PAIRED, not last seen", () => {
  // A column headed "Last seen" showing the pairing date is a lie by omission.
  expect(source).toContain("device.lastSeenAt ? fmtAgo(device.lastSeenAt) : `paired ${fmtAgo(device.createdAt)}`");
});

test("renaming in place survived the move, and so did the address it connected from", () => {
  expect(source).toContain('title="Rename"');
  expect(source).toContain("const whereabouts = [device.identity?.address");
  // The declared client is its own column now rather than a clause in a run-on
  // sentence — and it is still suppressed when the name already carries it.
  expect(source).toContain("{source ?? kind ?? \"—\"}");
  expect(source).toContain("declaredSource && !device.name.includes(declaredSource)");
});

test("the role is a dropdown, like every other enumeration (#364)", () => {
  expect(source).toContain('<Dropdown<"full" | "observer">');
  expect(source).not.toContain("<Segmented");
  // The trigger needs its own short text: the option labels carry a `title`
  // element, which is a tooltip and not something a trigger can render.
  expect(source).toContain('{ value: "observer", text: "View only"');
});

test("revoke stays on the device it names", () => {
  // A Danger group that hoisted every list affordance out of its list would be
  // a worse page, not a safer one — revoke-all is separate and still is.
  expect(source).toContain("aria-label={`Revoke ${device.name}`}");
  expect(source).toContain("<RevokeOthersRow");
});

// @ts-expect-error bun:test has no types in this app's tsconfig
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { SpoolLane } from "@telar/engine-client";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DEADLINE_KIND_ITEMS, laneItems, laneLabel } from "./lanes";

const lane = (patch: Partial<SpoolLane> = {}): SpoolLane => ({ key: "deep_work", label: "Deep work", window: "mornings", items: [], ...patch });

test("a lane's label is its name, with its window when it has one", () => {
  expect(laneLabel(lane())).toBe("Deep work — mornings");
  expect(laneLabel(lane({ window: "" }))).toBe("Deep work");
});

/**
 * THE TRIGGER READS THE NAME, NOT THE KEY (#352, #318's bug in the Spool).
 * base-ui's `Select.Value` renders the raw value with no `items` mapping, so
 * every lane picker showed the stored `deep_work` above a list reading
 * "Deep work — mornings".
 */
test("a Select given laneItems renders the lane's name in its trigger", () => {
  const lanes = [lane()];
  const html = renderToStaticMarkup(
    <Select value="deep_work" items={laneItems(lanes)}>
      <SelectTrigger>
        <SelectValue placeholder="not filed in any lane" />
      </SelectTrigger>
      <SelectContent>
        {lanes.map((l) => <SelectItem key={l.key} value={l.key}>{laneLabel(l)}</SelectItem>)}
      </SelectContent>
    </Select>,
  );
  expect(html).toContain('data-slot="select-value" class="flex flex-1 text-left">Deep work — mornings<');
  expect(html).not.toContain(">deep_work<");
});

test("with nothing filed the placeholder still wins", () => {
  const html = renderToStaticMarkup(
    <Select value="" items={laneItems([lane()])}>
      <SelectTrigger>
        <SelectValue placeholder="not filed in any lane" />
      </SelectTrigger>
      <SelectContent />
    </Select>,
  );
  expect(html).toContain("not filed in any lane");
});

test("the deadline kind reads 'mine', which is the only word its list ever used", () => {
  expect(DEADLINE_KIND_ITEMS.self).toBe("mine");
  const html = renderToStaticMarkup(
    <Select value="self" items={DEADLINE_KIND_ITEMS}>
      <SelectTrigger>
        <SelectValue />
      </SelectTrigger>
      <SelectContent />
    </Select>,
  );
  expect(html).toContain('data-slot="select-value" class="flex flex-1 text-left">mine<');
});

/** Every lane picker carries the mapping — the fix is worthless in two of three. */
test("all three lane pickers pass the mapping", () => {
  for (const file of ["tray.tsx", "task-row.tsx", "add-task.tsx"]) {
    expect(readFileSync(new URL(`./${file}`, import.meta.url), "utf8")).toContain("items={laneItems(lanes)}");
  }
  for (const file of ["tray.tsx", "add-task.tsx"]) {
    expect(readFileSync(new URL(`./${file}`, import.meta.url), "utf8")).toContain("items={DEADLINE_KIND_ITEMS}");
  }
});

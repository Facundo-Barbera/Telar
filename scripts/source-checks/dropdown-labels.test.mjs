import { expect, test } from "bun:test";
import { ungroupedLabels } from "./dropdown-labels.mjs";

test("a label dropped straight into the content is caught; one in a group is not", () => {
  expect(ungroupedLabels(`<DropdownMenuContent><DropdownMenuLabel>Reasoning</DropdownMenuLabel></DropdownMenuContent>`)).toHaveLength(1);
  expect(ungroupedLabels(`<DropdownMenuContent><DropdownMenuGroup><DropdownMenuLabel>Reasoning</DropdownMenuLabel></DropdownMenuGroup></DropdownMenuContent>`)).toEqual([]);
});

test("a label after a group has closed is back outside it", () => {
  expect(
    ungroupedLabels(`<DropdownMenuContent><DropdownMenuGroup><DropdownMenuItem /></DropdownMenuGroup><DropdownMenuLabel>Access</DropdownMenuLabel></DropdownMenuContent>`),
  ).toHaveLength(1);
});

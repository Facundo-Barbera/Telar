import { expect, test } from "bun:test";
import { contextMenuProblems } from "./context-menus.mjs";

const shared = 'import { ContextMenuItem } from "@/ui/context-menu";\n';

test("a menu on the shared primitive with callback items passes", () => {
  expect(contextMenuProblems(`${shared}<ContextMenuItem onClick={() => onOpen(path)} />`)).toEqual([]);
});

test("a private menu, a missing import and a fetching item are each caught", () => {
  expect(contextMenuProblems(`<ContextMenuItem onClick={() => onOpen(path)} />`)).toEqual(["does not import @/ui/context-menu"]);
  expect(contextMenuProblems(`${shared}function ContextMenu() {}\n<ContextMenuItem />`)).toEqual(["defines a ContextMenu of its own"]);
  expect(contextMenuProblems(`${shared}<ContextMenuItem onClick={() => fetch("/v2/x")} />`)).toHaveLength(1);
});

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useListNav } from "./use-list-nav";

GlobalRegistrator.register({ url: "http://localhost/" });
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
});
afterAll(async () => {
  await GlobalRegistrator.unregister();
});

function List({ rows, wrap, picked }: { rows: string[]; wrap?: boolean; picked: string[] }) {
  const nav = useListNav({ count: rows.length, onPick: (at) => picked.push(rows[at]!), idPrefix: "list", ...(wrap === undefined ? {} : { wrap }) });
  return (
    <div>
      <input aria-activedescendant={nav.activeId} onKeyDown={nav.onKeyDown} />
      <ul role="listbox">
        {rows.map((row, at) => (
          <li key={row} {...nav.optionProps(at)}>
            {row}
          </li>
        ))}
      </ul>
    </div>
  );
}

const host = () => document.body.lastElementChild as HTMLElement;
function mount(node: React.ReactElement) {
  const element = document.createElement("div");
  document.body.append(element);
  root = createRoot(element);
  act(() => root!.render(node));
}
const press = (key: string) =>
  act(() => {
    host().querySelector("input")!.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
const selected = () => host().querySelector('[aria-selected="true"]')?.textContent;

describe("useListNav", () => {
  test("arrows move the highlight and Enter picks it", () => {
    const picked: string[] = [];
    mount(<List rows={["a", "b", "c"]} picked={picked} />);
    expect(selected()).toBe("a");
    press("ArrowDown");
    press("ArrowDown");
    expect(selected()).toBe("c");
    expect(host().querySelector("input")!.getAttribute("aria-activedescendant")).toBe("list-2");
    press("Enter");
    expect(picked).toEqual(["c"]);
  });

  test("wraps at both ends by default, and stops at them without wrap", () => {
    mount(<List rows={["a", "b"]} picked={[]} />);
    press("ArrowUp");
    expect(selected()).toBe("b");
    act(() => root!.render(<List rows={["a", "b"]} wrap={false} picked={[]} />));
    press("ArrowDown");
    expect(selected()).toBe("b");
  });

  test("a list that shrinks under the highlight keeps a real row highlighted", () => {
    const picked: string[] = [];
    mount(<List rows={["a", "b", "c"]} picked={picked} />);
    press("ArrowDown");
    press("ArrowDown");
    act(() => root!.render(<List rows={["a"]} picked={picked} />));
    expect(selected()).toBe("a");
    press("Enter");
    expect(picked).toEqual(["a"]);
  });

  test("an empty list highlights nothing and picks nothing", () => {
    const picked: string[] = [];
    mount(<List rows={[]} picked={picked} />);
    press("ArrowDown");
    press("Enter");
    expect(picked).toEqual([]);
    expect(host().querySelector("input")!.hasAttribute("aria-activedescendant")).toBe(false);
  });
});

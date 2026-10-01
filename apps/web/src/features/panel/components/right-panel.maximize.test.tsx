import { beforeEach, describe, expect, test } from "bun:test";
import { useState } from "react";
import { installTestDom, mount, click, stubFetch } from "@/test/dom";
import { SidebarProvider, useSidebar } from "@/ui/sidebar";
import { setSidebarCollapsed } from "@/ui/sidebar-width";
import { RightPanel } from "./right-panel";
import type { PanelTabItem } from "../model";

installTestDom();

const STORED = "telar-sidebar:rail-test";
const tabs = [{ id: "agents", kind: "agents", params: {} }] as PanelTabItem[];

function Rail() {
  return <p data-testid="rail">{useSidebar().state}</p>;
}

function Shell() {
  const [open, setOpen] = useState(true);
  return (
    <SidebarProvider storageKey="rail-test">
      <Rail />
      <button type="button" onClick={() => setOpen(false)}>
        close panel
      </button>
      <RightPanel sessionId="session_a" projectId="project_a" tabs={tabs} tab="agents" open={open} onTabChange={() => {}} onOpenTab={() => {}} onCloseTab={() => {}} onClose={() => {}} />
    </SidebarProvider>
  );
}

const rail = (host: HTMLElement) => host.querySelector('[data-testid="rail"]')!.textContent;
const labelled = (host: HTMLElement, label: string) => host.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const byText = (host: HTMLElement, text: string) => [...host.querySelectorAll("button")].find((node) => node.textContent === text)!;

const stored = () => JSON.parse(localStorage.getItem(STORED) ?? "{}").collapsed;

beforeEach(() => {
  setSidebarCollapsed("rail-test", false);
  stubFetch({});
});

describe("filling the window with the panel", () => {
  test("hides an open rail, and brings it back on restore without rewriting the person's choice", async () => {
    const { host } = await mount(<Shell />);
    expect(rail(host)).toBe("expanded");
    await click(labelled(host, "Fill the window"));
    expect(rail(host)).toBe("collapsed");
    expect(stored()).toBe(false);
    await click(labelled(host, "Exit fullscreen"));
    expect(rail(host)).toBe("expanded");
  });

  test("a rail the person had hidden stays hidden after restore", async () => {
    setSidebarCollapsed("rail-test", true);
    const { host } = await mount(<Shell />);
    expect(rail(host)).toBe("collapsed");
    await click(labelled(host, "Fill the window"));
    await click(labelled(host, "Exit fullscreen"));
    expect(rail(host)).toBe("collapsed");
    expect(stored()).toBe(true);
  });

  test("closing the panel while it fills the window brings the rail back", async () => {
    const { host } = await mount(<Shell />);
    await click(labelled(host, "Fill the window"));
    await click(byText(host, "close panel"));
    expect(rail(host)).toBe("expanded");
  });
});

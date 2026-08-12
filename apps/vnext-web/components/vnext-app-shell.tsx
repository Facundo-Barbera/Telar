"use client";

import { useState, type ReactNode } from "react";
import { Icon } from "./vnext-icons";
import { VNextSidebar } from "./vnext-sidebar";

export function VNextAppShell({ children }: { children: ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  return <div className={`vnext-app-shell ${collapsed ? "sidebar-collapsed" : ""}`}><VNextSidebar collapsed={collapsed} onClose={() => setCollapsed(true)} /><div className="vnext-app-inset"><header className="vnext-mobile-bar"><button type="button" className="vnext-icon-button" aria-label="Open navigation" onClick={() => setCollapsed(false)}><Icon name="menu" /></button><span>telar <em>vNext</em></span></header>{collapsed && <button type="button" className="vnext-desktop-sidebar-toggle vnext-icon-button" aria-label="Show navigation" onClick={() => setCollapsed(false)}><Icon name="menu" /></button>}{children}</div>{!collapsed && <button type="button" className="vnext-sidebar-scrim" aria-label="Close navigation" onClick={() => setCollapsed(true)} />}</div>;
}

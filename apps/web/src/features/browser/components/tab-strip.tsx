"use client";

import { useState } from "react";
import { CodeXmlIcon, Loader2Icon, MoonIcon, PlusIcon, UserRoundIcon, XIcon } from "lucide-react";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { describePermissionKinds } from "@/lib/desktop-site-permissions";
import { browserPageReference, startReferenceDrag } from "@/lib/drag-reference";
import { useNativeViewOverlay } from "@/lib/native-view-overlay";
import { cn } from "@/lib/utils";
import type { BrowserUi } from "../hooks/use-browser-session";
import type { DesktopBrowserTab } from "../types";

// Every item names this tab by index, so a right-click on a background tab never selects it.
function TabMenu({ tab, b, className, children }: { tab: DesktopBrowserTab; b: BrowserUi; className: string; children: React.ReactNode }) {
  const tabs = b.state?.tabs ?? [];
  const { act } = b;
  const onOpenExternal = b.bridge.openExternal;
  const web = /^https?:\/\//i.test(tab.url);
  const [menuOpen, setMenuOpen] = useState(false);
  useNativeViewOverlay(menuOpen);
  return (
    <ContextMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <ContextMenuTrigger className={className}>{children}</ContextMenuTrigger>
      <ContextMenuContent className="w-auto">
        <ContextMenuItem onClick={() => void act({ action: "reload", index: tab.index })}>Reload</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => void act({ action: "duplicate", index: tab.index })}>Duplicate</ContextMenuItem>
        <ContextMenuItem onClick={() => void navigator.clipboard.writeText(tab.url)}>Copy URL</ContextMenuItem>
        {onOpenExternal && (
          <ContextMenuItem disabled={!web} onClick={() => void onOpenExternal(tab.url)}>
            Open in system browser
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem onClick={() => void act({ action: "close", index: tab.index })}>Close</ContextMenuItem>
        <ContextMenuItem
          disabled={tabs.length < 2}
          onClick={() => {
            // Descending: closing a tab renumbers every tab after it.
            void (async () => {
              for (const other of [...tabs].sort((a, c) => c.index - a.index)) {
                if (other.id !== tab.id) await act({ action: "close", index: other.index });
              }
            })();
          }}
        >
          Close others
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function TabMarks({ tab, b }: { tab: DesktopBrowserTab; b: BrowserUi }) {
  const { state, prompts } = b;
  const prompt = prompts.find((open) => open.tabId === tab.id);
  const otherProfile = state?.profile && tab.profileId && tab.profileId !== state.profile.id;
  return (
    <>
      {tab.loading ? (
        <Loader2Icon aria-label="Loading" className="size-3 shrink-0 animate-spin text-muted-foreground" />
      ) : tab.sleeping ? (
        <span title="Remembered — loads when selected" className="flex shrink-0">
          <MoonIcon aria-label="Not loaded yet" className="size-3 text-muted-foreground/70" />
        </span>
      ) : tab.favicon ? (
        // eslint-disable-next-line @next/next/no-img-element -- page-supplied favicon URL; nothing for next/image here
        <img src={tab.favicon} alt="" aria-hidden className="size-3 shrink-0 rounded-[2px]" />
      ) : null}
      {prompt && !tab.active ? (
        <span title={`This page is asking to use your ${describePermissionKinds(prompt.kinds)}`} className="flex shrink-0">
          <span aria-label="Waiting for a permission answer" role="img" className="block size-1.5 rounded-full bg-primary" />
        </span>
      ) : null}
      {tab.devtools ? (
        <span title="Developer Tools are open on this tab" className="flex shrink-0">
          <CodeXmlIcon aria-label="Developer Tools open" className="size-3 text-primary" />
        </span>
      ) : null}
      {otherProfile ? (
        <span
          title={`Signed in as ${state?.profiles?.find((profile) => profile.id === tab.profileId)?.label ?? "another profile"} — the profile this tab was opened in`}
          className="flex shrink-0"
        >
          <UserRoundIcon aria-label="Another browser profile" className="size-3 text-warning" />
        </span>
      ) : null}
    </>
  );
}

/** The tab strip. A tab drags into the message as a reference to the page open in this browser. */
export function TabStrip({ b }: { b: BrowserUi }) {
  const { act } = b;
  return (
    <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border px-2 py-1" role="tablist" aria-label="Browser tabs">
      {(b.state?.tabs ?? []).map((tab) => (
        <div
          key={tab.id}
          className="min-w-0"
          draggable
          onDragStart={(event) => startReferenceDrag(event.dataTransfer, browserPageReference({ title: tab.title, url: tab.url }))}
          onAuxClick={(event) => {
            if (event.button === 1) void act({ action: "close", index: tab.index });
          }}
        >
          <TabMenu
            tab={tab}
            b={b}
            className={cn(
              "flex min-w-0 max-w-44 cursor-grab items-center gap-1 rounded-md px-2 py-1 active:cursor-grabbing",
              tab.active ? "bg-muted" : "hover:bg-muted/50",
              tab.controller === "agent" && "ring-1 ring-primary/40",
              tab.agentFocus && tab.controller !== "agent" && "ring-1 ring-primary/20",
            )}
          >
            <TabMarks tab={tab} b={b} />
            <span
              aria-label={tab.openedBy === "human" ? "Opened by you" : "Opened by the agent"}
              title={`${tab.openedBy === "human" ? "Opened by you" : "Opened by the agent"}${tab.controller === "agent" ? " · agent acting" : tab.agentFocus ? " · the agent is working here" : ""}`}
              className={cn("size-1.5 shrink-0 rounded-full", tab.openedBy === "human" ? "bg-warning" : "bg-primary/70")}
            />
            <button
              type="button"
              role="tab"
              aria-selected={tab.active}
              className="min-w-0 flex-1 truncate text-left text-xs"
              title={`${tab.url}\nDrag into the message to reference this page`}
              onClick={() => void act({ action: "select", index: tab.index })}
            >
              {tab.title || "New tab"}
            </button>
            <button
              type="button"
              aria-label={`Close ${tab.title || "tab"}`}
              className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={(event) => {
                event.stopPropagation();
                void act({ action: "close", index: tab.index });
              }}
            >
              <XIcon className="size-3" />
            </button>
          </TabMenu>
        </div>
      ))}
      <button type="button" aria-label="New tab" className="shrink-0 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground" onClick={() => void act({ action: "new" })}>
        <PlusIcon className="size-3.5" />
      </button>
    </div>
  );
}

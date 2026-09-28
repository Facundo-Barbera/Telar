"use client";

import { useState } from "react";
import { GlobeIcon } from "lucide-react";
import type { BrowserProvider, BrowserSnapshot } from "@telar/engine-client";
import { createEngineApi } from "@/platform/engine";
import { browserPageReference, startReferenceDrag } from "@/features/composer";
import { Badge } from "@/ui/badge";
import { Spinner } from "@/ui/spinner";
import { PanelEmpty } from "@/ui/panel";
import { cn } from "@/ui/utils";
import { usePoll } from "@/ui/hooks/use-poll";
import { browserTabLabel, type BrowserState } from "../model";

const api = createEngineApi();

/** A screenshot is a round trip through Chromium: fast enough to watch an agent, not a frame rate. */
const BROWSER_POLL_MS = 3_000;

const BROWSER_PROVIDER: Record<BrowserProvider, string> = {
  headless: "the engine’s own headless Chromium",
  attached: "a client-provided webview",
  none: "no browser",
};

/** A browser page for clients with no native view. Only the focused page can be photographed. */
export function BrowserScreenshotSurface({ pageId, state, sessionId }: { pageId: string; state?: BrowserState; sessionId?: string }) {
  const page = state?.tabs.find((tab) => tab.id === pageId);
  const [snapshot, setSnapshot] = useState<BrowserSnapshot>();
  const live = Boolean(page?.active) && Boolean(sessionId);

  usePoll(
    async (signal) => {
      if (!sessionId) return;
      try {
        const next = await api.browserState(sessionId, { screenshot: true });
        if (!signal.aborted) setSnapshot(next.browser);
      } catch {
        // The address row stays true when the browser cannot be described.
      }
    },
    live ? BROWSER_POLL_MS : null,
    { key: sessionId },
  );

  if (!page) {
    return (
      <PanelEmpty icon={<GlobeIcon />} title="This page is no longer open">
        The engine closed it, or the session ended.
      </PanelEmpty>
    );
  }
  const provider = BROWSER_PROVIDER[state?.provider ?? "none"];
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        draggable
        onDragStart={(event) => startReferenceDrag(event.dataTransfer, browserPageReference({ title: page.title, url: page.url }))}
        title="Drag into the message to reference this page"
        className="flex shrink-0 cursor-grab items-center gap-2 border-b border-border px-3 py-2 active:cursor-grabbing"
      >
        <GlobeIcon className={cn("size-3.5 shrink-0", page.loading ? "text-primary" : "text-muted-foreground")} />
        <span className="min-w-0 flex-1 truncate font-mono text-2xs text-muted-foreground" title={page.url}>
          {page.url || "about:blank"}
        </span>
        {live && !snapshot?.screenshot && <Spinner className="size-3 shrink-0 text-muted-foreground" />}
        {page.loading && <Badge variant="outline" className="shrink-0 px-1 py-0 text-4xs font-normal">loading</Badge>}
        {page.active && <Badge variant="secondary" className="shrink-0 px-1 py-0 text-4xs font-normal">active</Badge>}
      </div>
      {snapshot?.screenshot ? (
        <div className="min-h-0 flex-1 overflow-auto bg-muted/40 p-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- a data URL polled from the engine; there is nothing for next/image to optimise */}
          <img
            src={snapshot.screenshot}
            alt={`Screenshot of ${browserTabLabel(page)}`}
            className="w-full rounded-md border border-border shadow-1"
          />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <div className="max-w-sm text-center">
            <GlobeIcon className="mx-auto size-8 text-muted-foreground/40" />
            <p className="mt-4 text-sm font-medium">{browserTabLabel(page)}</p>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              {!page.active
                ? "Only the page with focus can be photographed."
                : snapshot?.error
                  ? snapshot.error
                  : snapshot && !snapshot.running
                    ? `The ${provider} is no longer running. This page is what it had open when it stopped.`
                    : `Waiting on the first frame from ${provider}.`}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

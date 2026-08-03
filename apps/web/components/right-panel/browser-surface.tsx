"use client";

import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  ExternalLinkIcon,
  GlobeIcon,
  LoaderCircleIcon,
  PlusIcon,
  RadioTowerIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
  XIcon,
} from "lucide-react";
import {
  useControlledBrowser,
  useDesktopBrowserViewport,
} from "@/lib/use-controlled-browser";
import { cn } from "@/lib/utils";
import type { TelarDesktopBrowserBridge } from "@/types/telar-desktop";

export function normalizeBrowserUrl(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed === "about:blank") return trimmed;
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function DesktopBrowserViewport({ bridge }: { bridge: TelarDesktopBrowserBridge }) {
  const hostRef = useRef<HTMLDivElement>(null);
  useDesktopBrowserViewport(bridge, hostRef);

  return <div ref={hostRef} className="min-h-0 flex-1 bg-white" aria-label="Desktop browser viewport" />;
}

export function BrowserSurface({
  title,
  url,
  onNavigate,
}: {
  title: string;
  url: string;
  onNavigate: (url: string) => void;
}) {
  const [draft, setDraft] = useState(url === "about:blank" ? "" : url);
  const [invalid, setInvalid] = useState(false);
  const syncDraft = useCallback((nextUrl: string) => setDraft(nextUrl), []);
  const {
    act,
    desktopBridge,
    hasNavigatedTab,
    loading,
    refresh,
    servers,
    serverState,
    setup,
    state,
    working,
  } = useControlledBrowser(syncDraft);
  const activeTab = useMemo(
    () => state.tabs.find((tab) => tab.active) ?? state.tabs[0] ?? null,
    [state.tabs],
  );

  const navigate = useCallback(async (next: string) => {
    setInvalid(false);
    if (await act({ action: state.tabs.length > 0 ? "navigate" : "new", url: next })) {
      onNavigate(next);
    }
  }, [act, onNavigate, state.tabs.length]);

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const next = normalizeBrowserUrl(draft);
    setInvalid(next === null);
    if (next) void navigate(next);
  };

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-1 border-b border-border bg-muted/20 px-2 pt-1.5">
        <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto pb-1.5">
          {state.tabs.map((tab) => (
            <div
              key={tab.index}
              className={cn(
                "group relative flex h-7 max-w-44 shrink-0 items-center rounded-lg text-[11px] text-muted-foreground hover:bg-muted",
                tab.active && "bg-background text-foreground shadow-sm",
              )}
            >
              <button
                type="button"
                onClick={() => void act({ action: "select", index: tab.index })}
                className="flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-lg px-2 pr-6 text-left"
              >
                <GlobeIcon className="size-3 shrink-0" />
                <span className="min-w-0 flex-1 truncate">{tab.title || `Tab ${tab.index + 1}`}</span>
              </button>
              <button
                type="button"
                aria-label={`Close ${tab.title || "browser tab"}`}
                onClick={(event) => {
                  event.stopPropagation();
                  void act({ action: "close", index: tab.index });
                }}
                className="absolute right-1 rounded p-0.5 opacity-0 hover:bg-muted group-hover:opacity-100 focus:opacity-100"
              >
                <XIcon className="size-3" />
              </button>
            </div>
          ))}
          <button
            type="button"
            aria-label="New browser tab"
            onClick={() => void act({ action: "new" })}
            className="flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <PlusIcon className="size-3.5" />
          </button>
        </div>
      </div>
      <form onSubmit={submit} className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1.5">
        <button type="button" onClick={() => void act({ action: "back" })} aria-label="Go back" className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
          <ArrowLeftIcon className="size-3.5" />
        </button>
        <button type="button" onClick={() => void act({ action: "forward" })} aria-label="Go forward" className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
          <ArrowRightIcon className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={() => {
            if (activeTab?.url && activeTab.url !== "about:blank") {
              void act({ action: "reload" });
            } else {
              void refresh();
            }
          }}
          aria-label="Reload browser page"
          className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <RefreshCwIcon className={cn("size-3.5", (loading || working) && "animate-spin")} />
        </button>
        <input
          aria-label="Browser address"
          value={draft}
          onChange={(event) => { setDraft(event.target.value); if (invalid) setInvalid(false); }}
          placeholder="localhost:3000"
          className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 font-mono text-[11px] outline-none placeholder:text-muted-foreground/50 focus:border-ring"
        />
        <button type="submit" aria-label="Open address" className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
          <ArrowRightIcon className="size-3.5" />
        </button>
        {activeTab?.url && activeTab.url !== "about:blank" && (
          <a href={activeTab.url} target="_blank" rel="noreferrer" aria-label={`Open ${title} in a new window`} className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
            <ExternalLinkIcon className="size-3.5" />
          </a>
        )}
      </form>

      {invalid && <p className="border-b border-destructive/20 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">Enter an http or https address.</p>}
      {state.error && (
        <div className="flex items-start gap-2 border-b border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
          <ShieldAlertIcon className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
          <div className="min-w-0 flex-1">
            <p className="break-words">{state.error}</p>
            {!desktopBridge && /not (?:found|installed)|install/i.test(state.error) && (
              <button
                type="button"
                disabled={working}
                onClick={() => void setup()}
                className="mt-2 rounded-lg bg-foreground px-2.5 py-1.5 font-medium text-background disabled:opacity-50"
              >
                {working ? "Installing…" : "Set up controlled browser"}
              </button>
            )}
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground"><LoaderCircleIcon className="size-5 animate-spin" /></div>
      ) : desktopBridge && hasNavigatedTab ? (
        <DesktopBrowserViewport bridge={desktopBridge} />
      ) : state.screenshot && hasNavigatedTab ? (
        <div className="flex min-h-0 flex-1 items-start justify-center overflow-auto bg-neutral-950 p-2">
          {/* eslint-disable-next-line @next/next/no-img-element -- live data URL from the local browser runtime */}
          <img src={state.screenshot} alt={`Controlled browser preview for ${activeTab?.title ?? title}`} className="max-w-full rounded-lg bg-white shadow" />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-8">
          <div className="mx-auto w-full max-w-2xl">
            <div className="flex items-center gap-2 text-sm font-medium"><RadioTowerIcon className="size-4 text-muted-foreground" />Local servers</div>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">Open a server in Telar&apos;s shared controlled browser. Agents can inspect and interact with the same tabs.</p>
            {serverState === "loading" ? (
              <div className="mt-5 space-y-2">{[0, 1, 2].map((item) => <div key={item} className="h-14 animate-pulse rounded-xl border border-border bg-muted/30" />)}</div>
            ) : servers.length > 0 ? (
              <div className="mt-5 space-y-2">
                {servers.map((server) => (
                  <button key={`${server.name}:${server.port}`} type="button" onClick={() => { setDraft(server.url); void navigate(server.url); }} className="flex w-full items-center gap-3 rounded-xl border border-border bg-card px-3 py-3 text-left shadow-sm hover:bg-muted/50">
                    <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-border bg-background"><GlobeIcon className="size-4 text-muted-foreground" /></span>
                    <span className="min-w-0 flex-1"><span className="block truncate text-sm font-medium">{server.name}</span><span className="block truncate font-mono text-[11px] text-muted-foreground">localhost:{server.port}</span></span>
                    <span aria-label="Listening" className="size-2 shrink-0 rounded-full bg-emerald-500" />
                  </button>
                ))}
              </div>
            ) : (
              <div className="mt-10 flex flex-col items-center gap-2 text-center text-muted-foreground"><GlobeIcon className="size-6 opacity-50" /><p className="text-sm font-medium text-foreground">No local servers found</p></div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

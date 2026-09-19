"use client";

import { useEffect, useState } from "react";
import { GlobeIcon, HistoryIcon, RadioTowerIcon, XIcon } from "lucide-react";

type Suggestions = { recent: { url: string }[]; servers: { url: string; port: number }[] };
type SuggestionsBridge = {
  suggestions?: (scopeKey: string) => Promise<Suggestions>;
  removeSuggestion?: (scopeKey: string, url: string) => Promise<void>;
};

type Props = { scopeKey: string; onOpen: (url: string) => void };

export function BrowserStartPage(props: Props) {
  return <BrowserStartPageContent key={props.scopeKey} {...props} />;
}

function BrowserStartPageContent({ scopeKey, onOpen }: Props) {
  const [data, setData] = useState<Suggestions>();
  const [error, setError] = useState(false);
  useEffect(() => {
    let live = true;
    const bridge = (window as unknown as { telarDesktop?: { browser?: SuggestionsBridge } }).telarDesktop?.browser;
    const refresh = async () => {
      try {
        const next = await bridge?.suggestions?.(scopeKey);
        if (live) { setData(next ?? { recent: [], servers: [] }); setError(false); }
      } catch { if (live) setError(true); }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15000);
    return () => { live = false; window.clearInterval(timer); };
  }, [scopeKey]);
  const remove = async (url: string) => {
    const bridge = (window as unknown as { telarDesktop?: { browser?: SuggestionsBridge } }).telarDesktop?.browser;
    try {
      await bridge?.removeSuggestion?.(scopeKey, url);
      setData(current => current ? { ...current, recent: current.recent.filter(entry => entry.url !== url) } : current);
    } catch { setError(true); }
  };
  return (
    <div className="h-full overflow-y-auto px-5 py-8">
      <div className="mx-auto flex w-full max-w-lg flex-col gap-6">
        <div className="space-y-2">
          <GlobeIcon className="size-6 text-muted-foreground" />
          <h2 className="text-base font-medium">Where would you like to go?</h2>
          <p className="text-sm text-muted-foreground">Type an address above, or open a site below.</p>
        </div>
        {data?.recent.length ? (
          <section className="space-y-2" aria-label="Recent sites in this project">
            <h3 className="flex items-center gap-2 text-xs font-medium text-muted-foreground"><HistoryIcon className="size-3.5" /> Recent sites in this project</h3>
            <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
              {data.recent.map(({ url }) => (
                <div key={url} className="flex items-center">
                  <button type="button" className="min-w-0 flex-1 truncate px-3 py-2.5 text-left text-sm hover:bg-muted focus-visible:outline focus-visible:outline-ring" onClick={() => onOpen(url)}>{url.replace(/^https?:\/\//, '').replace(/\/$/, '')}</button>
                  <button type="button" aria-label={`Remove ${url} from recent sites`} className="m-1 rounded p-2 text-muted-foreground hover:bg-muted" onClick={() => void remove(url)}><XIcon className="size-3.5" /></button>
                </div>
              ))}
            </div>
          </section>
        ) : null}
        {data?.servers.length ? (
          <section className="space-y-2" aria-label="Local servers on this Mac">
            <h3 className="flex items-center gap-2 text-xs font-medium text-muted-foreground"><RadioTowerIcon className="size-3.5" /> Local servers</h3>
            <div className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-card">
              {data.servers.map(({ url, port }) => <button type="button" key={url} className="block w-full px-3 py-2.5 text-left text-sm hover:bg-muted focus-visible:outline focus-visible:outline-ring" onClick={() => onOpen(url)}>localhost:{port}</button>)}
            </div>
          </section>
        ) : null}
        {!data && !error && <p role="status" className="text-xs text-muted-foreground">Looking for local web servers…</p>}
        {error && <p role="status" className="text-xs text-muted-foreground">Suggestions are unavailable. You can still enter an address above.</p>}
        {data && !data.servers.length && <p className="text-xs text-muted-foreground">Start a local web server and it will appear here.</p>}
      </div>
    </div>
  );
}

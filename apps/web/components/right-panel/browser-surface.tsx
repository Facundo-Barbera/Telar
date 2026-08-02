"use client";

import { ExternalLinkIcon, GlobeIcon, ShieldAlertIcon } from "lucide-react";

export function BrowserSurface({ title, url }: { title: string; url: string }) {
  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-muted/20 px-3 py-2">
        <GlobeIcon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
          {url}
        </span>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open ${title} in a new window`}
          className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ExternalLinkIcon className="size-3.5" />
        </a>
      </div>
      <div className="flex items-start gap-2 border-b border-border bg-amber-500/5 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
        <ShieldAlertIcon className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
        <span>
          This browser is an iframe. Some sites block framing through their security policy;
          Telar cannot reliably detect that refusal, so a blank page may need the external link.
        </span>
      </div>
      <iframe
        title={title}
        src={url}
        className="min-h-0 flex-1 border-0 bg-white"
        sandbox="allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-same-origin allow-scripts"
      />
    </div>
  );
}

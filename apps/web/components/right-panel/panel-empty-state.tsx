import { PanelsTopLeftIcon } from "lucide-react";

export function PanelEmptyState({ onOpenBrowser }: { onOpenBrowser: () => void }) {
  return (
    <div className="flex h-full items-center justify-center p-6">
      <div className="max-w-xs text-center">
        <PanelsTopLeftIcon className="mx-auto size-8 text-muted-foreground/40" />
        <h2 className="mt-4 font-heading text-sm font-medium">No panel tabs open</h2>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Open Git or a browser tab from the plus menu to keep working beside the chat.
        </p>
        <button
          type="button"
          onClick={onOpenBrowser}
          className="mt-4 rounded-lg border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
        >
          Open browser
        </button>
      </div>
    </div>
  );
}

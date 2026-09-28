import { useRef, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { FolderPlusIcon, MessageSquarePlusIcon, XIcon } from "lucide-react";
import { SidebarSearchField } from "@/components/sidebar-search-field";
import { Button } from "@/components/ui/button";
import { KeyHint, type CommandId } from "@/features/commands";
import type { SidebarSession } from "@/lib/session-list";

export function RailSearch({
  query,
  onType,
  onClear,
  results,
  selectedIndex,
  setSelectedIndex,
  onOpen,
  filter,
  soleTargetName,
  run,
}: {
  query: string;
  onType: (value: string) => void;
  onClear: () => void;
  results: readonly SidebarSession[];
  selectedIndex: number;
  setSelectedIndex: Dispatch<SetStateAction<number>>;
  onOpen: (session: SidebarSession) => void;
  filter: ReactNode | undefined;
  soleTargetName: string | undefined;
  run: (id: CommandId) => void;
}) {
  const composing = useRef(false);

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      if (query) {
        event.preventDefault();
        onClear();
      }
      return;
    }
    if (!query || results.length === 0) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setSelectedIndex((index) => (index + delta + results.length) % results.length);
    } else if (event.key === "Enter" && selectedIndex >= 0) {
      event.preventDefault();
      const selected = results[selectedIndex];
      if (selected) onOpen(selected);
    }
  };

  return (
    <div className="px-2 pb-2 pt-3">
      <div className="flex items-center gap-1.5">
        <SidebarSearchField
          className="min-w-0 flex-1"
          value={query}
          onChange={(event) => onType(event.target.value)}
          onKeyDown={onKeyDown}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
          placeholder="Search"
          aria-label="Search sessions"
          role="combobox"
          aria-expanded={Boolean(query)}
          aria-controls="sidebar-session-results"
          aria-activedescendant={query && selectedIndex >= 0 ? `sidebar-session-${results[selectedIndex]?.id}` : undefined}
          {...(filter ? { start: filter } : {})}
          end={
            query ? (
              <button
                type="button"
                aria-label="Clear session search"
                onClick={onClear}
                className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground"
              >
                <XIcon className="size-3.5" />
              </button>
            ) : (
              <KeyHint command="search-sessions" always />
            )
          }
        />
        <div className="flex shrink-0 items-center gap-0.5 rounded-lg border border-sidebar-border/60 p-0.5">
          <Button variant="ghost" size="icon-sm" aria-label="Add project" title="Add project" onClick={() => run("add-project")}>
            <FolderPlusIcon />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="New conversation"
            title={soleTargetName ? `New conversation in ${soleTargetName}` : "New conversation — choose the project"}
            onClick={() => run("new-conversation")}
          >
            <MessageSquarePlusIcon />
          </Button>
        </div>
      </div>
    </div>
  );
}

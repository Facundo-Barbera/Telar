"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { XIcon } from "lucide-react";
import { SidebarSearchField } from "@/ui/sidebar-search-field";
import { isEditableTarget } from "@/features/commands";
import { searchSettings, type SettingsSearchEntry, type SettingsSearchIndex } from "../search";
import { cn } from "@/ui/utils";

const MAX_RESULTS = 12;

export function SettingsSearchNav({
  index,
  onChoose,
  children,
}: {
  index: SettingsSearchIndex;
  onChoose: (entry: SettingsSearchEntry) => void;
  children: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const searching = query.trim().length > 0;
  const results = searching ? searchSettings(index, query, { limit: MAX_RESULTS }) : [];
  const current = Math.min(active, Math.max(results.length - 1, 0));
  const optionId = (entry: SettingsSearchEntry) => `${listId}-${entry.id}`;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      input.current?.focus();
      input.current?.select();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!searching) return;
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [current, searching]);

  const choose = (entry: SettingsSearchEntry) => {
    onChoose(entry);
    setQuery("");
    setActive(0);
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="px-1">
        <SidebarSearchField
          ref={input}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              if (query) {
                event.preventDefault();
                setQuery("");
                setActive(0);
              } else {
                input.current?.blur();
              }
              return;
            }
            if (!results.length) return;
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((index) => (Math.min(index, results.length - 1) + 1) % results.length);
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((index) => (Math.min(index, results.length - 1) + results.length - 1) % results.length);
            } else if (event.key === "Enter") {
              event.preventDefault();
              const entry = results[current];
              if (entry) choose(entry);
            }
          }}
          placeholder="Search settings"
          aria-label="Search settings"
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={searching}
          aria-controls={listId}
          {...(searching && results[current] ? { "aria-activedescendant": optionId(results[current]) } : {})}
          end={
            searching ? (
              <button
                type="button"
                aria-label="Clear settings search"
                onClick={() => {
                  setQuery("");
                  setActive(0);
                  input.current?.focus();
                }}
                className="flex size-6 items-center justify-center rounded text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <XIcon className="size-3.5" />
              </button>
            ) : (
              <kbd className="pointer-events-none font-sans text-3xs text-sidebar-foreground/35">/</kbd>
            )
          }
        />
      </div>

      {!searching ? (
        children
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
          <ul ref={list} id={listId} role="listbox" aria-label="Settings search results" className="flex flex-col gap-0.5">
            {results.map((entry, position) => {
              const Icon = entry.icon;
              const on = position === current;
              return (
                <li
                  key={entry.id}
                  id={optionId(entry)}
                  role="option"
                  aria-selected={on}
                  onMouseDown={(event) => event.preventDefault()}
                  onMouseMove={() => setActive(position)}
                  onClick={() => choose(entry)}
                  className={cn(
                    "flex cursor-pointer items-start gap-2.5 rounded-lg px-2 py-1.5 text-left text-sm",
                    on ? "bg-muted text-foreground" : "text-muted-foreground",
                  )}
                >
                  {Icon && (
                    <span className={cn("mt-0.5 flex size-4 shrink-0 items-center justify-center", on ? "text-foreground" : "text-muted-foreground/70")}>
                      <Icon className="size-4" />
                    </span>
                  )}
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-foreground">{entry.title}</span>
                    <span className="truncate text-xs text-muted-foreground">{entry.pageLabel}</span>
                  </span>
                </li>
              );
            })}
          </ul>
          {results.length === 0 && (
            <p role="status" className="px-2 py-1.5 text-sm text-muted-foreground">
              No settings found.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

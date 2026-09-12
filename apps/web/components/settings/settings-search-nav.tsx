"use client";

/**
 * SEARCH STANDS WHERE THE NAV STANDS, and takes its place while you type.
 *
 * Seven panes, and General alone stacks six sections — so the nav answers
 * "which pane" and nothing answers "which row". This field does, and in the
 * nav's own column rather than in a modal over the page: the results ARE the
 * navigation for as long as there is a query, and clearing the field puts the
 * panes back. Nothing moves, nothing overlays, and the way out is the same key
 * that gets out of everything else.
 *
 * `/` FROM ANYWHERE IN SETTINGS, because the field is only useful if reaching
 * it costs nothing — and it is suppressed while focus is in a text field, where
 * a bare slash is a slash. That rule is `isEditableTarget`, the one this app
 * already applies to its command keys, rather than a second opinion about what
 * counts as typing.
 *
 * A COMBOBOX, PROPERLY. ↑/↓ move a highlight the input OWNS (the input keeps
 * focus; `aria-activedescendant` says which option is current), Enter chooses,
 * Escape clears — the pattern a screen reader already knows, so none of it has
 * to be explained.
 */

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { XIcon } from "lucide-react";
import { SidebarSearchField } from "@/components/sidebar-search-field";
import { isEditableTarget } from "@/lib/command-keys";
import { searchSettings, type SettingsSearchEntry, type SettingsSearchIndex } from "@/lib/settings-search";
import { cn } from "@/lib/utils";

/** Enough to scan without scrolling the rail; a query that matches more than
 *  this is a query, not a choice, and the answer is to keep typing. */
const MAX_RESULTS = 12;

export function SettingsSearchNav({
  index,
  onChoose,
  children,
}: {
  index: SettingsSearchIndex;
  /** Navigate to the entry's pane and reveal its row. */
  onChoose: (entry: SettingsSearchEntry) => void;
  /** The pane list, shown whenever there is no query. */
  children: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const searching = query.trim().length > 0;
  const results = searching ? searchSettings(index, query, { limit: MAX_RESULTS }) : [];
  // Clamped rather than reset: a query that grows by a character usually keeps
  // its first result, and snapping the highlight back to the top on every
  // keystroke would fight anyone arrowing down as they type.
  const current = Math.min(active, Math.max(results.length - 1, 0));
  const optionId = (entry: SettingsSearchEntry) => `${listId}-${entry.id}`;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      // A slash inside a field is a slash. Same rule as the command keys.
      if (isEditableTarget(event.target)) return;
      event.preventDefault();
      input.current?.focus();
      input.current?.select();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Keep the highlighted option in view when the keyboard moves it — the list
  // scrolls, and an `aria-activedescendant` nobody can see is not a highlight.
  useEffect(() => {
    if (!searching) return;
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [current, searching]);

  const choose = (entry: SettingsSearchEntry) => {
    onChoose(entry);
    // THE FIELD CLEARS ON CHOOSING, which is what puts the pane list back. A
    // query left standing would leave the nav showing results for a search
    // already acted on, beside the pane it sent you to.
    setQuery("");
    setActive(0);
  };

  return (
    // One nav child, so the field sits just above what it replaces rather than
    // a nav gap away from it.
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
              // One press clears, a second leaves the field — so Escape never
              // strands you in a search box with nothing to undo.
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
                className="flex size-6 items-center justify-center rounded text-muted-foreground hover:text-foreground"
              >
                <XIcon className="size-3.5" />
              </button>
            ) : (
              // The key, shown where the clear button will be, so the chip
              // teaches the shortcut without costing a row of its own.
              <kbd className="pointer-events-none font-sans text-[0.625rem] text-sidebar-foreground/35">/</kbd>
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
                  // The input keeps focus through the whole gesture: the
                  // highlight, the arrow keys and Enter all belong to it, and a
                  // mousedown that stole focus would close the list under the
                  // pointer before the click landed.
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
                    {/* WHICH PANE IT LIVES ON is the second line, because it is
                        the answer to the question that sent you here — and it
                        is what tells two rows with the same title apart. */}
                    <span className="truncate text-xs text-muted-foreground">{entry.pageLabel}</span>
                  </span>
                </li>
              );
            })}
          </ul>
          {/* One line, in the place the results would have been. An empty state
              that explains itself would be longer than the list it replaces. */}
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

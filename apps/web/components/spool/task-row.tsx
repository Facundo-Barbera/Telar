"use client";

/**
 * THE ROW GRAMMAR — §13.8, "the map is content, not chrome": "rows edit in
 * place." Factored ONCE here so `Row`'s "Waiting its turn" rows (`stance.tsx`,
 * the subject room's own list) and `ScheduledLine`'s pinned rows (Today and
 * Scheduled) never grow two different editors for the same gesture — both
 * mount `EditableTitle` for the title and `RowDisclosure` for the inset
 * lane/pin/tag panel, and keep their own shells (a subject dot on one, none
 * on the other) unchanged. `GhostTaskRow` is the third piece: the empty
 * typing row a subject room's Tasks tab ends on, in place of "Add a task".
 *
 * PLUMBING RULE: every write here goes through the existing generic item
 * PATCH (`/api/spool/items/:id`, `apps/engine/src/spool/store.ts`'s
 * `PATCHABLE`) or the existing create route (`/api/spool/items`) — the SAME
 * routes `add-task.tsx` and `room.tsx`'s bulk bar already speak. Nothing here
 * opens a new route. `pinned`'s null form clears a pin (the store's own
 * `SpoolItemPatch` allows it); `tags` is a whole-array replace, so every tag
 * edit here sends the full next array, never a delta the store would have to
 * interpret.
 */
import { useState } from "react";
import { ChevronRightIcon, XIcon } from "lucide-react";
import type { SpoolLane } from "@telar/engine-client";
import { laneItems, laneLabel } from "@/components/spool/lanes";
import { cn } from "@/lib/utils";
import { FieldGroup, FieldRow, RowInput } from "@/components/spool/field-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

/**
 * CLICK-TO-EDIT TITLE. Click (or Enter on focus) opens a plain text field;
 * Enter or blur commits through `onCommit`, Escape reverts without asking.
 * A failed commit reverts the text and shows the engine's own sentence,
 * verbatim — the same convention every write in this module already keeps.
 * `stopPropagation` on every gesture here matters: the title sits inside the
 * row's own "open the packet" click target, and editing a word must never
 * also open the tray.
 */
export function EditableTitle({
  text,
  onCommit,
  className,
}: {
  text: string;
  onCommit: (next: string) => Promise<void>;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const commit = () => {
    const trimmed = value.trim();
    if (!trimmed || trimmed === text) {
      setEditing(false);
      setValue(text);
      return;
    }
    setBusy(true);
    setError(null);
    void onCommit(trimmed)
      .then(() => setEditing(false))
      .catch((err) => {
        setValue(text);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setBusy(false));
  };

  if (editing) {
    return (
      <span className="block min-w-0" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          value={value}
          disabled={busy}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
            if (e.key === "Escape") {
              e.preventDefault();
              setValue(text);
              setEditing(false);
            }
          }}
          className="block w-full min-w-0 border-none bg-transparent p-0 text-sm leading-relaxed font-medium text-foreground outline-none"
        />
        {error && <span className="block text-xs leading-relaxed text-muted-foreground">{error}</span>}
      </span>
    );
  }
  return (
    <span
      role="button"
      tabIndex={0}
      onClick={(e) => {
        e.stopPropagation();
        setValue(text);
        setEditing(true);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.stopPropagation();
          setValue(text);
          setEditing(true);
        }
      }}
      className={cn("block min-w-0 truncate text-sm leading-relaxed font-medium text-foreground", className)}
    >
      {text}
    </span>
  );
}

/**
 * THE PER-ROW DISCLOSURE — a quiet chevron that opens an inset `FieldGroup`
 * under the row: lane, pin day, tags. Every field commits on its own gesture,
 * no dialog, no save button — the same "picking IS stating it" law
 * `add-task.tsx`'s pin field already keeps. OMITTED: a note/body field —
 * `SpoolItem` (`packages/engine-client/src/protocol/spool.ts`) carries no
 * such field; notes are a separate shelf/note store with its own route, not
 * a property of an item, so there is nothing here to disclose or patch.
 */
export function RowDisclosure({
  lane,
  lanes,
  tags,
  pinnedDay,
  onLane,
  onPin,
  onTags,
}: {
  lane?: string;
  lanes: SpoolLane[];
  tags: string[];
  pinnedDay?: string;
  onLane: (lane: string) => void;
  onPin: (day: string | null) => void;
  onTags: (tags: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const [tagDraft, setTagDraft] = useState("");
  return (
    <div className="pl-9">
      <button
        type="button"
        aria-expanded={open}
        aria-label={open ? "Hide details" : "Show details"}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        className="rounded-sm p-0.5 text-muted-foreground/50 transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ChevronRightIcon className={cn("size-3 transition-transform", open && "rotate-90")} aria-hidden />
      </button>
      {open && (
        <FieldGroup className="mt-1.5 mb-2 mr-3">
          {lanes.length > 0 && (
            <FieldRow label="Lane">
              {/* `items` so the trigger reads the lane's NAME rather than its
                  stored key — see `lanes.ts` (#352). */}
              <Select value={lane ?? ""} items={laneItems(lanes)} onValueChange={(next) => onLane(next ?? "")}>
                <SelectTrigger size="sm" className="w-full border-none bg-transparent shadow-none">
                  <SelectValue placeholder="Not filed" />
                </SelectTrigger>
                <SelectContent>
                  {lanes.map((l) => (
                    <SelectItem key={l.key} value={l.key}>
                      {laneLabel(l)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FieldRow>
          )}
          <FieldRow label="Pin day" hint="Picking a day is stating it — it clears the same way.">
            <div className="flex items-center justify-end gap-2">
              <RowInput
                type="date"
                value={pinnedDay ?? ""}
                onChange={(e) => onPin(e.target.value || null)}
                className="text-right"
              />
              {pinnedDay && (
                <button
                  type="button"
                  onClick={() => onPin(null)}
                  className="shrink-0 rounded-sm text-xs text-muted-foreground/70 underline decoration-dotted transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                >
                  clear
                </button>
              )}
            </div>
          </FieldRow>
          <FieldRow label="Tags">
            <div className="flex flex-wrap justify-end gap-1">
              {tags.map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 rounded-full border border-border px-1.5 py-0.5 text-3xs text-muted-foreground"
                >
                  #{tag}
                  <button
                    type="button"
                    onClick={() => onTags(tags.filter((t) => t !== tag))}
                    aria-label={`Remove tag ${tag}`}
                    className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <XIcon className="size-2.5" />
                  </button>
                </span>
              ))}
              <input
                value={tagDraft}
                onChange={(e) => setTagDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && tagDraft.trim()) {
                    e.preventDefault();
                    const next = tagDraft.trim();
                    if (!tags.includes(next)) onTags([...tags, next]);
                    setTagDraft("");
                  }
                }}
                placeholder="add a tag"
                className="h-6 w-20 rounded-md border-none bg-transparent px-1 text-right text-2xs text-foreground outline-none placeholder:text-muted-foreground/50"
              />
            </div>
          </FieldRow>
        </FieldGroup>
      )}
    </div>
  );
}

/**
 * THE GHOST ROW — Reminders' "type to add": an always-present empty row at
 * the list's foot. Enter creates through the SAME create route
 * `add-task.tsx` speaks (`POST /api/spool/items`), preset to this room's
 * subject; on success the field just clears and keeps focus — the same input
 * becomes a fresh ghost row without remounting, so a hand naming several
 * tasks in a row never has to click back in.
 */
export function GhostTaskRow({ subject, onCreated }: { subject: string; onCreated: () => void }) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const title = value.trim();
    if (!title || busy) return;
    setBusy(true);
    setError(null);
    void fetch("/api/spool/items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, project: subject }),
    })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data?.error?.message ?? data?.error ?? `HTTP ${res.status}`);
        setValue("");
        onCreated();
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  return (
    <li className="border-b border-border/40 last:border-b-0">
      <div className="flex w-full items-center gap-2 px-3 py-2">
        <span className="size-4 shrink-0 rounded-full border border-dashed border-muted-foreground/30" aria-hidden />
        <input
          value={value}
          disabled={busy}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="Add a task"
          className="min-w-0 flex-1 border-none bg-transparent p-0 text-sm text-foreground outline-none placeholder:text-muted-foreground/50"
        />
      </div>
      {error && <p className="px-3 pb-1.5 text-xs leading-relaxed text-muted-foreground">{error}</p>}
    </li>
  );
}

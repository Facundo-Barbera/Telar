"use client";

// THE CONVERSATION SHELL — AD-12, executed.
//
// FOUR SLOTS, CONFIGURED BY PROPS, NEVER BY INHERITANCE: a transcript rendered
// through an item-kind registry, a composer, a right rail, a header. There is no
// children-as-transcript, no subclassing, and no cloneElement of a caller's
// tree. A surface configures this component; it never extends it.
//
// WHAT THE SHELL OWNS: scrolling, auto-follow and the streaming affordance —
// the StickToBottom viewport, its content wrapper, its scroll button, and the
// per-item open/closed view state.
//
// WHAT THE SHELL MUST NEVER OWN: data fetching and session semantics. No
// request of any kind, no event stream, no window listener, no storage, no
// session id, no permission mode, no run id. INV-8a in
// packages/core/test/invariants.test.ts is that sentence made executable over
// this whole directory, with a closed denylist and a file-count floor so
// deleting the directory cannot make it pass. If you find yourself needing a
// term on that list, you have found a design problem, not a missing prop: the
// adapter owns session state and hands this component a PROJECTION.
//
// THE VIEW STATE IS OPAQUE, ON PURPOSE. The shell holds one
// `Record<string, boolean>` and knows nothing about what a "tool group" or a
// "thinking block" is; a renderer names its own keys and the shell scopes them
// to that item, so no kind can read or clobber another's disclosure state. That
// scoping is what lets `ItemViewState` carry no domain vocabulary at all —
// which is how a shell avoids acquiring session semantics one field at a time.
//
// AN UNREGISTERED KIND IS A TOMBSTONE, NEVER A THROW (AD-8). A transcript
// containing one unknown item must still render the other nine.

import { Fragment, useState, type ReactNode } from "react";
import {
  Conversation as ConversationViewport,
  ConversationContent as ConversationViewportContent,
  ConversationScrollButton as ConversationViewportScrollButton,
} from "@/components/ai-elements/conversation";
import { cn } from "@/lib/utils";
import type { TranscriptItem } from "./items";
import { Marker } from "./marker";
import type { ItemKindRegistry, ItemViewState } from "./registry";

export type ConversationProps = {
  // ── the four slots ────────────────────────────────────────────────────────
  /** The transcript, rendered through… */
  items: readonly TranscriptItem[];
  /** …the item-kind registry. A PROP, never a module singleton: two surfaces on
   *  one page must not share a registration list. */
  kinds: ItemKindRegistry;
  /** Absent ⇒ a read-only transcript. */
  composer?: ReactNode;
  /** Absent ⇒ no right rail. One slot, many rails. */
  rail?: ReactNode;
  /** Absent ⇒ no header. */
  header?: ReactNode;

  // ── view configuration, not slots ─────────────────────────────────────────
  /** A turn is streaming. ONE BOOLEAN IS SUFFICIENT: the shell marks only the
   *  LAST top-level item live (the donor's `isCurrentMessage`) and a composite
   *  kind derives per-child liveness from its own children. The moment this
   *  becomes a status union, the shell knows about turns. */
  live?: boolean;
  /** Shown in place of the transcript when `items` is empty. */
  empty?: ReactNode;
  /**
   * Caller-supplied chrome rendered INSIDE the scroll column, after the items.
   * Same category as `empty` — a node the shell places, not a slot the contract
   * counts. It exists because an owner adapter legitimately has trailing
   * material that must scroll away with history (the project session's durable
   * loom-event rows) and that must NOT be a transcript item: the shell marks the
   * last top-level item live, so anything appended after the streaming turn
   * would silently steal its liveness.
   */
  trailing?: ReactNode;
  className?: string;
};

export function Conversation({
  items,
  kinds,
  composer,
  rail,
  header,
  live = false,
  empty,
  trailing,
  className,
}: ConversationProps) {
  // ONE opaque map for every kind's disclosure state, keyed by the item's own
  // key plus the key its renderer named, joined by NUL — a separator that cannot
  // occur in any key a transcript or a renderer would ever mint, so two items
  // can never collide through string concatenation.
  const [openState, setOpenState] = useState<Record<string, boolean>>({});

  const renderItem = (item: TranscriptItem, itemLive: boolean): ReactNode => {
    const renderer = kinds.get(item.kind);
    if (!renderer) {
      // AD-8's tombstone. It reads as state, not prose, and it names the
      // unregistered id so a developer can see exactly what is missing.
      return (
        <Fragment key={item.key}>
          <Marker attention>unregistered item kind · {item.kind}</Marker>
        </Fragment>
      );
    }
    const scope = (key: string) => `${item.key}\u0000${key}`;
    const view: ItemViewState = {
      live: itemLive,
      isOpen: (key: string, fallback = false) => openState[scope(key)] ?? fallback,
      setOpen: (key: string, next: boolean) =>
        setOpenState((prev) => ({ ...prev, [scope(key)]: next })),
      render: (child, override) => renderItem(child, override?.live ?? false),
    };
    return <Fragment key={item.key}>{renderer(item.payload as never, view)}</Fragment>;
  };

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", className)}>
      {header}
      <div className="flex min-h-0 flex-1">
        <ConversationViewport className="min-w-0 flex-1">
          <ConversationViewportContent className="px-4">
            {items.length === 0
              ? empty
              : items.map((item, i) => renderItem(item, live && i === items.length - 1))}
            {trailing}
          </ConversationViewportContent>
          <ConversationViewportScrollButton />
        </ConversationViewport>
        {rail}
      </div>
      {composer}
    </div>
  );
}

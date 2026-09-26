"use client";

/**
 * THE ONE RENDERER FOR `buildSessionActionMenuItems`.
 *
 * `lib/session-action-menu.ts` decides what the menu SAYS; this decides what it
 * looks like, once, for every surface that draws it. Three do — the rail row's
 * `⋯` dropdown, the rail row's right-click menu, and the cockpit header's title
 * menu — and two of those are built on different primitives, so the parts
 * (item, separator, submenu) are injected rather than imported.
 *
 * WHY NOT JUST IMPORT BOTH SETS AND BRANCH. A `kind === "context" ? … : …`
 * inside the item renderer is the same drift the definition file exists to
 * prevent, one layer down: the branch that draws a destructive item would
 * eventually differ from the branch that draws an ordinary one. Passing the
 * five components in means there is exactly one piece of markup per item shape.
 *
 * THE ICON IS A TOKEN IN THE DEFINITION and a component here, which is what
 * lets that file stay free of React and be tested without one.
 */

import { Fragment, type ComponentType, type ReactNode } from "react";
import {
  AlarmClockIcon,
  AppWindowIcon,
  ArrowRightIcon,
  CircleCheckIcon,
  CopyIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  SettingsIcon,
  SquarePenIcon,
  SquareTerminalIcon,
  Trash2Icon,
  UndoIcon,
} from "lucide-react";
import type { SessionActionIcon, SessionActionItem } from "@/lib/session-action-menu";
import {
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

/**
 * The glyphs, matched to the ones the row's own buttons already use — settle is
 * a check and un-settle is an undo there, so the menu saying the same thing
 * with different pictures would be two vocabularies for one verb.
 */
const ICONS: Record<SessionActionIcon, ComponentType<{ className?: string }>> = {
  // Going there, and going there in a window of its own.
  open: ArrowRightIcon,
  "new-window": AppWindowIcon,
  "new-session": SquarePenIcon,
  pin: PinIcon,
  unpin: PinOffIcon,
  settle: CircleCheckIcon,
  unsettle: UndoIcon,
  terminal: SquareTerminalIcon,
  snooze: AlarmClockIcon,
  wake: AlarmClockIcon,
  rename: PencilIcon,
  copy: CopyIcon,
  "project-settings": SettingsIcon,
  delete: Trash2Icon,
};

type ItemProps = {
  children?: ReactNode;
  disabled?: boolean;
  variant?: "default" | "destructive";
  onClick?: () => void;
  /** The refusal, as a hover title. A disabled row that does not say why is a
   *  dead end, and the reason is already in hand. */
  title?: string;
};

export type SessionMenuParts = {
  Item: ComponentType<ItemProps>;
  Separator: ComponentType<Record<string, never>>;
  Sub: ComponentType<{ children?: ReactNode }>;
  SubTrigger: ComponentType<{ children?: ReactNode; disabled?: boolean; title?: string }>;
  SubContent: ComponentType<{ children?: ReactNode }>;
};

export const dropdownSessionMenuParts: SessionMenuParts = {
  Item: ({ children, disabled, variant, onClick, title }) => (
    <DropdownMenuItem disabled={disabled} variant={variant} onClick={onClick} title={title}>
      {children}
    </DropdownMenuItem>
  ),
  Separator: () => <DropdownMenuSeparator />,
  Sub: ({ children }) => <DropdownMenuSub>{children}</DropdownMenuSub>,
  SubTrigger: ({ children, disabled, title }) => (
    <DropdownMenuSubTrigger disabled={disabled} title={title}>
      {children}
    </DropdownMenuSubTrigger>
  ),
  SubContent: ({ children }) => <DropdownMenuSubContent className="min-w-44">{children}</DropdownMenuSubContent>,
};

export const contextSessionMenuParts: SessionMenuParts = {
  Item: ({ children, disabled, variant, onClick, title }) => (
    <ContextMenuItem disabled={disabled} variant={variant} onClick={onClick} title={title}>
      {children}
    </ContextMenuItem>
  ),
  Separator: () => <ContextMenuSeparator />,
  Sub: ({ children }) => <ContextMenuSub>{children}</ContextMenuSub>,
  SubTrigger: ({ children, disabled, title }) => (
    <ContextMenuSubTrigger disabled={disabled} title={title}>
      {children}
    </ContextMenuSubTrigger>
  ),
  SubContent: ({ children }) => <ContextMenuSubContent className="min-w-44">{children}</ContextMenuSubContent>,
};

/** Label, then the detail column — the resolved snooze time, the countdown. */
function ItemBody({ item }: { item: SessionActionItem }) {
  const Icon = item.icon ? ICONS[item.icon] : undefined;
  return (
    <>
      {Icon ? <Icon /> : null}
      <span className="flex-1 truncate">{item.label}</span>
      {item.detail ? <span className="text-xs text-muted-foreground">{item.detail}</span> : null}
    </>
  );
}

export function SessionActionMenuItems({ items, parts }: { items: readonly SessionActionItem[]; parts: SessionMenuParts }) {
  const { Item, Separator, Sub, SubTrigger, SubContent } = parts;
  return (
    <>
      {items.map((item, index) => {
        // A hairline above the FIRST item would draw a rule against the popup's
        // own edge. The groups are what carry meaning, not the count of rules.
        const separator = item.separatorBefore && index > 0 ? <Separator /> : null;
        const reason = typeof item.disabled === "string" ? item.disabled : undefined;
        // A FRAGMENT, NOT A WRAPPER ELEMENT. Both primitives register their items
        // through a composite list, and putting a real node between the popup and
        // its items is how a menu quietly loses arrow-key navigation.
        if (item.children) {
          return (
            <Fragment key={item.id}>
              {separator}
              <Sub>
                <SubTrigger disabled={Boolean(item.disabled)} title={reason}>
                  <ItemBody item={item} />
                </SubTrigger>
                <SubContent>
                  <SessionActionMenuItems items={item.children} parts={parts} />
                </SubContent>
              </Sub>
            </Fragment>
          );
        }
        return (
          <Fragment key={item.id}>
            {separator}
            <Item
              disabled={Boolean(item.disabled)}
              variant={item.destructive ? "destructive" : "default"}
              title={reason}
              {...(item.run ? { onClick: item.run } : {})}
            >
              <ItemBody item={item} />
            </Item>
          </Fragment>
        );
      })}
    </>
  );
}

/**
 * RIGHT-CLICK ANYWHERE INSIDE `children` OPENS THE SAME LIST — the rail row,
 * and the cockpit's whole breadcrumb.
 *
 * The trigger is a `display: contents` box rather than a real one, so wrapping
 * an element in this cannot change what that element's parent lays out: a row
 * inside a flex list and a breadcrumb with `flex-1` both keep the box they had.
 *
 * NO ITEMS MEANS NO MENU, not an empty popup. A fresh canvas has no session to
 * act on, and a right-click that opens a blank card is worse than one that does
 * the browser's usual thing.
 */
export function SessionActionContextMenu({
  items,
  children,
  onOpen,
}: {
  items?: readonly SessionActionItem[];
  children: ReactNode;
  /** Told as the menu opens — the cockpit asks what Settle would close then (#883). */
  onOpen?: () => void;
}) {
  if (!items || items.length === 0) return <>{children}</>;
  return (
    <ContextMenu onOpenChange={(open) => open && onOpen?.()}>
      <ContextMenuTrigger render={<div className="contents" />}>{children}</ContextMenuTrigger>
      {/* `w-(--anchor-width)` is the primitive's default, which would size the
          popup to the width of whatever was right-clicked — a rail row, or the
          full breadcrumb. Neither is a menu width. */}
      <ContextMenuContent className="w-56">
        <SessionActionMenuItems items={items} parts={contextSessionMenuParts} />
      </ContextMenuContent>
    </ContextMenu>
  );
}
